/**
 * The conversation as it stood when a turn ended (`agent.turn_ended`).
 *
 * Paseo 0.12 and older put the whole conversation in the hook's `timeline`; from 0.13 it is always `[]`
 * (getpaseo/paseo#7477) and plugins read what they need. `turnTimeline` keeps the hook's items when there are any.
 * Otherwise it reads the agent's projected timeline from the end backwards, `pageSize` rows a page, until
 * `enough(items)` holds (by default: the window reaches back to the start of the latest turn, see `isTurnStart`), the
 * start of the conversation, `maxRows`, or the deadline. It never throws: a failed or slow read keeps the newer pages
 * that came in before it. At turn end the agent is loaded, so reading it loads nothing.
 */

import { hasTurnStart } from "../shared/turn-start";

export { hasTurnStart, isTurnStart, latestTurnStart, turnStartText, type TurnStartItem } from "../shared/turn-start";

/** The part of the plugin's `paseo` API this reads. */
export interface TurnTimelinePaseo {
  agents: {
    ref(id: string): {
      timeline: {
        refetch(options: { direction: "tail" | "before"; cursor?: { epoch: string; seq: number }; limit: number; projection: "projected" }): Promise<unknown>;
      };
    };
  };
}

export interface TurnTimeline<Item> {
  /** Oldest first. */
  items: Item[];
  /** Each item's place in the conversation: its row's first sequence number when read (the same on every read), else its index. */
  positions: number[];
  /** The items go back to the start of the conversation (always so for the hook's own items). */
  complete: boolean;
  source: "hook" | "read";
}

export interface TurnTimelineOptions<Item> {
  /** Stop reading older pages once this holds. Default: a row that starts a turn is among the items (`hasTurnStart`). */
  enough?: (items: readonly Item[]) => boolean;
  /** Rows per page (default 100). */
  pageSize?: number;
  /** At most this many rows in all (default 600). */
  maxRows?: number;
  /** The whole read gives up after this long (default 10 s); each page after at most 5 s. */
  timeoutMs?: number;
}

const PAGE_ROWS = 100;
const MAX_ROWS = 600;
const READ_MS = 10_000;
const PAGE_MS = 5_000;

export function hasUserMessage(items: readonly { type: string }[]): boolean {
  return items.some((item) => item.type === "user_message");
}

export async function turnTimeline<Item extends { type: string }>(
  paseo: TurnTimelinePaseo | null | undefined,
  agentId: string,
  hookItems: readonly Item[],
  options: TurnTimelineOptions<Item> = {},
): Promise<TurnTimeline<Item>> {
  if (hookItems.length) return { items: [...hookItems], positions: hookItems.map((_, index) => index), complete: true, source: "hook" };
  const enough = options.enough ?? hasTurnStart;
  const maxRows = Math.max(1, options.maxRows ?? MAX_ROWS);
  const pageSize = Math.max(1, Math.min(options.pageSize ?? PAGE_ROWS, maxRows));
  const deadline = Date.now() + (options.timeoutMs ?? READ_MS);
  let items: Item[] = [];
  let positions: number[] = [];
  if (!paseo) return { items, positions, complete: false, source: "read" };
  let cursor: { epoch: string; seq: number } | null = null;
  let epoch: string | null = null;
  let rows = 0;
  try {
    while (rows < maxRows) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const limit = Math.min(pageSize, maxRows - rows);
      const request = cursor === null
        ? { direction: "tail" as const, limit, projection: "projected" as const }
        : { direction: "before" as const, cursor, limit, projection: "projected" as const };
      const page = record(await within(paseo.agents.ref(agentId).timeline.refetch(request), Math.min(PAGE_MS, left)));
      const pageEpoch = typeof page.epoch === "string" ? page.epoch : "";
      // A rebuilt timeline (new epoch, reset, stale cursor) is another history: keep only the newer pages read so far.
      if (epoch !== null && (pageEpoch !== epoch || page.reset === true || page.staleCursor === true)) break;
      epoch = pageEpoch;
      const entries = Array.isArray(page.entries) ? page.entries : [];
      // Pages never overlap, but a repeated row must not be counted twice.
      const first = positions.length ? positions[0]! : Number.POSITIVE_INFINITY;
      const older: Item[] = [];
      const olderPositions: number[] = [];
      for (const raw of entries) {
        const entry = record(raw);
        const item = record(entry.item);
        if (typeof item.type !== "string") continue;
        const position = typeof entry.seqStart === "number" ? entry.seqStart : typeof entry.seq === "number" ? entry.seq : Number.NaN;
        if (Number.isFinite(position) && position >= first) continue;
        older.push(item as Item);
        olderPositions.push(position);
      }
      rows += entries.length;
      items = [...older, ...items];
      positions = [...olderPositions, ...positions];
      if (page.hasOlder !== true) return { items, positions: settle(positions), complete: true, source: "read" };
      const start = record(page.startCursor);
      if (enough(items) || !entries.length || typeof start.seq !== "number") break;
      cursor = { epoch: typeof start.epoch === "string" && start.epoch ? start.epoch : pageEpoch, seq: start.seq };
    }
  } catch {
    // Keep what came in.
  }
  return { items, positions: settle(positions), complete: false, source: "read" };
}

/** Rows without a sequence number take their index, so every position is a number. */
function settle(positions: number[]): number[] {
  return positions.map((position, index) => (Number.isFinite(position) ? position : index));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeline read timed out")), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error: unknown) => { clearTimeout(timer); reject(error); },
    );
  });
}
