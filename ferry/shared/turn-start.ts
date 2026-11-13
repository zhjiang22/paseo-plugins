/**
 * Where a turn starts in an agent's timeline, for plugin code on the server and in the app. Kept in kit/ and copied into
 * each plugin's shared/ folder by `npm run kit:sync`: edit the kit/ copy.
 */

/** The fields these read; timeline items carry them as Paseo sends them. */
export interface TurnStartItem {
  type: string;
  name?: unknown;
  callId?: unknown;
  agentMessage?: unknown;
  text?: unknown;
  detail?: unknown;
}

/**
 * Whether a row starts a turn, as Paseo 0.14 decides for folding and paging (`isTimelineTurnTrigger`): a user message, a
 * message from another agent (a tool call carrying `agentMessage`), or a schedule or heartbeat prompt. 0.14 records that
 * prompt as a completed `heartbeat` tool call whose id starts with `paseo-system:`; 0.13 dropped it, so on 0.13 only the
 * first two occur. The id prefix is checked too, so an ordinary tool that happens to be named "heartbeat" stays a step.
 */
export function isTurnStart(item: TurnStartItem): boolean {
  if (item.type === "user_message") return true;
  if (item.type !== "tool_call") return false;
  if (item.agentMessage !== undefined && item.agentMessage !== null) return true;
  return item.name === "heartbeat" && typeof item.callId === "string" && item.callId.startsWith("paseo-system:");
}

export function hasTurnStart(items: readonly TurnStartItem[]): boolean {
  return items.some(isTurnStart);
}

/** The index of the row that starts the latest turn in `items`, or -1 when none of them starts one. */
export function latestTurnStart(items: readonly TurnStartItem[]): number {
  for (let index = items.length - 1; index >= 0; index--) if (isTurnStart(items[index]!)) return index;
  return -1;
}

/** What started a turn: the user's message, or the body of the agent message or schedule prompt ("" for other rows). */
export function turnStartText(item: TurnStartItem): string {
  if (!isTurnStart(item)) return "";
  if (item.type === "user_message") return typeof item.text === "string" ? item.text : "";
  const detail = item.detail as { text?: unknown } | null | undefined;
  if (detail && typeof detail === "object" && typeof detail.text === "string") return detail.text;
  const message = item.agentMessage as { text?: unknown } | null | undefined;
  return message && typeof message === "object" && typeof message.text === "string" ? message.text : "";
}
