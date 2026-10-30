import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { TokenIngester } from "../server/tokens/ingester";
import { LocalTokenCallSource } from "../server/tokens/source";

const NOW = Date.parse("2026-10-11T12:00:00Z");
type DatabaseSource = "opencode" | "mimo" | "hermes";
const filenames = { opencode: "opencode.db", mimo: "mimocode.db", hermes: "state.db" };

async function fixture(kind: DatabaseSource, run: (db: DatabaseSync, path: string, ingester: TokenIngester, source: LocalTokenCallSource,
  insert: (session: string, id: string, output: number) => void, update: (session: string, id: string, output: number) => void) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "tokens-database-source-")), path = join(root, filenames[kind]);
  const db = new DatabaseSync(path), ingester = new TokenIngester({ roots: [{ source: kind, path: root }], now: () => NOW, onCall: () => {} });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  if (kind === "hermes") {
    db.exec("CREATE TABLE sessions (id text PRIMARY KEY, parent_session_id text, cwd text, ended_at real)");
    db.exec("CREATE TABLE session_model_usage (session_id text, model text, api_call_count integer, input_tokens integer, output_tokens integer, cache_read_tokens integer, cache_write_tokens integer, reasoning_tokens integer)");
    db.exec("CREATE INDEX usage_session ON session_model_usage(session_id)");
  } else {
    db.exec("CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text)");
    db.exec("CREATE TABLE message (id text PRIMARY KEY, session_id text, data text)");
    db.exec("CREATE INDEX message_session ON message(session_id)");
  }
  const message = (output: number) => JSON.stringify({ role: "assistant", modelID: "test-model", path: { cwd: "/repo" },
    time: { created: NOW - 2000, completed: NOW - 1000 }, tokens: { input: 100, output, reasoning: 0, cache: { read: 0, write: 0 } }, text: "PRIVATE_OUTPUT" });
  const insert = (session: string, id: string, output: number) => {
    if (kind === "hermes") {
      db.prepare("INSERT OR IGNORE INTO sessions VALUES (?, NULL, '/repo', ?)").run(session, (NOW - 1000) / 1000);
      db.prepare("INSERT INTO session_model_usage VALUES (?, ?, 1, 100, ?, 0, 0, 0)").run(session, id, output);
    } else {
      db.prepare("INSERT OR IGNORE INTO session VALUES (?, NULL, '/repo')").run(session);
      db.prepare("INSERT INTO message VALUES (?, ?, ?)").run(id, session, message(output));
    }
  };
  const update = (session: string, id: string, output: number) => {
    if (kind === "hermes") db.prepare("UPDATE session_model_usage SET output_tokens=? WHERE session_id=? AND model=?").run(output, session, id);
    else db.prepare("UPDATE message SET data=? WHERE session_id=? AND id=?").run(message(output), session, id);
  };
  try { await run(db, path, ingester, new LocalTokenCallSource(ingester), insert, update); }
  finally { await ingester.close(); db.close(); await rm(root, { recursive: true, force: true }); }
}

for (const kind of ["opencode", "mimo", "hermes"] as const) {
  test(`${kind}: recap reads reject symlinked and non-file WAL paths`, async () => {
    const root = await mkdtemp(join(tmpdir(), "tokens-database-wal-")), path = join(root, filenames[kind]);
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE placeholder (id integer)"); db.close();
    const ingester = new TokenIngester({ roots: [{ source: kind, path: root }], now: () => NOW, onCall: () => {} });
    try {
      await ingester.scan();
      const source = new LocalTokenCallSource(ingester);
      await writeFile(join(root, "unrelated"), "PRIVATE_CONTENT");
      await symlink(join(root, "unrelated"), path + "-wal");
      assert.equal(await source.callsForSessions(["session"]), null);
      assert.equal(source.diagnostics.bytesRead, 0);
      assert.equal(ingester.roots[0]!.error, "READ_ERROR", "the source rejects the path before SQLite opens it");
      await rm(path + "-wal"); await mkdir(path + "-wal");
      assert.equal(await source.callsForSessions(["session"]), null);
      assert.equal(source.diagnostics.bytesRead, 0);
      assert.equal(ingester.roots[0]!.error, "READ_ERROR");
    } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
  });

  test(`${kind}: recap caches stay scoped on repeat, WAL-only edits and read errors`, () => fixture(kind, async (db, path, ingester, source, insert, update) => {
    insert("alpha", "a", 10); insert("beta", "b", 900);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await ingester.backfillAll();
    const alpha = await source.callsForSessions(["alpha"]);
    assert.equal(alpha?.source, kind);
    assert.deepEqual(alpha?.calls.map(call => call.output), [10]);
    const bytes = source.diagnostics.bytesRead;
    assert.deepEqual(await source.callsForSessions(["alpha"]), alpha);
    assert.equal(source.diagnostics.bytesRead, bytes, "unchanged session snapshot comes from the cache");
    assert.deepEqual((await source.callsForSessions(["beta"]))?.calls.map(call => call.output), [900]);
    assert.deepEqual((await source.callsForSessions(["alpha", "beta"]))?.calls.map(call => call.output).sort((a, b) => a - b), [10, 900]);
    assert.deepEqual((await source.callsForSessions(["alpha"]))?.calls.map(call => call.output), [10], "another request never broadens a cached session");

    const before = await stat(path, { bigint: true });
    update("alpha", "a", 17);
    const after = await stat(path, { bigint: true });
    assert.deepEqual([after.size, after.mtimeNs, after.ctimeNs], [before.size, before.mtimeNs, before.ctimeNs], "only the WAL changed");
    const changed = await source.callsForSessions(["alpha"]);
    assert.deepEqual(changed?.calls.map(call => call.output), [17]);
    assert.notEqual(changed?.version, alpha?.version, "a counter edit changes the recap version even with the same call count");
    assert.ok(!JSON.stringify(changed).includes("PRIVATE_OUTPUT"));

    // A transient schema/read error can retain the last counters, but only for the requested session set.
    db.exec(`ALTER TABLE ${kind === "hermes" ? "session_model_usage" : "message"} RENAME TO temporarily_unavailable`);
    assert.deepEqual((await source.callsForSessions(["alpha"]))?.calls.map(call => call.output), [17]);
    assert.deepEqual((await source.callsForSessions(["beta"]))?.calls.map(call => call.output), [900]);
    assert.equal(await source.callsForSessions(["unknown"]), null);
  }));

  test(`${kind}: recaps find sessions outside the bounded index and read only their paginated rows`, () => fixture(kind, async (db, _path, ingester, source, insert) => {
    db.exec("BEGIN");
    for (let index = 0; index < 600; index++) insert(`other-${index}`, `other-call-${index}`, 999);
    for (let index = 0; index < 530; index++) insert("old-target", `target-${String(index).padStart(3, "0")}`, 1);
    insert("last-other", "last-other-call", 999);
    db.exec("COMMIT");
    await ingester.backfillAll();
    assert.ok([...ingester.files.values()].every(file => !file.state.sessions.includes("old-target")), "the old session is not in the persisted bounded lookup");
    const history = await source.callsForSessions(["old-target"]);
    assert.equal(history?.source, kind);
    assert.equal(history?.calls.length, 530, "target session history spans multiple 512-row batches");
    assert.ok(history?.calls.every(call => call.output === 1));
    const expectedBytes = kind === "hermes" ? 530 * 512 : Number((db.prepare("SELECT sum(length(data)) AS bytes FROM message WHERE session_id='old-target'").get() as { bytes: number }).bytes);
    assert.equal(source.diagnostics.bytesRead, expectedBytes, "unrelated database rows are not parsed or cached for this recap");
  }));
}
