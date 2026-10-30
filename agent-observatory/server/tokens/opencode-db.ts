import { DatabaseSync } from "node:sqlite";
import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { parseOpendencodeMessage } from "./parser";
import type { CallSink, LogFile } from "./types";

/** OpenCode ≥ 1.2 keeps every session, message and part in one database next to the legacy `storage/` tree. */
export const OPENCODE_DB_FILE = "opencode.db";
/** MiMoCode reuses OpenCode's database layout under its own XDG data directory. */
export const MIMO_DB_FILE = "mimocode.db";
/**
 * Rows newer than the watermark minus this many are read again on every poll: a message's row appears when the message
 * starts and gains its tokens and completed time only when it ends, so the window is what catches a message completed
 * after the watermark first passed it. A message that completes later still — this many newer rows ahead of it, several
 * agents writing at once — is not counted; the window is the declared bound, not a promise.
 */
export const OPENCODE_DB_WINDOW = 512;
/** Rows per batch: `node:sqlite` is synchronous, so one poll never holds the event loop for a whole import. */
const OPENCODE_DB_BATCH = 512;

export const isOpendencodeDb = (file: LogFile): boolean => file.source === "opencode" && basename(file.path) === OPENCODE_DB_FILE;
export const isMimoDb = (file: LogFile): boolean => file.source === "mimo" && basename(file.path) === MIMO_DB_FILE;

/**
 * Reads the assistant messages a database holds past the watermark, earliest first, and moves the watermark along.
 * Returns whether the watermark moved (a poll over an unchanged database must not dirty the ledger). A database
 * replaced whole (a reinstall) has a smaller top rowid than the watermark: it is read from its first row again, and
 * the message ids deduplicate what both versions counted. Opens read-only: the database is OpenCode's, never written;
 * a failed open or a vanished file throws (the root shows it). Orphan rows whose session is gone count as top-level.
 */
export async function readOpendencodeDb(file: LogFile, sink: CallSink, onBytes?: (bytes: number) => void, sessionIds?: readonly string[]): Promise<boolean> {
  if (sessionIds && !sessionIds.length) return false;
  // The database's own times keep it in the hot poll; a vanished file throws and the root shows it.
  const details = await stat(file.path);
  file.size = details.size; file.mtime = details.mtimeMs;
  const start = file.offset;
  const db = new DatabaseSync(file.path, { readOnly: true });
  try {
    // On-demand recaps read only their sessions, never every message in this shared database.
    const filter = sessionIds ? ` AND m.session_id IN (${sessionIds.map(() => "?").join(",")})` : "";
    const top = (db.prepare("SELECT max(m.rowid) AS top FROM message m WHERE 1=1" + filter).get(...(sessionIds ?? [])) as { top: number | null }).top ?? 0;
    if (top < file.offset) file.offset = 0;
    const read = db.prepare(
      "SELECT m.rowid AS rowid, m.id AS id, m.session_id AS sessionId, m.data AS data, s.parent_id AS parent FROM message m LEFT JOIN session s ON s.id = m.session_id WHERE m.rowid > ?" + filter + " ORDER BY m.rowid LIMIT " + OPENCODE_DB_BATCH,
    );
    let cursor = Math.max(0, file.offset - OPENCODE_DB_WINDOW);
    for (;;) {
      const batch = read.all(cursor, ...(sessionIds ?? [])) as Array<Record<string, unknown>>;
      for (const row of batch) {
        cursor = Math.max(cursor, Number(row.rowid));
        let message: unknown;
        try { message = JSON.parse(String(row.data)); } catch { continue; }
        if (!message || typeof message !== "object" || Array.isArray(message)) continue;
        const fields = message as Record<string, unknown>;
        if (typeof fields.role === "string" && fields.role !== "assistant") continue;
        // The row's session id is the column; legacy data carried it in the JSON, migrated rows do not. Same for the id.
        if (typeof fields.id !== "string") fields.id = String(row.id ?? "");
        if (typeof fields.sessionID !== "string") fields.sessionID = String(row.sessionId ?? "");
        parseOpendencodeMessage(fields, file, sink, row.parent != null);
        onBytes?.(String(row.data).length);
      }
      file.offset = cursor; // each batch is durable on its own; a crash resumes from the watermark
      if (batch.length < OPENCODE_DB_BATCH) break;
      await yieldLoop();
    }
    return file.offset !== start;
  } finally { db.close(); }
}
