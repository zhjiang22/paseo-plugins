// How much history goes into a handoff, and which items. The idea follows T3 Code's handoff (design only, no code):
// whole items, never a cut through the middle of the list; the latest request, the latest reply and the original
// request first; then from newest to oldest, skipping what does not fit and carrying on. Two changes: background items
// (reads, notices) only fill what is left at the end, and every item is shortened to a fair share first, so one huge
// output can never push everything else out.

import { BYTES_PER_TOKEN, byteLength, clipHead, clipMiddle, tokensOf } from "./bytes";
import { preamble, renderEnvelope, renderItem, type VisitLine } from "./envelope";
import type { NumberedItem } from "./model";

export const DEFAULT_WINDOW_TOKENS = 128_000;
/** The largest budget the settings allow (64k tokens), in bytes. */
export const MAX_ENVELOPE_BYTES = 192 * 1024;
export const IMAGE_TOKENS = 8192;
/** A delta that cannot get this much room is not worth sending: the target's context is nearly full. */
export const MIN_DELTA_BYTES = 2 * 1024;

export interface BudgetInput {
  /** The configured ceiling, in tokens. */
  capTokens: number;
  /** The target model's context window, when the provider reports it. */
  windowTokens?: number | null;
  /** What the target already holds (a returning agent's last known usage). */
  usedTokens?: number | null;
  /** The user's own message. */
  messageBytes: number;
  images?: number;
}

export interface Budget {
  cap: number;
  window: number;
  used: number;
  message: number;
  headroom: number;
  /** What the envelope may use, in bytes (the rest of the budget is in tokens). */
  effective: number;
}

export function handoffBudget(input: BudgetInput): Budget {
  const window = input.windowTokens && input.windowTokens > 0 ? input.windowTokens : DEFAULT_WINDOW_TOKENS;
  const used = Math.max(0, input.usedTokens ?? 0);
  const message = tokensOf(input.messageBytes) + Math.max(0, input.images ?? 0) * IMAGE_TOKENS;
  const headroom = Math.max(16_000, Math.floor(window / 4));
  const room = window - used - message - headroom;
  const effective = Math.min(MAX_ENVELOPE_BYTES, Math.max(0, Math.min(input.capTokens, room)) * BYTES_PER_TOKEN);
  return { cap: input.capTokens, window, used, message, headroom, effective };
}

export interface ItemLimits {
  /** Bytes for one message; also bounds plans. */
  message: number;
  /** Bytes of command output; 0 leaves output out. */
  output: number;
}

export function itemLimits(budgetBytes: number, options: { includeToolOutput: boolean; toolOutputBytes: number }): ItemLimits {
  return {
    message: Math.max(1024, Math.floor(budgetBytes * 0.3)),
    output: options.includeToolOutput ? Math.max(200, Math.min(options.toolOutputBytes, Math.floor(budgetBytes * 0.3))) : 0,
  };
}

/** An item's body as it goes into the envelope. */
export function itemBody(item: NumberedItem, limits: ItemLimits): string {
  switch (item.kind) {
    case "message":
      return clipHead(item.text, item.role === "agent" ? Math.min(4096, limits.message) : limits.message);
    case "plan":
      return clipHead(item.text, Math.min(8192, limits.message));
    case "command": {
      const newline = item.text.indexOf("\n");
      const command = clipHead(newline < 0 ? item.text : item.text.slice(0, newline), 600);
      const output = newline < 0 ? "" : item.text.slice(newline + 1);
      if (!output || limits.output === 0) return command;
      return `${command}\n${clipMiddle(output, limits.output)}`;
    }
    case "file_change":
    case "subagent":
    case "error":
      return clipHead(item.text, 1024);
    case "todo":
      return clipHead(item.text, 2048);
    case "prior_context":
      return clipHead(item.text, 4096);
    case "explored":
    case "tool":
      return clipHead(item.text, 600);
    default:
      return clipHead(item.text, 500);
  }
}

export interface Candidate {
  bytes: number;
  priority: 1 | 2 | 3;
  role: string;
  kind: string;
}

/**
 * Indexes of the candidates that fit in `budget` bytes after `overhead`, in time order. Candidates are in time order.
 */
export function selectItems(candidates: readonly Candidate[], budget: number, overhead: number): number[] {
  const picked = new Set<number>();
  let used = overhead;
  const add = (index: number) => {
    if (index < 0 || picked.has(index)) return;
    const size = candidates[index]!.bytes + 1;
    if (used + size > budget) return;
    picked.add(index);
    used += size;
  };
  const last = (test: (candidate: Candidate) => boolean) => {
    for (let index = candidates.length - 1; index >= 0; index--) if (test(candidates[index]!)) return index;
    return -1;
  };
  const isUser = (candidate: Candidate) => candidate.role === "user" && candidate.kind === "message";
  add(last(isUser));
  add(last((candidate) => candidate.role === "assistant" && candidate.kind === "message"));
  add(candidates.findIndex(isUser));
  add(last((candidate) => candidate.kind === "todo"));
  for (let index = candidates.length - 1; index >= 0; index--) if (candidates[index]!.priority <= 2) add(index);
  for (let index = candidates.length - 1; index >= 0; index--) add(index);
  return [...picked].sort((a, b) => a - b);
}

/** Runs of item numbers in `numbers` that are not in `picked`, as [first, last] pairs. */
export function omittedRanges(numbers: readonly number[], picked: ReadonlySet<number>): [number, number][] {
  const ranges: [number, number][] = [];
  for (const number of numbers) {
    if (picked.has(number)) continue;
    const previous = ranges[ranges.length - 1];
    if (previous && previous[1] === number - 1) previous[1] = number;
    else ranges.push([number, number]);
  }
  return ranges;
}

export interface BuildInput {
  id: string;
  chainId: string;
  mode: "full" | "delta";
  cwd: string;
  visits: readonly VisitLine[];
  /** The items this envelope covers, in time order. */
  items: readonly NumberedItem[];
  budgetBytes: number;
  includeToolOutput: boolean;
  toolOutputBytes: number;
  recordPath: string | null;
  tool: string | null;
}

export interface BuiltEnvelope {
  text: string;
  bytes: number;
  selected: number;
  total: number;
  omitted: [number, number][];
  /** Numbers of the items sent. */
  numbers: number[];
}

export function buildEnvelope(input: BuildInput): BuiltEnvelope {
  const limits = itemLimits(input.budgetBytes, input);
  const rendered = input.items.map((item) => renderItem(item, itemBody(item, limits)));
  const candidates = input.items.map((item, index) => ({ bytes: byteLength(rendered[index]!), priority: item.priority, role: item.role, kind: item.kind }));
  // The preamble with every count at its widest, plus room for the omitted ranges it lists.
  const overhead =
    byteLength(
      preamble({
        id: input.id,
        chainId: input.chainId,
        mode: input.mode,
        cwd: input.cwd,
        visits: input.visits,
        selected: input.items.length,
        total: input.items.length,
        omitted: [],
        recordPath: input.recordPath,
        tool: input.tool,
      }),
    ) + 400;
  const picked = selectItems(candidates, input.budgetBytes, overhead);
  const pickedNumbers = new Set(picked.map((index) => input.items[index]!.n));
  const omitted = omittedRanges(
    input.items.map((item) => item.n),
    pickedNumbers,
  );
  const text = renderEnvelope({
    id: input.id,
    chainId: input.chainId,
    mode: input.mode,
    cwd: input.cwd,
    visits: input.visits,
    rendered: picked.map((index) => rendered[index]!),
    selected: picked.length,
    total: input.items.length,
    omitted,
    recordPath: input.recordPath,
    tool: input.tool,
  });
  return { text, bytes: byteLength(text), selected: picked.length, total: input.items.length, omitted, numbers: [...pickedNumbers] };
}
