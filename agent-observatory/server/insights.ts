import { t } from "../shared/text";
import { createHash, randomUUID } from "node:crypto";
import type { PaseoApi } from "./paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { cancelInsight, getInsightState, getInsightReport, grokModelLabel, grokRunnerLabel, listInsightJobs, listInsightRunners, listInsightModels, insightReportSchema, setFindingFeedback, startInsight, updateInsightSettings,
  type FindingFeedback, type InsightJob, type InsightListState, type InsightSettings, type InsightRunner } from "../shared/insights";
import type { SessionTrajectory, TrajectoryRow } from "../shared/trajectory";
import { assessTrajectory, buildAnalysisRequest, InsightReportError, isUsefulInsightReport, parseGrokReport, redactSecrets, trajectoryFingerprint } from "./insight-analysis";
import { excerptText } from "../shared/evidence";
import { ANALYSIS_SYSTEM_PROMPT, findGrokBinary, GrokTurnLimitError, runGrokAnalysis } from "./grok-runner";
import { abortable, fetchTrajectory } from "./trajectory";
import { telemetryDirectory } from "./telemetry";
import { fitInsightReport, InsightStorage, retainInsightJobs, summarizeInsight, type InsightActivity, type InsightCooldown } from "./insight-storage";

import { AUTO_RUNNER_LABEL, BUILTIN_INSIGHT_RUNNER, InsightRunnerRegistry, NO_RUNNER_ERROR, cleanupInsightAgents, grokPlan, runPaseoStructured } from "./insight-runner";
import { isInsightAgent, isKnownInsightAgent, markInsightAgent } from "./insight-runner-lifecycle";
import { turnRead } from "./lifecycle-hub";
import { hookTimeline, isTurnStart, turnTimeline } from "./turn-timeline";
import { getInsightOverview, getInsightSuggestions, startInsightSuggestions, cancelInsightSuggestions, setActionFeedback,
  suggestionReportSchema, type OverviewDays, type SuggestionJob, type ActionFeedback } from "../shared/insight-overview";
import { buildInsightOverview, getSuggestionTiming, summarizeSuggestion } from "./insight-overview";
import { collectSuggestionContext, buildSuggestionPrompt, parseSuggestionText, suggestionZone, windowClock, SUGGESTION_SYSTEM_PROMPT, type SuggestionClock } from "./insight-suggestions";
import { SuggestionStorage, retainSuggestionJobs } from "./insight-suggestions-storage";

const ACTIVE = new Set<InsightJob["status"]>(["queued", "collecting", "analyzing"]);
const defaults: InsightSettings = { autoEnabled: false, minTurns: 3, minTools: 3, cooldownHours: 6, runner: { kind: "auto" } };
type ReportQueueEntry = { kind: "report"; id: string; paseo: PaseoApi; question?: string; mode: "full" | "incremental"; runner?: InsightRunner };
/** `clock`: whose days the window is cut in, fixed when the job is queued (the client's, else the devices' last zone). */
type SuggestionQueueEntry = { kind: "suggestion"; id: string; paseo: PaseoApi; runner?: InsightRunner; clock: SuggestionClock | null };
type QueueEntry = ReportQueueEntry | SuggestionQueueEntry;
export interface InsightManagerOptions {
  directory?: string; now?: () => number; findBinary?: typeof findGrokBinary; run?: typeof runGrokAnalysis; fetch?: typeof fetchTrajectory;
  /**
   * The zone a client reported last (DeviceZone.device()), for suggestion windows queued without a client's clock:
   * automatic suggestions in the background (grok-F3). Null or absent: UTC days, which the job then says.
   */
  zone?: () => string | null;
}
export class InsightManager {
  private settings = structuredClone(defaults);
  private readonly registries = new WeakMap<PaseoApi, InsightRunnerRegistry>();
  private cleanup: Promise<void> | null = null;
  private lastPaseo: PaseoApi | undefined;
  private jobs: InsightJob[] = [];
  private suggestionJobs: SuggestionJob[] = [];
  private readonly suggestionStorage: SuggestionStorage;
  private cooldowns: Record<string, InsightCooldown> = {};
  private activity: Record<string, InsightActivity> = {};
  private revision = 1;
  private queue: QueueEntry[] = [];
  private readonly autoTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly autoDue = new Map<string, number>();
  private readonly storage: InsightStorage;
  private readonly now: () => number;
  private readonly run: typeof runGrokAnalysis;
  private readonly fetch: typeof fetchTrajectory;
  private readonly findBinary: typeof findGrokBinary;
  private readonly zone: () => string | null;
  private binary: string | null = null;
  private ready: Promise<void>;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saveLazy = false;
  private processing: Promise<void> | null = null;
  private current: { id: string; abort: AbortController } | null = null;
  private readonly executions = new Set<Promise<unknown>>();
  private closed = false;
  private initialized = false;
  private deferredLifecycle: Array<{ id: string; started: boolean }> = [];
  constructor(options: InsightManagerOptions = {}) {
    this.storage = new InsightStorage(options.directory ?? telemetryDirectory());
    this.suggestionStorage = new SuggestionStorage(options.directory ?? telemetryDirectory()); this.now = options.now ?? Date.now;
    this.run = options.run ?? runGrokAnalysis; this.fetch = options.fetch ?? fetchTrajectory; this.findBinary = options.findBinary ?? findGrokBinary;
    this.zone = options.zone ?? (() => null);
    this.ready = this.initialize();
  }
  private async initialize() {
    const data = await this.storage.load(defaults); this.settings = data.settings; this.cooldowns = data.cooldowns; this.activity = data.activity;
    this.revision = data.revision + 1;
    this.suggestionJobs = (await this.suggestionStorage.load()).map(job => ACTIVE.has(job.status)
      ? { ...job, status: "canceled", stage: t("serverInsights.m001"), updatedAt: this.iso() } : job);
    this.jobs = retainInsightJobs(data.jobs.map(job => ACTIVE.has(job.status) ? { ...job, status: "canceled", stage: t("serverInsights.m002"), updatedAt: this.iso() }
      : job.status === "completed" && !isUsefulInsightReport(job.report) ? { ...job, status: "failed", stage: t("serverInsights.m003"), error: t("serverInsights.m004"), updatedAt: this.iso() } : job));
    await this.refreshBinary(); this.initialized = true;
    for (const event of this.deferredLifecycle) event.started ? this.turnStarted(event.id) : this.turnEnded(event.id);
    this.deferredLifecycle = []; await this.persist();
  }
  attach(paseo: PaseoApi) {
    this.lastPaseo = paseo;
    // PluginServerContext exposes its PaseoApi on the first RPC/hook, not at contribution startup.
    this.cleanup ??= this.ready.then(() => cleanupInsightAgents(paseo, new Set(this.current ? [this.current.id] : []))).then(result => {
      for (const error of result.errors) console.error(redactSecrets(error).slice(0, 500));
    }, error => {
      console.error(t("serverInsights.m005"), redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 500));
    });
  }
  private registry(paseo: PaseoApi) {
    let registry = this.registries.get(paseo);
    if (!registry) { registry = new InsightRunnerRegistry(paseo, { now: this.now, findBinary: this.findBinary }); this.registries.set(paseo, registry); }
    return registry;
  }
  /** The built-in Grok option carries the saved model and effort when it is the configured runner, so picking it keeps them. */
  async runners(paseo: PaseoApi) {
    await this.ready; this.attach(paseo);
    const runners = await this.registry(paseo).runners(), saved = this.settings.runner;
    if (saved.kind === "grok") { const plan = grokPlan(saved); runners.builtin = { ...runners.builtin, runner: structuredClone(saved), label: plan.info.label, modelLabel: grokModelLabel(plan.model), thinkingLabel: plan.effort }; }
    return runners;
  }
  async models(paseo: PaseoApi, provider: string) { await this.ready; this.attach(paseo); return this.registry(paseo).models(provider); }
  /** 总览 in the client's clock: its offset, and its IANA zone when it knows one (grok-F3). */
  async overview(paseo: PaseoApi, days: OverviewDays, utcOffsetMinutes: number, revision?: string, timeZone?: string) {
    await this.ready; this.attach(paseo);
    const runnerLabel = await this.runnerLabel(paseo);
    return buildInsightOverview({ jobs: this.jobs, suggestionJobs: this.suggestionJobs, autoEnabled: this.settings.autoEnabled, runnerLabel, now: this.now(), days, utcOffsetMinutes, timeZone, revision });
  }
  /** A client's clock when it sent one, else the zone a client reported last (automatic work), else none (UTC). */
  private clockFor(clock?: SuggestionClock): SuggestionClock | null {
    if (clock && (clock.timeZone || typeof clock.utcOffsetMinutes === "number")) return { timeZone: clock.timeZone ?? null, utcOffsetMinutes: clock.utcOffsetMinutes ?? null };
    const device = this.zone();
    return device ? { timeZone: device } : null;
  }
  private async available() {
    if (this.settings.runner.kind === "grok" || (this.settings.runner.kind === "auto" && this.binary)) return !!this.binary;
    if (!this.lastPaseo) return false;
    try { await this.registry(this.lastPaseo).resolve(this.settings.runner); return true; } catch { return false; }
  }
  private async runnerLabel(paseo = this.lastPaseo) {
    const runner = this.settings.runner;
    if (runner.kind === "grok" || (runner.kind === "auto" && this.binary)) return runner.kind === "auto" ? `${AUTO_RUNNER_LABEL} · ${BUILTIN_INSIGHT_RUNNER.label}` : grokRunnerLabel(runner);
    try {
      if (paseo) { const label = (await this.registry(paseo).resolve(runner)).info.label; return (runner.kind === "auto" ? `${AUTO_RUNNER_LABEL} · ${label}` : label).slice(0, 160); }
    } catch { /* preserve the configured identity when unavailable */ }
    if (runner.kind === "auto") return t("serverInsights.m006", { AUTO_RUNNER_LABEL: AUTO_RUNNER_LABEL });
    return (runner.kind === "profile" ? t("serverInsights.m007", { value1: runner.profileId.slice(0, 140) }) : t("serverInsights.m008", { value1: runner.provider.slice(0, 140) })).slice(0, 160);
  }
  private async refreshBinary() { const binary = await this.findBinary().catch(() => null); if (binary !== this.binary) { this.binary = binary; this.revision++; } }
  private iso() { return new Date(this.now()).toISOString(); }
  /** Job changes persist promptly; turn-activity counters only feed freshness hints and are saved lazily. */
  private changed(lazy = false) {
    this.revision++;
    if (this.closed || this.saveTimer && (lazy || !this.saveLazy)) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveLazy = lazy;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.persist(); }, lazy ? 30_000 : 200); this.saveTimer.unref();
  }
  private persist() {
    this.jobs = retainInsightJobs(this.jobs);
    const limit = <T,>(values: Record<string, T>) => Object.fromEntries(Object.entries(values).slice(-2000));
    this.cooldowns = limit(this.cooldowns); this.activity = limit(this.activity);
    this.suggestionJobs = retainSuggestionJobs(this.suggestionJobs);
    return Promise.all([this.storage.save({ settings: this.settings, jobs: this.jobs, cooldowns: this.cooldowns, activity: this.activity, revision: this.revision }),
      this.suggestionStorage.save(this.suggestionJobs)]).then(() => {});
  }
  private update(id: string, patch: Partial<InsightJob>) {
    const index = this.jobs.findIndex(job => job.id === id); if (index < 0) return;
    let updated = { ...this.jobs[index], ...patch, updatedAt: this.iso() };
    if (updated.report) updated = fitInsightReport(updated);
    this.jobs[index] = updated; this.changed();
  }
  private decorate(job: InsightJob): InsightJob {
    const progress = this.activity[job.agentId]; const source = job.source;
    const newTurns = source ? Math.max(0, (progress?.turns ?? source.observedTurnCounter) - source.observedTurnCounter) : null;
    const newer = !!source && ((newTurns ?? 0) > 0 || (progress?.generation ?? 0) > (source.observedGeneration ?? Infinity));
    const success = this.cooldowns[job.agentId];
    return { ...job, freshness: { state: !source ? "unknown" : newer ? "new_activity" : "current", newTurns, latestTurnAt: progress?.latestTurnAt ?? null },
      nextAutoAt: success ? new Date(Date.parse(success.analyzedAt) + this.settings.cooldownHours * 3600000).toISOString() : null };
  }
  async state(agentId?: string) {
    await this.ready;
    return structuredClone({ settings: this.settings, jobs: this.jobs.filter(job => !agentId || job.agentId === agentId).map(job => this.decorate(job)), persistenceError: this.storage.error ?? this.suggestionStorage.error, available: await this.available() });
  }
  async list(agentId?: string, revision?: number): Promise<InsightListState> {
    await this.ready; await this.refreshBinary();
    const relevant = this.jobs.filter(job => !agentId || job.agentId === agentId);
    const due = [...this.autoDue].filter(([id]) => !agentId || id === agentId);
    const content = { settings: this.settings, runnerLabel: await this.runnerLabel(), jobs: relevant.map(job => summarizeInsight(this.decorate(job))), persistenceError: this.storage.error ?? this.suggestionStorage.error, available: await this.available(),
      activeCount: relevant.filter(job => ACTIVE.has(job.status)).length, nextScheduledAt: due.length ? new Date(Math.min(...due.map(([, at]) => at))).toISOString() : null };
    // A content revision (a 48-bit integer): turn activity of Agents without reports and other
    // scopes no longer resend the list, while any visible change still does.
    const current = parseInt(createHash("sha1").update(JSON.stringify(content)).digest("hex").slice(0, 12), 16);
    return structuredClone({ ...content, jobs: revision === current ? [] : content.jobs, revision: current, unchanged: revision === current });
  }
  async report(jobId: string) { await this.ready; const job = this.jobs.find(item => item.id === jobId); return { job: job ? structuredClone(this.decorate(job)) : null, revision: this.revision }; }
  async feedback(jobId: string, findingId: string, status: FindingFeedback["status"]) {
    await this.ready; const job = this.jobs.find(item => item.id === jobId);
    if (!job?.report?.findings.some(finding => finding.id === findingId)) throw new Error(t("serverInsights.m009"));
    this.update(jobId, { findingFeedback: { ...job.findingFeedback, [findingId]: { status, updatedAt: this.iso() } } }); await this.persist();
    return structuredClone(this.decorate(this.jobs.find(item => item.id === jobId)!));
  }
  async configure(input: boolean | { autoEnabled?: boolean; runner?: InsightRunner }) {
    await this.ready; const patch = typeof input === "boolean" ? { autoEnabled: input } : input;
    this.settings = { ...this.settings, ...(patch.autoEnabled !== undefined ? { autoEnabled: patch.autoEnabled } : {}), ...(patch.runner ? { runner: structuredClone(patch.runner) } : {}) };
    if (patch.autoEnabled === false) { for (const timer of this.autoTimers.values()) clearTimeout(timer); this.autoTimers.clear(); this.autoDue.clear();
      for (const entry of [...this.queue]) if (this.queuedJob(entry)?.trigger === "auto") { if (entry.kind === "suggestion") await this.cancelSuggestion(entry.id); else await this.cancel(entry.id); } }
    this.changed(); await this.storage.saveSettings(this.settings); await this.persist(); return structuredClone(this.settings);
  }
  private skip(agentId: string, reason: string, existing?: InsightJob): InsightJob {
    const previous = this.jobs.find(job => job.agentId === agentId && job.status === "skipped");
    const job: InsightJob = { ...(existing ?? previous ?? this.newJob(agentId, "auto")), status: "skipped", stage: reason,
      createdAt: this.iso(), updatedAt: this.iso(), skipCount: (previous?.skipCount ?? 0) + 1 };
    this.jobs = this.jobs.filter(item => item.id !== previous?.id && item.id !== existing?.id); this.jobs.unshift(job); this.changed();
    return structuredClone(this.decorate(job));
  }
  private newJob(agentId: string, trigger: "manual" | "auto", selection?: InsightRunner): InsightJob {
    const at = this.iso();
    // Until the runner is resolved, a queued job names the chosen kind instead of looking like a Grok run.
    const pending = selection && selection.kind !== "grok" ? { runner: { ...BUILTIN_INSIGHT_RUNNER, kind: selection.kind, model: null, thinkingOptionId: null,
      label: selection.kind === "auto" ? AUTO_RUNNER_LABEL : t("serverInsights.m010"), provider: selection.kind === "provider" ? selection.provider : null } } : {};
    return { id: randomUUID(), agentId, agentTitle: this.jobs.find(job => job.agentId === agentId)?.agentTitle ?? t("serverInsights.m011"),
      projectName: this.jobs.find(job => job.agentId === agentId)?.projectName ?? t("serverInsights.m012"), createdAt: at, updatedAt: at, status: "queued", trigger,
      stage: t("serverInsights.m013"), eligibility: null, coverage: null, report: null, model: "grok-4.7", effort: "xhigh", usage: null, error: null, ...pending };
  }
  async start(paseo: PaseoApi, agentId: string, trigger: "manual" | "auto" = "manual", question?: string, mode: "full" | "incremental" = "incremental", runner?: InsightRunner): Promise<InsightJob> {
    await this.ready;
    if (this.closed) throw new Error(t("serverInsights.m014"));
    if (trigger === "auto" && !this.settings.autoEnabled) throw new Error(t("serverInsights.m015"));
    this.attach(paseo);
    const existing = this.jobs.find(job => job.agentId === agentId && ACTIVE.has(job.status));
    if (existing) {
      if (trigger === "manual" && existing.trigger === "auto" && existing.status === "queued") {
        this.update(existing.id, { trigger: "manual", stage: t("serverInsights.m016") });
        const entry = this.queue.find(entry => entry.id === existing.id); if (entry?.kind === "report") { this.queue = this.queue.filter(item => item !== entry); entry.question = question; entry.mode = mode; entry.runner = runner; this.enqueue(entry, "manual"); }
      }
      return structuredClone(this.decorate(this.jobs.find(job => job.id === existing.id)!));
    }
    if (trigger === "auto") {
      const last = this.cooldowns[agentId];
      if (last && this.now() < Date.parse(last.analyzedAt) + this.settings.cooldownHours * 3600000)
        return this.skip(agentId, t("serverInsights.m017", { value1: new Date(Date.parse(last.analyzedAt) + this.settings.cooldownHours * 3600000).toISOString() }));
    }
    await this.refreshBinary();
    if (this.closed) throw new Error(t("serverInsights.m018"));
    if (trigger === "auto" && !this.settings.autoEnabled) throw new Error(t("serverInsights.m019"));
    if (this.jobs.some(job => job.agentId === agentId && ACTIVE.has(job.status))) return this.start(paseo, agentId, trigger, question, mode, runner);
    const selection = runner ?? this.settings.runner;
    if (selection.kind === "grok" && !this.binary) throw new Error(t("serverInsights.m020"));
    if (selection.kind === "auto" && !this.binary) await this.registry(paseo).resolve(selection).catch(error => { throw error instanceof Error && error.message === NO_RUNNER_ERROR ? error : new Error(t("serverInsights.m021", { NO_RUNNER_ERROR: NO_RUNNER_ERROR, value2: error instanceof Error ? error.message : String(error) })); });
    if (this.queue.length >= 8) throw new Error(t("serverInsights.m022"));
    const job = this.newJob(agentId, trigger, selection); this.jobs.unshift(job); this.enqueue({ kind: "report", id: job.id, paseo, question, mode, runner }, trigger); this.changed(); this.kick();
    return structuredClone(job);
  }
  private queuedJob(entry: QueueEntry) { return (entry.kind === "report" ? this.jobs : this.suggestionJobs).find(job => job.id === entry.id); }
  private enqueue(entry: QueueEntry, trigger: "manual" | "auto") {
    const index = trigger === "manual" ? this.queue.findIndex(item => this.queuedJob(item)?.trigger === "auto") : -1;
    if (index < 0) this.queue.push(entry); else this.queue.splice(index, 0, entry);
  }
  private kick() { if (this.processing || this.closed) return; this.processing = this.drain().finally(() => { this.processing = null; if (this.queue.length && !this.closed) this.kick(); }); }
  private async drain() {
    while (this.queue.length && !this.closed) {
      const entry = this.queue.shift()!;
      if (entry.kind === "suggestion") { await this.runSuggestion(entry); continue; }
      const job = this.jobs.find(job => job.id === entry.id); if (!job || job.status === "canceled") continue;
      const selection = structuredClone(entry.runner ?? this.settings.runner);
      const abort = new AbortController(); this.current = { id: job.id, abort };
      try {
        this.update(job.id, { status: "collecting", stage: t("serverInsights.m023") });
        if (this.cleanup) await abortable(this.cleanup, abort.signal);
        const plan = await abortable(this.registry(entry.paseo).resolve(selection), abort.signal);
        this.update(job.id, { model: plan.model, effort: plan.effort, runner: plan.info });
        const baseline = { ...(this.activity[job.agentId] ?? { turns: 0, generation: 0, latestTurnAt: null }) };
        const prior = this.jobs.find(previous => previous.agentId === job.agentId && previous.status === "completed" && previous.report);
        const incremental = entry.mode !== "full" && !!prior?.source;
        const after = incremental ? { epoch: prior!.source!.epoch, seq: prior!.source!.endSeq } : undefined;
        const trajectory = await abortable(this.fetch(entry.paseo, job.agentId, { limit: 1500, maxCharacters: 400000, signal: abort.signal, after }), abort.signal);
        if (abort.signal.aborted || this.closed) continue;
        const sameEpoch = !!after && trajectory.coverage.epoch === after.epoch;
        if (sameEpoch) trajectory.rows = trajectory.rows.filter(row => row.seqEnd > after.seq);
        const assessed: SessionTrajectory = sameEpoch && prior ? { ...trajectory, counts: { ...trajectory.counts,
          userTurns: prior.source!.userTurns + trajectory.rows.filter(row => row.kind === "user_message" && row.seqStart > after!.seq).length,
          tools: (prior.eligibility?.toolCount ?? 0) + trajectory.rows.filter(row => row.kind === "tool_call" && row.seqStart > after!.seq).length } } : trajectory;
        const eligibility = assessTrajectory(assessed, job.trigger, this.settings.minTurns, this.settings.minTools);
        this.update(job.id, { agentTitle: trajectory.agent.title || t("serverInsights.m024"), projectName: trajectory.project?.name || t("serverInsights.m025"), eligibility,
          coverage: { rows: trajectory.rows.length, characters: trajectory.rows.reduce((sum, row) => sum + row.text.length, 0), truncated: !trajectory.coverage.complete, oldestAt: trajectory.coverage.firstAt, newestAt: trajectory.coverage.lastAt } });
        if (job.trigger === "auto" && (this.activity[job.agentId]?.generation ?? 0) > baseline.generation) { this.skip(job.agentId, t("serverInsights.m026"), this.jobs.find(item => item.id === job.id)); continue; }
        if (!eligibility.eligible) { this.update(job.id, { status: "skipped", stage: eligibility.reason }); continue; }
        if (sameEpoch && !trajectory.rows.length) { this.skip(job.agentId, t("serverInsights.m027"), this.jobs.find(item => item.id === job.id)); continue; }
        const fingerprint = trajectoryFingerprint(trajectory), last = this.cooldowns[job.agentId];
        const sourceUnchanged = !!last?.source && last.source.epoch === trajectory.coverage.epoch && Math.max(0, ...trajectory.rows.map(row => row.seqEnd)) <= last.source.endSeq;
        if (job.trigger === "auto" && (last?.fingerprint === fingerprint || sourceUnchanged)) { this.skip(job.agentId, t("serverInsights.m028"), this.jobs.find(item => item.id === job.id)); continue; }
        const currentPrior = this.jobs.find(item => item.id === prior?.id) ?? prior;
        const unresolved = sameEpoch && currentPrior?.report ? currentPrior.report.findings.filter(finding => !["resolved", "false_positive"].includes(currentPrior.findingFeedback?.[finding.id]?.status ?? "open")) : [];
        const neededRefs = new Set(unresolved.flatMap(finding => finding.evidence));
        const historicalEvidence: TrajectoryRow[] = (prior?.evidence ?? []).filter(row => neededRefs.has(row.ref)).slice(0, 40).map(row => ({
          ref: row.ref, epoch: prior?.source?.epoch ?? "legacy", seqStart: 0, seqEnd: 0, at: row.at, turnId: null, kind: row.kind, text: row.text, toolName: row.toolName, toolStatus: null }));
        const source = { epoch: trajectory.coverage.epoch, endSeq: trajectory.coverage.endSeq ?? Math.max(0, sameEpoch ? after!.seq : 0, ...trajectory.rows.map(row => row.seqEnd)), capturedAt: trajectory.capturedAt,
          userTurns: eligibility.turnCount, lastTurnId: [...trajectory.rows].reverse().find(row => row.turnId)?.turnId ?? null,
          observedTurnCounter: baseline.turns, observedGeneration: baseline.generation };
        this.update(job.id, { source, reviewContext: { mode: sameEpoch ? "incremental" : "full", baseJobId: sameEpoch ? prior!.id : null,
          newRows: trajectory.rows.length, unresolvedFindings: unresolved.length }, status: "analyzing", stage: sameEpoch ? t("serverInsights.m029") : t("serverInsights.m030", { value1: plan.info.label }) });
        const context = { previousReview: sameEpoch && prior ? { jobId: prior.id, summary: prior.report!.summary, findings: unresolved } : undefined, historicalEvidence };
        let request = buildAnalysisRequest(trajectory, entry.question, context);
        let parsed: ReturnType<typeof parseGrokReport> | null = null, priorUsage: InsightJob["usage"] = null; let retried = false;
        if (plan.info.kind !== "grok") {
          const result = await runPaseoStructured<ReturnType<typeof parseGrokReport>>({ paseo: entry.paseo, plan,
            parent: { id: job.agentId, cwd: trajectory.agent.cwd ?? "", workspaceId: trajectory.agent.workspaceId, archived: !!trajectory.agent.archivedAt, title: trajectory.agent.title },
            jobId: job.id, prompt: request.prompt, systemPrompt: ANALYSIS_SYSTEM_PROMPT, schema: insightReportSchema,
            parse: text => parseGrokReport(text, request.references), signal: abort.signal, now: this.now,
            onSession: runner => { markInsightAgent(runner.sessionAgentId!); this.update(job.id, { runner }); },
            onRetry: () => this.update(job.id, { stage: t("serverInsights.m031") }) });
          parsed = { ...result.value, usage: result.usage };
        } else for (let attempt = 0; attempt < 2; attempt++) {
          if (abort.signal.aborted || this.closed) break;
          if (!this.binary) await this.refreshBinary();
          if (!this.binary) throw new Error(t("serverInsights.m032"));
          const execution = this.run({ binary: this.binary, prompt: request.prompt, signal: abort.signal, model: plan.model, effort: plan.effort ?? undefined });
          this.executions.add(execution); void execution.then(() => this.executions.delete(execution), () => this.executions.delete(execution));
          // A Grok turn limit (GrokTurnLimitError) is an InsightReportError too: it gets the same one compact retry (opus-F72).
          try { const output = await abortable(execution, abort.signal); if (abort.signal.aborted || this.closed) break; parsed = parseGrokReport(output, request.references); break; }
          catch (error) { if (abort.signal.aborted || this.closed || !(error instanceof InsightReportError) || attempt > 0) throw error; priorUsage = error.usage; retried = true;
            this.update(job.id, { stage: error instanceof GrokTurnLimitError ? t("serverInsights.m033") : t("serverInsights.m034") });
            request = buildAnalysisRequest(trajectory, entry.question, { ...context, compact: true }); }
        }
        if (abort.signal.aborted || this.closed) continue; if (!parsed) throw new Error(t("serverInsights.m035"));
        if (retried) { const sum = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? null : a + b;
          parsed.usage = { inputTokens: sum(priorUsage?.inputTokens, parsed.usage?.inputTokens), outputTokens: sum(priorUsage?.outputTokens, parsed.usage?.outputTokens), costUsd: sum(priorUsage?.costUsd, parsed.usage?.costUsd) }; }
        if (!trajectory.coverage.complete || request.sampled) { parsed.report.limitations = [...parsed.report.limitations.slice(0, 7), t("serverInsights.m036", { value1: request.evidence.length })]; if (parsed.report.confidence === "high") parsed.report.confidence = "medium"; }
        const cited = new Set(parsed.report.findings.flatMap(finding => finding.evidence));
        const evidence = request.evidence.filter(row => cited.has(row.ref)).slice(0, 80).map(row => ({ ref: row.ref, at: row.at, kind: row.kind.slice(0, 100), toolName: row.toolName?.slice(0, 200) ?? null, text: excerptText(row.text, 2000).text }));
        this.update(job.id, { status: "completed", stage: t("serverInsights.m037"), report: parsed.report, evidence, usage: parsed.usage, error: null });
        delete this.cooldowns[job.agentId]; this.cooldowns[job.agentId] = { fingerprint, analyzedAt: this.iso(), reportId: job.id, source };
        if (getSuggestionTiming({ jobs: this.jobs, suggestionJobs: this.suggestionJobs, autoEnabled: this.settings.autoEnabled, now: this.now() }).ready)
          await this.suggest(entry.paseo, 7, undefined, "auto").catch(() => {});
      } catch (error) { if (!abort.signal.aborted && !this.closed) this.update(job.id, { status: "failed", stage: t("serverInsights.m038"), error: error instanceof Error ? redactSecrets(error.message).slice(0, 2000) : t("serverInsights.m039") }); }
      finally { if (this.current?.id === job.id) this.current = null; await this.persist(); }
    }
  }
  private updateSuggestion(id: string, patch: Partial<SuggestionJob>) {
    const index = this.suggestionJobs.findIndex(job => job.id === id); if (index < 0) return;
    this.suggestionJobs[index] = { ...this.suggestionJobs[index], ...patch, updatedAt: this.iso() }; this.changed();
  }
  async suggestions(jobId?: string) {
    await this.ready;
    const history = retainSuggestionJobs(this.suggestionJobs);
    return structuredClone({ job: (jobId ? history.find(job => job.id === jobId) : history.find(job => job.status === "completed" && job.report)) ?? null,
      history: history.map(summarizeSuggestion) });
  }
  /**
   * Queues a suggestion set over `days` local days. `clock` is the requesting client's (manual); automatic jobs, and
   * clients that send none, use the zone a client reported last, else UTC days (grok-F3).
   */
  async suggest(paseo: PaseoApi, days: OverviewDays, runner?: InsightRunner, trigger: "manual" | "auto" = "manual", clock?: SuggestionClock): Promise<SuggestionJob> {
    await this.ready;
    if (this.closed) throw new Error(t("serverInsights.m040"));
    if (trigger === "auto" && !this.settings.autoEnabled) throw new Error(t("serverInsights.m041"));
    this.attach(paseo);
    const existing = this.suggestionJobs.find(job => ACTIVE.has(job.status) && job.window.days === days);
    if (existing) {
      if (trigger === "manual" && existing.trigger === "auto" && existing.status === "queued") {
        this.updateSuggestion(existing.id, { trigger: "manual", stage: t("serverInsights.m042") });
        const entry = this.queue.find(entry => entry.id === existing.id);
        if (entry?.kind === "suggestion") { this.queue = this.queue.filter(item => item !== entry); entry.runner = runner; if (clock) entry.clock = this.clockFor(clock); this.enqueue(entry, "manual"); }
      }
      return structuredClone(this.suggestionJobs.find(job => job.id === existing.id)!);
    }
    if (this.queue.length >= 8) throw new Error(t("serverInsights.m043"));
    const at = this.iso(), selection = runner ?? this.settings.runner, resolved = this.clockFor(clock);
    const job: SuggestionJob = { id: randomUUID(), createdAt: at, updatedAt: at, status: "queued", trigger, stage: t("serverInsights.m044"),
      window: { days, from: at, to: at, reports: 0, findings: 0, agents: 0, ...windowClock(suggestionZone(resolved, this.now()), this.now()) },
      runner: selection.kind === "grok" ? grokPlan(selection).info : { ...BUILTIN_INSIGHT_RUNNER, kind: selection.kind, label: selection.kind === "auto" ? AUTO_RUNNER_LABEL : t("serverInsights.m045"),
        provider: selection.kind === "provider" ? selection.provider : null, model: null, thinkingOptionId: null },
      usage: null, error: null, report: null, basis: [] };
    this.suggestionJobs.unshift(job); this.enqueue({ kind: "suggestion", id: job.id, paseo, runner, clock: resolved }, trigger); this.changed(); this.kick();
    return structuredClone(job);
  }
  private async runSuggestion(entry: SuggestionQueueEntry) {
    const job = this.suggestionJobs.find(job => job.id === entry.id); if (!job || job.status === "canceled") return;
    const selection = structuredClone(entry.runner ?? this.settings.runner);
    const abort = new AbortController(); this.current = { id: job.id, abort };
    try {
      this.updateSuggestion(job.id, { status: "collecting", stage: t("serverInsights.m046") });
      const context = collectSuggestionContext(this.jobs, job.window.days, this.now(), entry.clock);
      this.updateSuggestion(job.id, { window: context.window, basis: context.basis });
      if (!context.eligible) { this.updateSuggestion(job.id, { status: "skipped", stage: context.reason }); return; }
      if (this.cleanup) await abortable(this.cleanup, abort.signal);
      const plan = await abortable(this.registry(entry.paseo).resolve(selection), abort.signal);
      this.updateSuggestion(job.id, { runner: plan.info, status: "analyzing", stage: t("serverInsights.m047", { value1: plan.info.label }) });
      let parsed: ReturnType<typeof parseSuggestionText>;
      if (plan.info.kind !== "grok") {
        const source = context.parentJob!;
        let parent;
        try { parent = (await abortable(entry.paseo.agents.ref(source.agentId).refresh(), abort.signal))?.agent; }
        catch (error) { if (abort.signal.aborted) throw error; throw new Error(t("serverInsights.m048")); }
        if (!parent) throw new Error(t("serverInsights.m049"));
        const result = await runPaseoStructured<ReturnType<typeof parseSuggestionText>>({ paseo: entry.paseo, plan,
          parent: { id: source.agentId, cwd: parent.cwd, workspaceId: parent.workspaceId ?? null, archived: !!parent.archivedAt, title: parent.title ?? source.agentTitle },
          jobId: job.id, title: t("serverInsights.m050", { value1: job.window.days }), prompt: buildSuggestionPrompt(context),
          systemPrompt: SUGGESTION_SYSTEM_PROMPT, schema: suggestionReportSchema, parse: text => parseSuggestionText(text, context.references),
          signal: abort.signal, now: this.now, onSession: runner => { markInsightAgent(runner.sessionAgentId!); this.updateSuggestion(job.id, { runner }); },
          onRetry: () => this.updateSuggestion(job.id, { stage: t("serverInsights.m051") }) });
        parsed = { ...result.value, usage: result.usage };
      } else {
        await this.refreshBinary(); if (!this.binary) throw new Error(t("serverInsights.m052"));
        let result: ReturnType<typeof parseSuggestionText> | null = null, priorUsage: InsightJob["usage"] = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (abort.signal.aborted || this.closed) return;
          const execution = this.run({ binary: this.binary, prompt: buildSuggestionPrompt(context, { compact: attempt > 0 }),
            signal: abort.signal, schema: suggestionReportSchema, systemPrompt: SUGGESTION_SYSTEM_PROMPT, model: plan.model, effort: plan.effort ?? undefined });
          this.executions.add(execution); void execution.then(() => this.executions.delete(execution), () => this.executions.delete(execution));
          // The run's own failure (a Grok turn limit) is inside the try, so it gets the one compact retry too (opus-F72).
          try { result = parseSuggestionText(await abortable(execution, abort.signal), context.references); }
          catch (error) { if (abort.signal.aborted || this.closed || !(error instanceof InsightReportError) || attempt) throw error; priorUsage = error.usage;
            this.updateSuggestion(job.id, { stage: error instanceof GrokTurnLimitError ? t("serverInsights.m053") : t("serverInsights.m054") }); continue; }
          if (attempt) {
            const sum = (a: number | null | undefined, b: number | null | undefined) => a == null || b == null ? null : a + b;
            result.usage = { inputTokens: sum(priorUsage?.inputTokens, result.usage?.inputTokens), outputTokens: sum(priorUsage?.outputTokens, result.usage?.outputTokens), costUsd: sum(priorUsage?.costUsd, result.usage?.costUsd) };
          }
          break;
        }
        if (!result) throw new Error(t("serverInsights.m055")); parsed = result;
      }
      if (abort.signal.aborted || this.closed) return;
      this.updateSuggestion(job.id, { status: "completed", stage: t("serverInsights.m056"), report: parsed.report, evidence: parsed.evidence, usage: parsed.usage, error: null });
    } catch (error) {
      if (!abort.signal.aborted && !this.closed) this.updateSuggestion(job.id, { status: "failed", stage: t("serverInsights.m057"), error: redactSecrets(error instanceof Error ? error.message : t("serverInsights.m058")).slice(0, 2000) });
    } finally { if (this.current?.id === job.id) this.current = null; await this.persist(); }
  }
  async cancelSuggestion(jobId: string): Promise<SuggestionJob> {
    await this.ready; const job = this.suggestionJobs.find(job => job.id === jobId); if (!job) throw new Error(t("serverInsights.m059"));
    if (ACTIVE.has(job.status)) { this.queue = this.queue.filter(entry => entry.id !== job.id); this.updateSuggestion(job.id, { status: "canceled", stage: t("serverInsights.m060") }); if (this.current?.id === job.id) this.current.abort.abort(); }
    return structuredClone(this.suggestionJobs.find(job => job.id === jobId)!);
  }
  async actionFeedback(jobId: string, actionId: string, status: ActionFeedback["status"]): Promise<SuggestionJob> {
    await this.ready; const job = this.suggestionJobs.find(job => job.id === jobId);
    if (!job?.report?.actions.some(action => action.id === actionId)) throw new Error(t("serverInsights.m061"));
    this.updateSuggestion(jobId, { feedback: { ...job.feedback, [actionId]: { status, updatedAt: this.iso() } } }); await this.persist();
    return structuredClone(this.suggestionJobs.find(job => job.id === jobId)!);
  }
  async cancel(jobId: string): Promise<InsightJob> {
    await this.ready; const job = this.jobs.find(job => job.id === jobId); if (!job) throw new Error(t("serverInsights.m062"));
    if (ACTIVE.has(job.status)) { this.queue = this.queue.filter(entry => entry.id !== job.id); this.update(job.id, { status: "canceled", stage: t("serverInsights.m063") }); if (this.current?.id === job.id) this.current.abort.abort(); }
    return structuredClone(this.decorate(this.jobs.find(item => item.id === jobId)!));
  }
  turnStarted(agentId: string, labels?: Record<string, string>) {
    if (this.closed) return;
    if (isKnownInsightAgent(agentId) || labels?.["observatory.role"] === "insight") { markInsightAgent(agentId); return; }
    if (!this.initialized) { this.deferredLifecycle.push({ id: agentId, started: true }); return; }
    const timer = this.autoTimers.get(agentId); if (timer) clearTimeout(timer); this.autoTimers.delete(agentId); this.autoDue.delete(agentId);
    const state = this.activity[agentId] ?? { turns: 0, generation: 0, latestTurnAt: null }; delete this.activity[agentId];
    this.activity[agentId] = { turns: state.turns + 1, generation: state.generation + 1, latestTurnAt: this.iso() }; this.changed(true);
  }
  turnEnded(agentId: string, labels?: Record<string, string>) { if (this.closed) return; if (isKnownInsightAgent(agentId) || labels?.["observatory.role"] === "insight") { markInsightAgent(agentId); return; } if (!this.initialized) { this.deferredLifecycle.push({ id: agentId, started: false }); return; } const state = this.activity[agentId] ?? { turns: 0, generation: 0, latestTurnAt: null }; this.activity[agentId] = { ...state, generation: state.generation + 1 }; this.changed(true); }
  /** `deeper` counts further back than the hook's window (Paseo 0.13 reads only the end of the conversation), only when asked. */
  async scheduleAuto(paseo: PaseoApi, agentId: string, observedUserTurns: number, observedTools: number, labels?: Record<string, string>,
    deeper?: (minTurns: number, minTools: number) => Promise<{ users: number; tools: number }>) {
    if (this.closed) return;
    if (isKnownInsightAgent(agentId) || labels?.["observatory.role"] === "insight") { markInsightAgent(agentId); return; }
    await this.ready; if (this.closed || !this.settings.autoEnabled) return;
    let users = observedUserTurns, tools = observedTools;
    if (deeper && (users < this.settings.minTurns || tools < this.settings.minTools)) ({ users, tools } = await deeper(this.settings.minTurns, this.settings.minTools));
    if (this.closed || users < this.settings.minTurns || tools < this.settings.minTools) return;
    const old = this.autoTimers.get(agentId); if (old) clearTimeout(old);
    const timer = setTimeout(() => { this.autoTimers.delete(agentId); this.autoDue.delete(agentId); void this.start(paseo, agentId, "auto").catch(() => {}); }, 90000);
    timer.unref(); this.autoTimers.set(agentId, timer); this.autoDue.set(agentId, this.now() + 90000); this.changed(true);
  }
  async close() {
    await this.ready; this.closed = true; for (const timer of this.autoTimers.values()) clearTimeout(timer); this.autoTimers.clear(); this.autoDue.clear();
    this.jobs = this.jobs.map(job => ACTIVE.has(job.status) ? { ...job, status: "canceled", stage: t("serverInsights.m064"), updatedAt: this.iso() } : job);
    this.suggestionJobs = this.suggestionJobs.map(job => ACTIVE.has(job.status) ? { ...job, status: "canceled", stage: t("serverInsights.m065"), updatedAt: this.iso() } : job);
    this.queue = []; this.current?.abort.abort(); if (this.saveTimer) clearTimeout(this.saveTimer); this.saveTimer = null;
    await this.processing;
    if (this.executions.size) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.allSettled([...this.executions]), new Promise<void>(resolve => { timeout = setTimeout(resolve, 4000); })]);
      if (timeout) clearTimeout(timeout);
    }
    await this.persist(); await this.storage.close(); await this.suggestionStorage.close();
  }
}

/**
 * User messages and distinct tool calls, the two thresholds of automatic analysis. Another agent's message and a schedule's
 * prompt (Paseo 0.14) are tool-call rows that start a turn, not tools.
 */
function conversationCounts(items: readonly { type: string; callId?: unknown; name?: unknown; agentMessage?: unknown }[]): { users: number; tools: number } {
  return { users: items.filter(item => item.type === "user_message").length,
    tools: new Set(items.filter(item => item.type === "tool_call" && !isTurnStart(item)).map(item => item.callId)).size };
}

/** Reads back from the end only as far as the thresholds need (at most 1000 rows). */
async function deeperCounts(paseo: PaseoApi, agentId: string, minTurns: number, minTools: number): Promise<{ users: number; tools: number }> {
  const read = await turnTimeline(paseo, agentId, [] as { type: string; callId?: unknown; name?: unknown; agentMessage?: unknown }[], {
    maxRows: 1000, enough: items => { const counts = conversationCounts(items); return counts.users >= minTurns && counts.tools >= minTools; } });
  return conversationCounts(read.items);
}

/**
 * `options.zone`: the zone a client reported last (index.server.ts passes `() => zones.device()`), for the day windows
 * of suggestions queued without a client's clock (grok-F3). Without it those windows are UTC days and say so.
 */
export function registerInsights(server: PluginServerContext, options: { zone?: () => string | null } = {}): () => Promise<void> {
  const manager = new InsightManager({ zone: options.zone });
  server.handle(getInsightState, ({ agentId }, { paseo }) => { manager.attach(paseo); return manager.state(agentId); });
  server.handle(listInsightJobs, ({ agentId, revision }, { paseo }) => { manager.attach(paseo); return manager.list(agentId, revision); });
  server.handle(listInsightRunners, (_, { paseo }) => manager.runners(paseo));
  server.handle(listInsightModels, ({ provider }, { paseo }) => manager.models(paseo, provider));
  server.handle(getInsightOverview, ({ days, utcOffsetMinutes, timeZone, revision }, { paseo }) => manager.overview(paseo, days, utcOffsetMinutes, revision, timeZone));
  server.handle(getInsightSuggestions, ({ jobId }, { paseo }) => { manager.attach(paseo); return manager.suggestions(jobId); });
  server.handle(startInsightSuggestions, ({ days, runner, timeZone, utcOffsetMinutes }, { paseo }) => manager.suggest(paseo, days, runner, "manual", { timeZone, utcOffsetMinutes }));
  server.handle(cancelInsightSuggestions, ({ jobId }, { paseo }) => { manager.attach(paseo); return manager.cancelSuggestion(jobId); });
  server.handle(setActionFeedback, ({ jobId, actionId, status }, { paseo }) => { manager.attach(paseo); return manager.actionFeedback(jobId, actionId, status); });
  server.handle(getInsightReport, ({ jobId }, { paseo }) => { manager.attach(paseo); return manager.report(jobId); });
  server.handle(setFindingFeedback, ({ jobId, findingId, status }, { paseo }) => { manager.attach(paseo); return manager.feedback(jobId, findingId, status); });
  server.handle(startInsight, ({ agentId, question, mode, runner }, { paseo }) => manager.start(paseo, agentId, "manual", question, mode, runner));
  server.handle(cancelInsight, ({ jobId }, { paseo }) => { manager.attach(paseo); return manager.cancel(jobId); });
  server.handle(updateInsightSettings, (input, { paseo }) => { manager.attach(paseo); return manager.configure(input); });
  const observe = (paseo: PaseoApi, agent: { id: string }, action: () => void | Promise<void>) => {
    manager.attach(paseo);
    // Hooks never wait for metadata or cleanup; labels are absent on the 0.9 hook projection.
    void isInsightAgent(paseo, agent).then(insight => { if (!insight) return action(); }).catch(() => {});
  };
  const removers = [server.on("agent.turn_started", ({ agent }, { paseo }) => observe(paseo, agent, () => manager.turnStarted(agent.id))),
    server.on("agent.turn_ended", (event, { paseo }) => observe(paseo, event.agent, () => {
      manager.turnEnded(event.agent.id); if (event.outcome.kind === "canceled") return;
      const { users, tools } = conversationCounts(hookTimeline(event)), read = turnRead(event);
      return manager.scheduleAuto(paseo, event.agent.id, users, tools, undefined,
        read && !read.complete ? (minTurns, minTools) => deeperCounts(paseo, event.agent.id, minTurns, minTools) : undefined);
    }))];
  return async () => { removers.forEach(remove => remove()); await manager.close(); };
}
