import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { addCall, emptyData } from "../server/tokens/data";
import { TokenIngester } from "../server/tokens/ingester";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { LocalTokenCallSource } from "../server/tokens/source";
import { StatsDirectory } from "../server/stats-directory";
import { tokenSnapshotSchema, tokenSourceNames } from "../shared/tokens";
import { iso, type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional data in the shapes OpenCode writes (field names checked against a real 1.19 database and legacy
// storage tree; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const coverage = { earliestAt: null, latestAt: null, backfill: { done: true, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, roots: [] as never[] };

interface OpendencodeTokens { input: number; output: number; reasoning?: number; cache: { read: number; write: number } }
const messageData = (parts: { id: string; session?: string; cwd?: string; model?: string; tokens?: OpendencodeTokens; created?: number; completed?: number | null; role?: string; cost?: number }) => ({
  id: parts.id, parentID: "msg_parent", ...(parts.session ? { sessionID: parts.session } : {}), role: parts.role ?? "assistant", mode: "build", agent: "build",
  path: { cwd: parts.cwd ?? "/home/me/app", root: parts.cwd ?? "/home/me/app" }, ...(parts.cost !== undefined ? { cost: parts.cost } : {}),
  ...(parts.tokens ? { tokens: parts.tokens } : {}), modelID: parts.model ?? "oc-test-model", providerID: "example",
  time: { created: parts.created ?? NOW - 9_000, ...(parts.completed === null ? {} : { completed: parts.completed ?? NOW - 8_000 }) },
});
const createTables = (db: DatabaseSync) => {
  db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL)");
  db.exec("CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL)");
};
const insertMessage = (db: DatabaseSync, id: string, session: string, data: unknown) =>
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)").run(id, session, NOW, NOW, JSON.stringify(data));
const full = { input: 3_587, output: 256, reasoning: 733, cache: { read: 50_096, write: 120 } };

async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>, onChange?: () => void): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-opencode-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); }, onChange });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("OpenCode: completed assistant messages of opencode.db, with their cache split and response time; sub-agents via the session's parent", () => ingest(root => [{ source: "opencode", path: root }], async (root, ingester, calls) => {
  const db = new DatabaseSync(join(root, "opencode.db"));
  createTables(db);
  db.prepare("INSERT INTO session (id, parent_id, directory) VALUES (?, ?, ?)").run("ses_own", null, "/home/me/app");
  db.prepare("INSERT INTO session (id, parent_id, directory) VALUES (?, ?, ?)").run("ses_sub", "ses_own", "/home/me/app");
  insertMessage(db, "msg_1", "ses_own", messageData({ id: "msg_1", session: "ses_own", tokens: full }));
  insertMessage(db, "msg_2", "ses_sub", messageData({ id: "msg_2", session: "ses_sub", tokens: full, created: NOW - 7_000, completed: NOW - 6_000 }));
  // A user message, an aborted all-zero assistant and an assistant still streaming (no completed time) are not calls.
  insertMessage(db, "msg_u", "ses_own", messageData({ id: "msg_u", session: "ses_own", role: "user" }));
  insertMessage(db, "msg_x", "ses_own", messageData({ id: "msg_x", session: "ses_own", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, completed: NOW - 5_000 }));
  insertMessage(db, "msg_w", "ses_own", messageData({ id: "msg_w", session: "ses_own", tokens: full, completed: null }));
  db.close();
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent]), [
    ["opencode", "ses_own", "/home/me/app", "oc-test-model", 3_587, 50_096, 120, 989, 733, NOW - 8_000, NOW - 9_000, false],
    ["opencode", "ses_sub", "/home/me/app", "oc-test-model", 3_587, 50_096, 120, 989, 733, NOW - 6_000, NOW - 7_000, true],
  ], "a message of a session with a parent is a sub-agent's");
  // The digest (复盘) reads the same database through the call source.
  const history = await new LocalTokenCallSource(ingester).callsForSessions(["ses_own"]);
  assert.equal(history?.source, "opencode");
  assert.deepEqual(history?.calls.map(call => call.output), [989], "a database session's calls reach 复盘, not an all-zero block");
  assert.equal(tokenSourceNames.opencode, "OpenCode");
  const data = emptyData(); for (const call of rows) addCall(data, call, null, NOW);
  const snapshot = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, NOW, new StatsDirectory(), coverage));
  assert.deepEqual(snapshot.sources.map(row => [row.key, row.label, row.calls]), [["opencode", "OpenCode", 2]]);
  assert.ok(snapshot.speed.p50 !== null, "completed messages carry their response time");
}));

test("OpenCode: a message completed after the first read is counted once when the window re-reads it; new rows land; a replaced database starts over", () => ingest(root => [{ source: "opencode", path: root }], async (root, ingester, calls) => {
  const path = join(root, "opencode.db");
  let db = new DatabaseSync(path);
  createTables(db);
  db.prepare("INSERT INTO session (id, parent_id, directory) VALUES (?, ?, ?)").run("ses_own", null, "/home/me/app");
  insertMessage(db, "msg_1", "ses_own", messageData({ id: "msg_1", session: "ses_own", tokens: full }));
  insertMessage(db, "msg_w", "ses_own", messageData({ id: "msg_w", session: "ses_own", tokens: full, completed: null }));
  db.close();
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  db = new DatabaseSync(path);
  db.prepare("UPDATE message SET data = ? WHERE id = ?").run(JSON.stringify(messageData({ id: "msg_w", session: "ses_own", tokens: full, completed: NOW - 4_000 })), "msg_w");
  insertMessage(db, "msg_2", "ses_own", messageData({ id: "msg_2", session: "ses_own", tokens: full, created: NOW - 3_000, completed: NOW - 2_000 }));
  db.close();
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => call.output).sort((a, b) => a - b), [989, 989, 989], "the late completion and the new row count, the re-read first row does not count again");
  // A database replaced whole (a reinstall) is read from its first row again; its calls are deduplicated by message id.
  db = new DatabaseSync(path);
  db.exec("DELETE FROM message");
  insertMessage(db, "msg_3", "ses_own", messageData({ id: "msg_3", session: "ses_own", tokens: full, created: NOW - 1_000, completed: NOW - 500 }));
  db.close();
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => call.sessionId).sort().length, 4, "the old calls stand and the replaced database's first row is one more");
  assert.equal([...calls.values()].reduce((sum, call) => sum + call.output, 0), 989 * 4);
}));

test("OpenCode: the legacy storage tree counts a message file per session id, and files that appear later join in", () => ingest(root => [{ source: "opencode", path: root }], async (root, ingester, calls) => {
  const message = (id: string, session: string, tokens: OpendencodeTokens | undefined, completed: number | null) => JSON.stringify(messageData({ id, session, tokens, completed }), null, 2);
  const write = async (session: string, id: string, text: string) => {
    await mkdir(join(root, "storage", "message", session), { recursive: true });
    await writeFile(join(root, "storage", "message", session, `${id}.json`), text);
  };
  await write("ses_aaa", "msg_a1", message("msg_a1", "ses_aaa", full, NOW - 8_000));
  // Still streaming: no completed time, so not a call yet.
  await write("ses_aaa", "msg_a2", message("msg_a2", "ses_aaa", full, null));
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  assert.equal([...calls.values()][0]!.sessionId, "ses_aaa", "the session id is the message file's directory");
  await write("ses_aaa", "msg_a2", message("msg_a2", "ses_aaa", full, NOW - 6_000));
  await write("ses_bbb", "msg_b1", message("msg_b1", "ses_bbb", full, NOW - 5_000));
  await ingester.poll(true);
  assert.equal(calls.size, 3);
  assert.deepEqual(ingester.roots.map(item => [item.files, item.error]), [[3, null]]);
}));

test("OpenCode: a root without a database and without storage is quiet", () => ingest(root => [{ source: "opencode", path: join(root, "nothing") }], async (root, ingester, calls) => {
  await ingester.backfillAll();
  await ingester.poll(true);
  assert.equal(calls.size, 0);
  assert.deepEqual(ingester.roots.map(item => [item.files, item.error]), [[0, null]]);
}));

test("OpenCode: a poll over an unchanged database changes nothing, and a message without a session row still counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "tokens-opencode-idle-")), calls = new Map<string, LedgerCall>();
  let changes = 0;
  const ingester = new TokenIngester({ roots: [{ source: "opencode", path: root }], now: () => NOW, onCall: call => { calls.set(call.key, call); }, onChange: () => { changes++; } });
  try {
    const db = new DatabaseSync(join(root, "opencode.db"));
    createTables(db);
    insertMessage(db, "msg_1", "ses_own", messageData({ id: "msg_1", session: "ses_own", tokens: full }));
    // An orphan: its session row is gone (a migration can leave one behind), a top-level call of its own.
    insertMessage(db, "msg_o", "ses_gone", messageData({ id: "msg_o", session: "ses_gone", tokens: full, created: NOW - 5_000, completed: NOW - 4_000 }));
    db.close();
    await ingester.backfillAll();
    assert.equal(calls.size, 2);
    assert.equal([...calls.values()].some(call => call.sessionId === "ses_gone" && !call.subagent), true, "an orphan message counts as its own top-level session");
    const before = changes;
    await ingester.poll(true);
    await ingester.poll(true);
    assert.equal(changes, before, "a poll that reads nothing new does not touch the ledger");
    const tracked = [...ingester.files.values()].find(file => file.path.endsWith("opencode.db"));
    assert.ok(tracked && tracked.mtime > 0, "the database's own times keep the file in the hot poll");
  } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
});

test("OpenCode: more rows than one batch reads are all counted", () => ingest(root => [{ source: "opencode", path: root }], async (root, ingester, calls) => {
  const db = new DatabaseSync(join(root, "opencode.db"));
  createTables(db);
  db.prepare("INSERT INTO session (id, parent_id, directory) VALUES (?, ?, ?)").run("ses_own", null, "/home/me/app");
  for (let index = 0; index < 1_200; index++) {
    const assistant = index % 240 === 0;
    insertMessage(db, `msg_${index}`, "ses_own", messageData({ id: `msg_${index}`, role: assistant ? undefined : "user",
      tokens: assistant ? full : undefined, completed: assistant ? NOW - 8_000 + index : null }));
  }
  db.close();
  await ingester.backfillAll();
  assert.equal(calls.size, 5, "five assistant rows across three batches, each counted once");
}));
