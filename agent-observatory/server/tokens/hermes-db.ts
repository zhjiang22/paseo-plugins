import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import type { CallSink, LedgerCall, LogFile } from "./types";
import { callKey } from "./parser";

/** Hermes keeps its session bookkeeping in one SQLite database under its home. */
export const HERMES_DB_FILE = "state.db";
/** Aggregated rows per read: `node:sqlite` is synchronous, so one poll never holds the event loop for a whole import. */
const HERMES_BATCH = 512;
/** A session's usage row is written while the session runs and finalised when it ends (`ended_at` set); its values are
 * final afterwards. The watermark is the newest end time already counted; a session that ends late — after newer ones
 * were counted — can fall behind it and is missed (the same trade the windowed sources make). */
const HERMES_LOOKBACK = 86_400;

export const isHermesDb = (file: LogFile): boolean => file.source === "hermes" && basename(file.path) === HERMES_DB_FILE;

/**
 * Reads Hermes's per-session per-model aggregates for sessions that have ended. Hermes's usage rows also distinguish
 * billing provider, base URL, billing mode and task; sum those rows before emitting one aggregate per session/model.
 * The ledger stores the aggregate rather
 * than per-request rows. A still-open session has no end time and waits; once it ends the row's values are final and
 * the seen index keeps the re-reads from counting it twice. Rows without a session end time wait.
 * `file.offset` carries the watermark: the newest end time (seconds) already counted. Optional session IDs restrict
 * the query for a digest without reading other sessions into memory.
 * Returns whether the checkpoint or file metadata changed. The sink reports newly accepted usage independently;
 * a look-back poll that only re-emits known aggregates must not dirty the ledger.
 */
export async function readHermesStateDb(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void, sessionIds?: readonly string[]): Promise<boolean> {
  if (sessionIds?.length === 0) return false;
  const initialOffset = file.offset, initialSize = file.size, initialMtime = file.mtime;
  // The database's own times keep it in the hot poll; a vanished file throws and the root shows it.
  const details = await stat(file.path);
  file.size = details.size; file.mtime = details.mtimeMs;
  const db = new DatabaseSync(file.path, { readOnly: true });
  try {
    const read = db.prepare(
      "SELECT m.session_id AS sessionId, m.model AS model, SUM(m.api_call_count) AS calls, SUM(m.input_tokens) AS input, SUM(m.output_tokens) AS output, " +
      "SUM(m.cache_read_tokens) AS cacheRead, SUM(m.cache_write_tokens) AS cacheWrite, SUM(m.reasoning_tokens) AS reasoning, " +
      "s.ended_at AS endedAt, s.parent_session_id AS parent, s.cwd AS cwd FROM session_model_usage m " +
      "JOIN sessions s ON s.id = m.session_id WHERE s.ended_at IS NOT NULL AND " +
      "(s.ended_at > ? OR (s.ended_at = ? AND (m.session_id > ? OR (m.session_id = ? AND m.model > ?)))) " +
      (sessionIds ? `AND m.session_id IN (${sessionIds.map(() => "?").join(",")}) ` : "") +
      "GROUP BY m.session_id, m.model ORDER BY s.ended_at, m.session_id, m.model LIMIT " + HERMES_BATCH,
    );
    // The watermark is the newest end time (seconds) already counted; a look-back window still re-reads sessions that
    // ended just before it, whose usage rows the extension finalises afterwards. Seen keys drop the re-emissions.
    // The in-read cursor includes the grouping key: multiple models of a session share ended_at and can straddle
    // a page boundary. Only the time watermark is persisted, so existing checkpoints remain readable.
    let cursor = Math.max(0, file.offset - HERMES_LOOKBACK), cursorSession = "", cursorModel = "", watermark = file.offset;
    for (;;) {
      const batch = read.all(cursor, cursor, cursorSession, cursorSession, cursorModel, ...(sessionIds ?? [])) as Array<Record<string, unknown>>;
      for (const row of batch) {
        cursor = Math.max(cursor, Number(row.endedAt ?? 0));
        cursorSession = String(row.sessionId ?? ""); cursorModel = String(row.model ?? "");
        watermark = Math.max(watermark, cursor);
        const sessionId = String(row.sessionId ?? "").slice(0, 256);
        if (!sessionId) continue;
        const atSeconds = Number(row.endedAt ?? 0);
        const at = Number.isFinite(atSeconds) && atSeconds > 0 ? Math.round(atSeconds * 1000) : null;
        if (at === null) continue;
        const input = Number(row.input ?? 0) || 0, cacheRead = Number(row.cacheRead ?? 0) || 0, cacheWrite = Number(row.cacheWrite ?? 0) || 0;
        const output = Number(row.output ?? 0) || 0, reasoning = Number(row.reasoning ?? 0) || 0;
        if (!input && !cacheRead && !cacheWrite && !output) continue;
        const model = String(row.model ?? "").slice(0, 240) || null;
        const calls = Math.max(1, Number(row.calls ?? 1) || 1);
        const call: LedgerCall = { key: callKey(["hermes", sessionId, model ?? ""]), source: "hermes", sessionId,
          cwd: String(row.cwd ?? "").slice(0, 4096), model, at, start: null, input, cacheWrite, cacheRead, output,
          reasoning, subagent: row.parent != null, calls };
        sink({ call, forked: false }, null, file, null);
        onBytes?.(512);
      }
      if (batch.length < HERMES_BATCH) break;
      await yieldLoop();
    }
    file.offset = watermark;
    return file.offset !== initialOffset || file.size !== initialSize || file.mtime !== initialMtime;
  } finally { db.close(); }
}
