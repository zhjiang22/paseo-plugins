import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TokenIngester } from "../server/tokens/ingester";
import { validStart } from "../server/tokens/values";
import { iso, type LedgerCall } from "../server/tokens/types";

const NOW = Date.parse("2026-09-23T12:00:00Z");
const line = (value: unknown) => JSON.stringify(value) + "\n";
const user = (at: number) => ({ type: "user", timestamp: iso(at), sessionId: "s", cwd: "/repo/demo", message: { content: "PRIVATE_PROMPT" } });
const assistant = (id: string, at: number, extra: Record<string, unknown> = {}) => ({ type: "assistant", timestamp: iso(at), sessionId: "s", cwd: "/repo/demo",
  requestId: `req-${id}`, message: { id, model: "claude-opus-4", content: "PRIVATE_OUTPUT", usage: { input_tokens: 11, cache_creation_input_tokens: 22, cache_read_input_tokens: 33, output_tokens: 44 } }, ...extra });
async function fixture(run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>, source: "claude" | "codex" = "claude"): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-ingest-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: [{ source, path: root }], now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); }
  finally { await ingester.close(); await rm(root, { force: true, recursive: true }); }
}

test("Claude globally deduplicates content blocks and fork copies, preferring originals", async () => fixture(async (root, ingester, calls) => {
  const original = join(root, "s.jsonl"), fork = join(root, "fork.jsonl");
  await writeFile(original, line(user(NOW - 10_000)) + line(assistant("a", NOW - 5000)) + line(assistant("a", NOW - 2000)));
  await writeFile(fork, line(user(NOW - 10_000)) + line(assistant("a", NOW - 5000, { sessionId: "fork", forkedFrom: { sessionId: "s" } })) + line(assistant("a", NOW - 2000, { sessionId: "fork", forkedFrom: { sessionId: "s" } })));
  await utimes(fork, new Date(NOW - 30_000), new Date(NOW - 30_000));
  await utimes(original, new Date(NOW), new Date(NOW));
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.at, call.start, call.input, call.cacheWrite, call.cacheRead, call.output]), [["s", NOW - 2000, NOW - 10_000, 11, 22, 33, 44]]);
  assert.equal(ingester.backfill.done, true);
  assert.ok(ingester.diagnostics.duplicates >= 2);
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
}));

test("unmarked copies dedupe globally; subagents are attributed to their parent; synthetic/errors ignored", async () => fixture(async (root, ingester, calls) => {
  await mkdir(join(root, "parent", "subagents"), { recursive: true });
  await writeFile(join(root, "s.jsonl"), line(assistant("a", NOW - 5000)));
  await writeFile(join(root, "copy.jsonl"), line(assistant("a", NOW - 5000, { sessionId: "copy" })));
  await writeFile(join(root, "parent", "subagents", "agent-x.jsonl"), line(user(NOW - 5000)) + line(assistant("b", NOW, { sessionId: "agent-x" })) +
    line(assistant("error", NOW, { isApiErrorMessage: true })) + line(assistant("synthetic", NOW, { message: { id: "syn", model: "<synthetic>", usage: { output_tokens: 50 } } })));
  await ingester.backfillAll();
  assert.equal(calls.size, 2);
  const subagent = [...calls.values()].find(call => call.subagent)!;
  assert.equal(subagent.sessionId, "parent"); assert.equal(subagent.start, NOW - 5000);
}));

test("start/end bounds use the latest user before the first response block", async () => fixture(async (root, ingester, calls) => {
  await writeFile(join(root, "s.jsonl"), line(user(NOW - 20_000)) + line(user(NOW - 10_000)) + line(assistant("a", NOW - 9950)) + line(user(NOW - 5000)) + line(assistant("a", NOW)));
  await ingester.backfillAll();
  assert.equal([...calls.values()][0].start, NOW - 10_000);
  assert.equal(validStart(NOW - 99, NOW), null); assert.equal(validStart(NOW - 100, NOW), NOW - 100);
  assert.equal(validStart(NOW - 900_001, NOW), null); assert.equal(validStart(NOW - 900_000, NOW), NOW - 900_000);
  assert.equal(validStart(NOW + 1, NOW), null); assert.equal(validStart(null, NOW), null);
}));

test("incremental tails reread incomplete UTF-8 lines and survive truncation and replacement", async () => fixture(async (root, ingester, calls) => {
  const file = join(root, "s.jsonl"), first = line(assistant("a", NOW - 5000)), second = line(assistant("b", NOW));
  await writeFile(file, first + second.slice(0, -5));
  await ingester.backfillAll(); assert.equal(calls.size, 1);
  assert.equal(ingester.files.get(file)!.offset, Buffer.byteLength(first));
  await appendFile(file, second.slice(-5)); await ingester.poll(true); assert.equal(calls.size, 2);
  await writeFile(file, first); await ingester.poll(true); assert.equal(calls.size, 2);
  await writeFile(file + ".new", line(assistant("c", NOW))); await rename(file + ".new", file); await ingester.poll(true); assert.equal(calls.size, 3);
}));

test("Codex splits cache input, preserves reasoning within output and skips repeated totals", async () => fixture(async (root, ingester, calls) => {
  const usage = { input_tokens: 100, cached_input_tokens: 40, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 12, total_tokens: 120 };
  const event = (at: number) => ({ type: "event_msg", timestamp: iso(at), payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } });
  await writeFile(join(root, "rollout-test.jsonl"), line({ type: "session_meta", payload: { id: "thread", cwd: "/repo" } }) +
    line({ type: "turn_context", payload: { model: "gpt-5" } }) + line({ type: "event_msg", timestamp: iso(NOW - 5000), payload: { type: "task_started" } }) + line(event(NOW)) + line(event(NOW + 1)));
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  const call = [...calls.values()][0];
  assert.deepEqual([call.sessionId, call.model, call.input, call.cacheWrite, call.cacheRead, call.output, call.reasoning, call.start], ["thread", "gpt-5", 50, 10, 40, 20, 12, NOW - 5000]);
}, "codex"));

test("Codex records pair with token_count without stealing the following tool result start", async () => fixture(async (root, ingester, calls) => {
  const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 200, total_tokens: 300 };
  const total = { input_tokens: 200, cached_input_tokens: 80, output_tokens: 400, total_tokens: 600 };
  const record = (id: string, at: number, cumulative: unknown) => ({ type: "token_usage_record", timestamp: iso(at), payload: { response_id: id, thread_id: "child", session_id: "root", usage, thread_token_usage: cumulative } });
  await writeFile(join(root, "rollout-test.jsonl"), line({ type: "session_meta", payload: { id: "child", cwd: "/repo", forked_from_id: "parent" } }) +
    line({ type: "session_meta", payload: { id: "parent", cwd: "/parent" } }) + line({ type: "event_msg", timestamp: iso(NOW - 6000), payload: { type: "user_message" } }) +
    line(record("r1", NOW - 4000, usage)) + line({ type: "response_item", timestamp: iso(NOW - 3900), payload: { type: "custom_tool_call_output", output: "PRIVATE_RESULT" } }) +
    line({ type: "event_msg", timestamp: iso(NOW - 3800), payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } }) + line(record("r2", NOW, total)));
  await ingester.backfillAll();
  const rows = [...calls.values()]; assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(call => [call.at, call.start, call.sessionId, call.cwd]), [[NOW - 3800, NOW - 6000, "child", "/repo"], [NOW, NOW - 3900, "child", "/repo"]]);
  assert.deepEqual([...ingester.files.values()][0].state.links, ["parent"]);
}, "codex"));

test("Claude streaming output corrections keep the largest usage even when timestamps go backwards", async () => fixture(async (root, ingester, calls) => {
  const first = assistant("stream", NOW - 1000), next = assistant("stream", NOW - 500), replay = assistant("stream", NOW - 2000);
  next.message.usage.output_tokens = 158; replay.message.usage.output_tokens = 8;
  await writeFile(join(root, "s.jsonl"), line(user(NOW - 10_000)) + line(first) + line(next) + line(replay));
  await ingester.backfillAll();
  assert.equal(calls.size, 1); const call = [...calls.values()][0];
  assert.equal(call.output, 158); assert.equal(call.at, NOW - 500); assert.equal(call.start, NOW - 10_000);
}));

test("legacy Codex copied history uses its original namespace while the first meta owns the new file", async () => fixture(async (root, ingester, calls) => {
  const meta = (id: string) => ({ type: "session_meta", payload: { id, cwd: "/repo" } });
  const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, total_tokens: 120 };
  const event = { type: "event_msg", timestamp: iso(NOW), payload: { type: "token_count", info: { last_token_usage: usage, total_token_usage: usage } } };
  const original = join(root, "rollout-parent.jsonl"), copy = join(root, "rollout-child.jsonl");
  await writeFile(original, line(meta("parent")) + line(event)); await utimes(original, new Date(NOW - 10000), new Date(NOW - 10000));
  await writeFile(copy, line(meta("child")) + line(meta("parent")) + line(event)); await utimes(copy, new Date(NOW), new Date(NOW));
  await ingester.backfillAll(); assert.equal(calls.size, 1); assert.equal([...calls.values()][0].sessionId, "parent");
  assert.equal(ingester.files.get(copy)!.state.sessionId, "child");
}, "codex"));

test("split multibyte characters never advance the committed cursor or leak into saved state", async () => fixture(async (root, ingester, calls) => {
  const file = join(root, "s.jsonl"), row = { ...assistant("utf8", NOW), content: "内容" }, bytes = Buffer.from(line(row)), cut = bytes.indexOf(Buffer.from("容")) + 1;
  await writeFile(file, bytes.subarray(0, cut)); await ingester.backfillAll();
  assert.equal(calls.size, 0); assert.equal(ingester.files.get(file)!.offset, 0);
  assert.ok(!JSON.stringify(ingester.files.get(file)).includes("内容"));
  await appendFile(file, bytes.subarray(cut)); await ingester.poll(true);
  assert.equal(calls.size, 1); assert.equal(ingester.files.get(file)!.offset, bytes.length);
}));

test("dedupe keys expire after the initial import and older copied history stays dropped", async () => fixture(async (root, ingester, calls) => {
  const DAY = 86_400_000, old = NOW - 70 * DAY;
  await writeFile(join(root, "s.jsonl"), line(user(old - 5000)) + line(assistant("old", old)) + line(user(NOW - 10_000)) + line(assistant("new", NOW - 5000)));
  await ingester.backfillAll();
  assert.equal(calls.size, 2); assert.equal(ingester.seen.size, 2); assert.equal(ingester.seenFloor, null);
  await ingester.poll(true);
  assert.equal(ingester.seen.size, 1); assert.equal(ingester.seenFloor, NOW - 60 * DAY);
  // A resumed session re-writes the old response with its original timestamp next to a genuinely new one.
  await writeFile(join(root, "resumed.jsonl"), line(assistant("old", old, { sessionId: "resumed" })) + line(user(NOW - 2000)) + line(assistant("fresh", NOW - 1000, { sessionId: "resumed" })));
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => call.at).sort(), [old, NOW - 5000, NOW - 1000]);
}));

const capped = async (limits: ConstructorParameters<typeof TokenIngester>[0]["limits"], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "tokens-caps-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: [{ source: "claude", path: root }], now: () => NOW, limits, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { force: true, recursive: true }); }
};

test("past the file cap only the newest logs are tracked, and the cut is reported", () => capped({ files: 2 }, async (root, ingester, calls) => {
  for (const [index, name] of ["old", "mid", "new"].entries()) {
    await writeFile(join(root, `${name}.jsonl`), line(assistant(name, NOW - 5000 + index)));
    await utimes(join(root, `${name}.jsonl`), new Date(NOW - 60_000 + index * 1000), new Date(NOW - 60_000 + index * 1000));
  }
  await ingester.backfillAll();
  assert.deepEqual([...ingester.files.keys()].map(path => path.split("/").at(-1)).sort(), ["mid.jsonl", "new.jsonl"]);
  assert.deepEqual([calls.size, ingester.truncated.files, ingester.roots[0].files], [2, true, 3]);
}));

test("past the byte budget a log is not imported; smaller ones still are", () => capped({ bytes: 4096 }, async (root, ingester, calls) => {
  await writeFile(join(root, "big.jsonl"), line(assistant("big", NOW - 4000)) + " ".repeat(5000) + "\n");
  await writeFile(join(root, "small.jsonl"), line(assistant("small", NOW - 3000)));
  await ingester.backfillAll();
  assert.deepEqual([[...calls.values()].map(call => call.key).length, ingester.truncated.bytes], [1, true]);
  assert.equal([...ingester.files.keys()].some(path => path.endsWith("big.jsonl")), false);
}));

test("a scan stops at its entry budget, says so, and keeps the files it did not reach", () => capped({ scanEntries: 4 }, async (root, ingester) => {
  await mkdir(join(root, "a"), { recursive: true }); await mkdir(join(root, "b"), { recursive: true });
  await writeFile(join(root, "a", "one.jsonl"), line(assistant("one", NOW - 5000)));
  await writeFile(join(root, "b", "two.jsonl"), line(assistant("two", NOW - 4000)));
  await ingester.backfillAll();
  assert.equal(ingester.truncated.scan, false); assert.equal(ingester.files.size, 2);
  for (let index = 0; index < 6; index++) await writeFile(join(root, "a", `noise-${index}.txt`), "x");
  await ingester.scan();
  assert.equal(ingester.truncated.scan, true);
  assert.equal(ingester.files.size, 2, "files the shortened walk did not reach stay tracked");
}));

test("the dedupe index keeps its newest keys under the cap and raises its floor, so old copies are not counted twice", () => capped({ index: 10 }, async (root, ingester, calls) => {
  await writeFile(join(root, "s.jsonl"), Array.from({ length: 20 }, (_, index) => line(assistant(`m${index}`, NOW - 100_000 + index * 1000))).join(""));
  await ingester.backfillAll();
  assert.equal(calls.size, 20); assert.ok(ingester.seen.size <= 10); assert.equal(ingester.truncated.index, true);
  assert.ok((ingester.seenFloor ?? 0) > NOW - 100_000);
  // A copy of the oldest calls in a new file is history, not new usage.
  await writeFile(join(root, "copy.jsonl"), line(assistant("m0", NOW - 100_000, { sessionId: "copy" })));
  await ingester.poll(true);
  assert.equal(calls.size, 20);
}));

test("a tracked log replaced by a symlink is not followed", async () => fixture(async (root, ingester, calls) => {
  const outside = await mkdtemp(join(tmpdir(), "tokens-outside-"));
  try {
    await writeFile(join(root, "s.jsonl"), line(assistant("a", NOW - 5000)));
    await ingester.backfillAll(); assert.equal(calls.size, 1);
    await writeFile(join(outside, "other.jsonl"), line(assistant("a", NOW - 5000)) + line(assistant("outside", NOW - 1000)));
    await rm(join(root, "s.jsonl")); await symlink(join(outside, "other.jsonl"), join(root, "s.jsonl"));
    await ingester.poll(false);
    assert.equal([...calls.keys()].length, 1, "nothing is read through the link");
    assert.equal(ingester.roots[0].error, null);
  } finally { await rm(outside, { recursive: true, force: true }); }
}));

const codexUsage = (total: number) => ({ input_tokens: 100 * total, cached_input_tokens: 40, output_tokens: 20 * total, total_tokens: 120 * total });
const codexMeta = (id: string, source: unknown = "vscode") => ({ type: "session_meta", timestamp: iso(NOW - 60_000), payload: { id, cwd: "/repo/demo", source, instructions: "PRIVATE_INSTRUCTIONS" } });
const codexRecord = (thread: string, response: string, at: number, total: number) => ({ type: "token_usage_record", timestamp: iso(at),
  payload: { thread_id: thread, response_id: response, usage: codexUsage(1), thread_token_usage: codexUsage(total) } });

test("Codex subagent rollouts are subagent calls of their own thread and name the thread that spawned them", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-subagent-")), calls = new Map<string, LedgerCall>(), threads: Array<[string, string]> = [];
  const ingester = new TokenIngester({ roots: [{ source: "codex", path: root }], now: () => NOW, onCall: call => { calls.set(call.key, call); }, onThread: (child, parent) => { threads.push([child, parent]); } });
  try {
    const spawn = { subagent: { thread_spawn: { parent_thread_id: "parent-thread", depth: 1, agent_nickname: "Helper", agent_role: null } } };
    await writeFile(join(root, "rollout-2026-10-01T00-00-00-child.jsonl"), line(codexMeta("child-thread", spawn)) +
      // A record inherited from the parent thread stays the parent's (and is deduplicated against its own log).
      line(codexRecord("parent-thread", "inherited", NOW - 3000, 1)) + line(codexRecord("child-thread", "own", NOW - 1000, 2)));
    await writeFile(join(root, "rollout-2026-10-01T00-00-00-parent.jsonl"), line(codexMeta("parent-thread")) + line(codexRecord("parent-thread", "inherited", NOW - 3000, 1)));
    await ingester.backfillAll();
    const rows = [...calls.values()].sort((a, b) => a.at - b.at);
    assert.deepEqual(rows.map(call => [call.sessionId, call.subagent]), [["parent-thread", false], ["child-thread", true]]);
    assert.ok(threads.some(([child, parent]) => child === "child-thread" && parent === "parent-thread"));
    const child = [...ingester.files.values()].find(file => file.path.endsWith("child.jsonl"))!;
    assert.equal(child.state.parentThread, "parent-thread"); assert.ok(child.state.links.includes("parent-thread"));
    assert.equal([...ingester.files.values()].find(file => file.path.endsWith("parent.jsonl"))!.state.parentThread, null);
    assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
  } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
});

test("an archived Codex session keeps its read position when its rollout moves to archived_sessions", async () => {
  const home = await mkdtemp(join(tmpdir(), "tokens-archive-")), sessions = join(home, "sessions"), archive = join(home, "archived_sessions"), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: [{ source: "codex", path: sessions }, { source: "codex", path: archive }], now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try {
    await mkdir(join(sessions, "2026", "10", "01"), { recursive: true }); await mkdir(archive);
    const name = "rollout-2026-10-01T00-00-00-moved.jsonl", before = join(sessions, "2026", "10", "01", name), after = join(archive, name);
    await writeFile(before, line(codexMeta("moved-thread")) + line(codexRecord("moved-thread", "r1", NOW - 5000, 1)));
    await ingester.backfillAll();
    const offset = ingester.files.get(before)!.offset, read = ingester.diagnostics.bytesRead;
    await rename(before, after);
    await ingester.poll(true);
    assert.equal(ingester.files.has(before), false); assert.equal(ingester.files.get(after)!.offset, offset);
    assert.equal(ingester.files.get(after)!.root, 1);
    assert.equal(ingester.diagnostics.bytesRead, read, "the moved log is not read again");
    await appendFile(after, line(codexRecord("moved-thread", "r2", NOW - 1000, 2)));
    await ingester.poll(true);
    assert.deepEqual([...calls.values()].map(call => call.key).length, 2);
    assert.equal(ingester.diagnostics.duplicates, 0);
    // Copied to another inode instead (another file system): read again, every call recognised as already counted.
    const copy = join(archive, "rollout-2026-10-01T00-00-00-copied.jsonl");
    await writeFile(copy, await readFile(after)); await rm(after);
    await ingester.poll(true);
    assert.equal(calls.size, 2); assert.ok(ingester.diagnostics.duplicates >= 2);
    assert.ok(ingester.files.has(copy));
  } finally { await ingester.close(); await rm(home, { recursive: true, force: true }); }
});
