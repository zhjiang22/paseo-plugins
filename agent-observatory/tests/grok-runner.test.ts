import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InsightReport } from "../shared/insights";
import { InsightReportError, parseGrokReport } from "../server/insight-analysis";
import { cleanupInsightLeftovers, findGrokBinary, GROK_DISALLOWED_TOOLS, GrokTurnLimitError, grokSessionsRoot, insightSessionGroups, runGrokAnalysis, scheduleInsightSweeps } from "../server/grok-runner";

// Every test works in its own scratch directory: a fake GROK_HOME, a fake temp root and a fake CLI. Nothing under the real ~/.grok is touched.
const report: InsightReport = { summary: "执行过程清晰", health: "watch", confidence: "high",
  findings: [{ id: "one", severity: "low", category: "efficiency", title: "减少重复读取", detail: "重复读取相同输出", evidence: ["ref-3"], recommendation: "复用结果" }], strengths: ["已有验证"], nextActions: ["检查结果"], limitations: [] };
/** Grok CLI 1.0.52's session-search index: a write-ahead-logged table plus an external-content FTS5 table kept in step by triggers. */
const INDEX_SCHEMA = `PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS session_docs (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL, updated_at INTEGER NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS session_docs_fts USING fts5(title, content, content='session_docs', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS session_docs_ai AFTER INSERT ON session_docs BEGIN INSERT INTO session_docs_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content); END;
CREATE TRIGGER IF NOT EXISTS session_docs_ad AFTER DELETE ON session_docs BEGIN INSERT INTO session_docs_fts(session_docs_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content); END;`;
/** A stand-in for the Grok CLI: it records its call, stores a session the way 1.0.50 does (by URL-encoded cwd) and then behaves as told. */
const FAKE_GROK = `#!/usr/bin/env node
const fs = require("node:fs"), path = require("node:path");
const behavior = JSON.parse(fs.readFileSync(path.join(__dirname, "behavior.json"), "utf8"));
const args = process.argv.slice(2), cwd = args[args.indexOf("--cwd") + 1];
fs.appendFileSync(path.join(__dirname, "calls.jsonl"), JSON.stringify({ args, cwd: process.cwd(), memory: process.env.GROK_MEMORY ?? null, home: process.env.GROK_HOME ?? null, search: process.env.GROK_SESSION_SEARCH ?? null, envNames: Object.keys(process.env) }) + "\\n");
// Like 1.0.52, also index the session's prompt for \`grok sessions search\` (the same schema as the real index).
if (behavior.index) {
  const { DatabaseSync } = require("node:sqlite"), db = new DatabaseSync(path.join(process.env.GROK_HOME, "sessions", "session_search.sqlite"));
  db.exec(${JSON.stringify(INDEX_SCHEMA)});
  db.prepare("INSERT INTO session_docs (session_id, cwd, updated_at, title, content, content_hash) VALUES (?, ?, ?, ?, ?, ?)").run("019a-" + process.pid, cwd, Math.floor(Date.now() / 1000), "analysis", fs.readFileSync(args[args.indexOf("--prompt-file") + 1], "utf8"), "h");
  db.close();
}
if (behavior.rejectDisallowed && args.includes("--disallowed-tools")) { process.stderr.write("error: unexpected argument '--disallowed-tools' found\\n"); process.exit(2); }
const group = path.join(process.env.GROK_HOME, "sessions", encodeURIComponent(cwd)), session = path.join(group, "019a-session");
if (behavior.symlinkGroup) fs.symlinkSync(behavior.symlinkGroup, group);
else {
  fs.mkdirSync(path.join(session, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(group, "prompt_history.jsonl"), "{}\\n");
  fs.copyFileSync(args[args.indexOf("--prompt-file") + 1], path.join(session, "prompts", "prompt_0.txt"));
  if (behavior.linkInside) fs.symlinkSync(behavior.linkInside, path.join(session, "outside"));
  // A model that first reaches for a tool: the call is refused and the next turn answers.
  if (behavior.toolDenied) fs.writeFileSync(path.join(session, "events.jsonl"), '{"type":"tool_started","name":"read_file"}\\n{"type":"permission_resolved","decision":"deny"}\\n');
}
if (behavior.hang) { process.on("SIGTERM", () => {}); fs.writeFileSync(path.join(__dirname, "ready"), ""); setInterval(() => {}, 1000); }
else if (behavior.maxTurns) { process.stderr.write("Error: max turns reached\\n"); process.exit(1); }
else if (behavior.fail) { process.stderr.write("Error: upstream unavailable\\n"); process.exit(1); }
else process.stdout.write(JSON.stringify(behavior.output ?? { structured_output: null }));
`;
interface Call { args: string[]; cwd: string; memory: string | null; home: string | null; search: string | null; envNames: string[] }
async function scratch(behavior: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "observatory-grok-runner-")), cli = join(root, "cli"), grokHome = join(root, "grok-home"), tmp = join(root, "tmp");
  await Promise.all([mkdir(cli), mkdir(join(grokHome, "sessions"), { recursive: true }), mkdir(tmp)]);
  const binary = join(cli, "grok");
  await writeFile(binary, FAKE_GROK, { mode: 0o700 });
  const configure = (next: Record<string, unknown>) => writeFile(join(cli, "behavior.json"), JSON.stringify(next));
  await configure(behavior);
  const calls = async (): Promise<Call[]> => (await readFile(join(cli, "calls.jsonl"), "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { root, binary, grokHome, tmp, sessions: join(grokHome, "sessions"), cli, configure, calls, close: () => rm(root, { recursive: true, force: true }) };
}
const run = (f: Awaited<ReturnType<typeof scratch>>, extra: Partial<Parameters<typeof runGrokAnalysis>[0]> = {}) =>
  runGrokAnalysis({ binary: f.binary, prompt: "fixture prompt", signal: new AbortController().signal, timeoutMs: 5000, grokHome: f.grokHome, tmp: f.tmp, ...extra });
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test("Grok gets no tools: every built-in removed by --disallowed-tools, any call denied, memory off; --tools \"\" is gone (opus-F72)", async () => {
  const f = await scratch({ output: { structured_output: report } });
  try {
    await run(f);
    const [call] = await f.calls();
    assert.equal(call.args.includes("--tools"), false, "--tools \"\" removed nothing: stock profiles add their tools before the allowlist");
    const removed = value(call.args, "--disallowed-tools").split(",");
    // The 25 tools Grok CLI 1.0.50 sent despite --tools "", under the names the model sees, plus the ids the flag matches.
    for (const tool of ["ask_user_question", "enter_plan_mode", "exit_plan_mode", "get_command_or_subagent_output", "grep", "image_edit", "image_gen", "image_to_video",
      "kill_command_or_subagent", "list_dir", "monitor", "read_file", "reference_to_video", "run_terminal_command", "scheduler_create", "scheduler_delete", "scheduler_list",
      "search_replace", "search_tool", "send_feedback", "spawn_subagent", "todo_write", "use_tool", "workflow", "write",
      "run_terminal_cmd", "task", "web_search", "web_fetch", "Agent"]) assert.ok(removed.includes(tool), tool);
    assert.deepEqual(removed, [...GROK_DISALLOWED_TOOLS]);
    assert.deepEqual([value(call.args, "--deny"), value(call.args, "--permission-mode"), value(call.args, "--max-turns"), value(call.args, "--output-format")], ["*", "dontAsk", "3", "json"]);
    assert.ok(call.args.includes("--no-subagents")); assert.ok(call.args.includes("--disable-web-search"));
    assert.deepEqual([call.memory, call.home], ["0", f.grokHome]);
    // The run's own directory is both the --cwd and the process's working directory (compared by name: macOS resolves /var to /private/var).
    assert.equal(basename(call.cwd), basename(value(call.args, "--cwd"))); assert.ok(value(call.args, "--cwd").startsWith(join(f.tmp, "paseo-insight-")));
  } finally { await f.close(); }
});

test("a run that tried a tool, was refused and then answered is accepted; its session and excerpt are deleted (opus-F71, opus-F72)", async () => {
  const f = await scratch({ toolDenied: true, output: { structured_output: report, num_turns: 2, usage: { input_tokens: 30, output_tokens: 20 } } });
  try {
    const output = await run(f);
    assert.equal(parseGrokReport(output, new Set(["ref-3"])).report.summary, "执行过程清晰");
    const [call] = await f.calls();
    assert.equal(existsSync(value(call.args, "--cwd")), false, "the temp directory with the excerpt is gone");
    assert.deepEqual(await readdir(f.sessions), [], "the session Grok stored for the run is gone");
  } finally { await f.close(); }
});

test("max turns reached is a Chinese, retryable turn-limit error, and its session is deleted too (opus-F71, opus-F72)", async () => {
  const f = await scratch({ maxTurns: true });
  try {
    const error = await run(f).then(() => null, (failure: unknown) => failure);
    assert.ok(error instanceof GrokTurnLimitError); assert.ok(error instanceof InsightReportError, "callers retry InsightReportError once with compact evidence");
    assert.match(error.message, /轮次上限/); assert.match(error.message, /3 轮/); assert.equal(/max turns/i.test(error.message), false);
    assert.deepEqual(await readdir(f.sessions), []); assert.deepEqual(await readdir(f.tmp), []);
    // Any other failure keeps the CLI's exit code and still cleans up.
    await f.configure({ fail: true });
    await assert.rejects(run(f), /^Error: Grok CLI 退出 \(1\)：Error: upstream unavailable/);
    assert.deepEqual(await readdir(f.sessions), []); assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.close(); }
});

test("cancelling kills a CLI that ignores SIGTERM within a second and deletes the excerpt and session at once (opus-F71)", async () => {
  const f = await scratch({ hang: true });
  try {
    const controller = new AbortController();
    const running = run(f, { signal: controller.signal, timeoutMs: 60_000 }).then(() => null, (failure: unknown) => failure);
    for (let index = 0; index < 400 && !existsSync(join(f.cli, "ready")); index++) await new Promise(resolve => setTimeout(resolve, 10));
    const [call] = await f.calls(), cwd = value(call.args, "--cwd"), group = join(f.sessions, encodeURIComponent(cwd));
    assert.ok(existsSync(group) && existsSync(cwd));
    const started = Date.now(); controller.abort();
    // Synchronously, before the CLI has exited: a host reload may end the plugin process within two seconds.
    assert.equal(existsSync(cwd), false); assert.equal(existsSync(group), false);
    const error = await running;
    assert.ok(error instanceof Error); assert.equal(error.message, "分析已取消");
    assert.ok(Date.now() - started < 1500, `SIGKILL follows SIGTERM within a second (took ${Date.now() - started} ms)`);
    assert.deepEqual(await readdir(f.sessions), []); assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.close(); }
});

test("a timed-out run is killed and cleaned up the same way (opus-F71)", async () => {
  const f = await scratch({ hang: true });
  try {
    await assert.rejects(run(f, { timeoutMs: 300 }), /Grok 分析超时/);
    assert.deepEqual(await readdir(f.sessions), []); assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.close(); }
});

test("a run deletes only its own session group: never a sibling run's, a look-alike or another project's (opus-F71)", async () => {
  const f = await scratch({ output: { structured_output: report } });
  try {
    const keep = [join(f.tmp, "paseo-insight-Other1"), join(f.tmp, "paseo-insights-abc123"), join(f.tmp, "paseo-insight"), "/home/me/app", join(f.tmp, "paseo-insight-abc123", "nested")].map(encodeURIComponent);
    for (const name of keep) { await mkdir(join(f.sessions, name, "019a-session"), { recursive: true }); await writeFile(join(f.sessions, name, "019a-session", "summary.json"), "{}"); }
    await run(f);
    assert.deepEqual((await readdir(f.sessions)).sort(), [...keep].sort());
  } finally { await f.close(); }
});

test("cleanup never follows a symlink: a planted group link and a link inside a group leave their targets intact (opus-F71)", async () => {
  const f = await scratch();
  try {
    const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep");
    await f.configure({ symlinkGroup: outside, output: { structured_output: report } });
    await run(f);
    const [linked] = await readdir(f.sessions);
    assert.ok((await lstat(join(f.sessions, linked!))).isSymbolicLink(), "a symlink in place of the group is not ours to remove");
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
    await rm(join(f.sessions, linked!));
    await f.configure({ linkInside: outside, output: { structured_output: report } });
    await run(f);
    assert.deepEqual(await readdir(f.sessions), [], "the group itself goes");
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep", "the link inside it was unlinked, not followed");
  } finally { await f.close(); }
});

test("a CLI that rejects --disallowed-tools runs once more with the deny rule alone (opus-F72)", async () => {
  const f = await scratch({ rejectDisallowed: true, output: { structured_output: report } });
  try {
    assert.equal(parseGrokReport(await run(f), new Set(["ref-3"])).report.summary, "执行过程清晰");
    const calls = await f.calls();
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes("--disallowed-tools")); assert.equal(calls[1].args.includes("--disallowed-tools"), false);
    assert.equal(value(calls[1].args, "--deny"), "*"); assert.equal(calls[1].cwd, calls[0].cwd);
    assert.deepEqual(await readdir(f.sessions), []); assert.deepEqual(await readdir(f.tmp), []);
  } finally { await f.close(); }
});

test("session groups match only the encoded temp prefix plus mkdtemp's suffix; GROK_HOME decides the root", () => {
  const ours = insightSessionGroups("/tmp");
  assert.equal(ours("%2Ftmp%2Fpaseo-insight-AbC123"), true);
  for (const name of ["%2Ftmp%2Fpaseo-insights-AbC123", "%2Ftmp%2Fpaseo-insight-", "%2Ftmp%2Fpaseo-insight-AbC123%2Fsub", "%2Fvar%2Ftmp%2Fpaseo-insight-AbC123",
    "%2Ftmp%2Fother%2Fpaseo-insight-AbC123", "%2Fhome%2Fme%2Fapp", "paseo-insight-AbC123", "%2Ftmp%2Fpaseo-insight-AbC.12"]) assert.equal(ours(name), false, name);
  assert.equal(grokSessionsRoot("/home/me/.grok"), "/home/me/.grok/sessions");
  assert.equal(grokSessionsRoot("relative/grok"), null);
});

test("the startup sweep clears stale temp directories and Grok sessions of finished runs, never a live run's, a look-alike or a symlink (opus-F71)", async () => {
  const f = await scratch();
  try {
    const now = Date.parse("2026-11-01T12:00:00Z"), hours = (count: number) => new Date(now - count * 3_600_000);
    const outside = join(f.root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep.txt"), "keep");
    const temp = async (name: string, age: number) => { const path = join(f.tmp, name); await mkdir(path); await writeFile(join(path, "trajectory.txt"), "x".repeat(100)); await utimes(path, hours(age), hours(age)); return path; };
    const group = async (cwd: string, age = 0) => { const path = join(f.sessions, encodeURIComponent(cwd)), session = join(path, "019a-session"); await mkdir(session, { recursive: true });
      await writeFile(join(session, "updates.jsonl"), "y".repeat(400)); await utimes(session, hours(age), hours(age)); await utimes(path, hours(age), hours(age)); return path; };
    const stale = await temp("paseo-insight-Stale1", 2), live = await temp("paseo-insight-Live01", 0.1), lookAlike = await temp("paseo-insights-Old001", 5);
    await symlink(outside, join(f.tmp, "paseo-insight-Link01"));
    await writeFile(join(f.tmp, "paseo-insight-File01"), "not a directory");
    await group(stale, 2); await group(live); await group(join(f.tmp, "paseo-insight-Gone01"), 2); await group(lookAlike, 5); await group("/home/me/app", 9);
    await group(join(f.tmp, "paseo-insight-Stale1", "nested"), 3);
    const linkedGroup = join(f.sessions, encodeURIComponent(join(f.tmp, "paseo-insight-Link02"))); await symlink(outside, linkedGroup);
    const withLink = await group(join(f.tmp, "paseo-insight-Gone02"), 2); await symlink(outside, join(withLink, "019a-session", "outside"));
    await utimes(join(withLink, "019a-session"), hours(2), hours(2));

    const swept = await cleanupInsightLeftovers({ grokHome: f.grokHome, tmp: f.tmp, now: () => now });
    assert.deepEqual([swept.directories, swept.sessions], [1, 3]);
    assert.ok(swept.bytes >= 100 + 3 * 400, `bytes from sizes only (${swept.bytes})`);
    assert.deepEqual((await readdir(f.tmp)).sort(), ["paseo-insight-File01", "paseo-insight-Link01", "paseo-insight-Live01", "paseo-insights-Old001"]);
    assert.deepEqual((await readdir(f.sessions)).sort(), [live, lookAlike, "/home/me/app", join(f.tmp, "paseo-insight-Stale1", "nested"), join(f.tmp, "paseo-insight-Link02")].map(encodeURIComponent).sort());
    assert.ok((await lstat(linkedGroup)).isSymbolicLink());
    assert.equal(await readFile(join(outside, "keep.txt"), "utf8"), "keep");
    // Nothing left to do the second time; a missing sessions root or temp root is not an error.
    assert.deepEqual(await cleanupInsightLeftovers({ grokHome: f.grokHome, tmp: f.tmp, now: () => now }), { directories: 0, sessions: 0, bytes: 0, indexed: 0 });
    assert.deepEqual(await cleanupInsightLeftovers({ grokHome: join(f.root, "missing"), tmp: join(f.root, "missing-tmp"), now: () => now }), { directories: 0, sessions: 0, bytes: 0, indexed: 0 });
    assert.ok((await stat(live)).isDirectory());
  } finally { await f.close(); }
});

test("a session group stays while it or a session in it changed within the hour, even when its temp directory is out of sight (r3-F7)", async () => {
  // Another daemon sharing this Grok home, with a /tmp of its own (systemd PrivateTmp, a container): its running analysis has no temp
  // directory here, but Grok keeps writing the group and its session while the run lasts.
  const f = await scratch();
  try {
    const now = Date.parse("2026-11-01T12:00:00Z"), minutes = (count: number) => new Date(now - count * 60_000);
    const group = async (suffix: string, ages: { group: number; session: number; history: number }) => {
      const path = join(f.sessions, encodeURIComponent(join(f.tmp, `paseo-insight-${suffix}`))), session = join(path, "019a-session");
      await mkdir(session, { recursive: true }); await writeFile(join(session, "updates.jsonl"), "{}\n"); await writeFile(join(path, "prompt_history.jsonl"), "{}\n");
      await utimes(join(path, "prompt_history.jsonl"), minutes(ages.history), minutes(ages.history));
      await utimes(session, minutes(ages.session), minutes(ages.session)); await utimes(path, minutes(ages.group), minutes(ages.group));
      return path;
    };
    const justCreated = await group("Elsew1", { group: 10, session: 120, history: 120 });
    const sessionWritten = await group("Elsew2", { group: 120, session: 5, history: 120 });
    const promptAdded = await group("Elsew3", { group: 120, session: 120, history: 20 });
    const finished = await group("Done01", { group: 120, session: 90, history: 61 });
    const swept = await cleanupInsightLeftovers({ grokHome: f.grokHome, tmp: f.tmp, now: () => now });
    assert.deepEqual([swept.directories, swept.sessions], [0, 1]);
    assert.deepEqual((await readdir(f.sessions)).sort(), [justCreated, sessionWritten, promptAdded].map(path => basename(path)).sort());
    assert.equal(existsSync(finished), false, "a group untouched for an hour goes as before");
    // An hour later the quiet ones go too.
    assert.equal((await cleanupInsightLeftovers({ grokHome: f.grokHome, tmp: f.tmp, now: () => now + 60 * 60_000 })).sessions, 3);
    assert.deepEqual(await readdir(f.sessions), []);
  } finally { await f.close(); }
});

/** The working directories the index holds rows for, and how many rows the full-text index finds for a word. */
const indexed = (sessions: string) => {
  const db = new DatabaseSync(join(sessions, "session_search.sqlite"));
  try { return db.prepare("SELECT cwd FROM session_docs ORDER BY cwd").all().map(row => String(row.cwd)); } finally { db.close(); }
};
const matches = (sessions: string, word: string) => {
  const db = new DatabaseSync(join(sessions, "session_search.sqlite"));
  try { return Number((db.prepare("SELECT COUNT(*) AS n FROM session_docs_fts WHERE session_docs_fts MATCH ?").get(word) as { n: number }).n); } finally { db.close(); }
};

test("the run's own session-search row goes with the run, leaving no copy in the index files; the CLI gets session search off and no provider secrets from the daemon", async () => {
  const f = await scratch({ index: true, output: { structured_output: report } });
  // An open connection, like the user's own Grok session: the write-ahead log is then not folded in when the last run closes.
  const db = new DatabaseSync(join(f.sessions, "session_search.sqlite")); db.exec(INDEX_SCHEMA);
  db.prepare("INSERT INTO session_docs (session_id, cwd, updated_at, title, content, content_hash) VALUES ('mine', '/home/user/app', 1, 'own work', 'unrelated words', 'h')").run();
  process.env.OBSERVATORY_TEST_API_KEY = "provider-secret"; process.env.GROK_TEST_SETTING = "kept";
  try {
    await run(f, { prompt: "trajectory ZebraFinch-QX9 excerpt" });
    const [call] = await f.calls();
    assert.equal(call.search, "0");
    assert.ok(!call.envNames.includes("OBSERVATORY_TEST_API_KEY"), "provider keys in the daemon's environment stay out");
    assert.ok(call.envNames.includes("GROK_TEST_SETTING") && call.envNames.includes("PATH") && call.envNames.includes("HOME"));
    assert.deepEqual(indexed(f.sessions), ["/home/user/app"], "only the user's own session stays indexed");
    assert.equal(matches(f.sessions, "zebrafinch"), 0, "the excerpt is no longer searchable");
    assert.equal(matches(f.sessions, "unrelated"), 1);
    for (const name of ["session_search.sqlite", "session_search.sqlite-wal"]) {
      const bytes = await readFile(join(f.sessions, name)).catch(() => Buffer.alloc(0));
      assert.ok(!bytes.includes("ZebraFinch-QX9"), `${name} keeps the excerpt`);
      assert.ok(!bytes.includes("zebrafinch"), `${name} keeps the excerpt's indexed words`);
    }
  } finally { db.close(); delete process.env.OBSERVATORY_TEST_API_KEY; delete process.env.GROK_TEST_SETTING; await f.close(); }
});

test("the startup sweep removes index rows of our old runs only", async () => {
  const f = await scratch();
  const db = new DatabaseSync(join(f.sessions, "session_search.sqlite")); db.exec(INDEX_SCHEMA);
  const now = Date.parse("2026-10-14T08:00:00Z"), old = Math.floor(now / 1000) - 2 * 3600, fresh = Math.floor(now / 1000) - 60;
  const add = db.prepare("INSERT INTO session_docs (session_id, cwd, updated_at, title, content, content_hash) VALUES (?, ?, ?, 't', ?, 'h')");
  add.run("a", join(f.tmp, "paseo-insight-OLD123"), old, "oldrun words");
  add.run("b", join(f.tmp, "paseo-insight-NEW456"), fresh, "newrun words");
  add.run("c", join(f.tmp, "paseo-insight-AB", "nested"), old, "nested words");
  add.run("d", "/home/user/app", old, "user words");
  db.close();
  try {
    const swept = await cleanupInsightLeftovers({ grokHome: f.grokHome, tmp: f.tmp, now: () => now });
    assert.equal(swept.indexed, 1);
    assert.deepEqual(indexed(f.sessions), ["/home/user/app", join(f.tmp, "paseo-insight-AB", "nested"), join(f.tmp, "paseo-insight-NEW456")].sort());
    assert.equal(matches(f.sessions, "oldrun"), 0);
  } finally { await f.close(); }
});

test("the Grok binary is never looked up in a relative PATH entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-grok-path-")), saved = process.env.PATH;
  try {
    await writeFile(join(root, "grok"), "#!/bin/sh\n", { mode: 0o700 });
    process.env.PATH = relative(process.cwd(), root);
    const found = await findGrokBinary();
    assert.notEqual(found, join(relative(process.cwd(), root), "grok"));
    assert.ok(found === null || found.startsWith("/"), String(found));
  } finally { process.env.PATH = saved; await rm(root, { recursive: true, force: true }); }
});

test("a run a crash left just before the start is swept an hour later, by the second sweep", async () => {
  const f = await scratch();
  let now = Date.parse("2026-10-14T08:00:00Z");
  const left = join(f.tmp, "paseo-insight-Crash1"); await mkdir(left);
  await utimes(left, new Date(now - 30 * 60_000), new Date(now - 30 * 60_000));
  const sweeps: number[] = [];
  let swept: () => void = () => {}; const second = new Promise<void>(resolve => { swept = resolve; });
  const stop = scheduleInsightSweeps(result => { sweeps.push(result.directories); if (sweeps.length === 2) swept(); }, { grokHome: f.grokHome, tmp: f.tmp, now: () => now, laterMs: 50 });
  try {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(existsSync(left), "the first sweep keeps a leftover younger than an hour");
    now += 61 * 60_000;
    await Promise.race([second, new Promise(resolve => setTimeout(resolve, 2000))]);
    assert.deepEqual(sweeps, [0, 1]);
    assert.equal(existsSync(left), false);
  } finally { stop(); await f.close(); }
});
