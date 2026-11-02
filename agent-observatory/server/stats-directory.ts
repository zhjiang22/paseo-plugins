import { translator } from "../shared/i18n";
import { t } from "../shared/text";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { PaseoApi, PaseoAgentListResult } from "./paseo-types";
import type { StatsDirectoryAgent } from "./stats-types";
import { TokenSessions } from "./token-session";

const text = (value: string | null | undefined, max: number): string | null => value?.trim().slice(0, max) || null;
const count = (value: number | undefined): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
function descriptor({ agent, project }: PaseoAgentListResult["entries"][number], sessionId: string | null): StatsDirectoryAgent {
  const cwdName = basename(agent.cwd).slice(0, 1024);
  return { id: agent.id, createdAt: agent.createdAt, provider: text(agent.provider, 1024) ?? "unknown",
    model: text(agent.model, 1024), parentAgentId: text(agent.labels?.["paseo.parent-agent-id"], 256),
    // i18n-ignore: Legacy fallback project key is persisted and must not depend on the display language.
    projectKey: text(project?.projectKey, 1024) ?? (cwdName || "未知"), projectName: text(project?.projectName, 240) ?? (cwdName.slice(0, 240) || t("serverStatsDirectory.m001")),
    status: agent.status, archivedAt: agent.archivedAt ?? null, title: text(agent.title, 240),
    requiresAttention: !!agent.requiresAttention, attentionReason: agent.attentionReason ?? null,
    pendingPermissions: agent.pendingPermissions?.length ?? 0, activeTurn: !!agent.activeTurn, lastUserMessageAt: agent.lastUserMessageAt ?? null, updatedAt: agent.updatedAt ?? null,
    contextUsed: count(agent.lastUsage?.contextWindowUsedTokens), contextMax: count(agent.lastUsage?.contextWindowMaxTokens),
    sessionId, cwd: agent.cwd,
    workspaceId: text(agent.workspaceId, 256), scheduleId: text(agent.labels?.["paseo.schedule-id"], 80), scheduleRunId: text(agent.labels?.["paseo.schedule-run"], 120) };
}

/** One bounded metadata walk per minute, shared by the stats store and the token ledger. Failure retains the last complete walk. */
export class StatsDirectory {
  agents: StatsDirectoryAgent[] = [];
  truncated = false;
  digest = "empty";
  loaded = false;
  refreshedAt = -Infinity;
  private expiresAt = -Infinity;
  private textKey = "";
  private pending: Promise<void> | null = null;
  constructor(private readonly now: () => number = Date.now, private readonly sessions = new TokenSessions({ now })) {}

  refresh(paseo: PaseoApi): Promise<void> {
    if (this.pending) return this.pending;
    const textKey = `${translator().language}:${translator().hash}`;
    if (this.textKey === textKey && this.now() < this.expiresAt) return Promise.resolve();
    this.textKey = textKey;
    this.pending = this.walk(paseo).catch(() => {}).finally(() => {
      this.expiresAt = this.now() + 60_000;
      this.pending = null;
    });
    return this.pending;
  }

  private async walk(paseo: PaseoApi): Promise<void> {
    const refreshedAt = this.now();
    const deadline = performance.now() + 20_000;
    const agents = new Map<string, StatsDirectoryAgent>();
    const cursors = new Set<string>();
    let cursor: string | undefined, truncated = false;
    for (let page = 0; page < 20; page++) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let result: PaseoAgentListResult;
      try {
        result = await Promise.race([
          paseo.agents.list({ filter: { includeArchived: true },
            sort: [{ key: "created_at", direction: "desc" }], page: { limit: 200, ...(cursor ? { cursor } : {}) }, timeout: 15_000 }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(t("serverStatsDirectory.m002"))), Math.max(0, deadline - performance.now())); timer.unref?.(); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      const descriptors = await Promise.all(result.entries.map(async entry =>
        descriptor(entry, await this.sessions.resolve(entry.agent.provider, entry.agent.persistence, paseo))));
      for (const agent of descriptors) agents.set(agent.id, agent);
      if (!result.pageInfo.hasMore) break;
      const next = result.pageInfo.nextCursor;
      if (!next || cursors.has(next) || page === 19) { truncated = true; break; }
      cursors.add(next); cursor = next;
    }
    this.agents = [...agents.values()];
    this.truncated = truncated;
    this.loaded = true;
    this.refreshedAt = refreshedAt;
    // Include attribution/context/title changes as well as the required live status fields.
    this.digest = createHash("sha256").update(JSON.stringify([truncated, [...this.agents].sort((a, b) => a.id.localeCompare(b.id))])).digest("hex").slice(0, 20);
  }
}
