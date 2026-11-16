import type { PluginHandlerContext } from "@getpaseo/plugin/server";

/**
 * Daemon API types, derived from the plugin SDK's own contracts instead of imported from `@getpaseo/client` /
 * `@getpaseo/protocol`. Paseo compiles a plugin from source and resolves its type imports too, but it supplies only
 * `@getpaseo/plugin` (with zod, React and React Native); deriving the types from it lets a Git install compile with
 * no `npm ci` step. They are the same types the SDK packages declare.
 */
export type PaseoApi = PluginHandlerContext["paseo"];
type Agents = PaseoApi["agents"];
export type PaseoAgentHandle = ReturnType<Agents["ref"]>;
export type PaseoAgent = NonNullable<ReturnType<PaseoAgentHandle["current"]>>;
export type PaseoAgentListResult = Awaited<ReturnType<Agents["list"]>>;
export type PaseoAgentCreateOptions = Parameters<Agents["create"]>[0];
export type PaseoAgentRefetchResult = NonNullable<Awaited<ReturnType<PaseoAgentHandle["refresh"]>>>;
export type PaseoAgentRunResult = Awaited<ReturnType<PaseoAgentHandle["waitForFinish"]>>;
export type PaseoAgentTimelineRefetchOptions = NonNullable<Parameters<PaseoAgentHandle["timeline"]["refetch"]>[0]>;
export type PaseoProviderSnapshotResult = Awaited<ReturnType<PaseoApi["providers"]["snapshot"]>>;
/** A projected timeline row's item. Taken from `timeline.refetch`: Paseo 0.16 dropped `agent.turn_ended`'s `timeline` from the SDK type. */
export type AgentTimelineItem = Awaited<ReturnType<PaseoAgentHandle["timeline"]["refetch"]>>["entries"][number]["item"];
export type ToolCallDetail = Extract<AgentTimelineItem, { type: "tool_call" }>["detail"];
export type AgentMode = PaseoAgent["availableModes"][number];
