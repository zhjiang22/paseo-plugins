import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLike } from "./types";

interface StoredRecord {
  id?: unknown;
  provider?: unknown;
  cwd?: unknown;
  workspaceId?: unknown;
  title?: unknown;
  createdAt?: unknown;
  archivedAt?: unknown;
  labels?: unknown;
  lastModeId?: unknown;
  attentionReason?: unknown;
  lastError?: unknown;
  config?: { model?: unknown; thinkingOptionId?: unknown; modeId?: unknown } | null;
  persistence?: { provider?: unknown; sessionId?: unknown; metadata?: { model?: unknown } | null } | null;
}

const text = (value: unknown) => (typeof value === "string" && value ? value : null);

/**
 * The daemon's own record of an agent, `$PASEO_HOME/agents/<project>/<id>.json`. The daemon cannot load an agent whose
 * provider was switched off (paused after its quota ran out, say), but its record still names the session, and
 * that is all a move needs. It is not loaded, so it is never running.
 */
export async function readStoredAgent(agentId: string, home: string): Promise<AgentLike | null> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(agentId)) return null;
  let directories: string[];
  try {
    directories = await readdir(join(home, "agents"));
  } catch {
    return null;
  }
  for (const directory of directories) {
    let record: StoredRecord;
    try {
      record = JSON.parse(await readFile(join(home, "agents", directory, `${agentId}.json`), "utf8")) as StoredRecord;
    } catch {
      continue;
    }
    const provider = text(record.provider);
    const cwd = text(record.cwd);
    if (record.id !== agentId || !provider || !cwd) continue;
    const sessionId = text(record.persistence?.sessionId);
    return {
      id: agentId,
      provider,
      cwd,
      workspaceId: text(record.workspaceId),
      status: "closed",
      title: text(record.title),
      model: text(record.config?.model) ?? text(record.persistence?.metadata?.model),
      thinkingOptionId: text(record.config?.thinkingOptionId),
      currentModeId: text(record.lastModeId) ?? text(record.config?.modeId),
      createdAt: text(record.createdAt) ?? undefined,
      archivedAt: text(record.archivedAt),
      labels: record.labels && typeof record.labels === "object" ? (record.labels as Record<string, string>) : {},
      persistence: sessionId ? { provider: text(record.persistence?.provider) ?? provider, sessionId } : null,
      attentionReason: text(record.attentionReason),
      lastError: text(record.lastError),
    };
  }
  return null;
}
