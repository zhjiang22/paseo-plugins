// Reading an agent's projected timeline (one row per message or tool call), newest pages first, only as far back as
// needed. The timeline lives in the daemon's memory, numbered per "epoch": a restart, an archived agent loaded again,
// a reload or a rewind renumbers it, so nothing here keeps a row number beyond one read.

import type { RawItem, RawRow } from "../shared/normalize";

export interface Row extends RawRow {
  item: RawItem;
  timestamp: string | null;
  seq: number;
}

export interface TimelinePage {
  epoch?: unknown;
  reset?: unknown;
  staleCursor?: unknown;
  hasOlder?: unknown;
  startCursor?: unknown;
  entries?: unknown;
  window?: unknown;
}

/** The part of the plugin's `paseo` API this reads. */
export interface TimelinePaseo {
  agents: {
    ref(id: string): {
      timeline: {
        refetch(options: {
          direction: "tail" | "before" | "after";
          cursor?: { epoch: string; seq: number };
          limit: number;
          projection: "projected";
        }): Promise<unknown>;
      };
    };
  };
}

export interface ReadOptions {
  /** Stop reading older pages once this holds for the rows read so far (oldest first). */
  enough?: (rows: readonly Row[]) => boolean;
  pageSize?: number;
  maxRows?: number;
  timeoutMs?: number;
  /** When the read stops before the beginning, also fetch this many of the first rows (the original request). */
  headRows?: number;
}

export interface ReadResult {
  rows: Row[];
  /** The rows reach the beginning of the conversation. */
  complete: boolean;
  /** The first rows of the conversation, when `rows` does not reach back to them. */
  head: Row[];
  epoch: string | null;
  /** Sequence number of the newest row (with the epoch: a cache key for this read). */
  lastSeq: number | null;
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function toRows(entries: unknown): Row[] {
  if (!Array.isArray(entries)) return [];
  const rows: Row[] = [];
  for (const raw of entries) {
    const entry = record(raw);
    const item = record(entry.item);
    if (typeof item.type !== "string") continue;
    rows.push({
      item: item as unknown as RawItem,
      timestamp: typeof entry.timestamp === "string" ? entry.timestamp : null,
      seq: typeof entry.seqStart === "number" ? entry.seqStart : typeof entry.seq === "number" ? entry.seq : Number.NaN,
    });
  }
  return rows;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeline read timed out")), Math.max(1, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * The agent's rows, oldest first, read from the end until `enough`, the beginning, `maxRows` or the deadline. A page
 * that comes from a renumbered timeline makes the read start over once; a second renumbering keeps what was read.
 * Errors propagate: the caller decides what an unreadable agent means.
 */
export async function readRows(paseo: TimelinePaseo, agentId: string, options: ReadOptions = {}): Promise<ReadResult> {
  const pageSize = Math.max(1, options.pageSize ?? 200);
  const maxRows = Math.max(1, options.maxRows ?? 6000);
  const deadline = Date.now() + (options.timeoutMs ?? 45_000);
  const timeline = paseo.agents.ref(agentId).timeline;
  for (let attempt = 0; attempt < 2; attempt++) {
    let rows: Row[] = [];
    let epoch: string | null = null;
    let lastSeq: number | null = null;
    let cursor: { epoch: string; seq: number } | null = null;
    let restarted = false;
    let complete = false;
    while (rows.length < maxRows) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const limit = Math.min(pageSize, maxRows - rows.length);
      const request = cursor
        ? { direction: "before" as const, cursor, limit, projection: "projected" as const }
        : { direction: "tail" as const, limit, projection: "projected" as const };
      const page = record(await within(timeline.refetch(request), Math.min(15_000, left))) as TimelinePage;
      const pageEpoch = typeof page.epoch === "string" ? page.epoch : "";
      if (epoch !== null && (pageEpoch !== epoch || page.reset === true || page.staleCursor === true)) {
        restarted = true;
        break;
      }
      epoch = pageEpoch;
      const pageRows = toRows(page.entries);
      if (lastSeq === null && pageRows.length) lastSeq = pageRows[pageRows.length - 1]!.seq;
      const first = rows.length ? rows[0]!.seq : Number.POSITIVE_INFINITY;
      rows = [...pageRows.filter((row) => !(row.seq >= first)), ...rows];
      if (page.hasOlder !== true) {
        complete = true;
        break;
      }
      if (options.enough?.(rows)) break;
      const start = record(page.startCursor);
      if (!pageRows.length || typeof start.seq !== "number") break;
      cursor = { epoch: typeof start.epoch === "string" && start.epoch ? start.epoch : pageEpoch, seq: start.seq };
    }
    if (restarted && attempt === 0) continue;
    let head: Row[] = [];
    if (!complete && (options.headRows ?? 0) > 0 && epoch) {
      head = await readHead(timeline, epoch, options.headRows!, rows[0]?.seq ?? Number.POSITIVE_INFINITY, deadline).catch(() => []);
    }
    return { rows, complete, head, epoch, lastSeq };
  }
  return { rows: [], complete: false, head: [], epoch: null, lastSeq: null };
}

async function readHead(timeline: ReturnType<TimelinePaseo["agents"]["ref"]>["timeline"], epoch: string, count: number, before: number, deadline: number): Promise<Row[]> {
  const page = record(await within(timeline.refetch({ direction: "after", cursor: { epoch, seq: 0 }, limit: count, projection: "projected" }), Math.min(10_000, deadline - Date.now())));
  if (typeof page.epoch === "string" && page.epoch !== epoch) return [];
  return toRows(page.entries).filter((row) => row.seq < before);
}
