// A chain's history: each visit's stretch of its agent's timeline, read once when the visit closes, normalized,
// numbered and kept (transcripts/<chain>/<visit>.jsonl). Later handoffs and the history tool read these snapshots,
// never the old agents again: loading a closed agent would start its provider.
//
// Where a visit's stretch begins in its agent's timeline:
// - origin: at the beginning;
// - handoff and delta: at the message Ferry sent (its client message id live, the envelope id after a replay);
// - native and manual: after the turn the previous stretch ended with (an anchor by content).
// When that place cannot be found, the stretch starts after the latest turn the chain already knows (by fingerprint),
// and the visit says so.

import { randomUUID } from "node:crypto";
import { stripEnvelopes } from "../shared/envelope";
import type { Chain, Item, NumberedItem, Visit } from "../shared/model";
import { normalizeRows } from "../shared/normalize";
import { TOOL_NAME } from "../shared/plugin-id";
import { afterTurn, endAnchor, relocate, turnStarts, type TurnStart } from "./anchors";
import type { ChainStore } from "./chain-store";
import { readRows, type ReadResult, type Row, type TimelinePaseo } from "./timeline-reader";
import type { AgentLike, Note } from "./types";

const MAX_FPS = 400;
const HEAD_ROWS = 40;

export interface HistoryDeps {
  paseo: TimelinePaseo;
  store: ChainStore;
  now(): Date;
  /** Row limits for a read (tests use small ones). */
  maxRows?: number;
}

/** Visits that saw the same provider session natively share a lineage; every other agent is its own. */
export function lineageOf(visit: Pick<Visit, "storeKey" | "sessionId" | "agentId">): string {
  return visit.storeKey && visit.sessionId ? `${visit.storeKey}|${visit.sessionId}` : `agent:${visit.agentId}`;
}

export function newChain(source: Pick<AgentLike, "workspaceId" | "cwd" | "title">, now: Date): Chain {
  const at = now.toISOString();
  return { v: 1, id: randomUUID(), workspaceId: source.workspaceId ?? null, cwd: source.cwd, title: source.title ?? null, createdAt: at, updatedAt: at, visits: [], deliveries: [] };
}

export type VisitFields = Omit<Visit, "n" | "closedAt" | "end" | "firstItem" | "itemCount">;

export function addVisit(chain: Chain, fields: VisitFields): Visit {
  const visit: Visit = { ...fields, n: chain.visits.reduce((max, entry) => Math.max(max, entry.n), 0) + 1, closedAt: null, end: null, firstItem: null, itemCount: 0 };
  chain.visits.push(visit);
  return visit;
}

/** The number the next closed item gets. */
function nextItemNumber(chain: Chain): number {
  let next = 1;
  for (const visit of chain.visits) if (visit.firstItem !== null && visit.itemCount > 0) next = Math.max(next, visit.firstItem + visit.itemCount);
  return next;
}

/** Fingerprints of every turn the chain already holds, except `except`'s. */
function knownFingerprints(chain: Chain, except?: Visit): Set<string> {
  const known = new Set<string>();
  for (const visit of chain.visits) if (visit !== except) for (const fp of visit.turnFps ?? []) known.add(fp);
  return known;
}

/** The row Ferry's message for `visit` became: by client message id while live, by envelope id after a replay. */
function deliveryRow(rows: readonly Row[], chain: Chain, visit: Visit): number {
  const delivery = chain.deliveries.find((entry) => entry.id === visit.deliveryId);
  if (!delivery) return -1;
  const ids = new Set(delivery.attempts.map((attempt) => attempt.messageId));
  for (let index = rows.length - 1; index >= 0; index--) {
    const item = rows[index]!.item;
    if (item.type !== "user_message") continue;
    const clientId = typeof item.clientMessageId === "string" ? item.clientMessageId : typeof item.messageId === "string" ? item.messageId : "";
    if (ids.has(clientId)) return index;
    if (typeof item.text === "string" && stripEnvelopes(item.text).envelopeId === delivery.id) {
      // Some providers replay the attachment as a message of its own, right before the user's words.
      return index;
    }
  }
  return -1;
}

/** Whether `rows` reach back to where `visit` begins, so reading can stop. */
function reachesStart(rows: readonly Row[], chain: Chain, visit: Visit): boolean {
  if (visit.openedBy === "origin") return false;
  if (visit.deliveryId && deliveryRow(rows, chain, visit) >= 0) return true;
  const start = visit.start;
  return !!start && turnStarts(rows).some((turn) => turn.fp === start.fp);
}

interface StretchStart {
  index: number;
  note?: Note;
}

function findStart(rows: readonly Row[], starts: readonly TurnStart[], chain: Chain, visit: Visit): StretchStart {
  if (visit.openedBy === "origin") return { index: 0 };
  if (visit.deliveryId) {
    const index = deliveryRow(rows, chain, visit);
    if (index >= 0) return { index };
  }
  if (visit.start) {
    const position = relocate(starts, visit.start);
    if (position !== null) return { index: afterTurn(starts, position, rows.length) };
  }
  const known = knownFingerprints(chain, visit);
  for (let position = starts.length - 1; position >= 0; position--) {
    if (known.has(starts[position]!.fp)) return { index: afterTurn(starts, position, rows.length), note: { code: "notes.startGuessed" } };
  }
  return { index: 0, note: { code: "notes.startUnknown" } };
}

const GAP_NOTICE: Item = {
  role: "system",
  kind: "notice",
  priority: 3,
  text: "Part of this agent's earlier history was too long to read here and is missing.",
};

/**
 * Close `visit`: read its agent (unless `read` is given), keep its stretch as numbered items and record where it ended.
 * An agent that cannot be read closes with nothing and a note.
 */
export async function closeVisit(deps: HistoryDeps, chain: Chain, visit: Visit, agent: Pick<AgentLike, "persistence" | "model"> | null, read?: ReadResult): Promise<Note[]> {
  const notes: Note[] = [];
  let result = read;
  if (!result) {
    try {
      result = await readRows(deps.paseo, visit.agentId, {
        enough: (rows) => reachesStart(rows, chain, visit),
        headRows: visit.openedBy === "origin" ? HEAD_ROWS : 0,
        ...(deps.maxRows ? { maxRows: deps.maxRows } : {}),
      });
    } catch (error) {
      visit.closedAt = deps.now().toISOString();
      visit.notes = [...(visit.notes ?? []), "unreadable"];
      notes.push({ code: "notes.visitUnreadable", params: { visit: visit.n, error: error instanceof Error ? error.message : String(error) } });
      return notes;
    }
  }
  const rows = result.rows;
  const starts = turnStarts(rows);
  const start = findStart(rows, starts, chain, visit);
  if (start.note) {
    notes.push({ ...start.note, params: { visit: visit.n, provider: visit.provider } });
    visit.notes = [...(visit.notes ?? []), start.note.code];
  }
  let items = normalizeRows(rows.slice(start.index), { toolName: TOOL_NAME });
  if (visit.openedBy === "origin" && !result.complete && result.head.length) {
    items = [...normalizeRows(result.head, { toolName: TOOL_NAME }), GAP_NOTICE, ...items];
  }
  const first = nextItemNumber(chain);
  const numbered: NumberedItem[] = items.map((item, index) => ({ ...item, n: first + index, visit: visit.n, provider: visit.provider }));
  if (numbered.length) await deps.store.writeSnapshot(chain.id, visit.n, numbered);
  visit.firstItem = numbered.length ? first : null;
  visit.itemCount = numbered.length;
  visit.closedAt = deps.now().toISOString();
  visit.end = endAnchor(starts) ?? visit.start ?? null;
  const ownStarts = starts.filter((turn) => turn.index >= start.index).map((turn) => turn.fp);
  visit.turnFps = ownStarts.slice(-MAX_FPS);
  if (agent?.persistence?.sessionId) visit.sessionId = agent.persistence.sessionId;
  if (agent?.model) visit.model = agent.model;
  return notes;
}

/**
 * Turns on `agent` after its latest closed visit ended: someone carried on there without Ferry. Recorded as a
 * "manual" visit, closed at once, so the next handoff includes them.
 */
async function catchUp(deps: HistoryDeps, chain: Chain, agent: AgentLike, latest: Visit, meta: { family: string; storeKey: string | null }): Promise<Note[]> {
  const end = latest.end;
  let result: ReadResult;
  try {
    result = await readRows(deps.paseo, agent.id, {
      enough: (rows) => !!end && turnStarts(rows).some((turn) => turn.fp === end.fp),
      ...(deps.maxRows ? { maxRows: deps.maxRows } : {}),
    });
  } catch {
    return [];
  }
  const starts = turnStarts(result.rows);
  let after: number | null = null;
  if (end) {
    const position = relocate(starts, end);
    if (position !== null) after = position;
  }
  if (after === null) {
    const known = knownFingerprints(chain);
    for (let position = starts.length - 1; position >= 0 && after === null; position--) if (known.has(starts[position]!.fp)) after = position;
  }
  if (after === null || after >= starts.length - 1) return [];
  const visit = addVisit(chain, {
    agentId: agent.id,
    provider: agent.provider,
    model: agent.model ?? null,
    sessionId: agent.persistence?.sessionId ?? null,
    storeKey: meta.storeKey,
    family: meta.family,
    openedBy: "manual",
    deliveryId: null,
    start: end ?? null,
    openedAt: starts[after + 1]!.at ?? deps.now().toISOString(),
  });
  // The stretch starts after the turn found above, whichever way it was found.
  visit.start = { turn: after, fp: starts[after]!.fp, prevFp: starts[after - 1]?.fp ?? null, turns: starts.length, at: starts[after]!.at };
  return closeVisit(deps, chain, visit, agent, result);
}

export interface Settled {
  chain: Chain;
  /** The chain did not exist before. */
  created: boolean;
  notes: Note[];
}

/**
 * Bring `chain` up to date before a move from `source`: close every open visit (reading their agents), start the chain
 * with the source's whole conversation when there is none, and pick up turns made on the source outside Ferry.
 */
export async function settle(
  deps: HistoryDeps,
  existing: Chain | null,
  source: AgentLike,
  meta: { family: string; storeKey: string | null },
  readAgent: (agentId: string) => Promise<AgentLike | null>,
): Promise<Settled> {
  const chain = existing ?? newChain(source, deps.now());
  const notes: Note[] = [];
  const openBefore = new Set(chain.visits.filter((entry) => !entry.closedAt));
  for (const visit of openBefore) {
    const agent = visit.agentId === source.id ? source : await readAgent(visit.agentId).catch(() => null);
    notes.push(...(await closeVisit(deps, chain, visit, agent)));
  }
  const own = chain.visits.filter((visit) => visit.agentId === source.id);
  if (!own.length) {
    const visit = addVisit(chain, {
      agentId: source.id,
      provider: source.provider,
      model: source.model ?? null,
      sessionId: source.persistence?.sessionId ?? null,
      storeKey: meta.storeKey,
      family: meta.family,
      openedBy: "origin",
      deliveryId: null,
      start: null,
      openedAt: source.createdAt ?? deps.now().toISOString(),
    });
    notes.push(...(await closeVisit(deps, chain, visit, source)));
  } else {
    const latest = own.reduce((last, visit) => (visit.n > last.n ? visit : last));
    // A visit closed just now ends at the source's latest turn: nothing can have happened on it since.
    if (!openBefore.has(latest)) notes.push(...(await catchUp(deps, chain, source, latest, meta)));
  }
  chain.updatedAt = deps.now().toISOString();
  return { chain, created: !existing, notes };
}

/** The items a returning lineage missed: everything after its latest visit. */
export function deltaItems(chain: Chain, history: readonly NumberedItem[], lineage: string): NumberedItem[] {
  const own = chain.visits.filter((visit) => lineageOf(visit) === lineage);
  if (!own.length) return [...history];
  const lastVisit = Math.max(...own.map((visit) => visit.n));
  const later = new Set(chain.visits.filter((visit) => visit.n > lastVisit && lineageOf(visit) !== lineage).map((visit) => visit.n));
  return history.filter((item) => later.has(item.visit));
}
