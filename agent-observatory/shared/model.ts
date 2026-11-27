import type { LiveIssue } from "./live-issue";
import { t } from "./text";
/** Pure dashboard models. This module is shared by native and web clients. */
import type { StopReason } from "./stop-reason";
import type { ReplyNudge } from "./reply";

/**
 * A stop as the server records it. `closedMidTurn`: the host closed (unloaded) the Agent while this turn was still open
 * (0.11 `agent.closed`). A turn that ends raises the host's own attention; a turn cut off by closing raises none.
 */
export type ObservedStop = StopReason & { closedMidTurn?: boolean };
/**
 * `idle` is 待回复: the latest final reply hands the next step to the user (a question, a choice, a request). `quiet` (空闲)
 * is a stopped Agent whose last turn left no known result: never observed ending and no final reply found.
 */
export const AGENT_STATUSES = ["running", "waiting", "idle", "completed", "quiet", "error", "initializing", "closed", "canceled"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];
export type CheckoutKind = "worktree" | "main" | "directory" | "unknown";
export type CompletionReadState = "unread" | "read" | "unknown" | "not_completed";
export type CompletionReadFilter = "all" | "unread" | "read";

/** 后台执行中: provider subagents still working after the Agent's own turn ended (Paseo shows them as "N working"). */
export interface AgentBackground {
  running: number;
  /** Start of the earliest current run; null when it began before the plugin observed it. */
  since: string | null;
  updatedAt: string | null;
  /** What they work on, newest first. */
  labels: string[];
}

export interface AgentUsageRecord {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  contextUsed: number | null;
  contextTotal: number | null;
}

/**
 * A permission request the Agent waits on, reduced to what a row can say. Paseo 0.11 kinds: Claude Code's AskUserQuestion
 * is `question`, ExitPlanMode is `plan`, a tool that needs approval is `tool`.
 */
export interface PendingRequest {
  kind: "tool" | "plan" | "question" | "mode" | "other";
  /** The question, the plan's title or the request title. */
  title: string | null;
  /** A shell command, a file, the plan's first line, or how many questions there are. */
  detail: string | null;
  /** A question's choices. */
  options: string[];
  /** The host's request id, when it has one: one chime per request (shared/alerts.ts). */
  requestId?: string;
}
/** What a waiting Agent waits for: a structured question, a plan to approve, or a tool approval. */
export type WaitingKind = "question" | "plan" | "approval";

/** A running turn's todo list: how far it got and what it is on (B12). Kept in memory on the server, never stored. */
export interface AgentTodo { done: number; total: number; current: string | null; at: string }

export interface AgentRecord {
  id: string;
  title: string;
  provider: string;
  model: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  projectId: string | null;
  projectName: string;
  projectRootPath: string | null;
  checkoutKind: CheckoutKind;
  worktreeName: string | null;
  worktreePath: string | null;
  branch: string | null;
  cwd: string | null;
  parentAgentId: string | null;
  status: AgentStatus;
  rawStatus: string;
  createdAt: string | null;
  updatedAt: string | null;
  lastActivityAt: string | null;
  /** Execution evidence, excluding archive/rename metadata writes. */
  lastExecutionAt?: string | null;
  lastUserMessageAt: string | null;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  /** Proven completion time, retained separately when native read clears attention. */
  completionAt?: string | null;
  /** Explicit receipt hints; native attention fields remain unchanged. */
  completionReadAt?: string | null;
  completionReadFor?: string | null;
  /** Native false can come from archiving rather than reading a result. */
  archiveReadOriginAt?: string | null;
  archiveReadOriginUserAt?: string | null;
  activeTurnStartedAt: string | null;
  /**
   * The latest turn the plugin observed (its lifecycle hooks), when it started and ended. A heartbeat or another system
   * notification starts a turn without a user message, so `lastUserMessageAt` stays; while an older result is unread the
   * host's attention keeps its first stamp too (edge-triggered). Only a turn seen starting after that stamp proves the stamp
   * names an earlier turn (codex-obs-attn-F1).
   */
  observedTurnStartedAt?: string | null;
  observedTurnEndedAt?: string | null;
  archivedAt: string | null;
  pendingPermissionCount: number;
  lastError: string | null;
  attentionReason: string | null;
  usage: AgentUsageRecord;
  labels: Record<string, string>;
  background?: AgentBackground | null;
  /** The pending requests (at most four), for 提问 / 计划待批 and the row's one-line reason. */
  pending?: PendingRequest[];
  /** Why the latest turn stopped when that is not simply done: a usage limit, an empty or an unfinished turn. */
  stop?: ObservedStop | null;
  /** What the latest final reply invites (快捷回复), only while the user has not written since (as 待回复). */
  replyNudge?: ReplyNudge | null;
  /** The latest final reply that asks the user (待回复), when it was written; null when the latest reply asks nothing. */
  replyAskedAt?: string | null;
  /** True while the user has marked that reply answered without sending anything; a newer reply asks again. */
  replyAnswered?: boolean;
  /** The closing sentence that invites it, redacted (live extras from the turn's end, memory only): the popover quotes it. */
  replyAsk?: string | null;
  /** The running turn's todo progress (live extras from the server). */
  todo?: AgentTodo | null;
  /** The running turn is going in circles or has been quiet for long (2.18, live extras from the server). */
  issue?: LiveIssue | null;
  /** The host's own attention note for the latest event (its notification body), in memory only. */
  note?: string | null;
  /** The latest merge or pull request the Agent's final replies linked to (`!12` / `#34`). */
  changeRequest?: { url: string; label: string; kind: "mr" | "pr" } | null;
}

/** Structural input allows snapshot normalization without a runtime SDK import. */
export interface AgentSource {
  id: string;
  title?: string | null;
  provider?: string;
  model?: string | null;
  workspaceId?: string | null;
  workspaceName?: string | null;
  projectId?: string | null;
  projectName?: string | null;
  projectRootPath?: string | null;
  checkoutKind?: CheckoutKind;
  worktreeName?: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  checkout?: AgentCheckoutMetadata | null;
  cwd?: string | null;
  parentAgentId?: string | null;
  status?: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastUserMessageAt?: string | null;
  activeTurn?: { startedAt?: string | null } | null;
  archivedAt?: string | null;
  pendingPermissions?: readonly unknown[];
  pendingPermissionCount?: number;
  lastError?: string | null;
  attentionReason?: string | null;
  attentionTimestamp?: string | null;
  requiresAttention?: boolean;
  /** Paseo 0.16 background agent: a helper that reports to the Agent that made it, never to the user. */
  background?: boolean;
  labels?: Record<string, string>;
  lastUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    totalCostUsd?: number;
    contextWindowUsedTokens?: number;
    contextWindowMaxTokens?: number;
  } | null;
}

export interface LifecycleOutcome {
  outcome: "completed" | "failed" | "canceled" | null;
  turnEndedAt: string | null;
  turnStartedAt?: string | null;
  /** When the latest turn's final reply was written and whether it asks the user something (待回复). */
  replyAt?: string | null;
  replyAsks?: boolean | null;
  /** The user marked a reply that asks as answered at this time: replies written at or before it no longer count as 待回复. */
  replyAnsweredAt?: string | null;
  /** What that reply invites (快捷回复), as a category; null when nothing or unknown. */
  replyNudge?: ReplyNudge | null;
  /** Why the latest turn stopped (usage limit, empty, unfinished); null when it simply ended. */
  stop?: ObservedStop | null;
}

export interface CompletionReadReceipt {
  agentId?: string;
  completionAt: string;
  lastUserMessageAt: string | null;
  readAt: string;
}

export interface ArchiveReadOrigin {
  agentId?: string;
  archivedAt: string;
  lastUserMessageAt: string | null;
}

/** Exact structural subset of Paseo 0.8 ProjectPlacementPayload. */
export interface AgentCheckoutMetadata {
  cwd?: string | null;
  isGit?: boolean;
  currentBranch?: string | null;
  isPaseoOwnedWorktree?: boolean;
  mainRepoRoot?: string | null;
  worktreeRoot?: string | null;
}

export interface AgentProjectPlacement {
  projectKey?: string | null;
  projectName?: string | null;
  workspaceName?: string | null;
  checkout?: AgentCheckoutMetadata | null;
}

export function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function validDate(value: string | null | undefined): string | null {
  return timestamp(value) === null ? null : value!;
}

function nonnegative(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Compare metadata roots without confusing trailing separators with separation. */
function comparablePath(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:/i.test(normalized) ? normalized.toLocaleLowerCase() : normalized;
}

function normalizeCheckout(source: AgentSource, checkout?: AgentCheckoutMetadata | null): Pick<AgentRecord, "checkoutKind" | "worktreeName" | "worktreePath" | "branch"> {
  const root = text(checkout?.worktreeRoot);
  const main = text(checkout?.mainRepoRoot);
  const separated = root !== null && main !== null && comparablePath(root) !== comparablePath(main);
  const knownMain = checkout?.isGit === true || (root !== null && main !== null && !separated);
  const checkoutKind: CheckoutKind = checkout?.isGit === false ? "directory"
    : checkout?.isPaseoOwnedWorktree === true || separated ? "worktree"
    : knownMain ? "main" : source.checkoutKind ?? "unknown";
  const worktreePath = checkoutKind === "worktree" ? root ?? text(source.worktreePath) : null;
  const worktreeName = worktreePath?.split(/[\\/]/).filter(Boolean).at(-1) ?? null;
  const branch = checkoutKind === "directory" ? null : checkout?.currentBranch !== undefined ? text(checkout.currentBranch) : text(source.branch);
  return { checkoutKind, worktreeName, worktreePath, branch };
}

function latestDate(values: Array<string | null | undefined>): string | null {
  return values.map(validDate).filter((date): date is string => date !== null)
    .sort((a, b) => timestamp(b)! - timestamp(a)!)[0] ?? null;
}
function currentLifecycleOutcome(source: Omit<AgentSource, "id">, lifecycle?: LifecycleOutcome | null) {
  if (!lifecycle?.outcome) return null;
  const endedAt = timestamp(lifecycle.turnEndedAt);
  const latestStart = Math.max(timestamp(source.lastUserMessageAt) ?? 0, timestamp(source.activeTurn?.startedAt) ?? 0,
    timestamp(lifecycle.turnStartedAt) ?? 0, timestamp(source.createdAt) ?? 0);
  return endedAt !== null && endedAt >= latestStart ? { status: lifecycle.outcome === "failed" ? "error" as const : lifecycle.outcome, at: endedAt } : null;
}

const recordOf = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const clip = (value: unknown, max: number): string | null => typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, max) : null;
const REQUEST_KINDS: ReadonlySet<string> = new Set(["tool", "plan", "question", "mode", "other"]);
/** One pending request in a few words: the question and its choices, the plan's first line, the command a tool wants to run. */
export function summarizeRequest(value: unknown): PendingRequest {
  const request = recordOf(value), requestId = clip(request.id, 200);
  return requestId ? { ...describeRequest(request), requestId } : describeRequest(request);
}
function describeRequest(request: Record<string, unknown>): PendingRequest {
  const input = recordOf(request.input), detail = recordOf(request.detail);
  const kind = REQUEST_KINDS.has(String(request.kind)) ? request.kind as PendingRequest["kind"] : "tool";
  if (kind === "question") {
    const questions = Array.isArray(input.questions) ? input.questions.map(recordOf) : [], first = questions[0] ?? {};
    const options = (Array.isArray(first.options) ? first.options : []).map(option => clip(typeof option === "string" ? option : recordOf(option).label, 40)).filter((label): label is string => !!label).slice(0, 4);
    return { kind, title: clip(first.question, 200) ?? clip(request.title, 160) ?? clip(request.description, 160), detail: questions.length > 1 ? t("sharedModel.m001", { value1: questions.length }) : clip(first.header, 40), options };
  }
  if (kind === "plan") {
    const plan = typeof input.plan === "string" ? input.plan : "", heading = plan.split("\n").map(line => line.replace(/^\s*#+\s*|\*\*/g, "").trim()).find(Boolean);
    return { kind, title: clip(heading, 120) ?? clip(request.title, 120), detail: null, options: [] };
  }
  const command = detail.type === "shell" ? clip(detail.command, 200) : null;
  return { kind, title: clip(request.title, 120) ?? clip(request.name, 80), detail: command ?? clip(detail.filePath, 200) ?? clip(request.description, 160), options: [] };
}
/** 提问 when every pending request is a question, 计划待批 when one is a plan and none a tool, otherwise 待审批. */
export function waitingKind(agent: Pick<AgentRecord, "pending" | "pendingPermissionCount" | "status">): WaitingKind | null {
  if (agent.pendingPermissionCount <= 0 && agent.status !== "waiting") return null;
  const kinds = (agent.pending ?? []).map(request => request.kind);
  if (kinds.length && kinds.length >= agent.pendingPermissionCount && kinds.every(kind => kind === "question")) return "question";
  if (kinds.includes("plan") && !kinds.some(kind => kind === "tool")) return "plan";
  return "approval";
}

/**
 * The host's completion stamp while it names the latest turn: not older than the latest prompt, running turn or creation, nor
 * (`observed`) than the latest turn the plugin saw start. A heartbeat starts a turn without a prompt and an unread stamp stays
 * (codex-obs-attn-F1); the newer turn's own end, observed, is then the completion.
 */
function nativeCompletionTimestamp(agent: AgentRecord, observed = true): string | null {
  const at = timestamp(agent.attentionTimestamp);
  const latestStart = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0, timestamp(agent.createdAt) ?? 0,
    observed ? timestamp(agent.observedTurnStartedAt) ?? 0 : 0);
  return agent.attentionReason === "finished" && at !== null && at >= latestStart ? validDate(agent.attentionTimestamp) : null;
}

/** This never derives completion from a generic updatedAt or an assistant reply. */
/** The Agent's own turn is running (not waiting for approval, not only its background subagents). */
export function ownTurnRunning(agent: AgentRecord): boolean {
  return agent.status === "running" && agent.rawStatus === "running";
}

export function knownCompletionAt(agent: AgentRecord): string | null {
  return completionOf(agent, true);
}
/** `observed` false: the completion the record knew of before the plugin's observation of the latest turn applies. */
function completionOf(agent: AgentRecord, observed: boolean): string | null {
  if (agent.status !== "completed") return null;
  const latestStart = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0, timestamp(agent.createdAt) ?? 0);
  const hint = timestamp(agent.completionAt);
  // Native attention timestamps are the acknowledgement token while they name the latest turn. Hook collection
  // normally happens milliseconds later and must never replace that token.
  return nativeCompletionTimestamp(agent, observed) ?? (hint !== null && hint >= latestStart ? validDate(agent.completionAt) : null);
}

/**
 * The end of the latest turn when the host's own tokens cannot tell it from the one before (codex-obs-attn-F1): the plugin saw
 * it start after the host's attention stamp, which a heartbeat or another system notification leaves as it was, together
 * with `lastUserMessageAt`. Null otherwise (the host's tokens name the turn), and while that turn has not ended.
 */
export function observedRound(agent: AgentRecord): string | null {
  const token = timestamp(agent.attentionTimestamp), started = timestamp(agent.observedTurnStartedAt), ended = timestamp(agent.observedTurnEndedAt);
  return token !== null && started !== null && started > token && ended !== null && ended >= started ? validDate(agent.observedTurnEndedAt) : null;
}

/**
 * Which turn a result was read for (the server labels each result it reads with it): the host's prompt and attention tokens, the
 * completion the page shows (`knownCompletionAt`) and the end of a round those tokens cannot name (`observedRound`). The
 * detail caches results by it, and marks a result or a reply that asks read only while the one on screen is its record's own:
 * a result read for an earlier heartbeat round never stands for the next (codex-obs-attn-F1).
 */
export interface ResultSource { lastUserMessageAt: string | null; attentionTimestamp: string | null; completionAt: string | null; roundEndedAt: string | null }
export function resultSource(agent: AgentRecord): ResultSource {
  return { lastUserMessageAt: agent.lastUserMessageAt, attentionTimestamp: agent.attentionTimestamp ?? null, completionAt: knownCompletionAt(agent), roundEndedAt: observedRound(agent) };
}
/** Whether a result read for `read` is about the turn `agent` is. A source without the round's fields (an older server) is judged by the host's tokens, as before. */
export function sameResultSource(agent: AgentRecord, read: Partial<ResultSource> | null | undefined): boolean {
  if (!read) return false;
  const current = resultSource(agent);
  return read.lastUserMessageAt === current.lastUserMessageAt && read.attentionTimestamp === current.attentionTimestamp
    && (read.completionAt === undefined || read.completionAt === current.completionAt) && (read.roundEndedAt === undefined || read.roundEndedAt === current.roundEndedAt);
}

export function completionReadState(agent: AgentRecord): CompletionReadState {
  if (agent.status !== "completed") return "not_completed";
  if (agent.pendingPermissionCount > 0 || agent.activeTurnStartedAt) return "unknown";
  const completion = timestamp(knownCompletionAt(agent));
  const nativeCompletion = timestamp(nativeCompletionTimestamp(agent));
  const receiptCompletion = timestamp(agent.completionReadFor);
  const receiptReadAt = timestamp(agent.completionReadAt);
  const receiptMatches = completion !== null && receiptCompletion === completion && receiptReadAt !== null && receiptReadAt >= completion;
  const attentionAt = timestamp(agent.attentionTimestamp);
  // The server only stores successful acknowledgements. An exact-token receipt can therefore beat an older client snapshot of
  // that same native unread flag, and stands for the flag the host keeps on an Agent it has not loaded (marked here without
  // loading it). So does one for a newer completion an edge-triggered, older token stands for (codex-F5): the user read the
  // latest result, which supersedes the one that token names.
  const supersedes = nativeCompletion === null && agent.attentionReason === "finished" && attentionAt !== null && receiptCompletion !== null && attentionAt < receiptCompletion;
  if (receiptMatches && (agent.requiresAttention !== true || nativeCompletion === receiptCompletion || supersedes)) return "read";
  // Archiving also clears native attention; that alone does not prove viewing.
  if (!agent.archivedAt && !agent.archiveReadOriginAt && agent.requiresAttention === false) return "read";
  if (!agent.archivedAt && agent.requiresAttention === true && nativeCompletion !== null && (completion === null || nativeCompletion >= completion)) return "unread";
  // Paseo's attention is edge-triggered: a turn that ends while an older completion is still unread leaves the older
  // timestamp in place (a heartbeat or an orchestrator prompted the Agent again). Attention still being set proves the
  // user saw neither result, so the newer, observed completion is unread; its own time is the acknowledgement token.
  if (!agent.archivedAt && agent.requiresAttention === true && agent.attentionReason === "finished" && nativeCompletion === null && completion !== null
    && attentionAt !== null && attentionAt < completion && (receiptCompletion === null || receiptCompletion < completion)) return "unread";
  return "unknown";
}

export function isUnreadCompletion(agent: AgentRecord): boolean {
  return !agent.archivedAt && completionReadState(agent) === "unread";
}

/**
 * Whether the latest turn's stop explains the Agent's state now: a finished, quiet or closed session shows why it stopped,
 * and a usage limit also outranks a failed turn or a reply that asks. Live work never shows an old stop. One rule for the
 * row, the detail, 需要处理, the sidebar badge and its popover.
 */
export function stopShown(agent: Pick<AgentRecord, "stop" | "status">): boolean {
  if (!agent.stop) return false;
  return agent.status === "completed" || agent.status === "quiet" || agent.status === "closed"
    || agent.stop.kind === "quota" && (agent.status === "error" || agent.status === "idle");
}

/**
 * A shown stop the user has not seen yet: it counts in 需要处理 (a subagent's too), is never hidden by 稍后处理 or the time
 * range, and its detail offers 知道了. Seen, one definition for every view:
 * - The host raised attention for the stop's turn, as it does whenever a turn ends (running → idle sets `finished`, a
 *   failure `error`). It is edge-triggered: an older unread attention it keeps instead stands for this turn too, since
 *   nobody opened the Agent in between. Seen once that attention is cleared (`requiresAttention !== true`): opening the
 *   Agent in Paseo, or 知道了 / 标记已读 here. A failed turn keeps the error rule: unknown attention still counts.
 * - The host raised none (`closedMidTurn`: it closed the Agent mid-turn): seen only after 知道了 here, which the server
 *   records as `seenAt` on exactly this stop. Loading the session again raises nothing either.
 * 知道了 records `seenAt` on both kinds, so a stop seen here stays seen whichever way it was seen.
 */
export function stopUnseen(agent: AgentRecord): boolean {
  if (agent.archivedAt || !stopShown(agent)) return false;
  const stop = agent.stop!;
  if (timestamp(stop.seenAt) !== null) return false;
  if (stop.closedMidTurn) return true;
  return agent.status === "error" ? agent.requiresAttention !== false : agent.requiresAttention === true;
}

/**
 * Whether 稍后处理 holds an unread result back (counted 稍后, left out of the 未读 list): never while its stop is not seen yet,
 * which a snooze cannot put off. One rule for the 未读 chip and the list it opens, so they count the same (P3-1).
 */
export function heldBySnooze(agent: AgentRecord, snoozed: boolean): boolean {
  return snoozed && !stopUnseen(agent);
}

/**
 * What the detail's 已读 action acknowledges: a stop not seen yet first, whatever the turn's outcome (a limit or an empty
 * turn usually ends "completed"), as 知道了 without a result receipt (on an Agent the host has not loaded, the receipt for
 * the host's token stands in for clearing it); then an unread result (标记已读, which leaves a receipt), a reply that asks
 * you (待回复, 标记已读), and a failure not seen yet (知道了). Null when nothing waits. A shown stop decides as it does for
 * 需要处理: once seen, the failed turn it ended (a usage limit) leaves nothing to acknowledge, also while an Agent the host
 * has not loaded keeps that turn's error attention raised (P2-3).
 */
export function acknowledgement(agent: AgentRecord, readState = completionReadState(agent)): "problem" | "result" | "question" | null {
  if (agent.archivedAt) return null;
  if (stopUnseen(agent)) return "problem";
  if (agent.status === "error" && stopShown(agent)) return null;
  if (readState === "unread") return "result";
  if (agent.status === "idle" && agent.requiresAttention === true && agent.attentionReason === "finished") return "question";
  return agent.status === "error" && agent.requiresAttention === true ? "problem" : null;
}

/** Preserve the cause of native attention clearing through restoration/reload. */
export function applyArchiveReadOrigin(agent: AgentRecord, origin?: ArchiveReadOrigin | null): AgentRecord {
  if (!origin || origin.agentId && origin.agentId !== agent.id) return agent;
  const archivedAt = timestamp(origin.archivedAt);
  if (archivedAt === null || (timestamp(agent.createdAt) ?? 0) > archivedAt) return agent;
  const user = timestamp(agent.lastUserMessageAt), oldUser = timestamp(origin.lastUserMessageAt);
  if (user !== null && (user > archivedAt || oldUser !== null && user > oldUser)) return agent;
  // Any completion the host stamped after the archive, also one a newer observed turn has since superseded.
  if ((timestamp(nativeCompletionTimestamp(agent, false)) ?? 0) > archivedAt) return agent;
  return { ...agent, archiveReadOriginAt: validDate(origin.archivedAt), archiveReadOriginUserAt: validDate(origin.lastUserMessageAt) };
}

/**
 * 待回复 marked read, or a failure acknowledged (知道了), where the host could not clear its attention (P2-3, P2-4): an Agent
 * it has not loaded keeps it, since clearing would load the Agent (and an ACP one cannot be loaded at all). The server stored
 * this receipt only for exactly that attention token and the prompt it answers, so the reply that asks counts as opened and
 * the failure as seen, as clearing the token would have made them — out of 需要处理 and the time range's pin; a failure
 * stays red — until a newer prompt, turn or attention. Only this derived record says so: the host keeps its flag, and Paseo
 * clears it as usual the next time the Agent is loaded.
 */
function seenAttention(agent: AgentRecord, receipt: CompletionReadReceipt): AgentRecord {
  const reasons = agent.status === "error" ? ["error", "finished"] : ["finished"];
  if (agent.archivedAt || agent.requiresAttention !== true || !reasons.includes(String(agent.attentionReason)) || agent.pendingPermissionCount > 0 || agent.activeTurnStartedAt) return agent;
  const token = timestamp(agent.attentionTimestamp), readAt = timestamp(receipt.readAt);
  if (token === null || timestamp(receipt.completionAt) !== token || readAt === null || readAt < token) return agent;
  if (timestamp(receipt.lastUserMessageAt) !== timestamp(agent.lastUserMessageAt) || (timestamp(agent.lastExecutionAt) ?? 0) > readAt) return agent;
  return { ...agent, requiresAttention: false };
}

/**
 * Restore only an explicitly acknowledged completion, never native attention; on an Agent the host has not loaded, the very
 * attention token a receipt acknowledged reads as acknowledged (`seenAttention`).
 */
export function applyReadReceipt(agent: AgentRecord, receipt?: CompletionReadReceipt | null): AgentRecord {
  if (!receipt || receipt.agentId && receipt.agentId !== agent.id) return agent;
  if (agent.status === "idle" || agent.status === "error") return seenAttention(agent, receipt);
  if (!["completed", "quiet", "closed"].includes(agent.status) || !["completed", "idle", "closed"].includes(agent.rawStatus)) return agent;
  if (agent.pendingPermissionCount > 0 || agent.activeTurnStartedAt || agent.attentionReason === "permission" || agent.attentionReason === "error") return agent;
  if (agent.requiresAttention === true && agent.attentionReason !== "finished") return agent;
  const completion = timestamp(receipt.completionAt), readAt = timestamp(receipt.readAt);
  if (completion === null || readAt === null || readAt < completion || (timestamp(agent.createdAt) ?? 0) > completion) return agent;
  const currentUser = timestamp(agent.lastUserMessageAt), receiptUser = timestamp(receipt.lastUserMessageAt);
  if (currentUser !== null && (receiptUser === null || currentUser > receiptUser || currentUser > completion)) return agent;
  if (receiptUser !== null && receiptUser > completion) return agent;
  if ((timestamp(agent.lastExecutionAt) ?? 0) > readAt) return agent;
  const currentCompletion = timestamp(knownCompletionAt(agent));
  const nativeCompletion = timestamp(nativeCompletionTimestamp(agent));
  // An observed hook end can lag its native completion token. A receipt may
  // refine that estimate if it was acknowledged after the observed end.
  if (currentCompletion !== null && currentCompletion > completion && (nativeCompletion !== null || currentCompletion > readAt)) return agent;
  if (nativeCompletion !== null && nativeCompletion > completion) return agent;
  // A raised token is settled by a receipt for itself, or for the newer completion an edge-triggered, older token stands for
  // (codex-F5; the server verified that one), also while the host keeps the flag on an Agent it has not loaded.
  const attentionAt = timestamp(agent.attentionTimestamp);
  if (agent.requiresAttention === true && nativeCompletion !== completion && !(nativeCompletion === null && attentionAt !== null && attentionAt < completion)) return agent;
  const at = validDate(receipt.completionAt)!;
  const execution = latestDate([agent.lastExecutionAt, agent.lastUserMessageAt, at]);
  return { ...agent, status: "completed", completionAt: at, completionReadAt: validDate(receipt.readAt), completionReadFor: at,
    lastExecutionAt: execution, lastActivityAt: agent.archivedAt ? execution ?? agent.lastActivityAt : latestDate([execution, agent.lastActivityAt]) };
}

/** Preserve observed completion when native read clears its attention metadata. */
export function preserveCompletionEvidence(previous: AgentRecord | undefined, current: AgentRecord): AgentRecord {
  const archivedAt = previous?.archiveReadOriginAt ?? previous?.archivedAt;
  if (previous && archivedAt) current = applyArchiveReadOrigin(current, { agentId: previous.id, archivedAt, lastUserMessageAt: previous.archiveReadOriginUserAt ?? previous.lastUserMessageAt });
  if (!previous || previous.id !== current.id || previous.status !== "completed") return current;
  if (!["quiet", "closed"].includes(current.status) || !["idle", "closed"].includes(current.rawStatus)) return current;
  if (timestamp(previous.lastUserMessageAt) !== timestamp(current.lastUserMessageAt)) return current;
  if (current.pendingPermissionCount > 0 || current.activeTurnStartedAt || current.attentionReason === "error" || current.attentionReason === "permission") return current;
  if (current.requiresAttention === true && current.attentionReason !== "finished") return current;
  if (current.lastError !== null && current.lastError !== previous.lastError) return current;
  const completionAt = knownCompletionAt(previous);
  const execution = latestDate([previous.lastExecutionAt, current.lastExecutionAt, completionAt]);
  return { ...current, status: "completed", completionAt, completionReadAt: previous.completionReadAt ?? null, completionReadFor: previous.completionReadFor ?? null,
    lastExecutionAt: execution, lastActivityAt: current.archivedAt ? execution ?? current.lastActivityAt : latestDate([current.lastActivityAt, execution]) };
}

/** Whether the latest reply asks the user and they have not marked it answered since it was written (待回复). */
export function replyStillAsks(lifecycle?: Pick<LifecycleOutcome, "replyAsks" | "replyAt" | "replyAnsweredAt"> | null): boolean {
  if (lifecycle?.replyAsks !== true) return false;
  const answered = timestamp(lifecycle.replyAnsweredAt), reply = timestamp(lifecycle.replyAt);
  return answered === null || reply === null || answered < reply;
}
/** Whether a reply that asks has been marked answered (the override the user can undo). */
export function replyMarkedAnswered(lifecycle?: Pick<LifecycleOutcome, "replyAsks" | "replyAt" | "replyAnsweredAt"> | null): boolean {
  return lifecycle?.replyAsks === true && !replyStillAsks(lifecycle);
}

export function classifyAgentStatus(source: Omit<AgentSource, "id">, lifecycle?: LifecycleOutcome): AgentStatus {
  const pending = source.pendingPermissions?.length ?? source.pendingPermissionCount ?? 0;
  const attentionAt = timestamp(source.attentionTimestamp);
  const latestPromptAt = Math.max(timestamp(source.lastUserMessageAt) ?? 0, timestamp(source.activeTurn?.startedAt) ?? 0,
    timestamp(lifecycle?.turnStartedAt) ?? 0);
  const attentionIsCurrent = attentionAt === null ? latestPromptAt === 0 : attentionAt >= latestPromptAt;
  if (pending > 0 || (source.attentionReason === "permission" && source.requiresAttention !== false && attentionIsCurrent)) return "waiting";
  if (source.status === "running") return "running";
  if (source.status === "initializing") return "initializing";
  if (source.status === "error") return "error";
  if (source.status === "canceled" || source.status === "cancelled") return "canceled";
  // A completed turn whose final reply asks the user is 待回复 until they send the next message, or mark it answered.
  const asks = replyStillAsks(lifecycle) && (timestamp(lifecycle!.replyAt) ?? -1) >= latestPromptAt;
  const settled = (status: AgentStatus): AgentStatus => status === "completed" && asks ? "idle" : status;
  if (source.status === "completed") return settled("completed");
  const lifecycleResult = currentLifecycleOutcome(source, lifecycle);
  const attentionResult = attentionIsCurrent && source.attentionReason === "finished" ? "completed"
    : attentionIsCurrent && source.attentionReason === "error" && (source.requiresAttention !== false || source.archivedAt || source.status === "closed") ? "error" : null;
  // A closed runtime can still have a proven terminal result. Archive state is
  // tracked separately; it must not hide that result from completed searches.
  if (lifecycleResult && (!attentionResult || attentionAt === null || lifecycleResult.at >= attentionAt)) return settled(lifecycleResult.status);
  if (attentionResult) return settled(attentionResult);
  if (source.status === "closed") return "closed";
  return source.status === "idle" ? asks ? "idle" : "quiet" : "initializing";
}

export function normalizeAgent(source: AgentSource, options: { workspaceName?: string | null; lifecycle?: LifecycleOutcome; project?: AgentProjectPlacement | null } = {}): AgentRecord {
  const usage = source.lastUsage;
  const inputTokens = nonnegative(usage?.inputTokens);
  const outputTokens = nonnegative(usage?.outputTokens);
  const labels = Object.fromEntries(Object.entries(source.labels ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  const currentOutcome = currentLifecycleOutcome(source, options.lifecycle);
  const status = classifyAgentStatus(source, options.lifecycle);
  const completionAt = status === "completed" ? validDate(source.attentionReason === "finished" ? source.attentionTimestamp : null)
    ?? validDate(currentOutcome?.status === "completed" ? options.lifecycle?.turnEndedAt : null) : null;
  const execution = latestDate([source.lastUserMessageAt, source.activeTurn?.startedAt, source.attentionTimestamp,
    currentOutcome ? options.lifecycle?.turnEndedAt : null]);
  const archivedAt = validDate(source.archivedAt);
  // Paseo's archive operation writes updatedAt=archivedAt and may clear attention.
  // Retained execution evidence is therefore more reliable for archived history.
  const beforeArchiveUpdate = archivedAt && timestamp(source.updatedAt) !== null && timestamp(source.updatedAt)! < timestamp(archivedAt)!
    ? validDate(source.updatedAt) : null;
  const activity = archivedAt ? execution ?? beforeArchiveUpdate ?? validDate(source.createdAt)
    : latestDate([source.updatedAt, execution, source.createdAt]);
  const cwd = text(source.cwd);
  const parent = text(source.parentAgentId) ?? text(labels["paseo.parent-agent-id"]);
  const checkout = options.project?.checkout ?? source.checkout;
  const checkoutFields = normalizeCheckout(source, checkout);
  // Prefer the original repository root over a worktree's generated directory.
  // A managed worktree without placement metadata cannot identify its project.
  const managedWorktree = cwd !== null && /[\\/]\.paseo[\\/]worktrees[\\/]/.test(cwd);
  const placementRoot = text(checkout?.mainRepoRoot) ?? (managedWorktree ? null : text(checkout?.worktreeRoot) ?? text(checkout?.cwd));
  const projectRootPath = placementRoot ?? text(source.projectRootPath) ?? (managedWorktree ? null : cwd);
  const projectName = text(options.project?.projectName) ?? text(source.projectName) ?? projectRootPath?.split(/[\\/]/).filter(Boolean).at(-1) ?? t("sharedModel.m002");
  return {
    id: source.id,
    title: text(source.title) ?? t("sharedModel.m003"),
    provider: text(source.provider) ?? "unknown",
    model: text(source.model),
    workspaceId: text(source.workspaceId),
    workspaceName: text(options.workspaceName) ?? text(options.project?.workspaceName) ?? text(source.workspaceName) ?? (cwd?.split(/[\\/]/).filter(Boolean).at(-1) ?? null),
    projectId: text(options.project?.projectKey) ?? text(source.projectId),
    projectName,
    projectRootPath,
    ...checkoutFields,
    cwd,
    parentAgentId: parent,
    status,
    rawStatus: source.status ?? "unknown",
    createdAt: validDate(source.createdAt),
    updatedAt: validDate(source.updatedAt),
    lastActivityAt: activity,
    lastExecutionAt: execution,
    lastUserMessageAt: validDate(source.lastUserMessageAt),
    attentionTimestamp: validDate(source.attentionTimestamp),
    requiresAttention: source.requiresAttention,
    completionAt,
    completionReadAt: null,
    completionReadFor: null,
    archiveReadOriginAt: archivedAt,
    archiveReadOriginUserAt: archivedAt ? validDate(source.lastUserMessageAt) : null,
    activeTurnStartedAt: validDate(source.activeTurn?.startedAt),
    archivedAt,
    pendingPermissionCount: source.pendingPermissions?.length ?? Math.floor(nonnegative(source.pendingPermissionCount) ?? 0),
    ...(source.pendingPermissions?.length ? { pending: source.pendingPermissions.slice(0, 4).map(summarizeRequest) } : {}),
    lastError: text(source.lastError),
    attentionReason: text(source.attentionReason),
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens: nonnegative(usage?.cachedInputTokens),
      totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      costUsd: nonnegative(usage?.totalCostUsd),
      contextUsed: nonnegative(usage?.contextWindowUsedTokens),
      contextTotal: nonnegative(usage?.contextWindowMaxTokens),
    },
    labels,
  };
}

/** Paseo 0.13: the server of the parent of an Agent delegated across connected hosts (absent: the same host). */
export const PARENT_SERVER_LABEL = "paseo.parent-server-id";

/**
 * The server the parent Agent runs on when that is another host, else null. Paseo 0.13 lets an Agent create Agents on a
 * connected host, and labels the child with its parent and the parent's server. Paseo still treats such a child as
 * delegated (it raises no notification for it; the parent hears when it finishes), and so does this plugin: only
 * showing and opening the parent differ, since the parent is not in this host's list and Paseo opens it on its own host.
 */
export function parentServerOf(agent: Pick<AgentRecord, "parentAgentId" | "labels">, serverId: string | null | undefined): string | null {
  const parentServer = agent.parentAgentId ? text(agent.labels[PARENT_SERVER_LABEL]) : null;
  return parentServer && serverId && parentServer !== serverId ? parentServer : null;
}

/** The latest turn's stop reason, unless a newer prompt has started another turn since. */
function currentStop(agent: AgentRecord, lifecycle: LifecycleOutcome): ObservedStop | null {
  const stop = lifecycle.stop, at = timestamp(stop?.at);
  if (!stop || at === null) return null;
  const latestPrompt = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0);
  // The prompt time is stamped when the message is accepted, a moment before the hook stamps the turn's end.
  return at >= latestPrompt ? stop : null;
}

/** What the latest final reply invites, while it still answers the latest prompt (the rule 待回复 uses). */
function currentNudge(agent: AgentRecord, lifecycle: LifecycleOutcome): ReplyNudge | null {
  const latestPrompt = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0, timestamp(lifecycle.turnStartedAt) ?? 0);
  // A reply marked answered offers no quick replies either.
  return lifecycle.replyNudge && !replyMarkedAnswered(lifecycle) && (timestamp(lifecycle.replyAt) ?? -1) >= latestPrompt ? lifecycle.replyNudge : null;
}

/** Known outcomes enrich idle/closed history; current live work always takes precedence. */
export function applyTelemetry(agent: AgentRecord, lifecycle?: LifecycleOutcome | null): AgentRecord {
  if (!lifecycle || ["running", "waiting", "initializing"].includes(agent.status)) return agent;
  const stop = currentStop(agent, lifecycle), nudge = currentNudge(agent, lifecycle);
  const enriched = applyLifecycle(agent, lifecycle);
  const stopped = stop ? { ...enriched, stop } : enriched.stop ? { ...enriched, stop: null } : enriched;
  const nudged = nudge ? { ...stopped, replyNudge: nudge } : stopped.replyNudge ? { ...stopped, replyNudge: null } : stopped;
  // The reply the 已答复 / 待回复 actions name: the latest prompt's reply, only when it asks.
  const latestPrompt = Math.max(timestamp(agent.lastUserMessageAt) ?? 0, timestamp(agent.activeTurnStartedAt) ?? 0, timestamp(lifecycle.turnStartedAt) ?? 0);
  const current = lifecycle.replyAsks === true && (timestamp(lifecycle.replyAt) ?? -1) >= latestPrompt;
  const replyAskedAt = current ? validDate(lifecycle.replyAt) : null, replyAnswered = current && replyMarkedAnswered(lifecycle);
  return (nudged.replyAskedAt ?? null) === replyAskedAt && !!nudged.replyAnswered === replyAnswered ? nudged : { ...nudged, replyAskedAt, replyAnswered };
}

function applyLifecycle(agent: AgentRecord, lifecycle: LifecycleOutcome): AgentRecord {
  const source = {
    status: agent.rawStatus,
    pendingPermissionCount: agent.pendingPermissionCount,
    createdAt: agent.createdAt,
    lastUserMessageAt: agent.lastUserMessageAt,
    activeTurn: agent.activeTurnStartedAt ? { startedAt: agent.activeTurnStartedAt } : null,
    attentionReason: agent.attentionReason,
    attentionTimestamp: agent.attentionTimestamp,
    requiresAttention: agent.requiresAttention,
    archivedAt: agent.archivedAt,
  };
  const status = classifyAgentStatus(source, lifecycle);
  const outcome = currentLifecycleOutcome(source, lifecycle);
  // The turn observed here goes on the record: whether the host's stamp still names the latest turn depends on it (codex-obs-attn-F1).
  const turnStartedAt = validDate(lifecycle.turnStartedAt), turnEndedAt = validDate(lifecycle.turnEndedAt);
  const observed = agent.observedTurnStartedAt === turnStartedAt && agent.observedTurnEndedAt === turnEndedAt ? agent : { ...agent, observedTurnStartedAt: turnStartedAt, observedTurnEndedAt: turnEndedAt };
  if (status === "idle") {
    // 待回复 wins over any completion evidence: the turn is over, but the Agent is waiting for the user's answer.
    const execution = latestDate([agent.lastExecutionAt, agent.lastUserMessageAt, lifecycle.turnStartedAt, lifecycle.replyAt, outcome ? lifecycle.turnEndedAt : null]);
    return { ...observed, status, completionAt: null, lastExecutionAt: execution, lastActivityAt: agent.archivedAt ? execution ?? agent.lastActivityAt : latestDate([execution, agent.lastActivityAt]) };
  }
  // The completion the record knew of before this observation; a turn observed to start after it retires it below.
  const existingCompletion = timestamp(completionOf(agent, false));
  if (existingCompletion !== null && outcome && outcome.at < existingCompletion) return observed;
  const sameKnownTurn = existingCompletion !== null && (timestamp(lifecycle.turnStartedAt) ?? 0) <= existingCompletion;
  // A host stamp older than the observed start names an earlier turn (a heartbeat left it as it was): the observed end is the completion.
  const completionAt = status === "completed" ? nativeCompletionTimestamp(observed)
    ?? (sameKnownTurn ? completionOf(agent, false) : null)
    ?? validDate(outcome?.status === "completed" ? lifecycle.turnEndedAt : null) : null;
  const execution = latestDate([agent.lastExecutionAt, agent.lastUserMessageAt, agent.activeTurnStartedAt,
    agent.attentionTimestamp, lifecycle.turnStartedAt, outcome ? lifecycle.turnEndedAt : null]);
  const activity = agent.archivedAt ? execution ?? agent.lastActivityAt : latestDate([execution, agent.lastActivityAt]);
  const result = status === observed.status && execution === observed.lastExecutionAt && activity === observed.lastActivityAt && completionAt === observed.completionAt ? observed
    : { ...observed, status, completionAt, lastExecutionAt: execution, lastActivityAt: activity };
  if (existingCompletion !== null && (timestamp(lifecycle.turnStartedAt) ?? 0) > existingCompletion) return result;
  return preserveCompletionEvidence(agent, result);
}

export interface AgentTreeNode {
  agent: AgentRecord;
  children: AgentTreeNode[];
  orphaned: boolean;
  cycleBroken: boolean;
}

const STATUS_ORDER: Record<AgentStatus, number> = { waiting: 0, error: 1, running: 3, initializing: 4, idle: 5, completed: 6, quiet: 7, canceled: 8, closed: 9 };
export function agentAttentionPriority(agent: AgentRecord): number {
  // A stop not seen yet waits for you as the popover ranks it (a usage limit with failures), even on a quiet or closed session.
  if (stopUnseen(agent)) return agent.stop!.kind === "quota" ? 1 : 2;
  return isUnreadCompletion(agent) ? 2 : STATUS_ORDER[agent.status];
}
export function compareAgents(a: AgentRecord, b: AgentRecord): number {
  return agentAttentionPriority(a) - agentAttentionPriority(b) || (timestamp(b.lastActivityAt) ?? 0) - (timestamp(a.lastActivityAt) ?? 0) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
}

/** Each ID appears once. Missing parents become roots; corrupt cycles are broken deterministically. */
export function buildAgentForest(agents: readonly AgentRecord[]): AgentTreeNode[] {
  const nodes = new Map<string, AgentTreeNode>();
  for (const agent of agents) {
    const previous = nodes.get(agent.id);
    if (!previous || (timestamp(agent.updatedAt) ?? 0) >= (timestamp(previous.agent.updatedAt) ?? 0)) {
      nodes.set(agent.id, { agent, children: [], orphaned: false, cycleBroken: false });
    }
  }
  const parents = new Map<string, string | null>();
  for (const [id, node] of nodes) {
    const parent = node.agent.parentAgentId;
    node.orphaned = !!parent && !nodes.has(parent);
    parents.set(id, parent && nodes.has(parent) ? parent : null);
  }
  const visited = new Set<string>();
  for (const id of [...nodes.keys()].sort()) {
    if (visited.has(id)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | null = id;
    while (cursor && !visited.has(cursor)) {
      const index = positions.get(cursor);
      if (index !== undefined) {
        const cycle = path.slice(index);
        const root = cycle.slice().sort()[0]!;
        parents.set(root, null);
        for (const member of cycle) nodes.get(member)!.cycleBroken = true;
        break;
      }
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    for (const member of path) visited.add(member);
  }
  const roots: AgentTreeNode[] = [];
  for (const [id, node] of nodes) {
    const parent = parents.get(id);
    if (parent) nodes.get(parent)!.children.push(node);
    else roots.push(node);
  }
  roots.sort((a, b) => compareAgents(a.agent, b.agent));
  for (const node of nodes.values()) node.children.sort((a, b) => compareAgents(a.agent, b.agent));
  return roots;
}

export interface AgentFilter {
  query?: string;
  statuses?: readonly AgentStatus[];
  workspaceId?: string | null;
  provider?: string | null;
  readFilter?: CompletionReadFilter;
}

/** 执行中 includes sessions still starting, as its list section does. */
export function matchesStatus(status: AgentStatus, filter: AgentStatus | "all"): boolean {
  return filter === "all" || status === filter || (filter === "running" && status === "initializing");
}
/** The status filter as the chips count it: an Agent waiting only on your answer to a question is 待回复, not 待审批 (opus-F12). */
export function matchesAgentStatus(agent: Pick<AgentRecord, "status" | "pending" | "pendingPermissionCount">, filter: AgentStatus | "all"): boolean {
  const question = waitingKind(agent) === "question";
  if (filter === "idle" && question) return true;
  if (filter === "waiting" && question) return false;
  return matchesStatus(agent.status, filter);
}

/** How full the context window is when it gets close (opus-B13): 85 % and up is high, 95 % and up critical. */
export function contextPressure(usage: Pick<AgentUsageRecord, "contextUsed" | "contextTotal">): { percent: number; level: "high" | "critical" } | null {
  const { contextUsed: used, contextTotal: total } = usage;
  if (used === null || total === null || !(total > 0) || !(used >= 0)) return null;
  const share = used / total;
  return share >= 0.85 ? { percent: Math.min(100, Math.round(share * 100)), level: share >= 0.95 ? "critical" : "high" } : null;
}

/**
 * What a directory update must change before the page refreshes its other data (opus-F6): state, attention, requests, a
 * new prompt, archive. A running turn reports usage on every model call; those updates alone change none of these.
 */
export { activitySignature } from "./activity-signature";

export function matchesAgent(agent: AgentRecord, filter: AgentFilter): boolean {
  if (filter.statuses?.length && !filter.statuses.some(status => matchesStatus(agent.status, status))) return false;
  if (filter.workspaceId && agent.workspaceId !== filter.workspaceId) return false;
  if (filter.provider && agent.provider !== filter.provider) return false;
  if (filter.readFilter === "unread" && !isUnreadCompletion(agent)) return false;
  if (filter.readFilter === "read" && completionReadState(agent) !== "read") return false;
  const query = filter.query?.trim().toLocaleLowerCase();
  if (!query) return true;
  const haystack = [agent.id, agent.title, agent.provider, agent.model, agent.projectId, agent.projectName, agent.projectRootPath, agent.workspaceName, agent.worktreeName, agent.worktreePath, agent.branch, agent.cwd, ...Object.values(agent.labels)].filter(Boolean).join(" ").toLocaleLowerCase();
  return query.split(/\s+/).every((part) => haystack.includes(part));
}

/** Keep ancestors of matches, as well as descendants of matching parents, for tree context. */
export function filterAgentForest(forest: readonly AgentTreeNode[], filter: AgentFilter): AgentTreeNode[] {
  const retained = new Map<AgentTreeNode, AgentTreeNode>();
  const stack: { node: AgentTreeNode; parentMatched: boolean; exit: boolean }[] = forest.map((node) => ({ node, parentMatched: false, exit: false })).reverse();
  while (stack.length) {
    const frame = stack.pop()!;
    const direct = matchesAgent(frame.node.agent, filter);
    if (!frame.exit) {
      stack.push({ ...frame, exit: true });
      for (let i = frame.node.children.length - 1; i >= 0; i--) stack.push({ node: frame.node.children[i]!, parentMatched: frame.parentMatched || direct, exit: false });
    } else {
      const children = frame.node.children.map((child) => retained.get(child)).filter((child): child is AgentTreeNode => !!child);
      if (direct || frame.parentMatched || children.length) retained.set(frame.node, { ...frame.node, children });
    }
  }
  return forest.map((node) => retained.get(node)).filter((node): node is AgentTreeNode => !!node);
}

export function flattenAgentForest(forest: readonly AgentTreeNode[]): Array<{ node: AgentTreeNode; depth: number }> {
  const result: Array<{ node: AgentTreeNode; depth: number }> = [];
  const stack = forest.map((node) => ({ node, depth: 0 })).reverse();
  while (stack.length) {
    const entry = stack.pop()!;
    result.push(entry);
    for (let i = entry.node.children.length - 1; i >= 0; i--) stack.push({ node: entry.node.children[i]!, depth: entry.depth + 1 });
  }
  return result;
}

export function statusLabel(status: AgentStatus): string {
  return { running: t("sharedModel.m004"), waiting: t("sharedModel.m005"), idle: t("sharedModel.m006"), completed: t("sharedModel.m007"), quiet: t("sharedModel.m008"), error: t("sharedModel.m009"), initializing: t("sharedModel.m010"), closed: t("sharedModel.m011"), canceled: t("sharedModel.m012") }[status];
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null || !Number.isFinite(milliseconds)) return "—";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return t("sharedModel.m013", { seconds: seconds });
  if (seconds < 3600) return t("sharedModel.m014", { value1: Math.floor(seconds / 60), value2: seconds % 60 });
  if (seconds < 86400) return t("sharedModel.m015", { value1: Math.floor(seconds / 3600), value2: Math.floor(seconds % 3600 / 60) });
  return t("sharedModel.m016", { value1: Math.floor(seconds / 86400), value2: Math.floor(seconds % 86400 / 3600) });
}

export function formatRelativeTime(value: string | null | undefined, now = Date.now()): string {
  const at = timestamp(value);
  if (at === null || !Number.isFinite(now)) return "—";
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 5) return t("sharedModel.m017");
  if (seconds < 60) return t("sharedModel.m018", { seconds: seconds });
  if (seconds < 3600) return t("sharedModel.m019", { value1: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("sharedModel.m020", { value1: Math.floor(seconds / 3600) });
  return t("sharedModel.m021", { value1: Math.floor(seconds / 86400) });
}

export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`;
  return Math.floor(value).toLocaleString();
}
