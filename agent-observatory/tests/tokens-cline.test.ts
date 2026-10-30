import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addCall, emptyData } from "../server/tokens/data";
import { TokenIngester } from "../server/tokens/ingester";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { StatsDirectory } from "../server/stats-directory";
import { tokenSnapshotSchema, tokenSourceNames } from "../shared/tokens";
import { type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional tasks in the shapes Cline / Roo Code / Kilo Code write (field names checked
// against the extension sources and community parsers; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const coverage = { earliestAt: null, latestAt: null, backfill: { done: true, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, roots: [] as never[] };
const reqRow = (parts: { ts: number; tokensIn?: number; tokensOut?: number; cacheWrites?: number; cacheReads?: number; say?: string }) => ({
  type: "say", say: parts.say ?? "api_req_started", ts: parts.ts,
  text: JSON.stringify({ request: "GET /api/data", ...(parts.tokensIn !== undefined ? { tokensIn: parts.tokensIn } : {}), ...(parts.tokensOut !== undefined ? { tokensOut: parts.tokensOut } : {}),
    ...(parts.cacheWrites !== undefined ? { cacheWrites: parts.cacheWrites } : {}), ...(parts.cacheReads !== undefined ? { cacheReads: parts.cacheReads } : {}) }),
});
async function taskDir(base: string, extId: string, taskId: string, rows: unknown[]): Promise<string> {
  const dir = join(base, extId, "tasks", taskId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "ui_messages.json"), JSON.stringify(rows));
  return dir;
}

async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-cline-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("Cline: an api_req_started row is one call with the cache kept out of tokensIn; placeholders and chatter are not calls", () => ingest(root => [{ source: "cline", path: join(root, "code", "globalStorage") }], async (root, ingester, calls) => {
  const base = join(root, "code", "globalStorage");
  await taskDir(base, "saoudrizwan.claude-dev", "task-aaa", [
    { type: "say", say: "api_req_started", ts: NOW - 60_000, text: JSON.stringify({ request: "GET /api/data" }) },
    reqRow({ ts: NOW - 50_000, tokensIn: 1_000, tokensOut: 200, cacheWrites: 120, cacheReads: 3_000 }),
    { type: "say", say: "text", ts: NOW - 45_000, text: "PRIVATE_OUTPUT" },
    reqRow({ ts: NOW - 40_000, tokensIn: 500, tokensOut: 80, cacheWrites: 0, cacheReads: 900 }),
    { type: "say", say: "api_req_finished", ts: NOW - 39_000, text: JSON.stringify({ cost: 0.01 }) },
    { type: "say", say: "subagent_usage", ts: NOW - 30_000, text: JSON.stringify({ tokensIn: 2_000, tokensOut: 300, cacheWrites: 0, cacheReads: 0, cost: 0.02 }) },
  ]);
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent]), [
    ["cline", "task-aaa", "", null, 1_000, 3_000, 120, 200, 0, NOW - 50_000, null, false],
    ["cline", "task-aaa", "", null, 500, 900, 0, 80, 0, NOW - 40_000, null, false],
    ["cline", "task-aaa", "", null, 2_000, 0, 0, 300, 0, NOW - 30_000, null, true],
  ], "tokensIn is fresh input (the cache rides beside it); a subagent_usage snapshot is the sub-agent's call; the leading placeholder and chatter are not calls");
  assert.equal(tokenSourceNames.cline, "Cline");
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
  // A whole-task record counts in totals but has no response time: nothing in the live speed or the fastest records.
  const data = emptyData(); for (const call of rows) addCall(data, call, null, NOW);
  const snapshot = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, NOW, new StatsDirectory(), coverage));
  assert.equal(snapshot.totals.calls, 3); assert.equal(snapshot.totals.genMs, 0); assert.equal(snapshot.speed.p50, null);
}));

test("Cline: rewritten task files are not counted twice, and Roo and Kilo share the shape under their own ids", () => ingest(root => [
  { source: "cline", path: join(root, "code", "globalStorage") },
  { source: "roo", path: join(root, "roo", "globalStorage") },
  { source: "kilo", path: join(root, "kilo", "globalStorage") },
], async (root, ingester, calls) => {
  const code = join(root, "code", "globalStorage", "saoudrizwan.claude-dev", "tasks", "task-bbb");
  await mkdir(code, { recursive: true });
  await writeFile(join(code, "ui_messages.json"), JSON.stringify([reqRow({ ts: NOW - 60_000, tokensIn: 10, tokensOut: 20, cacheWrites: 0, cacheReads: 0 })]));
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  // The whole file is rewritten in place with the same content: nothing new.
  await writeFile(join(code, "ui_messages.json"), JSON.stringify([reqRow({ ts: NOW - 60_000, tokensIn: 10, tokensOut: 20, cacheWrites: 0, cacheReads: 0 })]));
  await ingester.poll(true);
  assert.equal(calls.size, 1);
  const rooDir = join(root, "roo", "globalStorage", "rooveterinaryinc.roo-cline", "tasks", "task-ccc");
  await mkdir(rooDir, { recursive: true });
  await writeFile(join(rooDir, "ui_messages.json"), JSON.stringify([reqRow({ ts: NOW - 30_000, tokensIn: 30, tokensOut: 40, cacheWrites: 0, cacheReads: 0 })]));
  const kiloDir = join(root, "kilo", "globalStorage", "kilocode.kilo-code", "tasks", "task-ddd");
  await mkdir(kiloDir, { recursive: true });
  await writeFile(join(kiloDir, "ui_messages.json"), JSON.stringify([reqRow({ ts: NOW - 20_000, tokensIn: 50, tokensOut: 60, cacheWrites: 0, cacheReads: 0 })]));
  await ingester.poll(true);
  const rows = [...calls.values()].sort((a, b) => a.input - b.input);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.input]), [
    ["cline", "task-bbb", 10], ["roo", "task-ccc", 30], ["kilo", "task-ddd", 50],
  ]);
  // A log in a foreign shape is skipped quietly.
  await writeFile(join(root, "code", "globalStorage", "saoudrizwan.claude-dev", "tasks", "task-bbb", "ui_messages.json"), "not json");
  await ingester.poll(true);
  assert.equal(ingester.roots[0]!.error, null);
}));

test("Cline: a task transcript over the old whole-file cap is still counted", () => ingest(root => [{ source: "cline", path: join(root, "gs") }], async (root, ingester, calls) => {
  const dir = join(root, "gs", "saoudrizwan.claude-dev", "tasks", "task-big");
  await mkdir(dir, { recursive: true });
  // Five megabytes of filler text rows around one billable api_req_started row.
  const rows: unknown[] = [{ type: "say", say: "text", ts: 0, text: "P".repeat(5000) }];
  while (Buffer.byteLength(JSON.stringify(rows)) < 5 * 1024 * 1024) rows.push({ type: "say", say: "text", ts: rows.length, text: "F".repeat(6000) });
  rows.push(reqRow({ ts: NOW - 40_000, tokensIn: 7_000, tokensOut: 700, cacheWrites: 70, cacheReads: 7_000 }));
  await writeFile(join(dir, "ui_messages.json"), JSON.stringify(rows));
  assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024);
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.input, call.cacheRead, call.output]), [[7_000, 7_000, 700]], "a five-megabyte transcript is read whole, not skipped by the old four-megabyte cap");
}));

test("Roo and Kilo sources keep their own labels", () => ingest(root => [
  { source: "roo", path: join(root, "roo") },
  { source: "kilo", path: join(root, "kilo") },
], async (root, ingester, calls) => {
  assert.equal(tokenSourceNames.roo, "Roo Code");
  assert.equal(tokenSourceNames.kilo, "Kilo Code");
  assert.deepEqual(ingester.roots.map(item => [item.files, item.error]), [[0, null], [0, null]]);
}));
