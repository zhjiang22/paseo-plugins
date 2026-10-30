import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addCall, emptyData } from "../server/tokens/data";
import { TokenIngester } from "../server/tokens/ingester";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { LocalTokenCallSource } from "../server/tokens/source";
import { StatsDirectory } from "../server/stats-directory";
import { tokenSnapshotSchema, tokenSourceNames, type TokenSnapshot } from "../shared/tokens";
import { iso, type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional sessions in the shape oh-my-pi writes (field names checked against real logs; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const coverage: TokenSnapshot["coverage"] = { earliestAt: null, latestAt: null, backfill: { done: true, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, roots: [] };

/** oh-my-pi's usage object: like Pi's, with a cost breakdown next to it. */
interface OmpUsage { input: number; output: number; cacheRead?: number; cacheWrite?: number }
const ompUsage = (usage: OmpUsage) => ({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0,
  totalTokens: usage.input + usage.output + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
/** The 256-byte-wide title slot every oh-my-pi log starts with; never a usage entry. */
const titleSlot = () => JSON.stringify({ type: "title", v: 1, title: "", updatedAt: iso(NOW - 3_600_000), pad: " ".repeat(256) });
const ompHeader = (id: string, cwd = "/home/me/app", parentSession?: string) => ({ type: "session", version: 3, id, timestamp: iso(NOW - 3_600_000), cwd, ...(parentSession ? { parentSession } : {}) });
const ompAssistant = (entry: string, end: number, start: number, usage: OmpUsage, model = "omp-test-model") => ({ type: "message", id: entry, parentId: "00000000", timestamp: iso(end),
  message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_OUTPUT" }], api: "example-api", provider: "example-provider", model,
    responseId: `resp-${entry}`, usage: ompUsage(usage), stopReason: "stop", timestamp: start } });
const ompFileName = (id: string) => `2026-10-11T10-00-00-000Z_${id}.jsonl`;
async function ompSession(root: string, id: string, rows: unknown[], cwd = "/home/me/app", parentSession?: string): Promise<string> {
  const dir = join(root, `-${cwd.replace(/^\//, "").replace(/\//g, "-")}`), path = join(dir, ompFileName(id));
  await mkdir(dir, { recursive: true });
  await writeFile(path, [titleSlot(), ompHeader(id, cwd, parentSession), ...rows].map(line).join(""));
  return path;
}

async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-omp-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("oh-my-pi: replies with their request start and response end, tool results, compactions, model_usage entries; the title slot is never a call", () => ingest(root => [{ source: "omp", path: root }], async (root, ingester, calls) => {
  await ompSession(root, "0aa00000-0000-4000-8000-00000000000a", [
    { type: "model_change", id: "b0000001", parentId: null, timestamp: iso(NOW - 60_000), provider: "example-provider", modelId: "omp-default-model" },
    { type: "message", id: "b0000002", parentId: "b0000001", timestamp: iso(NOW - 50_000), message: { role: "user", content: "PRIVATE_PROMPT", timestamp: NOW - 50_000 } },
    ompAssistant("b0000003", NOW - 40_000, NOW - 49_000, { input: 12, output: 340, cacheRead: 9_000, cacheWrite: 600 }),
    { type: "message", id: "b0000004", parentId: "b0000003", timestamp: iso(NOW - 39_000), message: { role: "toolResult", toolCallId: "t1", toolName: "agent", content: [{ type: "text", text: "PRIVATE_RESULT" }], isError: false, usage: ompUsage({ input: 70, output: 7 }), timestamp: NOW - 39_000 } },
    { type: "compaction", id: "b0000005", parentId: "b0000004", timestamp: iso(NOW - 20_000), summary: "PRIVATE_SUMMARY", tokensBefore: 50_000, usage: ompUsage({ input: 5_000, output: 400 }),
      retainedTail: [ompAssistant("b0000003", NOW - 40_000, NOW - 49_000, { input: 12, output: 340, cacheRead: 9_000, cacheWrite: 600 }).message] },
    { type: "model_usage", id: "b0000006", parentId: "b0000005", timestamp: iso(NOW - 10_000), purpose: "title", api: "example-api", provider: "example-provider",
      model: "omp-title-model", usage: ompUsage({ input: 900, output: 20 }) },
  ]);
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.at, call.start]), [
    ["omp", "0aa00000-0000-4000-8000-00000000000a", "/home/me/app", "omp-test-model", 12, 9_000, 600, 340, NOW - 40_000, NOW - 49_000],
    ["omp", "0aa00000-0000-4000-8000-00000000000a", "/home/me/app", "omp-test-model", 70, 0, 0, 7, NOW - 39_000, null],
    ["omp", "0aa00000-0000-4000-8000-00000000000a", "/home/me/app", "omp-test-model", 5_000, 0, 0, 400, NOW - 20_000, null],
    ["omp", "0aa00000-0000-4000-8000-00000000000a", "/home/me/app", "omp-title-model", 900, 0, 0, 20, NOW - 10_000, null],
  ], "each entry counts under the model it names (an assistant's own, else the session's), a model_usage under the model it called");
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
  // The Token page labels the source oh-my-pi, and its replies carry a response time.
  assert.equal(tokenSourceNames.omp, "oh-my-pi");
  const data = emptyData(); for (const call of rows) addCall(data, call, null, NOW);
  const snapshot = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, NOW, new StatsDirectory(), coverage));
  assert.deepEqual(snapshot.sources.map(row => [row.key, row.label, row.calls]), [["omp", "oh-my-pi", 4]]);
  assert.ok(snapshot.speed.p50 !== null, "entries carry a request start, so the output speed is known");
}));

test("oh-my-pi: a log is read on from where it stopped, and the replies a fork copies into a new session count once", () => ingest(root => [{ source: "omp", path: root }], async (root, ingester, calls) => {
  const original = await ompSession(root, "1aa00000-0000-4000-8000-000000000001", [ompAssistant("c0000001", NOW - 50_000, NOW - 52_000, { input: 10, output: 100 })]);
  await ingester.backfillAll();
  const bytes = ingester.diagnostics.bytesRead, next = line(ompAssistant("c0000002", NOW - 40_000, NOW - 41_000, { input: 20, output: 200 }));
  await appendFile(original, next);
  await ingester.poll(true);
  assert.equal(calls.size, 2); assert.equal(ingester.diagnostics.bytesRead - bytes, Buffer.byteLength(next));
  // A fork names the session it came from; the copied replies keep their response ids.
  await ompSession(root, "2aa00000-0000-4000-8000-000000000002", [ompAssistant("c0000001", NOW - 50_000, NOW - 52_000, { input: 10, output: 100 }),
    ompAssistant("c0000003", NOW - 20_000, NOW - 21_000, { input: 30, output: 300 })], "/home/me/app", original);
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.output]).sort((a, b) => Number(a[1]) - Number(b[1])), [
    ["1aa00000-0000-4000-8000-000000000001", 100], ["1aa00000-0000-4000-8000-000000000001", 200], ["2aa00000-0000-4000-8000-000000000002", 300]]);
  // The fork's history in 复盘 includes the conversation it continues.
  const history = await new LocalTokenCallSource(ingester).callsForSessions(["2aa00000-0000-4000-8000-000000000002"]);
  assert.equal(history?.source, "omp"); assert.deepEqual(history?.calls.map(call => call.output), [100, 200, 300]);
  // A log in a format oh-my-pi does not write is skipped quietly.
  await writeFile(join(root, "-home-me-app", ompFileName("3aa00000-0000-4000-8000-000000000003")), "not json\n{\"type\":\"message\",\"message\":7}\n");
  await ingester.poll(true);
  assert.equal(calls.size, 3); assert.equal(ingester.roots[0]!.error, null);
}));
