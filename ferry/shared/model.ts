// The shapes Ferry keeps: one conversation item as handed over, and a chain (one conversation spread over agents).
// Plain data, so the server, the client and the tests share them; the chain file on disk is a `Chain` as JSON.

import type { HandoffRow } from "./kinds";

export type Role = "user" | "assistant" | "agent" | "tool" | "system";
export type ItemKind =
  | "message"
  | "prior_context"
  | "command"
  | "file_change"
  | "explored"
  | "plan"
  | "subagent"
  | "tool"
  | "todo"
  | "error"
  | "notice"
  | "compaction"
  | "interrupt";

/**
 * 1: what was said and planned (messages, plans); 2: what was done (commands, file changes, errors);
 * 3: background (reads and searches, notices, other tools). Selection fills with 1–2 first, then 3.
 */
export type Priority = 1 | 2 | 3;

/** One conversation item, normalized from a timeline row (or several folded rows). Text is redacted and capped. */
export interface Item {
  role: Role;
  kind: ItemKind;
  text: string;
  priority: Priority;
  status?: "completed" | "failed" | "canceled" | "running";
  /** Timestamp of the row, when the timeline had one. */
  at?: string | null;
  /** Command exit code, edited paths: details the renderer shows in the item's header. */
  exitCode?: number | null;
  /** For a message from another agent: who sent it. */
  from?: string;
}

/** An item as stored in a chain: numbered across the whole chain, with the visit (and so the provider) it came from. */
export interface NumberedItem extends Item {
  n: number;
  visit: number;
  provider: string;
}

/** Where a stretch of an agent's timeline ends or begins, by content: robust to restarts that renumber rows. */
export interface Anchor {
  /** Ordinal of the turn start among the agent's turn starts (0-based) when the anchor was taken. */
  turn: number;
  /** Fingerprint of that turn start, and of the latest one before it (to tell repeated messages apart). */
  fp: string;
  prevFp: string | null;
  /** How many turn starts the agent's timeline had then. */
  turns: number;
  at: string | null;
}

export type VisitOpening = "origin" | "handoff" | "delta" | "native" | "manual";

/** One stretch of the conversation on one agent. A return to an agent is a new visit. */
export interface Visit {
  n: number;
  agentId: string;
  provider: string;
  model: string | null;
  /** Provider session; with the session store it identifies the lineage that saw this visit natively. */
  sessionId: string | null;
  storeKey: string | null;
  family: string;
  openedBy: VisitOpening;
  /** The Ferry message that opened it (handoff and delta visits). */
  deliveryId: string | null;
  /** For native and manual visits: the content starts after this turn of the agent's timeline. */
  start: Anchor | null;
  openedAt: string;
  closedAt: string | null;
  end: Anchor | null;
  /** Numbers of its items in the chain, fixed when it closes. */
  firstItem: number | null;
  itemCount: number;
  /** Fingerprints of the turns it holds (newest last, at most a few hundred): lets a later read skip what is known. */
  turnFps?: string[];
  /** Notes made when it closed, e.g. that its start could not be found. */
  notes?: string[];
}

export type DeliveryStatus = "pending" | "accepted" | "read" | "failed" | "canceled";

export interface DeliveryAttempt {
  messageId: string;
  at: string;
  status: "sent" | "rejected";
  error?: string;
}

/** A handoff or delta message Ferry sent, and whether the agent got to read it. */
export interface Delivery {
  id: string;
  visitN: number;
  targetAgentId: string;
  mode: "full" | "delta";
  /** Delta only: items after this number were sent. */
  since: number | null;
  via: "attachment" | "inline";
  selected: number;
  total: number;
  bytes: number;
  attempts: DeliveryAttempt[];
  status: DeliveryStatus;
  error?: string;
  /** The user's own words that went with it, for the retry. */
  message: string;
  /** The row shown on the target, kept so its status can be updated. */
  row?: HandoffRow;
}

export interface Chain {
  v: 1;
  id: string;
  workspaceId: string | null;
  cwd: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  visits: Visit[];
  deliveries: Delivery[];
}
