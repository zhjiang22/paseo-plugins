import { randomUUID } from "node:crypto";
import type { PluginHookAgent, PluginServerContext } from "@getpaseo/plugin/server";
import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { GROK_DEFAULT_MODEL, grokRunnerLabel } from "../shared/insights";
import { RECAP_DEFAULTS, RECAP_GROK_EFFORT, getRecapStatus, getRecaps, recapSettings, type RecapSettings, type RecapStatus, type RecapView } from "../shared/recap";
import type { AgentTimelineItem, PaseoApi } from "./paseo-types";
import { languageName } from "./locales";
import { findGrokBinary, runGrokAnalysis } from "./grok-runner";
import { InsightRunnerRegistry, runPaseoStructured, type InsightRunnerPlan } from "./insight-runner";
import { isKnownInsightAgent, markInsightAgent } from "./insight-runner-lifecycle";
import { redactSecrets } from "./insight-analysis";
import { telemetryDirectory } from "./telemetry";
import { contentRevision } from "./revision";
import { buildRecapPrompt, endsWithReply, isCompacting, parseRecapOutput, recapOutputSchema, RECAP_SYSTEM_PROMPT, type ParsedRecap } from "./recap-prompt";
import { RecapStorage, retainRecaps, type StoredRecap } from "./recap-storage";
import { hookTimeline } from "./turn-timeline";

/** Quiet time after a turn ends before its recap is written: a reply or a new turn in it cancels the recap. */
export const RECAP_QUIET_MS = 10_000;
/** Recaps written at once, host-wide; the rest wait in a short queue (newest turn per Agent). */
export const RECAP_CONCURRENCY = 2;
const QUEUE_LIMIT = 16, MAX_AGENT_STATES = 2000;
const GROK_TIMEOUT_MS = 2 * 60_000, PROVIDER_TIMEOUT_MS = 4 * 60_000, SNAPSHOT_TIMEOUT_MS = 8_000;
/** No usable runner (no Grok CLI, a profile that cannot run): look again after this long. */
const UNAVAILABLE_MS = 5 * 60_000;
/** After a failed run new recaps pause 1, 2, 4 … minutes, at most 30; a written recap ends the pause. */
const BACKOFF_BASE_MS = 60_000, BACKOFF_MAX_MS = 30 * 60_000;
const BINARY_CACHE_MS = 5 * 60_000, SAVE_DELAY_MS = 1_000;
/**
 * A profile or another model writes through a temporary sub-agent the host keeps (archived; it cannot be deleted): such a run
 * starts at most once in this time per Agent, for its latest turn. The Grok CLI leaves nothing behind and has no such wait.
 */
export const RECAP_HELPER_COOLDOWN_MS = 30 * 60_000;

type Problem = "grok" | "runner";
/** The chosen runner cannot run now: not a failure, recaps simply wait. */
class RecapUnavailable extends Error { constructor(readonly problem: Problem, readonly reason: string | null) { super(problem); this.name = "RecapUnavailable"; } }
interface Job { agentId: string; seq: number; prompt: string; paseo: PaseoApi; title: string | null }
interface AgentState {
  /** Bumped by every turn start and end: a job runs only while its turn is still the Agent's latest. */
  seq: number;
  /** Approval requests still open. */
  permissions: Set<string>;
  timer: ReturnType<typeof setTimeout> | null;
  /** Waiting out the quiet time, or queued for a free slot. */
  job: Job | null;
  running: { seq: number; abort: AbortController } | null;
  /** When a profile or another model last started a recap for it (0: never). */
  helperAt: number;
}
type Plan = { kind: "grok"; binary: string; model: string; effort: string; label: string } | { kind: "paseo"; plan: InsightRunnerPlan; label: string };
export interface ObservedTurn { startedAt: string | null; endedAt: string | null }
export interface RecapManagerOptions {
  directory?: string; now?: () => number; quietMs?: number; concurrency?: number; helperCooldownMs?: number;
  findBinary?: () => Promise<string | null>; runGrok?: typeof runGrokAnalysis; runPaseo?: typeof runPaseoStructured;
  registry?: (paseo: PaseoApi) => Pick<InsightRunnerRegistry, "resolve">;
  /** When the plugin saw the Agent's latest turn start and end (the telemetry store); null when it holds no record. */
  observedTurn?: (agentId: string) => Promise<ObservedTurn | null>;
  /** The host's Agent directory as the stats walk last read it, to forget recaps of Agents archived or deleted since. */
  directoryAgents?: () => { loaded: boolean; truncated: boolean; refreshedAt: number; agents: ReadonlyArray<{ id: string; archivedAt: string | null }> };
  /** The Grok CLI's home and temp root (tests). */ grokHome?: string; tmp?: string;
}

const iso = (ms: number) => new Date(ms).toISOString();
const kindOf = (error: unknown) => error instanceof Error ? (error.name || "Error").slice(0, 40) : "Error";
async function within<T>(pending: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([pending, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); timer.unref?.(); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/**
 * 每轮小结 (turn summary) and 建议回复 for every top-level Agent. A turn that ends normally, on a reply, with nothing waiting
 * for approval and no compaction running, gets a recap once the Agent has rested `quietMs` (a new turn in that time cancels
 * it; each turn gets at most one try). The conversation comes from the turn's own hook (never a timeline read, which would
 * load an unloaded Agent); just before the model runs the host's fetch of the Agent (it never loads one) confirms it still
 * rests. At most `concurrency` run at once; a failure pauses new recaps with a growing backoff, a missing runner for five
 * minutes, and nothing is shown for either. A profile or another model runs for an Agent at most once in
 * `RECAP_HELPER_COOLDOWN_MS`, for its latest turn. Off on a new install (host setting `recap`); turning it off cancels what is
 * running and deletes every recap, with the file and any copy of it.
 */
export class RecapManager {
  private settings: RecapSettings = RECAP_DEFAULTS;
  private recaps = new Map<string, StoredRecap>();
  private readonly agents = new Map<string, AgentState>();
  private readonly queue = new Map<string, Job>();
  private readonly executions = new Set<Promise<unknown>>();
  private readonly registries = new WeakMap<PaseoApi, Pick<InsightRunnerRegistry, "resolve">>();
  private readonly storage: RecapStorage;
  private readonly now: () => number;
  private readonly quietMs: number;
  private readonly helperCooldownMs: number;
  private readonly concurrency: number;
  private readonly findBinary: () => Promise<string | null>;
  private readonly runGrok: typeof runGrokAnalysis;
  private readonly runPaseo: typeof runPaseoStructured;
  private active = 0;
  private failures = 0;
  private backoffUntil = 0;
  private unavailable: { until: number; problem: Problem; reason: string | null } | null = null;
  private last: { at: number; outcome: "written" | "failed" | "skipped" } | null = null;
  private binary: { at: number; value: Promise<string | null> } | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  readonly ready: Promise<void>;
  constructor(private readonly options: RecapManagerOptions = {}) {
    this.storage = new RecapStorage(options.directory ?? telemetryDirectory());
    this.now = options.now ?? Date.now; this.quietMs = options.quietMs ?? RECAP_QUIET_MS; this.helperCooldownMs = options.helperCooldownMs ?? RECAP_HELPER_COOLDOWN_MS; this.concurrency = Math.max(1, options.concurrency ?? RECAP_CONCURRENCY);
    this.findBinary = options.findBinary ?? findGrokBinary; this.runGrok = options.runGrok ?? runGrokAnalysis; this.runPaseo = options.runPaseo ?? runPaseoStructured;
    this.ready = this.storage.load(this.now()).then(recaps => { this.recaps = new Map(recaps.map(recap => [recap.agentId, recap])); });
  }

  /** The host setting, as read or changed; null when it is unreadable (recaps pause, nothing is forgotten). */
  async configure(values: RecapSettings | null): Promise<void> {
    await this.ready;
    if (this.closed) return;
    const before = this.settings;
    this.settings = values ?? { ...this.settings, enabled: false };
    if (!this.settings.enabled) { this.stop(); if (values) await this.forget(); return; }
    if (JSON.stringify(before.runner) !== JSON.stringify(this.settings.runner)) { this.unavailable = null; this.failures = 0; this.backoffUntil = 0; }
    if (!this.settings.suggestions) {
      let changed = false;
      for (const [agentId, recap] of this.recaps) if (recap.reply) { this.recaps.set(agentId, { ...recap, reply: null }); changed = true; }
      if (changed) this.save();
    }
  }

  turnStarted(agentId: string): void {
    if (this.closed) return;
    const state = this.agents.get(agentId);
    if (state) { state.seq++; state.permissions.clear(); this.drop(agentId, state); state.running?.abort.abort(); }
    // The recap now describes the turn before: it stays, marked out of date, without its suggested reply.
    const recap = this.recaps.get(agentId);
    if (recap && !recap.stale) { this.recaps.set(agentId, { ...recap, stale: true, reply: null }); this.save(); }
  }

  turnEnded(paseo: PaseoApi, agent: Pick<PluginHookAgent, "id" | "parentAgentId" | "title">, outcome: string, timeline: readonly AgentTimelineItem[]): void {
    if (this.closed || !this.settings.enabled) return;
    const state = this.state(agent.id);
    state.seq++;
    this.drop(agent.id, state);
    // Only a top-level Agent's normal turn that ended on a reply, with no compaction under way; never the plugin's own helpers.
    if (agent.parentAgentId || outcome !== "completed" || isKnownInsightAgent(agent.id) || isCompacting(timeline) || !endsWithReply(timeline)) return;
    let prompt: string | null;
    try { prompt = buildRecapPrompt(timeline, { language: currentLanguage(), languageName: languageName(), suggestions: this.settings.suggestions, title: agent.title }); }
    catch (error) { console.warn(`agent-observatory: recap input skipped (${kindOf(error)})`); return; }
    if (!prompt) return;
    const job: Job = { agentId: agent.id, seq: state.seq, prompt, paseo, title: agent.title };
    state.job = job;
    this.arm(job, state, this.quietMs);
  }
  private arm(job: Job, state: AgentState, ms: number): void {
    state.timer = setTimeout(() => { state.timer = null; this.release(job); }, ms);
    state.timer.unref?.();
  }

  permissionRequested(agentId: string, requestId: string): void {
    const state = this.agents.get(agentId);
    if (!state || this.closed) return;
    state.permissions.add(requestId);
    // A request after the turn ended (a plan, a question): no recap until the next turn ends.
    this.drop(agentId, state);
  }
  permissionResolved(agentId: string, requestId: string): void { this.agents.get(agentId)?.permissions.delete(requestId); }

  /** Archived: its recap goes too. */
  archived(agentId: string): void {
    const state = this.agents.get(agentId);
    if (state) { this.drop(agentId, state); state.running?.abort.abort(); this.agents.delete(agentId); }
    if (this.recaps.delete(agentId)) this.save();
  }

  /** The recaps to show, with a content revision: an unchanged list costs a few bytes. Empty while recaps are off. */
  async list(revision?: string) {
    await this.ready;
    this.prune();
    const enabled = this.settings.enabled, suggestions = enabled && this.settings.suggestions, views: RecapView[] = [];
    if (enabled) {
      for (const recap of this.recaps.values()) views.push({ ...recap, reply: suggestions && !recap.stale ? recap.reply : null, state: this.stateOf(recap.agentId) });
      for (const agentId of this.agents.keys()) {
        const state = this.stateOf(agentId);
        if (state !== "idle" && !this.recaps.has(agentId)) views.push({ agentId, summary: null, next: null, reply: null, at: null, roundAt: null, endedAt: null, stale: false, state, runner: null });
      }
    }
    const content = { enabled, suggestions, recaps: views.slice(0, 400) }, current = contentRevision(content);
    return revision === current ? { mode: "unchanged" as const, revision: current } : { mode: "full" as const, revision: current, ...content };
  }

  /** Who writes recaps and whether it can now, for the settings. */
  async status(paseo?: PaseoApi): Promise<RecapStatus> {
    await this.ready;
    const now = this.now(), runner = this.settings.runner;
    let label = this.grokLabel(), available = false, problem: RecapStatus["problem"] = null, reason: string | null = null;
    if (runner.kind === "grok" || runner.kind === "auto") {
      this.binary = null;
      available = !!(await this.grokBinary());
      if (!available) problem = "grok";
    } else if (paseo) {
      try { const plan = await this.registryOf(paseo).resolve(runner); label = plan.info.label; available = true; }
      catch (error) { problem = "runner"; reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300); label = runner.kind === "profile" ? runner.profileId.slice(0, 160) : runner.provider.slice(0, 160); }
    }
    if (available) this.unavailable = null;
    const pausing = available && now < this.backoffUntil;
    return { enabled: this.settings.enabled, suggestions: this.settings.suggestions, runner: label.slice(0, 160), available, problem: pausing ? "backoff" : problem, reason, until: pausing ? iso(this.backoffUntil) : null,
      active: this.active, queued: this.queue.size, lastAt: this.last ? iso(this.last.at) : null, lastOutcome: this.last?.outcome ?? null };
  }

  async close(): Promise<void> {
    await this.ready;
    this.closed = true;
    this.stop();
    if (this.executions.size) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.executions]), new Promise<void>(resolve => { timer = setTimeout(resolve, 4000); })]);
      if (timer) clearTimeout(timer);
    }
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    await this.storage.save([...this.recaps.values()], this.now());
    await this.storage.close();
  }

  private state(agentId: string): AgentState {
    let state = this.agents.get(agentId);
    if (!state) {
      state = { seq: 0, permissions: new Set(), timer: null, job: null, running: null, helperAt: 0 };
      this.agents.set(agentId, state);
      // Bounded: forget the oldest Agents with nothing under way.
      if (this.agents.size > MAX_AGENT_STATES) for (const [id, old] of this.agents) {
        if (this.agents.size <= MAX_AGENT_STATES) break;
        if (old !== state && !old.timer && !old.job && !old.running && !old.permissions.size && !this.cooldownLeft(old)) this.agents.delete(id);
      }
    }
    return state;
  }
  private stateOf(agentId: string): RecapView["state"] {
    const state = this.agents.get(agentId);
    // A job waiting out the cooldown is not under way: until then the Agent's recap simply stays out of date.
    return state?.running ? "generating" : state?.job && !this.cooldownLeft(state) ? "pending" : "idle";
  }
  /** How long the Agent still waits before a profile or another model may write its recap (none with the Grok CLI). */
  private cooldownLeft(state: AgentState): number {
    const kind = this.settings.runner.kind;
    return (kind === "profile" || kind === "provider") && state.helperAt ? Math.max(0, state.helperAt + this.helperCooldownMs - this.now()) : 0;
  }
  /** Its quiet wait or place in the queue ends; a run already started is the caller's to abort. */
  private drop(agentId: string, state: AgentState): void {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    state.job = null;
    this.queue.delete(agentId);
  }
  private stop(): void {
    for (const [agentId, state] of this.agents) { this.drop(agentId, state); state.running?.abort.abort(); }
    this.queue.clear();
  }
  /** Turned off: every recap goes, from memory and from disk with every copy of the file, even when memory held none. */
  private forget(): Promise<void> {
    this.recaps.clear();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    return this.storage.clear();
  }
  private paused(now = this.now()): boolean { return now < this.backoffUntil || (!!this.unavailable && now < this.unavailable.until); }

  /** The quiet time is over: run now, wait out the cooldown or for a slot, or skip (approval waiting, recaps paused). */
  private release(job: Job): void {
    const state = this.agents.get(job.agentId);
    if (!state || state.job !== job || state.seq !== job.seq || this.closed || !this.settings.enabled) return;
    // A newer turn's end replaces this job and a new turn drops it: what runs after the wait is the latest turn.
    const left = this.cooldownLeft(state);
    if (left > 0) { this.arm(job, state, left); return; }
    if (state.permissions.size || this.paused()) { state.job = null; this.note("skipped"); return; }
    if (this.active < this.concurrency) { this.start(job); return; }
    this.queue.delete(job.agentId); this.queue.set(job.agentId, job);
    for (const [agentId, queued] of this.queue) {
      if (this.queue.size <= QUEUE_LIMIT) break;
      this.queue.delete(agentId);
      const waiting = this.agents.get(agentId);
      if (waiting?.job === queued) waiting.job = null;
    }
  }
  private drain(): void {
    for (const [agentId, job] of this.queue) {
      if (this.active >= this.concurrency || this.closed) return;
      this.queue.delete(agentId);
      const state = this.agents.get(agentId);
      if (!state || state.job !== job || state.seq !== job.seq) continue;
      if (this.paused()) { state.job = null; continue; }
      this.start(job);
    }
  }
  private start(job: Job): void {
    const state = this.state(job.agentId), abort = new AbortController();
    state.job = null; state.running = { seq: job.seq, abort }; this.active++;
    const execution = this.generate(job, state, abort.signal).catch(() => {}).finally(() => {
      this.active--;
      if (state.running?.abort === abort) state.running = null;
      this.drain();
    });
    this.executions.add(execution);
    void execution.then(() => this.executions.delete(execution));
  }

  private async generate(job: Job, state: AgentState, signal: AbortSignal): Promise<void> {
    const current = () => !signal.aborted && !this.closed && state.seq === job.seq && this.settings.enabled;
    try {
      // The host's word on the Agent right now (a fetch, which never loads an Agent): still resting, nothing waiting for
      // approval, not archived, and not one of the plugin's own analysis helpers.
      const snapshot = (await within(job.paseo.agents.ref(job.agentId).refresh(), SNAPSHOT_TIMEOUT_MS))?.agent;
      if (!current()) return;
      if (!snapshot || snapshot.archivedAt || snapshot.labels?.["observatory.role"] === "insight" || (snapshot.status !== "idle" && snapshot.status !== "closed") || (snapshot.pendingPermissions?.length ?? 0) > 0) { this.note("skipped"); return; }
      const plan = await this.plan(job.paseo);
      if (!current()) return;
      const turn = await (this.options.observedTurn?.(job.agentId) ?? Promise.resolve(null)).catch(() => null);
      const suggestions = () => this.settings.suggestions;
      let parsed: ParsedRecap;
      if (plan.kind === "grok") {
        const output = await this.runGrok({ binary: plan.binary, prompt: job.prompt, signal, timeoutMs: GROK_TIMEOUT_MS, model: plan.model, effort: plan.effort, schema: recapOutputSchema,
          systemPrompt: RECAP_SYSTEM_PROMPT, maxTurns: 3, ...(this.options.grokHome ? { grokHome: this.options.grokHome } : {}), ...(this.options.tmp ? { tmp: this.options.tmp } : {}) });
        if (!current()) return;
        parsed = parseRecapOutput(output, { suggestions: suggestions() });
      } else {
        const title = (snapshot.title || job.title || "").trim().slice(0, 40);
        // The host keeps the sub-agent this starts: the Agent's next recap waits out the cooldown.
        state.helperAt = this.now();
        const result = await this.runPaseo<ParsedRecap>({ paseo: job.paseo, plan: plan.plan, parent: { id: job.agentId, cwd: snapshot.cwd, workspaceId: snapshot.workspaceId ?? null, archived: false, title },
          jobId: `recap-${randomUUID()}`, title: t("serverRecap.helperTitle", { title }), prompt: job.prompt, systemPrompt: RECAP_SYSTEM_PROMPT, schema: recapOutputSchema,
          parse: text => parseRecapOutput(text, { suggestions: suggestions() }), signal, timeoutMs: PROVIDER_TIMEOUT_MS, now: this.now,
          onSession: runner => { if (runner.sessionAgentId) markInsightAgent(runner.sessionAgentId); } });
        if (!current()) return;
        parsed = result.value;
      }
      this.recaps.delete(job.agentId);
      this.recaps.set(job.agentId, { agentId: job.agentId, summary: parsed.summary, next: parsed.next, reply: suggestions() ? parsed.reply : null, at: iso(this.now()),
        roundAt: turn?.startedAt ?? null, endedAt: turn?.endedAt ?? null, stale: false, runner: plan.label.slice(0, 160) });
      this.failures = 0; this.backoffUntil = 0;
      this.note("written"); this.save();
    } catch (error) {
      // Cancelled by a new turn, the setting or a reload: not a failure.
      if (signal.aborted || this.closed || state.seq !== job.seq) return;
      if (error instanceof RecapUnavailable) { this.unavailable = { until: this.now() + UNAVAILABLE_MS, problem: error.problem, reason: error.reason }; this.note("skipped"); return; }
      this.failures++;
      this.backoffUntil = this.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(10, this.failures - 1));
      this.note("failed");
      // The kind only: a message can quote the conversation.
      console.warn(`agent-observatory: recap failed (${kindOf(error)}); recaps pause until ${iso(this.backoffUntil)}`);
    }
  }

  private grokLabel(): string {
    const runner = this.settings.runner;
    return grokRunnerLabel({ model: runner.kind === "grok" && runner.model ? runner.model : GROK_DEFAULT_MODEL, effort: runner.kind === "grok" && runner.effort ? runner.effort : RECAP_GROK_EFFORT });
  }
  private grokBinary(): Promise<string | null> {
    if (!this.binary || this.now() - this.binary.at >= BINARY_CACHE_MS) this.binary = { at: this.now(), value: this.findBinary().catch(() => null) };
    return this.binary.value;
  }
  private registryOf(paseo: PaseoApi): Pick<InsightRunnerRegistry, "resolve"> {
    let registry = this.registries.get(paseo);
    if (!registry) { registry = this.options.registry?.(paseo) ?? new InsightRunnerRegistry(paseo, { now: this.now }); this.registries.set(paseo, registry); }
    return registry;
  }
  /** The run's runner: the Grok CLI (low effort unless set) or the profile or provider, which must be able to run now. */
  private async plan(paseo: PaseoApi): Promise<Plan> {
    const runner = this.settings.runner;
    if (runner.kind === "grok" || runner.kind === "auto") {
      const binary = await this.grokBinary();
      if (!binary) throw new RecapUnavailable("grok", null);
      const model = runner.kind === "grok" && runner.model ? runner.model : GROK_DEFAULT_MODEL, effort = runner.kind === "grok" && runner.effort ? runner.effort : RECAP_GROK_EFFORT;
      return { kind: "grok", binary, model, effort, label: grokRunnerLabel({ model, effort }) };
    }
    try { const plan = await this.registryOf(paseo).resolve(runner); return { kind: "paseo", plan, label: plan.info.label }; }
    catch (error) { throw new RecapUnavailable("runner", redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300)); }
  }
  private note(outcome: "written" | "failed" | "skipped"): void { this.last = { at: this.now(), outcome }; }
  /** Recaps older than 30 days, and those of Agents the host has archived or deleted since (as its last directory walk saw). */
  private prune(): void {
    const now = this.now(), kept = retainRecaps([...this.recaps.values()], now);
    let changed = kept.length !== this.recaps.size;
    const directory = this.options.directoryAgents?.();
    if (directory?.loaded && !directory.truncated) {
      const known = new Map(directory.agents.map(agent => [agent.id, agent.archivedAt]));
      for (let index = kept.length - 1; index >= 0; index--) {
        const recap = kept[index]!, archivedAt = known.get(recap.agentId);
        // Absent from a walk that started after the recap was written: deleted. Archived: gone from the list.
        if (archivedAt || (archivedAt === undefined && Date.parse(recap.at) < directory.refreshedAt)) { kept.splice(index, 1); changed = true; }
      }
    }
    if (!changed) return;
    // Newest first in the file, oldest first in the map, as written.
    this.recaps = new Map(kept.reverse().map(recap => [recap.agentId, recap]));
    this.save();
  }
  private save(): void {
    if (this.saveTimer || this.closed) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.storage.save([...this.recaps.values()], this.now()); }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }
}

/**
 * The host setting `recap`, the hooks and `observatory.recap.list / status`. A host without settings storage keeps recaps
 * off. Returns the manager and its cleanup.
 */
export function registerRecaps(server: PluginServerContext, options: RecapManagerOptions = {}): { manager: RecapManager; close: () => Promise<void> } {
  const manager = new RecapManager(options);
  let stopSettings = () => {};
  try {
    const settings = server.registerSettings(recapSettings);
    const adopt = (state: { status: string; values?: unknown }) => { void manager.configure(state.status === "ready" ? state.values as RecapSettings : null); };
    stopSettings = settings.subscribe(adopt);
    settings.read().then(adopt, () => {});
  } catch { /* no settings storage: recaps stay off */ }
  server.handle(getRecaps, input => manager.list(input.revision));
  server.handle(getRecapStatus, (_input, { paseo }) => manager.status(paseo));
  const removers = [
    server.on("agent.turn_started", ({ agent }) => { manager.turnStarted(agent.id); }),
    server.on("agent.turn_ended", (event, { paseo }) => { manager.turnEnded(paseo, event.agent, event.outcome.kind, hookTimeline<AgentTimelineItem>(event)); }),
    server.on("agent.permission_requested", ({ agent, request }) => { manager.permissionRequested(agent.id, request.id); }),
    server.on("agent.permission_resolved", ({ agent, requestId }) => { manager.permissionResolved(agent.id, requestId); }),
    server.on("agent.archived", ({ agent }) => { manager.archived(agent.id); }),
  ];
  return { manager, close: async () => { stopSettings(); for (const remove of removers) remove(); await manager.close(); } };
}
