import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { AGENT_STATUSES, knownCompletionAt, timestamp, type AgentRecord } from "./model";

const iso = z.iso.datetime({ offset: true });
const viewKey = z.string().min(1).max(256);
export const viewPreferencesSchema = z.object({
  query: z.string().max(1000), status: z.enum(["all", ...AGENT_STATUSES]),
  readFilter: z.enum(["all", "unread", "read"]),
  workspace: z.string().max(512), project: z.string().max(1024), checkout: z.string().max(2048), provider: z.string().max(128),
  range: z.enum(["24h", "7d", "30d", "all"]), sessionScope: z.enum(["all", "current", "history"]),
  view: z.enum(["tree", "list"]), sort: z.enum(["attention", "recent"]),
  expanded: z.array(z.string().min(1).max(256)).max(2000), scrollOffset: z.number().finite().min(0).max(100_000_000),
  // 2.2 quick scope「需要处理」. Optional so views stored by older versions still parse; older servers strip it.
  focus: z.enum(["all", "attention"]).optional(),
});
export const savedViewSchema = z.object({
  id: z.string().min(1).max(128), name: z.string().trim().min(1).max(80), createdAt: iso, updatedAt: iso, view: viewPreferencesSchema,
});
export const completionSnoozeSchema = z.object({
  agentId: z.string().min(1).max(256), completionAt: iso, until: iso,
});
/** Host-wide settings, shared by every page and the sidebar badge. */
export const observatorySettingsSchema = z.object({
  /** 「子 Agent 完成计入需要处理」: off by default, the parent has the result already. */
  childCompletions: z.boolean(),
  /**
   * 「显示后台工作区里的 Agent」: Agents in background workspaces (Paseo 0.12+; Paseo Bots keeps its chats there) are listed and counted too.
   * Off by default, as in Paseo's own lists. Optional so a reply from an older server still parses.
   */
  backgroundWorkspaces: z.boolean().optional(),
});
export const defaultObservatorySettings: ObservatorySettings = { childCompletions: false, backgroundWorkspaces: false };
export const preferencesSnapshotSchema = z.object({
  revision: z.number().int().nonnegative(), view: viewPreferencesSchema,
  savedViews: z.array(savedViewSchema).max(12), snoozes: z.array(completionSnoozeSchema).max(2000), error: z.string().nullable(),
  // Optional so a reply from an older server still parses.
  settings: observatorySettingsSchema.optional(),
});
export const getPreferences = defineRpc({
  name: "observatory.preferences.get", input: z.object({ viewKey }), output: preferencesSnapshotSchema,
});
export const updatePreferences = defineRpc({
  name: "observatory.preferences.update",
  input: z.object({
    viewKey, expectedRevision: z.number().int().nonnegative(), view: viewPreferencesSchema.partial().optional(),
    saveView: z.object({ id: z.string().min(1).max(128).optional(), name: z.string().trim().min(1).max(80), view: viewPreferencesSchema }).optional(),
    deleteSavedViewId: z.string().min(1).max(128).optional(),
    snooze: completionSnoozeSchema.optional(),
    unsnooze: z.object({ agentId: z.string().min(1).max(256), completionAt: iso }).optional(),
    settings: observatorySettingsSchema.partial().optional(),
  }),
  output: preferencesSnapshotSchema.extend({ status: z.enum(["updated", "conflict"]) }),
});

export type ViewPreferences = z.infer<typeof viewPreferencesSchema>;
export type ObservatorySettings = z.infer<typeof observatorySettingsSchema>;
export type SavedView = z.infer<typeof savedViewSchema>;
export type CompletionSnooze = z.infer<typeof completionSnoozeSchema>;
export type PreferencesSnapshot = z.infer<typeof preferencesSnapshotSchema>;
export type PreferencesUpdate = z.infer<typeof updatePreferences.input>;
export type PreferencesUpdateResult = z.infer<typeof updatePreferences.output>;

export function defaultViewPreferences(key = "overview"): ViewPreferences {
  const archived = key === "archives" || key.endsWith(":archives");
  return { query: "", status: "all", readFilter: "all", workspace: "all", project: "all", checkout: "all", provider: "all",
    range: "7d", sessionScope: "all", view: archived ? "list" : "tree", sort: archived ? "recent" : "attention", expanded: [], scrollOffset: 0 };
}

/**
 * What a snooze is tied to: the completion, or for 待回复 the host's attention stamp of the reply that asks you (opus-F1).
 * A newer result or question has a newer token and is shown again.
 */
export function snoozeToken(agent: AgentRecord): string | null {
  if (agent.status === "idle" && !agent.archivedAt && agent.requiresAttention === true && agent.attentionReason === "finished") {
    // The host's stamp stays at the first reply nobody read (edge-triggered): after a newer prompt, that prompt names the turn.
    // A heartbeat (any system notification) moves neither, so a turn this plugin saw start after both is named by that start:
    // known while the turn ran, the same on the page and for the badge, and new each round (codex-obs-attn-F1).
    const stamp = timestamp(agent.attentionTimestamp), prompt = timestamp(agent.lastUserMessageAt), started = timestamp(agent.observedTurnStartedAt);
    if (stamp !== null && started !== null && started > stamp && (prompt === null || started > prompt)) return agent.observedTurnStartedAt ?? null;
    return prompt !== null && (stamp === null || prompt > stamp) ? agent.lastUserMessageAt : agent.attentionTimestamp ?? null;
  }
  return knownCompletionAt(agent);
}
/** Snoozing affects only one completion token; it never changes native read state. */
export function isCompletionSnoozed(agent: AgentRecord, snoozes: readonly CompletionSnooze[], now = Date.now()): boolean {
  const completionAt = snoozeToken(agent);
  if (!completionAt) return false;
  const token = Date.parse(completionAt);
  return snoozes.some(snooze => snooze.agentId === agent.id && Date.parse(snooze.completionAt) === token && Date.parse(snooze.until) > now);
}
/** The earliest instant after `now` at which one snooze stops applying; Infinity if none. */
export function nextSnoozeExpiry(snoozes: readonly CompletionSnooze[], now: number): number {
  let next = Infinity;
  for (const snooze of snoozes) { const until = Date.parse(snooze.until); if (until > now) next = Math.min(next, until); }
  return next;
}
