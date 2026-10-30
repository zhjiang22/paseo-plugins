import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { TokenIngester } from "../server/tokens/ingester";
import { readHermesStateDb } from "../server/tokens/hermes-db";
import { dshDayStamp, dshToday } from "../server/tokens/parser";
import { tokenSourceNames } from "../shared/tokens";
import { type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional data in the shapes Hermes (state.db), MiMoCode (mimocode.db, OpenCode-shaped)
// and dsh (cost-meter/ledger.json) write (field names checked against real files; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const DAY = 86_400_000;
const line = (row: unknown) => JSON.stringify(row) + "\n";

async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-hmd-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("Hermes: closed sessions emit their per-model aggregates; open sessions and model-less rows wait", () => ingest(root => [{ source: "hermes", path: root }], async (root, ingester, calls) => {
  const db = new DatabaseSync(join(root, "state.db"));
  db.exec("CREATE TABLE sessions (id text PRIMARY KEY, parent_session_id text, cwd text, ended_at real, started_at real)");
  db.exec("CREATE TABLE session_model_usage (session_id text, model text, api_call_count integer, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer, first_seen real, last_seen real)");
  const session = (id: string, parent: string | null, ended: number | null) => db.prepare("INSERT INTO sessions VALUES (?, ?, '/home/me/app', ?, ?)").run(id, parent, ended, NOW - 3_600_000);
  const usage = (session: string, model: string, calls: number, input: number, out: number, read: number, write: number, reason: number, seen: number) =>
    db.prepare("INSERT INTO session_model_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(session, model, calls, input, out, read, write, reason, seen, seen);
  session("h-ses-1", null, (NOW - 60_000) / 1000);
  session("h-sub", "h-ses-1", (NOW - 50_000) / 1000);
  session("h-open", null, null); // still running: not counted yet
  usage("h-ses-1", "hm-test-model", 3, 1_000, 200, 5_000, 100, 20, (NOW - 60_000) / 1000);
  usage("h-sub", "hm-test-model", 1, 300, 50, 0, 0, 5, (NOW - 50_000) / 1000);
  usage("h-open", "hm-test-model", 1, 9_999, 0, 0, 0, 0, (NOW - 10_000) / 1000);
  db.close();
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent, call.calls ?? 1]), [
    ["hermes", "h-ses-1", "hm-test-model", 1_000, 5_000, 100, 200, 20, NOW - 60_000, null, false, 3],
    ["hermes", "h-sub", "hm-test-model", 300, 0, 0, 50, 5, NOW - 50_000, null, true, 1],
  ], "a closed session emits one call per model row; the open session waits");
  assert.equal(tokenSourceNames.hermes, "Hermes");
}));

test("Hermes: every billing route and auxiliary task contributes to the session/model aggregate", () => ingest(root => [{ source: "hermes", path: root }], async (root, ingester, calls) => {
  const db = new DatabaseSync(join(root, "state.db"));
  db.exec("CREATE TABLE sessions (id text PRIMARY KEY, parent_session_id text, cwd text, ended_at real)");
  // Hermes's real composite key: a session/model can have several independent counters.
  db.exec("CREATE TABLE session_model_usage (session_id text, model text, billing_provider text, billing_base_url text, billing_mode text, task text, api_call_count integer, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer, PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task))");
  db.prepare("INSERT INTO sessions VALUES ('routes', NULL, '/home/me/app', ?)").run((NOW - 60_000) / 1000);
  const write = db.prepare("INSERT INTO session_model_usage VALUES ('routes', 'model-a', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const routes = [["provider-a", "url-a", "api", ""], ["provider-b", "url-a", "api", ""], ["provider-a", "url-b", "api", ""], ["provider-a", "url-a", "subscription", ""], ["provider-a", "url-a", "api", "voice_chat"]];
  for (const [index, route] of routes.entries()) { const n = index + 1; write.run(...route, n, n * 100, n * 10, n * 1_000, n, n * 2); }
  db.close();
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.sessionId, call.model, call.calls, call.input, call.output, call.cacheRead, call.cacheWrite, call.reasoning]), [
    ["routes", "model-a", 15, 1_500, 150, 15_000, 15, 30],
  ]);
  const key = [...calls.keys()][0];
  await ingester.poll(true);
  assert.equal(calls.size, 1);
  assert.equal([...calls.keys()][0], key, "re-reading the aggregate preserves its identity");
  assert.equal(ingester.diagnostics.calls, 1);
  assert.equal(await readHermesStateDb(ingester.files.get(join(root, "state.db"))!, () => {}), false, "an unchanged look-back poll does not dirty the checkpoint");
  assert.equal(ingester.roots[0]!.error, null);
}));

test("Hermes: models sharing a session end time survive the 512-row page boundary and filtered reads", () => ingest(root => [{ source: "hermes", path: root }], async (root, ingester, calls) => {
  const path = join(root, "state.db"), db = new DatabaseSync(path);
  db.exec("CREATE TABLE sessions (id text PRIMARY KEY, parent_session_id text, cwd text, ended_at real)");
  db.exec("CREATE TABLE session_model_usage (session_id text, model text, api_call_count integer, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer)");
  const session = db.prepare("INSERT INTO sessions VALUES (?, NULL, '/home/me/app', ?)");
  const usage = db.prepare("INSERT INTO session_model_usage VALUES (?, ?, 1, 100, 10, 0, 0, 0)");
  for (let index = 0; index < 512; index++) {
    const id = `session-${index}`;
    session.run(id, (NOW - 1_000_000 + index * 1_000) / 1000); usage.run(id, "model-a");
  }
  usage.run("session-511", "model-b"); // row 513 has the exact same ended_at as row 512
  db.close();
  await ingester.backfillAll();
  assert.equal(calls.size, 513);
  assert.deepEqual([...calls.values()].filter(call => call.sessionId === "session-511").map(call => call.model), ["model-a", "model-b"]);
  const checkpoint = ingester.files.get(path)!;
  const watermark = checkpoint.offset;
  await ingester.poll(true);
  assert.equal(calls.size, 513);
  assert.equal(ingester.diagnostics.calls, 513, "the look-back reread counts no aggregate twice");
  assert.equal(checkpoint.offset, watermark, "the persisted watermark keeps its existing seconds-only format");
  const selected: LedgerCall[] = [];
  await readHermesStateDb({ ...checkpoint, offset: 0 }, candidate => selected.push(candidate.call), undefined, ["session-511"]);
  assert.deepEqual(selected.map(call => [call.sessionId, call.model]), [["session-511", "model-a"], ["session-511", "model-b"]]);
  await readHermesStateDb({ ...checkpoint, offset: 0 }, candidate => selected.push(candidate.call), undefined, []);
  assert.equal(selected.length, 2, "an empty session filter never returns the whole database");
  assert.equal(ingester.roots[0]!.error, null);
}));

test("MiMoCode: assistant messages of mimocode.db count like OpenCode's, minus synthetic and zero rows", () => ingest(root => [{ source: "mimo", path: root }], async (root, ingester, calls) => {
  const db = new DatabaseSync(join(root, "mimocode.db"));
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, agent_id text, time_created integer, time_updated integer, data text NOT NULL)");
  db.exec("CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text)");
  db.prepare("INSERT INTO session VALUES (?, NULL, ?)").run("ses_m1", "/home/me/app");
  const message = (id: string, body: Record<string, unknown>) => db.prepare("INSERT INTO message VALUES (?, 'ses_m1', NULL, ?, ?, ?)").run(id, NOW, NOW, JSON.stringify({ id, sessionID: "ses_m1", role: "assistant", path: { cwd: "/home/me/app" }, modelID: "mimo-test-model", time: { created: NOW - 30_000, completed: NOW - 29_000 }, tokens: { input: 4_000, output: 300, reasoning: 25, cache: { read: 6_000, write: 90 } }, ...body }));
  message("mm1", {});
  message("mm2", { modelID: "<synthetic>", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: NOW - 20_000, completed: NOW - 20_000 } });
  db.close();
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent]), [
    ["mimo", "ses_m1", "/home/me/app", "mimo-test-model", 4_000, 6_000, 90, 325, 25, NOW - 29_000, NOW - 30_000, false],
  ], "the synthetic zero row is not a call");
  assert.equal(tokenSourceNames.mimo, "MiMoCode");
}));

test("dsh: a closed day emits one call per session per provider-model; today's key waits under both calendars", () => ingest(root => [{ source: "dsh", path: root }], async (root, ingester, calls) => {
  const costMeter = join(root, "storages", "cost-meter");
  await mkdir(costMeter, { recursive: true });
  const modelRow = (input: number, out: number, read: number, write: number, reason: number, calls: number) => ({ input, output: out, cacheRead: read, cacheWrite: write, reasoning: reason, calls, cost: 0 });
  const CLOSED = "2026-10-01";
  const sessionRow = (id: string, at: number, input: number, out: number, read: number, write: number, reason: number, calls: number) =>
    ({ id, input, output: out, cacheRead: read, cacheWrite: write, reasoning: reason, calls, cost: 0, at, title: "t", byProviderModel: { "dsh:deepseek-v4": modelRow(input, out, read, write, reason, calls) } });
  // dsh keys its ledger on this device without a documented calendar: the running day is skipped under the local and the UTC one.
  const todayLocal = dshToday(), todayUtc = new Date().toISOString().slice(0, 10);
  const days: Record<string, unknown> = {
    [CLOSED]: {
      date: CLOSED, input: 1_300, output: 240, cacheRead: 3_000, cacheWrite: 100, reasoning: 25, calls: 3, cost: 0,
      byProviderModel: { "dsh:deepseek-v4": modelRow(1_300, 240, 3_000, 100, 25, 3) },
      sessions: [
        sessionRow("session-abc", NOW - DAY, 1_000, 200, 2_500, 100, 20, 2),
        sessionRow("session-def", NOW - DAY + 60_000, 300, 40, 500, 0, 5, 1),
      ],
    },
    [todayLocal]: { date: todayLocal, input: 9, output: 9, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1, cost: 0,
      byProviderModel: { "dsh:deepseek-v4": modelRow(9, 9, 0, 0, 0, 1) },
      sessions: [sessionRow("session-today", NOW, 500, 50, 0, 0, 0, 1)] },
  };
  if (todayUtc !== todayLocal) days[todayUtc] = { date: todayUtc, input: 9, output: 9, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 1, cost: 0, byProviderModel: {}, sessions: [sessionRow("session-utc", NOW, 700, 70, 0, 0, 0, 1)] };
  await writeFile(join(costMeter, "ledger.json"), JSON.stringify({ version: 5, days }));
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.subagent]), [
    ["dsh", "session-abc", "dsh:deepseek-v4", 1_000, 2_500, 100, 200, 20, NOW - DAY, false],
    ["dsh", "session-def", "dsh:deepseek-v4", 300, 500, 0, 40, 5, NOW - DAY + 60_000, false],
  ], "one call per session per provider-model of a closed day; today's key waits under both calendars");
  assert.equal(tokenSourceNames.dsh, "DeepSeek Harness");
}));

test("dsh: a ledger whose newest day is in the past counts it (intermittent use never rewrites it)", () => ingest(root => [{ source: "dsh", path: root }], async (root, ingester, calls) => {
  const costMeter = join(root, "storages", "cost-meter");
  await mkdir(costMeter, { recursive: true });
  const modelRow = (calls: number) => ({ input: 800, output: 120, cacheRead: 0, cacheWrite: 0, reasoning: 10, calls, cost: 0 });
  // The only day is long over; dsh was simply not used since. The old "latest day waits" rule dropped it forever.
  await writeFile(join(costMeter, "ledger.json"), JSON.stringify({
    version: 5, days: { "2026-10-01": { date: "2026-10-01", input: 800, output: 120, cacheRead: 0, cacheWrite: 0, reasoning: 10, calls: 2, cost: 0,
      byProviderModel: { "dsh:deepseek-v4": modelRow(2) }, sessions: [{ id: "session-old", input: 800, output: 120, cacheRead: 0, cacheWrite: 0, reasoning: 10, calls: 2, cost: 0, at: NOW - 5 * DAY, title: "old", byProviderModel: { "dsh:deepseek-v4": modelRow(2) } }] } },
  }));
  await ingester.backfillAll();
  assert.deepEqual([...calls.values()].map(call => [call.source, call.sessionId, call.model, call.input, call.output, call.reasoning, call.at]), [
    ["dsh", "session-old", "dsh:deepseek-v4", 800, 120, 10, NOW - 5 * DAY],
  ], "the last active day counts even when no newer day ever follows it");
}));

test("dsh: a calendar rollover re-reads the unchanged ledger without counting a day twice", () => ingest(root => [{ source: "dsh", path: root }], async (root, ingester, calls) => {
  const costMeter = join(root, "storages", "cost-meter");
  await mkdir(costMeter, { recursive: true });
  const ledger = join(costMeter, "ledger.json");
  const modelRow = (calls: number) => ({ input: 800, output: 120, cacheRead: 0, cacheWrite: 0, reasoning: 10, calls, cost: 0 });
  await writeFile(ledger, JSON.stringify({
    version: 5, days: { "2026-10-01": { date: "2026-10-01", input: 800, output: 120, cacheRead: 0, cacheWrite: 0, reasoning: 10, calls: 2, cost: 0,
      byProviderModel: { "dsh:deepseek-v4": modelRow(2) }, sessions: [{ id: "session-old", input: 800, output: 120, cacheRead: 0, cacheWrite: 0, reasoning: 10, calls: 2, cost: 0, at: NOW - 5 * DAY, title: "old", byProviderModel: { "dsh:deepseek-v4": modelRow(2) } }] } },
  }));
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  const file = ingester.files.get(ledger)!;
  assert.ok(file, "the ledger is tracked");
  file.state.day = "2000-01-01T2000-01-01"; // the clock moved on; the file itself did not change
  await ingester.backfillAll();
  assert.equal(calls.size, 1, "the forced re-read counts nothing twice");
  assert.equal(file.state.day, dshDayStamp(), "the parsed day stamp is current again");
}));
