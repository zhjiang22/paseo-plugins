import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { REPLY_NUDGES } from "./reply";

export const changeRequestSchema = z.object({ url: z.string().max(2000).regex(/^https?:\/\//), label: z.string().max(40), kind: z.enum(["mr", "pr"]) });
export type ChangeRequestLink = z.infer<typeof changeRequestSchema>;

/** These are observations made while this plugin is enabled, not lifetime session totals. */
export const agentTelemetrySchema = z.object({
  agentId: z.string().min(1).max(256),
  turnStartedAt: z.iso.datetime().nullable(),
  turnEndedAt: z.iso.datetime().nullable(),
  outcome: z.enum(["completed", "failed", "canceled"]).nullable(),
  completedTurns: z.number().int().nonnegative(),
  failedTurns: z.number().int().nonnegative(),
  canceledTurns: z.number().int().nonnegative(),
  totalRunMs: z.number().nonnegative(),
  permissionWaitMs: z.number().nonnegative(),
  /** The latest turn's final reply: when it was written and whether it hands the next step to the user (待回复). Never its text. */
  replyAt: z.iso.datetime().nullable().optional(),
  replyAsks: z.boolean().nullable().optional(),
  /** What that reply invites (快捷回复, opus-B26), its category only; cleared with `replyAsks` by the next turn. */
  replyNudge: z.enum(REPLY_NUDGES).nullable().optional(),
  /** The user message (its time) a backfill already read the reply for, so each turn's tail is fetched at most once. */
  replyFor: z.iso.datetime().nullable().optional(),
  /**
   * Why the latest turn stopped when that is not simply done (usage limit with its reset, empty, unfinished). Never text.
   * `resetGuessed`: the notice named no time zone, so the reset is read in the devices' (grok-F2). `closedMidTurn`: the host
   * closed the Agent while the turn was open, which raises no attention of its own. `seenAt`: 知道了 here (opus-F34).
   */
  stop: z.object({ kind: z.enum(["quota", "silent", "unfinished"]), resetAt: z.iso.datetime().nullable(), resetGuessed: z.boolean().optional(), at: z.iso.datetime(),
    closedMidTurn: z.boolean().optional(), seenAt: z.iso.datetime().nullable().optional() }).nullable().optional(),
  /** The latest merge or pull request a final reply linked to (opus-B16): its URL and `!12` / `#34`, never the reply. */
  link: changeRequestSchema.nullable().optional(),
});

export const telemetryEventSchema = z.object({
  id: z.string().min(1).max(128),
  agentId: z.string().min(1).max(256),
  agentTitle: z.string().max(160),
  at: z.iso.datetime(),
  type: z.enum([
    "created",
    "turn_started",
    "turn_completed",
    "turn_failed",
    "turn_canceled",
    "permission_requested",
    "permission_resolved",
    "archived",
  ]),
  label: z.string().max(160),
  /** Generated lifecycle text is rendered by stable type; old freeform labels remain untouched. */
  localized: z.boolean().optional(),
  permissionAllowed: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
});

export const telemetrySnapshotSchema = z.object({
  startedAt: z.iso.datetime(),
  persistenceError: z.string().nullable(),
  agents: z.array(agentTelemetrySchema).max(2_000),
  events: z.array(telemetryEventSchema).max(500),
});

const revision = z.string().min(1).max(80);
/**
 * `full` without a known revision; afterwards only summaries/events recorded after that revision (`delta`),
 * or a few bytes when nothing changed. A plugin reload issues a new revision generation and a full reply.
 */
export const telemetryResponseSchema = z.discriminatedUnion("mode", [
  telemetrySnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  // `eventCount` is how many events the server retains in this scope; the client trims to it after merging.
  telemetrySnapshotSchema.extend({ mode: z.literal("delta"), unchanged: z.literal(false), revision, eventCount: z.number().int().nonnegative().max(500) }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);

export const getTelemetry = defineRpc({
  name: "observatory.telemetry.get",
  input: z.object({ agentId: z.string().min(1).max(256).optional(), revision: revision.optional() }),
  output: telemetryResponseSchema,
});

export type AgentTelemetry = z.infer<typeof agentTelemetrySchema>;
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetrySnapshot = z.infer<typeof telemetrySnapshotSchema>;
export type TelemetryResponse = z.infer<typeof telemetryResponseSchema>;
export type TelemetryState = TelemetrySnapshot & { revision?: string };
export type TurnOutcome = NonNullable<AgentTelemetry["outcome"]>;

/**
 * The Chinese name of a lifecycle event. Events stored by 2.12 and earlier carry English labels; the type decides, so
 * old and new events read the same.
 */
export function eventLabel(event: Pick<TelemetryEvent, "type" | "label" | "localized" | "permissionAllowed">): string {
  // i18n-ignore: Exact historical lifecycle labels distinguish generated text from freeform stored content.
  const historical = new Set(["新建 Agent", "开始一轮", "完成一轮", "一轮失败", "一轮被取消", "等你审批或回答", "请求已批准", "请求被拒绝或撤销", "已归档"]);
  if (!event.localized && /[\u3400-\u9fff]/.test(event.label) && !historical.has(event.label)) return event.label;
  switch (event.type) {
    case "created": return t("sharedTelemetry.m001");
    case "turn_started": return t("sharedTelemetry.m002");
    case "turn_completed": return t("sharedTelemetry.m003");
    case "turn_failed": return t("sharedTelemetry.m004");
    case "turn_canceled": return t("sharedTelemetry.m005");
    case "permission_requested": return t("sharedTelemetry.m006");
    case "permission_resolved": return (event.permissionAllowed === false || (event.permissionAllowed === undefined && /declined|denied|cleared|拒绝|取消|撤销/i.test(event.label))) ? t("sharedTelemetry.m007") : t("sharedTelemetry.m008"); // i18n-ignore: Match original Chinese provider/user text; this is parser data.
    case "archived": return t("sharedTelemetry.m009");
  }
}

/** Count only events clearing optional filters can reveal, within the current page and time range. */
export function hiddenEventCount(retained: readonly TelemetryEvent[], shown: readonly TelemetryEvent[], sinceMs: number, availableAgentIds: ReadonlySet<string>): number {
  const visible = new Set(shown.map(event => event.id));
  return retained.filter(event => availableAgentIds.has(event.agentId) && Date.parse(event.at) >= sinceMs && !visible.has(event.id)).length;
}

/** Client cache update: deltas replace changed summaries and prepend new events, trimmed to the server's retained count. */
export function mergeTelemetry(previous: TelemetryState | undefined, response: TelemetryResponse | TelemetrySnapshot): TelemetryState {
  if (!("mode" in response)) return response;
  if (response.mode !== "full" && !previous) throw new Error(t("sharedTelemetry.m010"));
  if (response.mode === "unchanged") return previous!;
  if (response.mode === "full" || !previous) { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return snapshot; }
  const { mode: _mode, unchanged: _unchanged, eventCount, ...snapshot } = response;
  const agentIds = new Set(snapshot.agents.map(agent => agent.agentId)), eventIds = new Set(snapshot.events.map(event => event.id));
  return { ...snapshot, agents: [...snapshot.agents, ...previous.agents.filter(agent => !agentIds.has(agent.agentId))],
    events: [...snapshot.events, ...previous.events.filter(event => !eventIds.has(event.id))].slice(0, eventCount) };
}
