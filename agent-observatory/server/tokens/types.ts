import type { TokenSource } from "../../shared/tokens";
import type { TokenCall } from "../token-source";

export const HOUR = 3_600_000, DAY = 24 * HOUR;
export const hourOf = (at: number): number => Math.floor(at / HOUR) * HOUR;
export const dayOf = (at: number): number => Math.floor(at / DAY) * DAY;
export const iso = (at: number): string => new Date(at).toISOString();
export const dayText = (at: number): string => iso(at).slice(0, 10);

/** Only this allowlist survives parsing. No provider message bodies are retained. */
export interface LedgerCall extends TokenCall {
  key: string; source: TokenSource; sessionId: string; cwd: string;
}
export interface Candidate { call: LedgerCall; forked: boolean; accepted?: boolean }
export interface ParserState {
  sessionId: string; cwd: string; model: string | null; inputAt: number | null;
  lastTotal: string | null; open: Candidate | null; openInputAt: number | null;
  sessions: string[]; links: string[]; hasForks: boolean;
  metaSeen: boolean; pendingRecord: boolean; legacySessionId: string;
  /**
   * Codex: the rollout's own thread (first `session_meta`) and, for a subagent rollout (`source.subagent`), the thread
   * that spawned it; null when it is not a subagent. Undefined in states saved before 2.13 (see TokenIngester.probeThreads).
   */
  threadId?: string; parentThread?: string | null;
  /** dsh: the local+UTC day stamp this ledger state last parsed (`dshDayStamp`); a calendar change forces the rollover re-read. */
  day?: string;
  /** ZCode SQLite part cursor and database/WAL identity; no message content. */
  zcode?: { row: number; signature: string; anchor?: string };
}
export interface LogRoot {
  source: TokenSource; path: string;
  /**
   * The one custom Paseo provider whose own config directory this is (gemini-B9, from the daemon's provider config):
   * its sessions that match no Paseo agent still count for that provider. Absent for shared and standard roots.
   */
  provider?: string;
}
export interface LogFile {
  path: string; root: number; source: TokenSource; parentSession: string | null;
  dev: number; ino: number; size: number; mtime: number; offset: number;
  /** Bytes after the last newline are re-read next time, never saved as content. */
  partialBytes: number; state: ParserState;
  imported: boolean;
}
export interface Backfill { done: boolean; files: number; filesDone: number; bytes: number; bytesDone: number }
export type CallSink = (candidate: Candidate, previous: Candidate | null, file: LogFile, settled?: Candidate | null) => void;
export const safeError = (error: unknown): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "READ_ERROR";
};
