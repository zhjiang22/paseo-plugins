import { lstat } from "node:fs/promises";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { initialParser } from "./parser";
import type { CallSink, Candidate, LogFile, ParserState } from "./types";
import { callKey, count, object, validStart } from "./values";

async function databaseDetails(path: string) {
  const details = await lstat(path);
  if (!details.isFile() || details.isSymbolicLink()) return null;
  const wal = await lstat(path + "-wal").catch(error => { if (error.code === "ENOENT") return null; throw error; });
  return wal && (!wal.isFile() || wal.isSymbolicLink()) ? null : { details, wal };
}

/** The bounded checkpoint session list is a hint; SQLite's session primary key remains authoritative. */
export async function zcodeSessionIds(file: LogFile, ids: readonly string[]): Promise<string[]> {
  if (!await databaseDetails(file.path)) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file.path, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000");
    const query = db.prepare("SELECT id FROM session WHERE id=?");
    return ids.filter(id => !!query.get(id));
  } finally { db.close(); }
}

/** Read completed model steps once. message.tokens duplicates step-finish.tokens and is never added again.
 * SQLite's read-only connection sees committed WAL rows; no checkpoint, migration, or provider write is issued.
 * A rowid cursor avoids rescanning tool output. Only allowlisted metadata and counters leave the SQL query.
 */
export async function tailZcode(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void, onReset?: (lost: ParserState) => void): Promise<boolean> {
  const identity = await databaseDetails(file.path);
  if (!identity) return false;
  const { details, wal } = identity;
  const signature = [details.dev, details.ino, details.size, details.mtimeMs, wal?.ino ?? 0, wal?.size ?? 0, wal?.mtimeMs ?? 0].join(":");
  const saved = file.state.zcode;
  if (saved?.signature === signature && (saved.row === 0 || saved.anchor)) return false;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file.path, { readOnly: true });
  try {
    // Keep the anchor and the paged reads in one read-only snapshot while the provider keeps writing its WAL.
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN");
    const last = Number(db.prepare("SELECT coalesce(max(rowid),0) AS last FROM part").get()!.last);
    const anchor = saved?.row ? db.prepare("SELECT id FROM part WHERE rowid=?").get(saved.row) : null;
    // Deleting recent sessions can reuse rowids without lowering max(rowid). One primary-key lookup detects that;
    // ordinary appends stay incremental, and a reset is deduplicated by stable part ids in the ledger.
    if (details.dev !== file.dev || details.ino !== file.ino || last < (saved?.row ?? 0) ||
        (saved?.row && (!saved.anchor || !anchor || callKey(["zcode-row", anchor.id]) !== saved.anchor))) {
      onReset?.(file.state); file.state = initialParser(file.path, null, file.source);
    }
    const cursor = file.state.zcode ?? { row: 0, signature: "" };
    file.state.zcode = cursor;
    const query = db.prepare(`SELECT p.rowid AS cursor, p.id, p.session_id,
      json_extract(p.data,'$.type') AS kind,
      CASE WHEN json_extract(p.data,'$.type')='step-finish' THEN json_extract(p.data,'$.tokens') END AS tokens,
      p.time_created AS at,
      CASE WHEN json_extract(p.data,'$.type')='step-finish' THEN json_extract(m.data,'$.modelId') END AS model,
      CASE WHEN json_extract(p.data,'$.type')='step-finish' THEN json_extract(m.data,'$.time.created') END AS start,
      s.directory AS cwd, s.parent_id AS parent, s.time_created AS sessionCreated, s.task_type AS taskType
      FROM part p LEFT JOIN message m ON p.message_id=m.id LEFT JOIN session s ON p.session_id=s.id
      WHERE p.rowid>? AND p.rowid<=? ORDER BY p.rowid LIMIT 256`);
    while (cursor.row < last) {
      const rows = query.all(cursor.row, last);
      if (!rows.length) { cursor.row = last; break; }
      for (const row of rows) {
        if (row.kind === "step-finish" && typeof row.tokens === "string" && typeof row.session_id === "string") {
          const usage = object(JSON.parse(row.tokens)), at = Number(row.at), sessionId = row.session_id.slice(0, 256);
          if (usage && Number.isFinite(at) && at >= 0 &&
              !(row.parent && typeof row.start === "number" && typeof row.sessionCreated === "number" && row.start < row.sessionCreated)) {
            const cacheRead = count(object(usage.cache).read), cacheWrite = count(object(usage.cache).write);
            const candidate: Candidate = { forked: false, call: {
              key: callKey(["zcode", row.id]), source: "zcode", sessionId, cwd: typeof row.cwd === "string" ? row.cwd.slice(0, 4096) : "",
              at, start: validStart(typeof row.start === "number" ? row.start : null, at), model: typeof row.model === "string" ? row.model.slice(0, 240) : null,
              input: Math.max(0, count(usage.input) - cacheRead - cacheWrite), cacheRead, cacheWrite,
              output: count(usage.output), reasoning: count(usage.reasoning), subagent: row.taskType === "subagent_child" || sessionId.startsWith("sess_subagent_"),
            } };
            if (!file.state.sessions.includes(sessionId) && file.state.sessions.length < 5000) file.state.sessions.push(sessionId);
            sink(candidate, null, file, file.state.open); file.state.open = candidate;
          }
        }
        cursor.row = Number(row.cursor);
        cursor.anchor = callKey(["zcode-row", row.id]);
      }
      onBytes?.(Buffer.byteLength(JSON.stringify(rows))); await yieldLoop();
    }
    cursor.signature = signature;
    file.dev = details.dev; file.ino = details.ino; file.size = details.size; file.mtime = Math.max(details.mtimeMs, wal?.mtimeMs ?? 0);
    file.offset = details.size; file.partialBytes = 0;
    return true;
  } finally { db.close(); }
}
