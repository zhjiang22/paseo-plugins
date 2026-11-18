import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { PaseoApi } from "./paseo-types";
import { createAgentDirectory, type AgentDirectoryApi, type AgentDirectorySubscription } from "../shared/directory-store";
import { enrichAgents, type BackgroundAgent } from "../shared/background";
import { applyArchiveReadOrigin, applyReadReceipt, type AgentRecord, type AgentTodo } from "../shared/model";
import { needsAttention } from "../shared/dashboard-model";
import { isCompletionSnoozed, type CompletionSnooze, type ObservatorySettings } from "../shared/preferences";
import { applyLiveExtras, attentionPhase, entryOf, getAttention, getLiveExtras, seeLiveIssue, loudPhases, phaseRank, waitingSince, ATTENTION_PHASES, type AttentionPhase, type AttentionResponse, type AttentionSummary, type LiveExtra, type LiveExtrasResponse } from "../shared/attention";
import { chimeKindEnabled, chimeKindOf, quietHours, type AlertSettings, type ChimeEvent, type ChimeKind, type ChimeState } from "../shared/alerts";
import type { TelemetrySnapshot } from "../shared/telemetry";
import type { ReadReceipt, ArchiveReadOrigin } from "../shared/read-state";
import { normalizeTimelinePage, object, projectTimelineRows, string, type TimelineItem } from "../shared/timeline";
import { redactSecrets } from "./insight-analysis";
import { activitySignature, detectLoop, shortHash, stuckLimit, toolStepOf, type LiveIssue, type ToolStep } from "../shared/live-issue";
import { contentRevision } from "./revision";

/** What the summary is computed from; the same inputs (and rules) the page uses. */
export interface AttentionSources {
  telemetry(): Promise<TelemetrySnapshot>;
  background(): BackgroundAgent[];
  /** Whether an Agent is loaded in the host now (seen live by this process): only those may have their timeline read. */
  isLive(agentId: string): boolean;
  receipts(): Promise<{ receipts: ReadReceipt[]; archiveOrigins: ArchiveReadOrigin[] }>;
  preferences(): Promise<{ snoozes: CompletionSnooze[]; settings: ObservatorySettings }>;
  /** Failed scheduled runs since an instant (定时运行 row); null when unknown. */
  scheduleFailures?(sinceMs: number): Promise<number | null>;
  /** The device's IANA zone a badge read reported (server/device-zone.ts `DeviceZone.note`), already shaped like a zone name. */
  noteZone?(zone: string): void;
  /** 提醒 settings (shared/alerts.ts): while the chime is on, the summary carries its events. */
  alerts?(): AlertSettings;
}
/** One Agent that needs you, by the page's rules, and where it ranks. */
interface Waiting { agent: AgentRecord; phase: AttentionPhase; rank: number; since: string | null }

/**
 * The chime's events (shared/alerts.ts `chimeSchema`): one per pending request (its id), else one per time the Agent started
 * waiting in this phase, each with the turn it belongs to. Kinds the settings silence and (unless asked) subagents are left out.
 */
export function chimeEvents(waiting: readonly Waiting[], settings: AlertSettings): ChimeState {
  const events: ChimeEvent[] = [];
  const add = (id: string, kind: ChimeKind, turn: string) => { if (chimeKindEnabled(settings, kind) && events.length < 64) events.push({ id: id.slice(0, 600), kind, turn: turn.slice(0, 300) }); };
  for (const { agent, phase, since } of waiting) {
    if (agent.parentAgentId && !settings.chimeSubagents) continue;
    const turn = agent.activeTurnStartedAt ?? agent.observedTurnStartedAt ?? agent.lastUserMessageAt ?? "";
    const requests = phase === "approval" || phase === "question" || phase === "plan" ? (agent.pending ?? []).filter(request => request.requestId) : [];
    for (const request of requests) add(`${agent.id}|request|${request.requestId}`, request.kind === "question" ? "question" : "approval", turn);
    if (!requests.length) add(`${agent.id}|${phase}|${since ?? ""}`, chimeKindOf(phase), turn);
  }
  return { quiet: quietHours(settings), events };
}
export interface AttentionOptions { now?: () => number; idleMs?: number; todoEveryMs?: number; maxTodoReads?: number }
type EventStream = ReturnType<PaseoApi["observeEvents"]>;

const NOTE_MAX = 160, MAX_NOTES = 500, ASK_MAX = 120;
/** The host's attention note (its notification body, the reply's start) as one redacted line. */
export function noteOf(body: unknown): string | null {
  const text = redactSecrets(string(body)).replace(/\s+/g, " ").trim();
  return text ? text.length > NOTE_MAX ? `${text.slice(0, NOTE_MAX - 1)}…` : text : null;
}
/** The sentence a reply's 快捷回复 answer (shared/reply.ts `nudgeSentence`), redacted like a note, on one line of at most 120 characters. */
/** Rows of a running turn read for its todo list and live issues: enough for the 16-call rotation window. */
const LIVE_ROWS = 80;
export function askOf(sentence: unknown): string | null {
  const text = redactSecrets(string(sentence)).replace(/\s+/g, " ").trim(), chars = Array.from(text);
  return text ? chars.length > ASK_MAX ? `${chars.slice(0, ASK_MAX - 1).join("")}…` : text : null;
}
/** The latest todo list in projected rows: how many are done and what is in progress (B12). */
export function todoOf(items: readonly TimelineItem[], at: string): AgentTodo | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.type !== "todo" || !Array.isArray(item.items)) continue;
    const tasks = item.items.map(object), done = tasks.filter(task => task.completed === true || task.status === "completed").length;
    const active = tasks.find(task => task.status === "in_progress") ?? tasks.find(task => task.completed !== true && task.status !== "completed");
    const current = string(active?.activeForm).trim() || string(active?.text).trim();
    return tasks.length ? { done, total: tasks.length, current: current ? current.slice(0, 40) : null, at } : null;
  }
  return null;
}

/**
 * The host-wide 需要处理 summary behind the sidebar badge (opus-B1), and the live extras of loaded Agents: the running turn's
 * todo progress (opus-B12), the host's attention notes (opus-B11) and the sentence each latest reply's 快捷回复 answer (P2-1).
 * It keeps its own directory observation while someone reads it and lets go after `idleMs` without a read, so a host nobody
 * looks at carries no observation.
 */
export class AttentionIndex {
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly todoEveryMs: number;
  private readonly maxTodoReads: number;
  private directory: ReturnType<typeof createAgentDirectory> | null = null;
  /** The directory's scope: 显示后台工作区, the host setting the page follows too. */
  private backgroundWorkspaces = false;
  private started: Promise<void> | null = null;
  private stream: EventStream | null = null;
  private paseo: PaseoApi | null = null;
  private lastRead = 0;
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly notes = new Map<string, { note: string; at: string }>();
  private readonly asks = new Map<string, { ask: string; at: string }>();
  private readonly todos = new Map<string, AgentTodo>();
  private readonly todoReadAt = new Map<string, number>();
  /** 原地打转 / 可能卡住 of running turns (2.18), memory only. */
  private readonly issues = new Map<string, Omit<LiveIssue, "seen">>();
  /** When the turn's latest rows last changed, as this process saw them. */
  private readonly activity = new Map<string, { turn: string; signature: string; changedAt: number }>();
  /** 知道了: the issue key the user saw, per Agent. */
  private readonly seenIssues = new Map<string, string>();
  private todoReading: Promise<void> | null = null;
  private closed = false;
  /** Kept observing without readers (同步到侧栏标签), and told of every directory change. */
  private kept = false;
  private readonly changeListeners = new Set<() => void>();

  constructor(private readonly sources: AttentionSources, options: AttentionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.idleMs = options.idleMs ?? 10 * 60_000;
    this.todoEveryMs = options.todoEveryMs ?? 30_000;
    this.maxTodoReads = options.maxTodoReads ?? 8;
  }

  /** Start (or keep) the directory observation and the attention-note stream for this connection. */
  attach(paseo: PaseoApi): Promise<void> {
    this.lastRead = this.now();
    if (this.closed) return Promise.resolve();
    this.paseo = paseo;
    if (!this.idleTimer) { this.idleTimer = setInterval(() => this.release(false), 60_000); this.idleTimer.unref?.(); }
    if (!this.stream && typeof paseo.observeEvents === "function") {
      try {
        const handle = paseo.observeEvents(["agent_attention_required"]);
        this.stream = handle;
        handle.subscribe({ snapshot: () => {}, update: message => this.receive(message), error: () => { if (this.stream === handle) { this.stream = null; void handle.release().catch(() => {}); } } });
      } catch { this.stream = null; }
    }
    // The badge counts the Agents the page lists: with 显示后台工作区 on, those in background workspaces too. A change of the
    // setting reads the other scope from the start.
    return this.sources.preferences().then(({ settings }) => settings.backgroundWorkspaces === true, () => this.backgroundWorkspaces).then(backgroundWorkspaces => {
      if (this.closed) return;
      if (this.directory && backgroundWorkspaces !== this.backgroundWorkspaces) { this.directory.stop(); this.directory = null; this.started = null; }
      this.backgroundWorkspaces = backgroundWorkspaces;
      if (!this.directory) {
        const api: AgentDirectoryApi = {
          list: options => paseo.agents.list(options) as never,
          observe: options => paseo.agents.list({ ...options, subscribe: {} }).then(result => result.subscription as unknown as AgentDirectorySubscription),
        };
        const directory = createAgentDirectory(api, { includeArchived: false, backgroundWorkspaces, notifyDelayMs: 0 });
        this.directory = directory;
        directory.subscribe(() => this.changed());
        directory.start(true);
        this.started = directory.refresh();
      }
      return this.started ?? undefined;
    });
  }

  /** `agent_attention_required`: the note is what the host would notify with (the reply's start, the request's title). */
  receive(message: unknown): void {
    const event = object(message), payload = object(event.payload);
    if (this.closed || event.type !== "agent_attention_required") return;
    const agentId = string(payload.agentId), at = Date.parse(string(payload.timestamp));
    if (!agentId || agentId.length > 256 || !Number.isFinite(at)) return;
    // Only a finished turn's note explains a result or a reply that asks; a request's note would be read as one later.
    if (string(payload.reason) === "finished") {
      const note = noteOf(object(payload.notification).body);
      this.notes.delete(agentId);
      if (note) this.notes.set(agentId, { note, at: new Date(at).toISOString() });
      while (this.notes.size > MAX_NOTES) this.notes.delete(this.notes.keys().next().value!);
    }
    // A live observation already delivers the Agent's new state; only a polling fallback is read again now.
    const directory = this.directory;
    if (directory && !directory.getSnapshot().live) void directory.refresh();
  }
  /**
   * `agent.turn_ended`: the closing sentence its final reply's 快捷回复 answer (`nudgeSentence` of that reply, null when it
   * invites nothing or there is none), at the turn's end. Memory only, like the notes: a new turn and a reload forget it, and
   * the popover then offers no quick reply (the detail still does, under the reply itself).
   */
  noteAsk(agentId: string, sentence: string | null, at: string = new Date(this.now()).toISOString()): void {
    if (this.closed || !agentId || agentId.length > 256) return;
    const ask = sentence ? askOf(sentence) : null, when = Date.parse(at);
    this.asks.delete(agentId);
    if (ask && Number.isFinite(when)) this.asks.set(agentId, { ask, at: new Date(when).toISOString() });
    while (this.asks.size > MAX_NOTES) this.asks.delete(this.asks.keys().next().value!);
  }
  /** A new turn makes the old todo list, note and quick replies' sentence stale. */
  turnStarted(agentId: string): void { this.todos.delete(agentId); this.todoReadAt.delete(agentId); this.asks.delete(agentId); this.forgetIssue(agentId); }
  /** The turn's final todo list is no longer progress; the next turn reads it again. */
  turnEnded(agentId: string): void { this.todos.delete(agentId); this.todoReadAt.delete(agentId); this.forgetIssue(agentId); }
  closedAgent(agentId: string): void { this.todos.delete(agentId); this.todoReadAt.delete(agentId); this.forgetIssue(agentId); }
  private forgetIssue(agentId: string): void { this.issues.delete(agentId); this.activity.delete(agentId); this.seenIssues.delete(agentId); }
  /** 知道了 on a live issue: it stays shown, and stops counting until a new pattern or a later turn. */
  seeIssue(agentId: string, key: string): boolean {
    const issue = this.issues.get(agentId);
    if (!issue || issue.key !== key) return false;
    this.seenIssues.set(agentId, key);
    this.changed();
    return true;
  }

  /** The page's records, enriched exactly as the page does it (lifecycle, background, receipts, notes, todos). */
  private async records(): Promise<{ agents: AgentRecord[]; truncated: boolean; ready: boolean; failed: boolean }> {
    const directory = this.directory?.getSnapshot();
    if (!directory) return { agents: [], truncated: false, ready: false, failed: false };
    const [telemetry, receipts] = await Promise.all([this.sources.telemetry(), this.sources.receipts()]);
    const byReceipt = new Map(receipts.receipts.map(receipt => [receipt.agentId, receipt])), byOrigin = new Map(receipts.archiveOrigins.map(origin => [origin.agentId, origin]));
    const visible = directory.agents.filter(agent => !agent.archivedAt && agent.labels["observatory.role"] !== "insight");
    const enriched = enrichAgents(visible, telemetry, { agents: this.sources.background() })
      .map(agent => applyReadReceipt(applyArchiveReadOrigin(agent, byOrigin.get(agent.id)), byReceipt.get(agent.id)));
    // Ready once a read went through; a failed one (even after that) is reported, so no stale or partial number is shown.
    return { agents: applyLiveExtras(enriched, this.extras()), truncated: directory.truncated, ready: directory.lastSyncedAt !== null, failed: directory.error !== null };
  }

  /** Everything that needs you, by the page's rules, waiting longest first within each rank. */
  private async waiting(): Promise<{ waiting: Waiting[]; truncated: boolean; ready: boolean; failed: boolean }> {
    const [{ agents, truncated, ready, failed }, { snoozes, settings }] = await Promise.all([this.records(), this.sources.preferences()]);
    // The badge's reads keep running turns watched (原地打转 / 可能卡住), not only an open page's.
    void this.readTodos(agents);
    const now = this.now();
    const waiting = agents.filter(agent => needsAttention(agent, isCompletionSnoozed(agent, snoozes, now), { childCompletions: settings.childCompletions }))
      .map(agent => { const phase = attentionPhase(agent) ?? "unread" as const; return { agent, phase, rank: phaseRank[phase], since: waitingSince(agent, phase) }; })
      .sort((a, b) => a.rank - b.rank || (Date.parse(a.since ?? "") || Infinity) - (Date.parse(b.since ?? "") || Infinity) || a.agent.id.localeCompare(b.agent.id));
    return { waiting, truncated, ready, failed };
  }

  async summary(): Promise<AttentionSummary> {
    const { waiting, truncated, ready, failed } = await this.waiting(), now = this.now();
    // Todo progress is read for the page's live extras only; the badge does not need it.
    const scheduleFailures = this.sources.scheduleFailures ? await this.sources.scheduleFailures(now - 86_400_000).catch(() => null) : null;
    const alerts = this.sources.alerts?.();
    return { count: waiting.length, truncated, blocking: waiting.filter(item => item.rank === 0).length, loud: waiting.filter(item => loudPhases.has(item.phase)).length,
      entries: waiting.slice(0, 8).map(item => entryOf(item.agent, item.phase)), scheduleFailures, ready, failed, chime: alerts?.chime ? chimeEvents(waiting, alerts) : null };
  }

  /**
   * 同步到侧栏标签: each workspace's most urgent 需要处理 phase, by the same rules as the badge. `known`: the directory was read
   * whole (not failed, not truncated): only then may a workspace missing here be taken as needing nothing.
   */
  async workspaces(): Promise<{ phases: Map<string, AttentionPhase>; ready: boolean; known: boolean }> {
    const { waiting, truncated, ready, failed } = await this.waiting(), phases = new Map<string, AttentionPhase>();
    for (const { agent, phase } of waiting) {
      if (!agent.workspaceId) continue;
      const held = phases.get(agent.workspaceId);
      if (!held || phaseRank[phase] < phaseRank[held] || phaseRank[phase] === phaseRank[held] && ATTENTION_PHASES.indexOf(phase) < ATTENTION_PHASES.indexOf(held)) phases.set(agent.workspaceId, phase);
    }
    return { phases, ready: ready && !failed, known: ready && !failed && !truncated };
  }
  /** Keep the directory observed while nobody reads the badge (the label sync), or let it go idle again. */
  keep(on: boolean): void { this.kept = on; }
  /** Told whenever the observed directory changes (debounce it: a running Agent reports often). */
  onChange(listener: () => void): () => void { this.changeListeners.add(listener); return () => { this.changeListeners.delete(listener); }; }

  async read(input: { revision?: string } = {}): Promise<AttentionResponse> {
    const summary = await this.summary(), revision = contentRevision(summary);
    return input.revision === revision ? { mode: "unchanged", unchanged: true, revision } : { ...summary, mode: "full", unchanged: false, revision };
  }

  extras(): LiveExtra[] {
    const ids = new Set([...this.notes.keys(), ...this.todos.keys(), ...this.asks.keys(), ...this.issues.keys()]);
    return [...ids].slice(-500).map(agentId => {
      const issue = this.issues.get(agentId);
      return { agentId, todo: this.todos.get(agentId) ?? null, note: this.notes.get(agentId)?.note ?? null, noteAt: this.notes.get(agentId)?.at ?? null,
        ask: this.asks.get(agentId)?.ask ?? null, askAt: this.asks.get(agentId)?.at ?? null,
        issue: issue ? { ...issue, seen: this.seenIssues.get(agentId) === issue.key } : null };
    });
  }
  async readExtras(input: { revision?: string } = {}): Promise<LiveExtrasResponse> {
    const records = await this.records();
    void this.readTodos(records.agents);
    const agents = this.extras(), revision = contentRevision(agents);
    return input.revision === revision ? { mode: "unchanged", unchanged: true, revision } : { mode: "full", unchanged: false, revision, agents };
  }

  /**
   * Todo progress and live issues (原地打转 / 可能卡住) of running Agents: their timeline tail, read at most every `todoEveryMs`
   * each and only for Agents this process has seen live (a running Agent is loaded; asking about an unloaded one would load it).
   */
  private readTodos(agents: readonly AgentRecord[]): Promise<void> {
    const paseo = this.paseo;
    if (!paseo || this.todoReading || this.closed) return this.todoReading ?? Promise.resolve();
    const now = this.now();
    const due = agents.filter(agent => agent.status === "running" && agent.activeTurnStartedAt && !agent.archivedAt && this.sources.isLive(agent.id)
      && now - (this.todoReadAt.get(agent.id) ?? -Infinity) >= this.todoEveryMs).slice(0, this.maxTodoReads);
    if (!due.length) return Promise.resolve();
    this.todoReading = (async () => {
      for (const agent of due) {
        if (this.closed) return;
        this.todoReadAt.set(agent.id, now);
        try {
          const page = normalizeTimelinePage(await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: LIVE_ROWS, projection: "projected" }));
          const start = Date.parse(agent.activeTurnStartedAt!);
          // Only this turn's lists count; an older one in the tail is the previous turn's.
          const rows = projectTimelineRows(page.rows).filter(row => Date.parse(row.timestamp) >= start - 1000);
          const todo = todoOf(rows.map(row => row.item), new Date(now).toISOString());
          if (todo) this.todos.set(agent.id, todo);
          this.watchTurn(agent.id, agent.activeTurnStartedAt!, rows.map(row => ({ item: row.item, at: Date.parse(row.timestamp) })), now, (agent.background?.running ?? 0) > 0);
        } catch { /* keep the last known progress */ }
      }
      while (this.todoReadAt.size > 2_000) this.todoReadAt.delete(this.todoReadAt.keys().next().value!);
    })().finally(() => { this.todoReading = null; });
    return this.todoReading;
  }

  /**
   * 原地打转 / 可能卡住 for one running turn, from its latest rows: a loop in its tool calls (shared/live-issue.ts), or rows that
   * stopped changing for 10 minutes (45 while a tool call still runs). A pattern keeps the time it was first seen. While its
   * sub-agents or background agents work (`delegated`) the Agent waits on them, not stuck: its quiet clock starts when they stop.
   */
  private watchTurn(agentId: string, turn: string, rows: ReadonlyArray<{ item: TimelineItem; at: number }>, now: number, delegated = false): void {
    const items = rows.map(row => row.item);
    const signature = activitySignature(items), previous = this.activity.get(agentId);
    const changedAt = !delegated && previous && previous.turn === turn && previous.signature === signature ? previous.changedAt : now;
    this.activity.set(agentId, { turn, signature, changedAt });
    while (this.activity.size > 2_000) this.activity.delete(this.activity.keys().next().value!);
    const short = (value: string, max: number) => { const clean = redactSecrets(value).replace(/\s+/g, " ").trim(); return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean; };
    const steps = rows.map(row => toolStepOf(row.item, row.at)).filter((step): step is ToolStep => step !== null && Number.isFinite(step.at));
    const loop = detectLoop(steps), held = this.issues.get(agentId);
    let issue: Omit<LiveIssue, "seen"> | null = null;
    if (loop) {
      const key = `${turn}:${loop.key}`;
      issue = { kind: "looping", key, since: held?.key === key ? held.since : new Date(now).toISOString(), pattern: loop.pattern, tool: short(loop.tool, 120) || null,
        count: loop.count, toolRunning: false, evidence: loop.evidence.map(line => short(line, 160)) };
    } else {
      const { limitMs, running } = stuckLimit(items), quietFor = now - changedAt, turnAge = now - Date.parse(turn);
      if (quietFor >= limitMs && turnAge >= limitMs) {
        const key = `${turn}:stuck:${shortHash(signature)}`;
        issue = { kind: "stuck", key, since: new Date(changedAt).toISOString(), pattern: null, tool: running ? short(running.label || running.name, 120) || null : null,
          count: Math.floor(quietFor / 60_000), toolRunning: !!running, evidence: steps.slice(-3).map(step => short(`${step.name} ${step.label}`, 160)) };
      }
    }
    if (issue) this.issues.set(agentId, issue);
    else { this.issues.delete(agentId); this.seenIssues.delete(agentId); }
    while (this.issues.size > 500) this.issues.delete(this.issues.keys().next().value!);
    // A new, changed or cleared issue has no directory event of its own: the sidebar labels hear it here.
    if ((issue?.key ?? null) !== (held?.key ?? null)) this.changed();
  }

  private changed(): void { for (const listener of this.changeListeners) listener(); }

  /** Let go of the observation and the stream when nobody has read for a while (or on close). */
  private release(force: boolean): void {
    if (!force && (this.kept || this.now() - this.lastRead < this.idleMs)) return;
    this.directory?.stop(); this.directory = null; this.started = null;
    const stream = this.stream; this.stream = null;
    void stream?.release().catch(() => {});
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }
  close(): void { this.closed = true; this.release(true); this.notes.clear(); this.todos.clear(); this.asks.clear(); this.issues.clear(); this.activity.clear(); this.seenIssues.clear(); this.changeListeners.clear(); }
}

export function registerAttention(server: PluginServerContext, sources: AttentionSources, options: AttentionOptions = {}) {
  const index = new AttentionIndex(sources, options);
  const ready = async (paseo: PaseoApi) => {
    // The first read waits briefly for the directory; later reads answer from it at once.
    await Promise.race([index.attach(paseo).catch(() => {}), new Promise<void>(resolve => { const timer = setTimeout(resolve, 4_000); timer.unref?.(); })]);
  };
  server.handle(getAttention, async (input, { paseo }) => { if (input.timeZone) sources.noteZone?.(input.timeZone); await ready(paseo); return index.read(input); });
  server.handle(getLiveExtras, async (input, { paseo }) => { await ready(paseo); return index.readExtras(input); });
  server.handle(seeLiveIssue, async (input, { paseo }) => { await ready(paseo); return { ok: index.seeIssue(input.agentId, input.key) }; });
  return index;
}
