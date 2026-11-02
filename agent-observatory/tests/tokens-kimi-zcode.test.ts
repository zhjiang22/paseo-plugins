import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TokenSessions, tokenSessionId } from "../server/token-session";
import { TokenStore } from "../server/tokens/store";
import { LocalTokenCallSource } from "../server/tokens/source";
import { defaultRoots, providerSource } from "../server/tokens/roots";
import { tokenSnapshotSchema } from "../shared/tokens";

const NOW = Date.parse("2026-10-28T04:00:00Z"), at = NOW - 10_000;
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row) + "\n").join("");
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "observatory-kimi-zcode-"));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const usage = (time: number, output = 20) => ({ type: "usage.record", time, model: "kimi-for-coding/k3", usageScope: "turn", usage: { inputOther: 10, inputCacheRead: 80, inputCacheCreation: 5, output } });
const request = (time: number) => ({ type: "llm.request", time, modelAlias: "kimi-for-coding/k3", prompt: "PRIVATE_PROMPT" });
async function kimiFile(root: string, agent: string, rows: unknown[]) {
  const folder = join(root, "wd_project", "session_test", "agents", agent);
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "../../state.json"), JSON.stringify({ id: "session_test", cwd: "/work/kimi", lastPrompt: "PRIVATE_PROMPT" }));
  const file = join(folder, "wire.jsonl"); await writeFile(file, jsonl(rows)); return file;
}
const snapshot = async (s: TokenStore) => tokenSnapshotSchema.parse(await s.read({ range: "7d", utcOffsetMinutes: 0 }));

test("Kimi: main/subagents, cache-exclusive counters, partial append, stable dedupe, restart and private metadata", () => fixture(async root => {
  const logs = join(root, "logs"), directory = join(root, "ledger");
  const path = await kimiFile(logs, "main", [request(at), usage(at + 1000), { type: "context.append_message", message: { usage: { inputOther: 999999 }, content: "PRIVATE_PROMPT" } }]);
  await kimiFile(logs, "agent-0", [request(at + 20), usage(at + 1100)]);
  let s = new TokenStore({ roots: [{ source: "kimi", path: logs }], directory, now: () => NOW, poll: false });
  try {
    await s.ready;
    let result = await snapshot(s);
    assert.deepEqual([result.totals.calls, result.totals.input, result.totals.cacheRead, result.totals.cacheWrite, result.totals.output], [2, 20, 160, 10, 40]);
    const history = new LocalTokenCallSource(s.ingester);
    assert.equal((await history.callsForSessions(["session_test"]))?.calls.filter(c => c.subagent).length, 1);
    assert.equal([...s.data.sessions.values()][0]?.cwd, "/work/kimi");
    await appendFile(path, jsonl([request(at + 2000)]) + JSON.stringify(usage(at + 3000)));
    await s.poll(true); assert.equal((await snapshot(s)).totals.calls, 2);
    await appendFile(path, "\n"); await s.poll(true); assert.equal((await snapshot(s)).totals.calls, 3);
    await appendFile(path, jsonl([usage(at + 3000)])); await s.poll(true); assert.equal((await snapshot(s)).totals.calls, 3);
    const bytes = s.ingester.diagnostics.bytesRead; await s.poll(true); assert.equal(s.ingester.diagnostics.bytesRead, bytes);
    await s.close(); s = new TokenStore({ roots: [{ source: "kimi", path: logs }], directory, now: () => NOW, poll: false }); await s.ready;
    assert.equal((await snapshot(s)).totals.calls, 3); assert.equal(s.ingester.diagnostics.bytesRead, 0);
    await s.flush(); assert.ok(!(await readFile(join(directory, "tokens.json"), "utf8")).includes("PRIVATE_PROMPT"));
  } finally { await s.close(); }
}));

function database(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE session(id TEXT PRIMARY KEY,directory TEXT,parent_id TEXT,time_created INTEGER,task_type TEXT);
    CREATE TABLE message(id TEXT PRIMARY KEY,data TEXT);
    CREATE TABLE part(id TEXT PRIMARY KEY,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);`);
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run("sess_a", "/work/a", null, at - 5000, "interactive");
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run("sess_b", "/work/b", "sess_a", at - 5000, "subagent_child");
  return db;
}
function step(db: DatabaseSync, id: string, session: string, time: number) {
  const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 5 } };
  db.prepare("INSERT INTO message VALUES(?,?)").run(id, JSON.stringify({ role: "assistant", modelId: "glm-5.3", time: { created: time - 1000 }, tokens }));
  const put = db.prepare("INSERT INTO part VALUES(?,?,?,?,?)");
  put.run(id + "-text", id, session, time - 10, JSON.stringify({ type: "text", text: "PRIVATE_OUTPUT", tokens }));
  put.run(id, id, session, time, JSON.stringify({ type: "step-finish", tokens }));
}

test("ZCode: read-only WAL import, no message/step double count, cache-inclusive input, isolated per-agent history, restart cursor", () => fixture(async root => {
  const logs = join(root, "db"), directory = join(root, "ledger"); await mkdir(logs);
  const path = join(logs, "db.sqlite"), db = database(path); step(db, "one", "sess_a", at); step(db, "two", "sess_b", at + 1000);
  db.prepare("INSERT INTO session VALUES(?,?,?,?,?)").run("sess_fork", "/work/a", "sess_a", at + 2000, "fork");
  step(db, "copied", "sess_fork", at);
  const main = await readFile(path), wal = await readFile(path + "-wal");
  let s = new TokenStore({ roots: [{ source: "zcode", path: logs }], directory, now: () => NOW, poll: false });
  try {
    await s.ready; const result = await snapshot(s);
    assert.deepEqual([result.totals.calls, result.totals.input, result.totals.cacheRead, result.totals.cacheWrite, result.totals.output], [2, 30, 160, 10, 40]);
    const history = new LocalTokenCallSource(s.ingester);
    assert.equal((await history.callsForSessions(["sess_a"]))?.calls.length, 1);
    assert.equal((await history.callsForSessions(["sess_b"]))?.calls[0]?.subagent, true);
    assert.deepEqual(await readFile(path), main); assert.deepEqual(await readFile(path + "-wal"), wal);
    const before = await stat(path); step(db, "three", "sess_a", at + 3000); assert.equal((await stat(path)).mtimeMs, before.mtimeMs);
    await s.poll(); assert.equal((await snapshot(s)).totals.calls, 3, "WAL growth is read even without a directory rescan");
    assert.equal((await history.callsForSessions(["sess_a"]))?.calls.length, 2);
    assert.equal((await history.callsForSessions(["sess_b"]))?.calls.length, 1);
    const bytes = s.ingester.diagnostics.bytesRead; await s.poll(true); assert.equal(s.ingester.diagnostics.bytesRead, bytes);
    await s.close(); s = new TokenStore({ roots: [{ source: "zcode", path: logs }], directory, now: () => NOW, poll: false }); await s.ready;
    assert.equal((await snapshot(s)).totals.calls, 3); assert.equal(s.ingester.diagnostics.bytesRead, 0);
    step(db, "four", "sess_a", at + 4000); await s.poll(true); assert.equal((await snapshot(s)).totals.calls, 4);
    await s.flush(); assert.ok(!(await readFile(join(directory, "tokens.json"), "utf8")).includes("PRIVATE_OUTPUT"));
  } finally { await s.close(); db.close(); }
}));

test("ZCode: unknown SQLite schema surfaces a coverage error", () => fixture(async root => {
  const db = new DatabaseSync(join(root, "db.sqlite")); db.exec("CREATE TABLE unknown(id INTEGER)"); db.close();
  const s = new TokenStore({ roots: [{ source: "zcode", path: root }], directory: join(root, "ledger"), poll: false });
  try { await s.ready; assert.ok(s.ingester.roots[0].error); assert.equal(s.data.recent.size, 0); } finally { await s.close(); }
}));

test("ZCode: execution reviews find sessions beyond the bounded checkpoint index, including after restart", () => fixture(async root => {
  const logs = join(root, "db"), directory = join(root, "ledger"); await mkdir(logs);
  const db = database(join(logs, "db.sqlite"));
  const insert = db.prepare("INSERT INTO session VALUES(?,?,?,?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < 5001; i++) {
    const id = `sess_bulk_${i}`;
    insert.run(id, "/work/bulk", null, at - 5000, "interactive"); step(db, `bulk_${i}`, id, at);
  }
  db.exec("COMMIT");
  let store = new TokenStore({ roots: [{ source: "zcode", path: logs }], directory, now: () => NOW, poll: false });
  try {
    await store.ready;
    assert.equal([...store.ingester.files.values()][0]!.state.sessions.length, 5000);
    for (let pass = 0; pass < 2; pass++) {
      const history = new LocalTokenCallSource(store.ingester);
      assert.equal((await history.callsForSessions(["sess_bulk_0"]))?.calls.length, 1);
      assert.equal((await history.callsForSessions(["sess_bulk_5000"]))?.calls.length, 1);
      assert.equal((await history.callsForSessions(["sess_bulk_4999", "sess_bulk_5000"]))?.calls.length, 2);
      assert.equal(await history.callsForSessions(["sess_missing"]), null);
      if (!pass) {
        await store.close(); store = new TokenStore({ roots: [{ source: "zcode", path: logs }], directory, now: () => NOW, poll: false }); await store.ready;
        assert.equal(store.ingester.diagnostics.bytesRead, 0, "a persisted cursor does not need a full import to find an unindexed session");
      }
    }
  } finally { await store.close(); db.close(); }
}));

for (const replacements of [1, 2]) test(`ZCode: rowid reuse with ${replacements === 1 ? "unchanged" : "larger"} max rowid preserves new usage and cached history`, () => fixture(async root => {
  const logs = join(root, "db"), directory = join(root, "ledger"); await mkdir(logs);
  const path = join(logs, "db.sqlite"), db = database(path);
  step(db, "keep", "sess_a", at); step(db, "deleted", "sess_b", at + 1000);
  let store = new TokenStore({ roots: [{ source: "zcode", path: logs }], directory, now: () => NOW, poll: false });
  try {
    await store.ready; await store.close();
    store = new TokenStore({ roots: [{ source: "zcode", path: logs }], directory, now: () => NOW, poll: false }); await store.ready;
    assert.equal(store.ingester.diagnostics.bytesRead, 0, "cursor and anchor survive restart");
    const history = new LocalTokenCallSource(store.ingester);
    assert.equal((await history.callsForSessions(["sess_b"]))?.calls.length, 1);
    db.exec("DELETE FROM part WHERE session_id='sess_b'; DELETE FROM message WHERE id='deleted'");
    for (let i = 0; i < replacements; i++) step(db, `replacement_${i}`, "sess_b", at + 2000 + i * 1000);
    const main = await readFile(path), wal = await readFile(path + "-wal");
    await store.poll(true);
    assert.equal((await snapshot(store)).totals.calls, 2 + replacements, "previous usage remains recorded; replacements are counted once");
    const current = await history.callsForSessions(["sess_b"]);
    assert.equal(current?.calls.length, replacements); assert.ok(current?.calls.every(call => call.at >= at + 2000));
    assert.equal((await history.callsForSessions(["sess_a"]))?.calls.length, 1);
    assert.deepEqual(await readFile(path), main); assert.deepEqual(await readFile(path + "-wal"), wal);
    const bytes = store.ingester.diagnostics.bytesRead;
    await store.poll(true); assert.equal(store.ingester.diagnostics.bytesRead, bytes, "unchanged polls do not rescan");
    step(db, "append", "sess_b", at + 5000); await store.poll(true);
    assert.equal((await snapshot(store)).totals.calls, 3 + replacements);
    assert.equal((await history.callsForSessions(["sess_b"]))?.calls.length, replacements + 1);
  } finally { await store.close(); db.close(); }
}));

test("Kimi/ZCode: standard and custom roots, provider recognition, native persistence", () => {
  const roots = defaultRoots({ home: "/home/me", env: { KIMI_CODE_HOME: "/srv/kimi", ZCODE_HOME: "/srv/zcode" } });
  assert.deepEqual(roots.filter(r => r.source === "kimi").map(r => r.path), ["/srv/kimi/sessions", "/home/me/.kimi-code/sessions"]);
  assert.deepEqual(roots.filter(r => r.source === "zcode").map(r => r.path), ["/srv/zcode/cli/db", "/home/me/.zcode/cli/db"]);
  for (const source of ["kimi", "zcode"] as const) {
    assert.equal(providerSource(source, {}), source);
    assert.equal(providerSource("custom", { extends: "acp", command: [source, "--acp"] }), source);
  }
  assert.equal(tokenSessionId("kimi", { sessionId: "session_test" }), "session_test");
  assert.equal(tokenSessionId("zcode", { sessionId: 'plugin:{"version":1,"data":{"sessionId":"sess_native"}}' }), "sess_native");
});

test("ZCode: ACP UUID maps through bridge metadata, never through a guessed prefix or cwd", () => fixture(async root => {
  await mkdir(join(root, "v2"));
  await writeFile(join(root, "v2", "acp-lazy-sessions.json"), JSON.stringify({ "test-bridge-id": { zcodeSid: "sess_verified", cwd: "/private/path" }, "test-empty-id": { cwd: "/private/path" } }));
  const sessions = new TokenSessions({ home: root, env: { ZCODE_HOME: root }, now: () => NOW });
  const persistence = (sessionId: string) => ({ sessionId: "plugin:" + JSON.stringify({ version: 1, data: { sessionId } }) });
  assert.equal(await sessions.resolve("zcode", persistence("test-bridge-id")), "sess_verified");
  assert.equal(await sessions.resolve("zcode", persistence("test-empty-id")), "test-empty-id");
  assert.equal(await sessions.resolve("zcode", { sessionId: 'plugin:{"version":2}' }), null);
}));

test("Kimi: same-request corrections agree between totals and per-agent history", () => fixture(async root => {
  const logs = join(root, "logs"), path = await kimiFile(logs, "main", [request(at), usage(at + 1000)]);
  const store = new TokenStore({ roots: [{ source: "kimi", path: logs }], directory: join(root, "ledger"), now: () => NOW, poll: false });
  try {
    await store.ready;
    const history = new LocalTokenCallSource(store.ingester);
    assert.equal((await history.callsForSessions(["session_test"]))?.calls[0]?.input, 10);
    const corrected = usage(at + 1000); corrected.usage.inputOther = 7;
    await appendFile(path, jsonl([corrected])); await store.poll(true);
    const result = await snapshot(store);
    assert.equal(result.totals.calls, 1); assert.equal(result.totals.input, 7);
    assert.equal((await history.callsForSessions(["session_test"]))?.calls[0]?.input, 7);
  } finally { await store.close(); }
}));
