// Timeline rows → handoff items. Paseo's projected timeline has one row per message and per tool call (its lifecycle
// already folded); this keeps what another agent needs to carry on and drops what it cannot use:
//
// - messages stay word for word (redacted, capped only when enormous); Ferry's own envelopes and Paseo's fork summary
//   are taken off the front of user messages, so a handoff never nests inside the next one;
// - commands keep their command line, exit code and output (start and end, where results and errors are);
// - reads, searches and fetches of a turn fold into one "explored" line, edits and writes into one "changed" line;
// - reasoning, plugin rows and info notices are dropped; only the latest task list is kept.
//
// The text stored here is generous; the envelope shortens each item again to fit the budget (see select.ts).

import { clipHead, clipMiddle } from "./bytes";
import { stripEnvelopes } from "./envelope";
import type { Item, ItemKind, Priority, Role } from "./model";
import { redact } from "./redact";
import { isTurnStart, turnStartText } from "./turn-start";

/** The fields of a timeline item this reads (Paseo's `AgentTimelineItem`, loosely typed so a new field breaks nothing). */
export interface RawItem {
  type: string;
  [field: string]: unknown;
  text?: unknown;
  message?: unknown;
  level?: unknown;
  name?: unknown;
  callId?: unknown;
  status?: unknown;
  error?: unknown;
  detail?: unknown;
  agentMessage?: unknown;
  items?: unknown;
  clientMessageId?: unknown;
  messageId?: unknown;
}

export interface RawRow {
  item: RawItem;
  timestamp?: string | null;
}

export const STORED_MESSAGE_BYTES = 128 * 1024;
export const STORED_OUTPUT_BYTES = 16 * 1024;
export const STORED_OTHER_BYTES = 8 * 1024;

const TRIVIAL_COMMAND =
  /^\s*(?:cd\s+\S+\s*&&\s*)?(?:ls|ll|pwd|cat|head|tail|wc|which|echo|find|rg|grep|sed\s+-n|stat|file|tree|du|df|ps|date|whoami|nl|less|more)\b/;

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const statusOf = (value: unknown): Item["status"] => (value === "failed" || value === "canceled" || value === "running" || value === "completed" ? value : undefined);

function errorText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  const message = record(value).message;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function brief(value: unknown, max: number): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  // Redacted before it is cut, so a cut never leaves half a key.
  return clipHead(redact(text).replace(/\s+/g, " ").trim(), max);
}

/** Lines added and removed in a unified diff, file headers excluded. */
export function diffStat(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    else if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  return { added, removed };
}

interface ChangeTally {
  edits: number;
  writes: number;
  added: number;
  removed: number;
  failed: number;
}

/** A place in the output that is filled at the end: the folded reads and changes of one turn. */
type Slot =
  | { kind: "item"; item: Item }
  | { kind: "explored"; lines: Map<string, number>; at: string | null }
  | { kind: "changes"; files: Map<string, ChangeTally>; at: string | null };

function make(role: Role, kind: ItemKind, priority: Priority, text: string, at: string | null | undefined, extra: Partial<Item> = {}): Item {
  return { role, kind, priority, text, at: at ?? null, ...extra };
}

function renderExplored(lines: Map<string, number>): string {
  return [...lines].map(([line, count]) => (count > 1 ? `${line} (×${count})` : line)).join("\n");
}

function renderChanges(files: Map<string, ChangeTally>): string {
  return [...files]
    .map(([path, tally]) => {
      const verb = tally.edits && tally.writes ? "edited and wrote" : tally.writes ? "wrote" : "edited";
      const counts = tally.added || tally.removed ? ` (+${tally.added} −${tally.removed})` : "";
      const times = tally.edits + tally.writes > 1 ? ` ×${tally.edits + tally.writes}` : "";
      const failed = tally.failed ? `, ${tally.failed} failed` : "";
      return `${verb} ${path}${counts}${times}${failed}`;
    })
    .join("\n");
}

function todoText(items: unknown): string {
  if (!Array.isArray(items)) return "";
  return items
    .map((entry) => {
      const task = record(entry);
      const done = task.completed === true || task.status === "completed";
      const mark = done ? "x" : task.status === "in_progress" ? "~" : " ";
      return `- [${mark}] ${str(task.text).trim()}`;
    })
    .join("\n");
}

/** Whether a tool name is Ferry's own history tool (as Claude names MCP tools, `mcp__paseo__<name>`, or bare). */
export function isOwnTool(name: string, toolName: string): boolean {
  return name === toolName || name.endsWith(`__${toolName}`);
}

/**
 * Handoff items for these rows, in order. `toolName` is Ferry's history tool: reading the history again is not part
 * of the conversation.
 */
export function normalizeRows(rows: readonly RawRow[], options: { toolName: string }): Item[] {
  const slots: Slot[] = [];
  let explored: Extract<Slot, { kind: "explored" }> | null = null;
  let changes: Extract<Slot, { kind: "changes" }> | null = null;
  let interrupted = false;
  let latestTodo: number | null = null;
  const push = (item: Item) => slots.push({ kind: "item", item });

  for (const row of rows) {
    const item = row.item;
    const at = row.timestamp ?? null;
    if (isTurnStart(item)) {
      explored = null;
      changes = null;
      interrupted = false;
    }
    switch (item.type) {
      case "user_message": {
        const stripped = stripEnvelopes(str(item.text));
        if (stripped.priorContext) push(make("system", "prior_context", 3, clipHead(redact(stripped.priorContext), STORED_OTHER_BYTES), at));
        if (stripped.typed) push(make("user", "message", 1, clipHead(redact(stripped.typed), STORED_MESSAGE_BYTES), at));
        break;
      }
      case "assistant_message": {
        const text = str(item.text).trim();
        if (!text) break;
        if (text.startsWith("[System Error]")) push(make("system", "error", 2, clipHead(redact(text), STORED_OTHER_BYTES), at));
        else push(make("assistant", "message", 1, clipHead(redact(text), STORED_MESSAGE_BYTES), at));
        break;
      }
      case "todo": {
        const text = todoText(item.items);
        if (!text) break;
        // Only the latest task list matters; an earlier one is replaced where it stood.
        if (latestTodo !== null) slots[latestTodo] = { kind: "item", item: make("system", "notice", 3, "", null) };
        latestTodo = slots.length;
        push(make("system", "todo", 1, clipHead(redact(text), STORED_OTHER_BYTES), at));
        break;
      }
      case "error": {
        const text = errorText(item.message).trim();
        if (text) push(make("system", "error", 2, clipHead(redact(text), STORED_OTHER_BYTES), at));
        break;
      }
      case "notification": {
        const level = str(item.level);
        const text = str(item.message).trim();
        if (text && (level === "warning" || level === "error")) push(make("system", level === "error" ? "error" : "notice", level === "error" ? 2 : 3, clipHead(redact(text), STORED_OTHER_BYTES), at));
        break;
      }
      case "compaction": {
        if (item.status === "loading") break;
        push(make("system", "compaction", 3, "The agent's context was compacted here; what came before was summarized for it.", at));
        break;
      }
      case "tool_call": {
        const name = str(item.name);
        if (isOwnTool(name, options.toolName)) break;
        const status = statusOf(item.status);
        const failure = status === "failed" ? redact(errorText(item.error)).trim() : "";
        const message = record(item.agentMessage);
        if (Object.keys(message).length) {
          const sender = record(message.sender);
          const from = str(sender.title) || str(sender.id) || "another agent";
          push(make("agent", "message", 1, clipHead(redact(str(message.text)), STORED_MESSAGE_BYTES), at, { from }));
          break;
        }
        if (isTurnStart(item)) {
          // A schedule or heartbeat prompt.
          const text = turnStartText(item).trim();
          if (text) push(make("system", "notice", 3, clipHead(redact(text), STORED_OTHER_BYTES), at));
          break;
        }
        if (status === "canceled" && !interrupted) {
          interrupted = true;
          push(make("system", "interrupt", 3, "The turn was interrupted here.", at));
        }
        const detail = record(item.detail);
        const type = str(detail.type);
        if (type === "read" || type === "search" || type === "fetch") {
          let line = "";
          if (type === "read") line = `read ${str(detail.filePath)}`;
          else if (type === "search") {
            const counts = typeof detail.numFiles === "number" ? ` (${detail.numFiles} files)` : "";
            line = `searched ${JSON.stringify(clipHead(redact(str(detail.query)), 200))}${counts}`;
          } else line = `fetched ${clipHead(redact(str(detail.url)), 300)}`;
          if (status === "failed") line += " (failed)";
          if (!explored) {
            explored = { kind: "explored", lines: new Map(), at };
            slots.push(explored);
          }
          explored.lines.set(line, (explored.lines.get(line) ?? 0) + 1);
          break;
        }
        if (type === "edit" || type === "write") {
          const path = str(detail.filePath) || "(unknown file)";
          if (!changes) {
            changes = { kind: "changes", files: new Map(), at };
            slots.push(changes);
          }
          const tally = changes.files.get(path) ?? { edits: 0, writes: 0, added: 0, removed: 0, failed: 0 };
          if (type === "write") tally.writes++;
          else tally.edits++;
          if (status === "failed") tally.failed++;
          else if (typeof detail.unifiedDiff === "string") {
            const stat = diffStat(detail.unifiedDiff);
            tally.added += stat.added;
            tally.removed += stat.removed;
          } else if (type === "write" && typeof detail.content === "string") tally.added += detail.content.split("\n").length;
          changes.files.set(path, tally);
          break;
        }
        const withFailure = (text: string) => (failure ? `${text}\nerror: ${clipHead(failure, 400)}` : text);
        if (type === "shell") {
          const command = str(detail.command).trim();
          const exitCode = typeof detail.exitCode === "number" ? detail.exitCode : null;
          const output = clipMiddle(redact(str(detail.output)).replace(/\s+$/, ""), STORED_OUTPUT_BYTES);
          const quiet = status === "completed" && (exitCode === 0 || exitCode === null) && TRIVIAL_COMMAND.test(command);
          const text = withFailure(`$ ${clipHead(redact(command), 2000)}${output ? `\n${output}` : ""}`);
          push(make("tool", "command", quiet ? 3 : 2, text, at, { status, exitCode }));
          break;
        }
        if (type === "plan") {
          push(make("assistant", "plan", 1, clipHead(redact(str(detail.text)), STORED_OTHER_BYTES), at, { status }));
          break;
        }
        if (type === "sub_agent") {
          const head = [str(detail.subAgentType) || "subagent", str(detail.description)].filter(Boolean).join(": ");
          const log = str(detail.log).trim();
          const text = withFailure(`${head}${log ? `\n${clipMiddle(redact(log), 2000)}` : ""}`);
          push(make("tool", "subagent", 2, clipHead(redact(text), STORED_OTHER_BYTES), at, { status }));
          break;
        }
        if (type === "worktree_setup") break;
        if (type === "plain_text") {
          const parts = [str(detail.label).trim(), str(detail.text).trim()].filter(Boolean);
          const text = withFailure(`${name}${parts.length ? `: ${parts.join("\n")}` : ""}`);
          push(make("tool", "tool", 3, clipHead(redact(text), STORED_OTHER_BYTES), at, { status }));
          break;
        }
        // Any other tool (MCP tools arrive as "unknown"): its name, then input and output in brief.
        const input = brief(detail.input, 300);
        const output = brief(detail.output, 300);
        const text = withFailure(`${name}${input ? ` ${input}` : ""}${output ? `\n→ ${output}` : ""}`);
        push(make("tool", "tool", 3, redact(text), at, { status }));
        break;
      }
      default:
        // reasoning, plugin rows and anything newer: not part of what is handed over.
        break;
    }
  }

  const items: Item[] = [];
  for (const slot of slots) {
    if (slot.kind === "item") {
      if (slot.item.text) items.push(slot.item);
    } else if (slot.kind === "explored") {
      if (slot.lines.size) items.push(make("tool", "explored", 3, clipHead(renderExplored(slot.lines), STORED_OTHER_BYTES), slot.at));
    } else if (slot.files.size) {
      items.push(make("tool", "file_change", 2, clipHead(renderChanges(slot.files), STORED_OTHER_BYTES), slot.at));
    }
  }
  return items;
}
