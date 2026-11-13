// Places in an agent's timeline that survive renumbering: a turn start (a user message, a message from another agent,
// a schedule prompt) identified by a fingerprint of its words, Ferry's envelopes taken off. The same turn has the same
// fingerprint whether it was read live or replayed from the provider's own history after a restart.

import { createHash } from "node:crypto";
import { stripEnvelopes } from "../shared/envelope";
import type { Anchor } from "../shared/model";
import { isTurnStart, turnStartText } from "../shared/turn-start";
import type { Row } from "./timeline-reader";

export interface TurnStart {
  /** Index of the row in the rows read. */
  index: number;
  fp: string;
  at: string | null;
}

export function fingerprint(kind: string, text: string): string {
  const words = text.replace(/\s+/g, " ").trim().slice(0, 4000);
  return createHash("sha256").update(`${kind}\n${words}`).digest("hex").slice(0, 16);
}

/** The turn starts among `rows`, in order. A message that was only a Ferry envelope starts nothing. */
export function turnStarts(rows: readonly Row[]): TurnStart[] {
  const starts: TurnStart[] = [];
  rows.forEach((row, index) => {
    if (!isTurnStart(row.item)) return;
    let kind: string = row.item.type;
    let text = turnStartText(row.item);
    if (row.item.type === "user_message") {
      text = stripEnvelopes(text).typed;
      if (!text) return;
      kind = "user";
    } else kind = row.item.agentMessage ? "agent" : "schedule";
    starts.push({ index, fp: fingerprint(kind, text), at: row.timestamp });
  });
  return starts;
}

/** An anchor at turn start `position` (an index into `starts`). */
export function anchorAt(starts: readonly TurnStart[], position: number): Anchor | null {
  const start = starts[position];
  if (!start) return null;
  return { turn: position, fp: start.fp, prevFp: starts[position - 1]?.fp ?? null, turns: starts.length, at: start.at };
}

/** An anchor at the last turn start, the end of a visit. */
export function endAnchor(starts: readonly TurnStart[]): Anchor | null {
  return anchorAt(starts, starts.length - 1);
}

/**
 * Where `anchor` is among `starts` now: the turn with its fingerprint; among several, one whose previous turn matches
 * too, and of those the latest. Reads cover different stretches of a timeline, so positions are not compared. Null
 * when no turn matches.
 */
export function relocate(starts: readonly TurnStart[], anchor: Anchor): number | null {
  let best: number | null = null;
  let bestPaired = false;
  starts.forEach((start, position) => {
    if (start.fp !== anchor.fp) return;
    // The first start read has no known predecessor: it may well be the paired one.
    const paired = anchor.prevFp === null || position === 0 || starts[position - 1]?.fp === anchor.prevFp;
    if (paired || !bestPaired) {
      best = position;
      bestPaired = paired;
    }
  });
  return best;
}

/** The row index where the turn after `position` starts, or `rows.length` when it was the last turn. */
export function afterTurn(starts: readonly TurnStart[], position: number, rowCount: number): number {
  return starts[position + 1]?.index ?? rowCount;
}
