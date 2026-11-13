// The parts of Paseo's agent records and API Ferry uses, typed loosely: a field Paseo adds or renames later should cost
// a feature, not a crash. The real `paseo` handed to plugin handlers satisfies these.

import type { SnapshotEntryLike, ProviderConfigLike } from "../shared/families";
import type { TimelinePaseo } from "./timeline-reader";

export interface AgentLike {
  id: string;
  provider: string;
  cwd: string;
  workspaceId?: string | null;
  status: string;
  title?: string | null;
  model?: string | null;
  thinkingOptionId?: string | null;
  currentModeId?: string | null;
  createdAt?: string;
  archivedAt?: string | null;
  labels?: Readonly<Record<string, string>>;
  persistence?: { provider?: string; sessionId?: string | null } | null;
  lastError?: string | null;
  attentionReason?: string | null;
  lastUsage?: { contextWindowUsedTokens?: number | null; contextWindowMaxTokens?: number | null } | null;
  activeTurn?: unknown;
}

export interface AgentListOptions {
  filter?: { labels?: Record<string, string>; includeArchived?: boolean; includeInternal?: boolean; includeBackground?: boolean; statuses?: string[] };
  page?: { limit: number; cursor?: string };
}

export interface TextAttachment {
  type: "text";
  mimeType: "text/plain";
  contextKind?: string;
  title?: string | null;
  text: string;
}

export interface PluginRow {
  type: "plugin";
  id: string;
  kind: string;
  version: number;
  data: unknown;
}

export interface AgentRefLike {
  refresh(): Promise<{ agent: AgentLike } | null>;
  archive(): Promise<unknown>;
  send(text: string, options?: { messageId?: string; attachments?: TextAttachment[] }): Promise<unknown>;
  timeline: ReturnType<TimelinePaseo["agents"]["ref"]>["timeline"] & { append(item: PluginRow): Promise<unknown> };
}

export interface CreateOptions {
  agentId?: string;
  idempotencyKey?: string;
  config: { provider: string; modeId?: string; thinkingOptionId?: string };
  title?: string | null;
  labels?: Record<string, string>;
  prompt?: string;
  clientMessageId?: string;
  attachments?: TextAttachment[];
}

export interface PaseoLike {
  agents: {
    ref(id: string): AgentRefLike;
    create(options: CreateOptions & { cwd: string }): Promise<{ id: string }>;
    list(options: AgentListOptions): Promise<{ entries: readonly { agent: AgentLike }[]; pageInfo?: { nextCursor: string | null; hasMore: boolean } | null }>;
  };
  workspaces: { ref(id: string): { agents: { create(options: CreateOptions): Promise<{ id: string }> } } };
  providers: {
    snapshot(): Promise<{ entries: readonly SnapshotEntryLike[] }>;
    waitForReady?(options?: { timeoutMs?: number }): Promise<{ entries: readonly SnapshotEntryLike[] }>;
  };
  config: { get(): Promise<{ config: { providers?: Readonly<Record<string, ProviderConfigLike | undefined>> | null; mcp?: { enabled?: boolean; injectIntoAgents?: boolean } | null } }> };
}

/** A message for the screens: a catalog id and its parameters, worded on each device in its own language. */
export interface Note {
  code: string;
  params?: Record<string, string | number>;
}
