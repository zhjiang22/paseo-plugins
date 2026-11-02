import { translator } from "../../shared/i18n";
import { t } from "../../shared/text";
import { createHash } from "node:crypto";
import type { PaseoApi } from "../paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getDigest, type Digest, type DigestResponse } from "../../shared/digest";
import type { TelemetrySnapshot } from "../../shared/telemetry";
import type { TelemetryStore } from "../telemetry";
import type { TokenCallSource } from "../token-source";
import { TokenSessions } from "../token-session";
import { buildDigest } from "./build";
import { fetchHistory, type History } from "./reader";

interface Dependencies {
  tokens: TokenCallSource;
  telemetry: { snapshot(agentId?: string): Promise<Pick<TelemetrySnapshot, "events">> };
  now?: () => number;
  timeoutMs?: number;
  sessions?: TokenSessions;
}
interface Cached extends History { revision: string; digest: Digest }
interface Full { digest: Digest; revision: string }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
/** While a turn runs, open durations grow with time alone; the revision moves on this grain, matching the 30 s client poll (client/use-digest.ts). */
export const ACTIVE_CLOCK_MS = 30_000;

/** Bounded per-agent LRU; one in-flight fetch/build services all concurrent revision requests. */
export class DigestService {
  private readonly cache = new Map<string, Cached>();
  private readonly pending = new Map<string, Promise<Full>>();
  private readonly cancellations = new Set<(error: Error) => void>();
  private closed = false;
  private readonly now: () => number;
  private readonly sessions: TokenSessions;
  constructor(private readonly deps: Dependencies) {
    this.now = deps.now ?? Date.now; this.sessions = deps.sessions ?? new TokenSessions({ now: this.now });
  }

  private async build(paseo: PaseoApi, agentId: string, signal: { aborted: boolean }): Promise<Full> {
    const handle = paseo.agents.ref(agentId);
    let snapshot;
    try { snapshot = await handle.refresh(); }
    catch (error) {
      if (error instanceof Error && /agent (?:not found|does not exist)/i.test(error.message)) {
        this.cache.delete(agentId); throw new Error(t("serverDigestIndex.m001"));
      }
      throw new Error(t("serverDigestIndex.m002"));
    }
    if (this.closed || signal.aborted) throw new Error(t("serverDigestIndex.m003"));
    if (!snapshot?.agent) { this.cache.delete(agentId); throw new Error(t("serverDigestIndex.m004")); }
    const agent = snapshot.agent, previous = this.cache.get(agentId);
    const session = this.sessions.resolve(agent.provider, agent.persistence, paseo);
    const [history, tokenHistory, telemetry, sessionId] = await Promise.all([
      fetchHistory(options => {
        if (this.closed || signal.aborted) throw new Error(t("serverDigestIndex.m005"));
        return handle.timeline.refetch(options);
      }, agentId, agent.cwd, previous),
      session.then(sessionId => {
        if (this.closed || signal.aborted) throw new Error(t("serverDigestIndex.m005"));
        return sessionId ? this.deps.tokens.callsForSessions([sessionId]) : null;
      }),
      this.deps.telemetry.snapshot(agentId), session,
    ]);
    if (this.closed || signal.aborted) throw new Error(t("serverDigestIndex.m006"));
    const now = this.now(), active = agent.status === "running" || agent.status === "initializing" || !!agent.activeTurn;
    const events = telemetry.events.filter(event => event.agentId === agentId);
    // Counts alone miss updates to an existing token call and telemetry's fixed-size eviction window. A source that versions
    // its calls (the logs' identity, size and read position) is hashed by that version instead of every call (opus-F70).
    const tokens = tokenHistory?.version ? [tokenHistory.source, tokenHistory.version] : tokenHistory;
    const revision = hash({ language: translator().language, catalog: translator().hash, epoch: history.state.epoch, seq: history.state.lastSeq, version: history.version, status: agent.status, active,
      sessionId, cwd: agent.cwd, rows: history.state.rows, truncated: history.state.truncated,
      tokens, events: events.map(({ id, at, type, durationMs }) => [id, at, type, durationMs]), clock: active ? Math.floor(now / ACTIVE_CLOCK_MS) : null });
    const digest = previous?.revision === revision ? previous.digest : buildDigest(history.state, { now, status: agent.status, activeTurn: !!agent.activeTurn, events }, tokenHistory);
    this.cache.delete(agentId); this.cache.set(agentId, { ...history, revision, digest });
    while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    return { digest, revision };
  }

  async read(input: { agentId: string; revision?: string }, paseo: PaseoApi): Promise<DigestResponse> {
    if (this.closed) throw new Error(t("serverDigestIndex.m007"));
    let task = this.pending.get(input.agentId);
    if (!task) {
      if (this.pending.size >= 24) throw new Error(t("serverDigestIndex.m008"));
      const signal = { aborted: false };
      let cancel!: (error: Error) => void;
      const aborted = new Promise<never>((_, reject) => { cancel = error => { signal.aborted = true; reject(error); }; });
      this.cancellations.add(cancel);
      const timer = setTimeout(() => cancel(new Error(t("serverDigestIndex.m009"))), this.deps.timeoutMs ?? 20_000);
      task = Promise.race([this.build(paseo, input.agentId, signal), aborted]).finally(() => {
        clearTimeout(timer); this.cancellations.delete(cancel);
        if (this.pending.get(input.agentId) === task) this.pending.delete(input.agentId);
      });
      this.pending.set(input.agentId, task);
    }
    const { digest, revision } = await task;
    return input.revision === revision ? { mode: "unchanged", unchanged: true, revision }
      : { ...digest, mode: "full", unchanged: false, revision };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const cancel of this.cancellations) cancel(new Error(t("serverDigestIndex.m010")));
    this.cache.clear(); this.pending.clear();
  }
}

export function registerDigest(server: PluginServerContext, deps: { tokens: TokenCallSource; telemetry: TelemetryStore }): () => Promise<void> {
  const service = new DigestService(deps);
  server.handle(getDigest, (input, { paseo }) => service.read(input, paseo));
  return () => service.close();
}
