import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tokenSnapshotSchema, type TokenSnapshot } from "../shared/tokens";
import { StatsDirectory } from "../server/stats-directory";
import type { StatsDirectoryAgent } from "../server/stats-types";
import { addCall, emptyData } from "../server/tokens/data";
import { TokenIngester } from "../server/tokens/ingester";
import { buildTokenLive } from "../server/tokens/live";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { LocalTokenCallSource } from "../server/tokens/source";
import { TokenStore } from "../server/tokens/store";
import { DAY, iso, type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional sessions in the shapes Grok CLI and Pi write (field names checked against real logs; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const coverage: TokenSnapshot["coverage"] = { earliestAt: null, latestAt: null, backfill: { done: true, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, roots: [] };

/** Grok's per-turn `usage.json`: `inputTokens` includes the cache reads and writes; `totalTokens` = input + output. */
interface GrokUsage { input: number; cacheRead: number; cacheWrite?: number; output: number; reasoning?: number; calls?: number }
const grokCounts = (usage: GrokUsage) => ({ inputTokens: usage.input, cachedReadTokens: usage.cacheRead, cacheCreationTokens: usage.cacheWrite ?? 0, outputTokens: usage.output,
  reasoningTokens: usage.reasoning ?? 0, totalTokens: usage.input + usage.output, modelCalls: usage.calls ?? 1, costUsdTicks: 1_000_000 });
function grokTurn(turnNumber: number, at: number, models: Record<string, GrokUsage>) {
  const all = Object.values(models).reduce<GrokUsage>((sum, usage) => ({ input: sum.input + usage.input, cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: (sum.cacheWrite ?? 0) + (usage.cacheWrite ?? 0), output: sum.output + usage.output, reasoning: (sum.reasoning ?? 0) + (usage.reasoning ?? 0), calls: (sum.calls ?? 0) + (usage.calls ?? 1) }), { input: 0, cacheRead: 0, output: 0, calls: 0 });
  // Grok writes nanoseconds and an explicit offset.
  return { turnNumber, endedAt: new Date(at).toISOString().replace("Z", "456789+00:00"), turnCount: 1, primaryModelId: Object.keys(models)[0], ...grokCounts(all),
    modelUsage: Object.fromEntries(Object.entries(models).map(([model, usage]) => [model, grokCounts(usage)])) };
}
const grokFile = (sessionId: string, turns: unknown[]) => JSON.stringify({ sessionId, updatedAt: iso(NOW), session: { turnCount: turns.length }, turns });
async function grokSession(root: string, cwd: string, sessionId: string, turns: unknown[]): Promise<string> {
  const dir = join(root, encodeURIComponent(cwd), sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "usage.json"), grokFile(sessionId, turns));
  // The conversation lives next to it and must never be opened.
  await writeFile(join(dir, "chat_history.jsonl"), line({ role: "user", content: "PRIVATE_PROMPT", usage: { inputTokens: 999 } }));
  await writeFile(join(dir, "updates.jsonl"), line({ sessionUpdate: "agent_message_chunk", content: "PRIVATE_OUTPUT" }));
  return join(dir, "usage.json");
}

/** Pi: a `session` header, then entries; an assistant entry's timestamp is the response end, its message's the request start. */
interface PiUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number }
const piUsage = (usage: PiUsage) => ({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cacheWrite1h: 0,
  totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const piHeader = (id: string, cwd = "/home/me/app", parentSession?: string) => ({ type: "session", version: 3, id, timestamp: iso(NOW - 3_600_000), cwd, ...(parentSession ? { parentSession } : {}) });
const piAssistant = (entry: string, end: number, start: number, usage: PiUsage, extra: Record<string, unknown> = {}) => ({ type: "message", id: entry, parentId: "00000000", timestamp: iso(end),
  message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_OUTPUT" }], api: "example-api", provider: "example-provider", model: "pi-test-model",
    responseId: `resp-${entry}`, usage: piUsage(usage), stopReason: "stop", timestamp: start, ...extra } });
const piFileName = (id: string) => `2026-10-11T10-00-00-000Z_${id}.jsonl`;
async function piSession(root: string, id: string, rows: unknown[], cwd = "/home/me/app", parentSession?: string): Promise<string> {
  const dir = join(root, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`), path = join(dir, piFileName(id));
  await mkdir(dir, { recursive: true });
  await writeFile(path, [piHeader(id, cwd, parentSession), ...rows].map(line).join(""));
  return path;
}

async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-grok-pi-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("Grok: every turn of usage.json, fresh input apart from the cache, one record per model with its model calls; nothing else is opened", () => ingest(root => [{ source: "grok", path: root }], async (root, ingester, calls) => {
  await grokSession(root, "/home/me/app", "0190a1b2-0000-7000-8000-000000000001", [
    grokTurn(1, NOW - 60_000, { "grok-test-fast": { input: 10_000, cacheRead: 8_000, cacheWrite: 500, output: 300, reasoning: 120, calls: 3 } }),
    grokTurn(2, NOW - 30_000, { "grok-test-fast": { input: 4_000, cacheRead: 3_000, output: 100 }, "grok-test-heavy": { input: 2_000, cacheRead: 0, output: 900, calls: 2 } }),
  ]);
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at || (a.model ?? "").localeCompare(b.model ?? ""));
  assert.deepEqual(rows.map(call => [call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.calls ?? 1, call.start, call.subagent]), [
    ["0190a1b2-0000-7000-8000-000000000001", "/home/me/app", "grok-test-fast", 1_500, 8_000, 500, 300, 120, 3, null, false],
    ["0190a1b2-0000-7000-8000-000000000001", "/home/me/app", "grok-test-fast", 1_000, 3_000, 0, 100, 0, 1, null, false],
    ["0190a1b2-0000-7000-8000-000000000001", "/home/me/app", "grok-test-heavy", 2_000, 0, 0, 900, 0, 2, null, false],
  ]);
  assert.deepEqual(rows.map(call => call.at), [NOW - 60_000, NOW - 30_000, NOW - 30_000], "the turn's end, nanoseconds and offset parsed");
  assert.deepEqual([...ingester.files.keys()].map(path => path.split("/").at(-1)), ["usage.json"]);
  assert.equal(ingester.roots[0]!.files, 1);
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
  // A turn's model calls are the ledger's calls; no response time is made up.
  const data = emptyData(); for (const call of rows) addCall(data, call, null, NOW);
  const snapshot = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, NOW, new StatsDirectory(), coverage));
  assert.equal(snapshot.totals.calls, 6); assert.equal(snapshot.totals.genMs, 0); assert.equal(snapshot.speed.p50, null);
  assert.deepEqual(snapshot.sources.map(row => [row.key, row.label, row.calls]), [["grok", "Grok CLI", 6]]);
  // A whole turn logged at its end is not a live speed: it counts today and shows on its session's live row with the
  // ten-minute totals, but adds no burst to the live chart and no fabricated rate.
  const live = buildTokenLive(data, { windowMinutes: 30, utcOffsetMinutes: 0, detail: "full" }, NOW, new StatsDirectory());
  assert.equal(live.today.calls, 6); assert.equal(live.today.output, 1300);
  assert.deepEqual([live.output.reduce((sum, value) => sum + value, 0), live.peak], [0, null], "the chart's output stays timing-true");
  assert.equal(live.calls.reduce((sum, value) => sum + value, 0), 6, "the steps count as calls for the picked-minute summary");
  assert.equal(live.now.outputPerSec, 1300 / 60, "the now-rate counts whole-turn arrivals in its trailing window");
  assert.equal(live.agents.length, 1);
  assert.deepEqual([live.agents[0]!.source, live.agents[0]!.output10m, live.agents[0]!.outputPerSec, live.agents[0]!.calls10m], ["grok", 1300, 1300 / 120, 6]);
}));

test("Grok: a new turn is counted once, and the turns a resumed or forked session carries are not counted again", () => ingest(root => [{ source: "grok", path: root }], async (root, ingester, calls) => {
  const first = grokTurn(1, NOW - 90_000, { "grok-test-fast": { input: 100, cacheRead: 50, output: 10 } }), second = grokTurn(2, NOW - 60_000, { "grok-test-fast": { input: 200, cacheRead: 100, output: 20 } });
  const path = await grokSession(root, "/home/me/app", "session-a", [first]);
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  await writeFile(path, grokFile("session-a", [first, second]));
  await ingester.poll(true);
  assert.equal(calls.size, 2);
  const fork = await grokSession(root, "/home/me/app-fork", "session-b", [first, second, grokTurn(3, NOW - 30_000, { "grok-test-fast": { input: 300, cacheRead: 0, output: 30 } })]);
  await ingester.poll(true);
  assert.equal(calls.size, 3); assert.ok(ingester.diagnostics.duplicates >= 3);
  assert.equal([...calls.values()].find(call => call.output === 30)?.sessionId, "session-b");
  // The digest's history reads the same records.
  const history = await new LocalTokenCallSource(ingester).callsForSessions(["session-b"]);
  assert.equal(history?.source, "grok"); assert.deepEqual(history?.calls.map(call => call.output), [10, 20, 30]);
  assert.ok(fork.endsWith("usage.json"));
}));

test("Grok: a file caught mid-write is read again, the observatory's own analyses are skipped, a long cwd comes from .cwd, a missing root is quiet", () => ingest(root => [{ source: "grok", path: join(root, "sessions") }, { source: "grok", path: join(root, "missing") }], async (root, ingester, calls) => {
  const sessions = join(root, "sessions"), turn = grokTurn(1, NOW - 10_000, { "grok-test-fast": { input: 100, cacheRead: 0, output: 10 } });
  const path = await grokSession(sessions, "/home/me/app", "session-c", [turn]);
  const complete = grokFile("session-c", [turn]);
  await writeFile(path, complete.slice(0, complete.length - 7));
  await grokSession(sessions, join(tmpdir(), "paseo-insight-AbC123"), "insight-session", [grokTurn(1, NOW - 5000, { "grok-test-fast": { input: 9, cacheRead: 0, output: 9 } })]);
  const long = join(sessions, "home-me-very-long-project-name-3f2a9c", "session-d");
  await mkdir(long, { recursive: true });
  await writeFile(join(sessions, "home-me-very-long-project-name-3f2a9c", ".cwd"), "/home/me/a-very-long-project-name\n");
  await writeFile(join(long, "usage.json"), grokFile("session-d", [grokTurn(1, NOW - 4000, { "grok-test-fast": { input: 50, cacheRead: 0, output: 5 } })]));
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.cwd]), [["session-d", "/home/me/a-very-long-project-name"]]);
  assert.ok(![...ingester.files.keys()].some(path => path.includes("insight")), "the analysis session is never tracked");
  assert.deepEqual(ingester.roots.map(item => [item.files, item.error]), [[2, null], [0, null]]);
  await writeFile(path, complete);
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => call.sessionId).sort(), ["session-c", "session-d"]);
}));

test("Pi: replies with their request start and response end, tool results and summaries with usage; copies in retainedTail and failed requests are not", () => ingest(root => [{ source: "pi", path: root }], async (root, ingester, calls) => {
  await piSession(root, "0f0e0d0c-0000-4000-8000-00000000000a", [
    { type: "model_change", id: "a0000001", parentId: null, timestamp: iso(NOW - 60_000), provider: "example-provider", modelId: "pi-default-model" },
    { type: "message", id: "a0000002", parentId: "a0000001", timestamp: iso(NOW - 50_000), message: { role: "user", content: "PRIVATE_PROMPT", timestamp: NOW - 50_000 } },
    piAssistant("a0000003", NOW - 40_000, NOW - 49_000, { input: 12, output: 340, cacheRead: 9_000, cacheWrite: 600 }),
    { type: "message", id: "a0000004", parentId: "a0000003", timestamp: iso(NOW - 39_000), message: { role: "toolResult", toolCallId: "t1", toolName: "agent", content: [{ type: "text", text: "PRIVATE_RESULT" }], isError: false, usage: piUsage({ input: 70, output: 7 }), timestamp: NOW - 39_000 } },
    { type: "message", id: "a0000005", parentId: "a0000004", timestamp: iso(NOW - 38_000), message: { role: "toolResult", toolCallId: "t2", toolName: "read", content: [], isError: false, timestamp: NOW - 38_000 } },
    piAssistant("a0000006", NOW - 30_000, NOW - 31_000, { input: 0, output: 0 }, { stopReason: "error", responseId: undefined }),
    { type: "compaction", id: "a0000007", parentId: "a0000006", timestamp: iso(NOW - 20_000), summary: "PRIVATE_SUMMARY", tokensBefore: 50_000, usage: piUsage({ input: 5_000, output: 400 }),
      retainedTail: [piAssistant("a0000003", NOW - 40_000, NOW - 49_000, { input: 12, output: 340, cacheRead: 9_000, cacheWrite: 600 }).message] },
    { type: "branch_summary", id: "a0000008", parentId: "a0000007", timestamp: iso(NOW - 10_000), fromId: "a0000003", summary: "PRIVATE_SUMMARY", usage: piUsage({ input: 800, output: 80 }) },
  ]);
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.at, call.start]), [
    ["0f0e0d0c-0000-4000-8000-00000000000a", "/home/me/app", "pi-test-model", 12, 9_000, 600, 340, NOW - 40_000, NOW - 49_000],
    ["0f0e0d0c-0000-4000-8000-00000000000a", "/home/me/app", "pi-test-model", 70, 0, 0, 7, NOW - 39_000, null],
    ["0f0e0d0c-0000-4000-8000-00000000000a", "/home/me/app", "pi-test-model", 5_000, 0, 0, 400, NOW - 20_000, null],
    ["0f0e0d0c-0000-4000-8000-00000000000a", "/home/me/app", "pi-test-model", 800, 0, 0, 80, NOW - 10_000, null],
  ]);
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
}));

test("Pi: a log is read on from where it stopped, and the messages a /fork copies into a new session count once", () => ingest(root => [{ source: "pi", path: root }], async (root, ingester, calls) => {
  const original = await piSession(root, "11111111-0000-4000-8000-000000000001", [piAssistant("b0000001", NOW - 50_000, NOW - 52_000, { input: 10, output: 100 })]);
  await ingester.backfillAll();
  const bytes = ingester.diagnostics.bytesRead, next = line(piAssistant("b0000002", NOW - 40_000, NOW - 41_000, { input: 20, output: 200 }));
  await appendFile(original, next);
  await ingester.poll(true);
  assert.equal(calls.size, 2); assert.equal(ingester.diagnostics.bytesRead - bytes, Buffer.byteLength(next));
  // /fork writes a new session whose header names the original; the copied replies keep their response ids.
  await piSession(root, "22222222-0000-4000-8000-000000000002", [piAssistant("b0000001", NOW - 50_000, NOW - 52_000, { input: 10, output: 100 }),
    piAssistant("c0000001", NOW - 20_000, NOW - 21_000, { input: 30, output: 300 })], "/home/me/app", original);
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.output]).sort((a, b) => Number(a[1]) - Number(b[1])), [
    ["11111111-0000-4000-8000-000000000001", 100], ["11111111-0000-4000-8000-000000000001", 200], ["22222222-0000-4000-8000-000000000002", 300]]);
  // The fork's history in 复盘 includes the conversation it continues.
  const history = await new LocalTokenCallSource(ingester).callsForSessions(["22222222-0000-4000-8000-000000000002"]);
  assert.equal(history?.source, "pi"); assert.deepEqual(history?.calls.map(call => call.output), [100, 200, 300]);
  // A log in a format Pi does not write is skipped quietly.
  await writeFile(join(root, "--home-me-app--", piFileName("33333333-0000-4000-8000-000000000003")), "not json\n{\"type\":\"message\",\"message\":7}\n");
  await ingester.poll(true);
  assert.equal(calls.size, 3); assert.equal(ingester.roots[0]!.error, null);
}));

const agent = (id: string, patch: Partial<StatsDirectoryAgent>): StatsDirectoryAgent => ({ id, createdAt: "2026-10-01T00:00:00.000Z", provider: "my-provider", model: null, parentAgentId: null,
  projectKey: "app", projectName: "示例项目", status: "idle", archivedAt: null, title: `会话 ${id}`, requiresAttention: false, attentionReason: null, pendingPermissions: 0,
  activeTurn: false, contextUsed: null, contextMax: null, sessionId: null, cwd: "/home/me/app", ...patch });

test("the Token page shows Grok and Pi as sources and their sessions under the Paseo provider that ran them", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-grok-pi-store-")), grok = join(root, "grok"), pi = join(root, "pi");
  await grokSession(grok, "/home/me/app", "grok-session-1", [grokTurn(1, NOW - 30_000, { "grok-test-fast": { input: 1_000, cacheRead: 600, output: 50, calls: 4 } })]);
  await piSession(pi, "44444444-0000-4000-8000-000000000004", [piAssistant("d0000001", NOW - 20_000, NOW - 25_000, { input: 15, output: 150, cacheRead: 2_000 })]);
  const directory = new StatsDirectory(); directory.loaded = true;
  directory.agents = [agent("grok-agent", { provider: "my-grok", sessionId: "grok-session-1" }), agent("pi-agent", { provider: "pi", sessionId: "44444444-0000-4000-8000-000000000004" })];
  const store = new TokenStore({ directory: join(root, "data"), agents: directory, roots: [{ source: "grok", path: grok }, { source: "pi", path: pi }], now: () => NOW, poll: false });
  try {
    await store.ready;
    const result = await store.read({ range: "7d", utcOffsetMinutes: 0 });
    if (result.mode !== "full") throw new Error("full expected");
    tokenSnapshotSchema.parse(result);
    assert.deepEqual(result.sources.map(row => [row.key, row.label, row.calls]).sort(), [["grok", "Grok CLI", 4], ["pi", "Pi", 1]]);
    assert.deepEqual(result.providers!.map(row => [row.key, row.calls]).sort(), [["my-grok", 4], ["pi", 1]]);
    assert.deepEqual(result.sessions.map(row => [row.source, row.agentId, row.project]).sort(), [["grok", "grok-agent", "示例项目"], ["pi", "pi-agent", "示例项目"]]);
    assert.deepEqual(result.models.map(row => row.key).sort(), ["grok-test-fast", "pi-test-model"]);
    assert.equal(result.paseoShare, 1);
    assert.deepEqual(result.coverage.roots.map(row => [row.source, row.files]), [["grok", 1], ["pi", 1]]);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("upgrading: a log source the saved ledger never watched is imported in full, past the dedupe window, and only once", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-upgrade-")), claude = join(root, "claude"), pi = join(root, "pi"), directory = join(root, "data");
  await mkdir(claude, { recursive: true });
  await writeFile(join(claude, "s.jsonl"), line({ type: "assistant", timestamp: iso(NOW - 60_000), sessionId: "s", cwd: "/home/me/app", requestId: "r",
    message: { id: "m", model: "example-model", usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 2 } } }));
  // 90 days old: older than the 60-day dedupe window, which a ledger that already ran has moved past.
  await piSession(pi, "55555555-0000-4000-8000-000000000005", [piAssistant("e0000001", NOW - 90 * DAY, NOW - 90 * DAY - 2000, { input: 10, output: 100 })]);
  const before = new TokenStore({ directory, roots: [{ source: "claude", path: claude }], now: () => NOW, poll: false });
  await before.ready; await before.poll(true);
  assert.ok(before.ingester.seenFloor !== null);
  await before.close();
  const roots: LogRoot[] = [{ source: "claude", path: claude }, { source: "pi", path: pi }];
  let store = new TokenStore({ directory, roots, now: () => NOW, poll: false });
  try {
    await store.ready;
    const read = async () => { const result = await store.read({ range: "90d", utcOffsetMinutes: 0 }); if (result.mode !== "full") throw new Error("full expected"); return result; };
    assert.equal((await read()).allTime.calls, 2, "the old Pi reply is counted");
    await store.close();
    store = new TokenStore({ directory, roots, now: () => NOW, poll: false }); await store.ready; await store.poll(true);
    assert.equal((await read()).allTime.calls, 2, "and not again after a restart");
    const saved = JSON.parse(await readFile(join(directory, "tokens.json"), "utf8"));
    assert.deepEqual(saved.roots.map((item: LogRoot) => item.source), ["claude", "pi"]);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("upgrading: only what a new log source holds when first listed imports past the dedupe window; a session resumed from it later counts only its new turns (r3-F2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-late-root-")), grok = join(root, "grok"), got: LedgerCall[] = [];
  let now = NOW;
  const ingester = new TokenIngester({ roots: [{ source: "grok", path: grok }, { source: "grok", path: join(root, "grok-later") }], now: () => now, onCall: (call, previous) => { if (!previous) got.push(call); } });
  const turn = (number: number, at: number, output: number) => grokTurn(number, at, { "grok-test-fast": { input: 1_000, cacheRead: 0, output } });
  try {
    ingester.markNewRoots([]); // a 2.13 ledger: it never watched Grok
    const old = [turn(1, NOW - 70 * DAY, 10), turn(2, NOW - 70 * DAY + 60_000, 20)];
    await grokSession(grok, "/home/me/app", "old-session", old);
    await ingester.backfillAll();
    assert.deepEqual(got.map(call => call.output), [10, 20], "the first import after the upgrade counts the old history");
    await ingester.poll(true); // the 30-second rescan drops the keys past 60 days
    assert.equal(ingester.seenFloor, NOW - 60 * DAY);
    now = NOW + 3 * DAY;
    await grokSession(grok, "/home/me/app", "resumed-session", [...old, turn(3, now - 1000, 30)]);
    await ingester.poll(true);
    assert.deepEqual(got.map(call => [call.sessionId, call.output]), [["old-session", 10], ["old-session", 20], ["resumed-session", 30]], "the inherited turns are not counted again");
    // A new root that did not exist yet is history whenever it is first listed, and only then.
    await grokSession(join(root, "grok-later"), "/home/me/lab", "moved-in", [turn(1, NOW - 80 * DAY, 40)]);
    await ingester.poll(true);
    assert.deepEqual(got.slice(3).map(call => [call.sessionId, call.output]), [["moved-in", 40]]);
    await ingester.poll(true);
    await grokSession(join(root, "grok-later"), "/home/me/lab", "moved-in-fork", [turn(1, NOW - 80 * DAY, 40), turn(2, now - 500, 50)]);
    await ingester.poll(true);
    assert.deepEqual(got.slice(3).map(call => [call.sessionId, call.output]), [["moved-in", 40], ["moved-in-fork", 50]]);
  } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
});

test("Grok: another session's usage.json written over a deleted one's inode is that new session, not the old one moved (r3-F3)", () => ingest(root => [{ source: "grok", path: root }], async (root, ingester, calls) => {
  const before = await grokSession(root, "/home/me/old-project", "session-a", [grokTurn(1, NOW - 60_000, { "grok-test-fast": { input: 1_000, cacheRead: 0, output: 100 } })]);
  await ingester.backfillAll();
  // Session A is deleted and session B's usage.json gets the same inode (ext4 hands a freed inode to the next file at once):
  // moving A's file into B's directory and rewriting it in place shows the scan exactly that.
  const after = join(root, encodeURIComponent("/home/me/new-project"), "session-b", "usage.json"), inode = (await stat(before)).ino;
  await mkdir(join(after, ".."), { recursive: true }); await rename(before, after);
  await writeFile(after, grokFile("session-b", [grokTurn(1, NOW - 30_000, { "grok-test-fast": { input: 2_000, cacheRead: 0, output: 200 } })]));
  assert.equal((await stat(after)).ino, inode);
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.cwd, call.output]), [["session-a", "/home/me/old-project", 100], ["session-b", "/home/me/new-project", 200]]);
  assert.deepEqual([...ingester.files.values()].map(file => [file.path, file.state.sessionId, file.state.cwd]), [[after, "session-b", "/home/me/new-project"]]);
}));

/** A Pi log as Pi names it: `<creation time>_<id>.jsonl`, the header carrying the same time (a fork's names the session it copies). */
async function piLog(root: string, id: string, created: number, rows: unknown[], parentSession?: string): Promise<string> {
  const dir = join(root, "--home-me-app--"), path = join(dir, `${iso(created).replace(/[:.]/g, "-")}_${id}.jsonl`);
  await mkdir(dir, { recursive: true });
  await writeFile(path, [{ ...piHeader(id, "/home/me/app", parentSession), timestamp: iso(created) }, ...rows].map(line).join(""));
  return path;
}

test("Pi: on the first import a fork older on disk than its original leaves it the replies it copied, and keeps its own (r3-F4)", () => ingest(root => [{ source: "pi", path: root }], async (root, ingester, calls) => {
  const HOUR = 3_600_000, A = "aaaaaaaa-0000-4000-8000-00000000000a", B = "bbbbbbbb-0000-4000-8000-00000000000b";
  const e1 = piAssistant("f0000001", NOW - 170 * 60_000, NOW - 171 * 60_000, { input: 10, output: 100 }), e2 = piAssistant("f0000002", NOW - 160 * 60_000, NOW - 161 * 60_000, { input: 20, output: 200 });
  // A wrote e1 and e2; /fork after e2 made B (its name and header carry the fork's time), B wrote e4, then the user went back to A for e3.
  const original = await piLog(root, A, NOW - 3 * HOUR, [e1, e2, piAssistant("f0000003", NOW - 10 * 60_000, NOW - 11 * 60_000, { input: 30, output: 300 })]);
  const fork = await piLog(root, B, NOW - 2 * HOUR, [e1, e2, piAssistant("f0000004", NOW - 20 * 60_000, NOW - 21 * 60_000, { input: 40, output: 400 })], original);
  await utimes(fork, new Date(NOW - 20 * 60_000), new Date(NOW - 20 * 60_000)); await utimes(original, new Date(NOW - 10 * 60_000), new Date(NOW - 10 * 60_000));
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.output]).sort((a, b) => Number(a[1]) - Number(b[1])), [[A, 100], [A, 200], [A, 300], [B, 400]]);
  assert.equal(ingester.files.get(fork)!.state.hasForks, true); assert.equal(ingester.files.get(original)!.state.hasForks, false);
  // Appended later, a fork's replies are its own as before.
  await appendFile(fork, line(piAssistant("f0000005", NOW - 60_000, NOW - 61_000, { input: 50, output: 500 })));
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].filter(call => call.sessionId === B).map(call => call.output), [400, 500]);
}));

test("Pi: a fork whose original log is gone still counts the replies it copied, once (r3-F4)", () => ingest(root => [{ source: "pi", path: root }], async (root, ingester, calls) => {
  const C = "cccccccc-0000-4000-8000-00000000000c", gone = join(root, "--home-me-app--", "2026-10-11T08-00-00-000Z_dddddddd-0000-4000-8000-00000000000d.jsonl");
  await piLog(root, C, NOW - 2 * 3_600_000, [piAssistant("g0000001", NOW - 150 * 60_000, NOW - 151 * 60_000, { input: 10, output: 100 }),
    piAssistant("g0000002", NOW - 30 * 60_000, NOW - 31 * 60_000, { input: 20, output: 200 })], gone);
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.output]).sort((a, b) => Number(a[1]) - Number(b[1])), [[C, 100], [C, 200]]);
  assert.equal(ingester.diagnostics.duplicates, 0);
}));
