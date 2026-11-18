import { t } from "./text";
import { agentAttentionPriority, compareAgents, normalizeAgent, preserveCompletionEvidence, timestamp, type AgentRecord, type AgentSource, type AgentProjectPlacement } from "./model";

export interface AgentDirectoryPage {
  entries: Array<{ agent: AgentSource; project?: AgentProjectPlacement | null }>;
  pageInfo: { nextCursor: string | null; hasMore: boolean };
}
export type AgentDirectoryUpdate =
  | { kind: "upsert"; agent: AgentSource; project?: AgentProjectPlacement | null }
  | { kind: "remove"; agentId: string };
export interface AgentDirectoryListOptions {
  filter: { includeArchived: boolean; requiresAttention?: boolean; includeBackground?: true };
  sort: Array<{ key: "updated_at"; direction: "desc" }>;
  page: { limit: number; cursor?: string };
  timeout: number;
}
/** An owned directory observation (Paseo 0.9 `agents.list({ subscribe: {} })`). */
export interface AgentDirectorySubscription {
  subscribe(observer: { snapshot(value: unknown): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
}
export interface AgentDirectoryApi {
  list(options: AgentDirectoryListOptions): Promise<AgentDirectoryPage>;
  /** Filter-scoped live updates for every matching agent; a fresh snapshot follows each reconnect. */
  observe?(options: AgentDirectoryListOptions): Promise<AgentDirectorySubscription>;
}
export interface ObservatoryState {
  agents: AgentRecord[];
  loading: boolean;
  error: string | null;
  lastSyncedAt: string | null;
  isRefreshing: boolean;
  truncated: boolean;
  /** An owned observation is delivering live updates; periodic reads are only a safety net. */
  live: boolean;
}
interface DirectoryOptions {
  includeArchived: boolean;
  /**
   * Agents in background workspaces too (「显示后台工作区里的 Agent」). Asked for only when on: Paseo's SDK refuses `includeBackground` on a
   * host older than 0.12, which has no background workspaces.
   */
  backgroundWorkspaces?: boolean;
  maxAgents?: number;
  pageSize?: number;
  /** Complete reads while no live observation is available. */
  pollIntervalMs?: number;
  /** Safety reconciliation while live updates are flowing. */
  reconcileIntervalMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  /**
   * Live updates are folded into one notification per this many milliseconds. A running Claude turn reports usage on every
   * API message, so a dozen running Agents send dozens of updates a second; each used to re-sort and re-render everything.
   */
  notifyDelayMs?: number;
}

export const DIRECTORY_LIMIT = 2_000;
export const DIRECTORY_POLL_INTERVAL = 15_000;
export const DIRECTORY_RECONCILE_INTERVAL = 10 * 60_000;
const OBSERVE_RETRY_DELAYS = [2_000, 5_000, 15_000, 30_000, 60_000];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : t("sharedDirectoryStore.m001");
}
/** A Paseo 0.16 background agent reports to the Agent that made it, never to the user: never listed, whatever the scope. */
const helper = (agent: AgentSource) => agent.background === true;

function normalizeDirectoryAgent(source: AgentSource, project: AgentProjectPlacement | null | undefined, previous?: AgentRecord): AgentRecord {
  const sameWorkspace = previous !== undefined && (source.workspaceId ?? null) === previous.workspaceId;
  const sameCheckout = sameWorkspace && (source.cwd ?? null) === previous?.cwd;
  return preserveCompletionEvidence(previous, normalizeAgent({
    ...source,
    projectId: source.projectId ?? (sameWorkspace ? previous?.projectId : undefined),
    projectName: source.projectName ?? (sameWorkspace ? previous?.projectName : undefined),
    projectRootPath: source.projectRootPath ?? (sameWorkspace ? previous?.projectRootPath : undefined),
    checkoutKind: source.checkoutKind ?? (sameCheckout ? previous?.checkoutKind : undefined),
    worktreePath: source.worktreePath !== undefined ? source.worktreePath : sameCheckout ? previous?.worktreePath : undefined,
    branch: source.branch !== undefined ? source.branch : sameCheckout ? previous?.branch : undefined,
  }, {
    project,
    workspaceName: project?.workspaceName ?? source.workspaceName ?? (sameWorkspace ? previous?.workspaceName : undefined),
  }));
}

/**
 * Paseo 0.9 delivers directory events only to observations this surface owns. One
 * released-on-hide observation (a one-entry snapshot) carries live updates; complete
 * paged reads run on start, foreground, reconnect and a slow safety interval, and fall
 * back to polling only while the observation is unavailable.
 */
export function createAgentDirectory(api: AgentDirectoryApi, options: DirectoryOptions) {
  const maxAgents = Math.max(1, options.maxAgents ?? DIRECTORY_LIMIT);
  const pageSize = Math.min(200, maxAgents, Math.max(1, options.pageSize ?? 200));
  const pollIntervalMs = Math.max(10, options.pollIntervalMs ?? DIRECTORY_POLL_INTERVAL);
  const reconcileIntervalMs = Math.max(pollIntervalMs, options.reconcileIntervalMs ?? DIRECTORY_RECONCILE_INTERVAL);
  const retryDelays = options.retryDelaysMs?.length ? options.retryDelaysMs : OBSERVE_RETRY_DELAYS;
  const now = options.now ?? Date.now;
  const notifyDelay = Math.max(0, options.notifyDelayMs ?? 200);
  const scope = { includeArchived: options.includeArchived, ...(options.backgroundWorkspaces ? { includeBackground: true as const } : {}) };
  let state: ObservatoryState = { agents: [], loading: true, error: null, lastSyncedAt: null, isRefreshing: false, truncated: false, live: false };
  let records = new Map<string, AgentRecord>();
  // Live updates mark the published list stale; it is rebuilt when read (getSnapshot), at most once per batch. Updates
  // that cannot move a row (usage, context, a pending-request detail) replace it in place instead of re-sorting the list.
  let stale = false, resort = false, notifyTimer: ReturnType<typeof setTimeout> | null = null;
  const replacements = new Map<string, AgentRecord>();
  let positions = new Map<string, number>();
  // Keep ordering metadata after an archive removes a visible row. Without it,
  // a delayed pre-archive snapshot can resurrect that row in the active view.
  const versions = new Map<string, { at: number | null; agent: AgentRecord | null }>();
  let revision = 0;
  const journal = new Map<string, { revision: number; value: AgentRecord | null; at: number | null }>();
  const listeners = new Set<() => void>();
  let observation: { handle: AgentDirectorySubscription; detach: () => void } | null = null;
  let observing: Promise<void> | null = null;
  let observeGeneration = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let disposed = false;
  let started = false;
  let active = true;
  let generation = 0;
  let activityGeneration = 0;

  function notify() {
    if (notifyTimer !== null) { clearTimeout(notifyTimer); notifyTimer = null; }
    for (const listener of listeners) listener();
  }
  function publish(patch: Partial<ObservatoryState>) {
    if (disposed) return;
    settle();
    state = { ...state, ...patch };
    notify();
  }
  function sortedRecords(): { agents: AgentRecord[]; overflow: boolean } {
    const sorted = [...records.values()].sort(compareAgents);
    const overflow = sorted.length > maxAgents;
    if (overflow) records = new Map(sorted.slice(0, maxAgents).map((agent) => [agent.id, agent]));
    const agents = overflow ? sorted.slice(0, maxAgents) : sorted;
    positions = new Map(agents.map((agent, index) => [agent.id, index]));
    replacements.clear(); resort = false; stale = false;
    return { agents, overflow };
  }
  /** Brings the published list up to date with live updates received since it was built. */
  function settle() {
    if (!stale) return;
    if (resort) { const { agents, overflow } = sortedRecords(); state = { ...state, agents, ...(overflow ? { truncated: true } : {}) }; return; }
    const agents = state.agents.slice();
    for (const [id, agent] of replacements) agents[positions.get(id)!] = agent;
    replacements.clear(); stale = false;
    state = { ...state, agents };
  }
  function publishRecords(patch: Partial<ObservatoryState> = {}) {
    const { agents, overflow } = sortedRecords();
    publish({ agents, ...(overflow ? { truncated: true } : {}), ...patch });
  }
  /** A live update: the list is rebuilt lazily and listeners hear about a batch of updates once. */
  function changed(id: string, previous: AgentRecord | undefined, value: AgentRecord | null) {
    const index = positions.get(id);
    const inPlace = !resort && value !== null && previous !== undefined && index !== undefined && state.agents[index]?.id === id
      && agentAttentionPriority(previous) === agentAttentionPriority(value) && previous.lastActivityAt === value.lastActivityAt && previous.title === value.title;
    if (inPlace) replacements.set(id, value); else resort = true;
    stale = true;
    if (notifyDelay === 0) { notify(); return; }
    if (notifyTimer === null) notifyTimer = setTimeout(() => { notifyTimer = null; if (!disposed) notify(); }, notifyDelay);
  }
  function stopTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function schedule() {
    stopTimer();
    if (active && started && !disposed) timer = setTimeout(() => { void refresh(); }, observation ? reconcileIntervalMs : pollIntervalMs);
  }
  function release() {
    observeGeneration += 1;
    observing = null;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    const current = observation;
    observation = null;
    if (current) { current.detach(); void current.handle.release().catch(() => {}); }
  }
  function retryObserve() {
    if (retryTimer !== null || disposed || !active || !started) return;
    const delay = retryDelays[Math.min(retries, retryDelays.length - 1)];
    retries += 1;
    retryTimer = setTimeout(() => { retryTimer = null; void observe(); }, delay);
  }
  function observe(): Promise<void> {
    if (!api.observe || disposed || !active || !started || observation) return Promise.resolve();
    if (observing) return observing;
    const current = ++observeGeneration;
    const request = Promise.resolve().then(() => api.observe!({ filter: { ...scope },
      sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 1 }, timeout: 12_000 })).then(handle => {
      if (current !== observeGeneration || disposed || !active) { void handle.release().catch(() => {}); return; }
      let bootstrapped = false;
      const lost = () => {
        if (observation?.handle !== handle) return;
        release(); publish({ live: false }); schedule(); retryObserve();
      };
      const detach = handle.subscribe({
        // The first snapshot is this subscription's own bootstrap; later ones mean reconnected delivery.
        snapshot: () => { if (!bootstrapped) { bootstrapped = true; return; } if (observation?.handle === handle) void refresh(); },
        update: message => { const event = message && typeof message === "object" ? message as { type?: unknown; payload?: unknown } : {};
          if (event.type === "agent_update" && event.payload && typeof event.payload === "object") handleUpdate(event.payload as AgentDirectoryUpdate); },
        error: lost,
      });
      observation = { handle, detach };
      retries = 0;
      publish({ live: true });
      // A retry after a lost observation catches up on events missed meanwhile; startup reads are already queued.
      if (!inFlight) void refresh();
    }).catch(() => {
      if (current !== observeGeneration) return;
      publish({ live: false });
      retryObserve();
    }).finally(() => { if (current === observeGeneration) observing = null; });
    observing = request;
    return request;
  }
  function observedAt(agent: AgentRecord): number | null {
    return timestamp(agent.updatedAt) ?? timestamp(agent.archivedAt);
  }
  function rememberVersion(id: string, agent: AgentRecord | null, at: number | null) {
    versions.delete(id);
    versions.set(id, { agent, at });
    while (versions.size > 4_000) versions.delete(versions.keys().next().value!);
  }
  function visible(agent: AgentRecord | null): AgentRecord | null {
    return agent?.archivedAt && !options.includeArchived ? null : agent;
  }
  function handleUpdate(update: AgentDirectoryUpdate) {
    if (disposed || update.kind === "upsert" && helper(update.agent)) return;
    const id = update.kind === "remove" ? update.agentId : update.agent.id;
    const known = versions.get(id);
    const previous = records.get(id) ?? known?.agent ?? undefined;
    const candidate = update.kind === "remove" ? null : normalizeDirectoryAgent(update.agent, update.project, previous);
    const at = candidate ? observedAt(candidate) : null;
    const previousAt = known?.at ?? (previous ? observedAt(previous) : null);
    // Compare before applying the archive visibility filter; a hidden row still
    // carries the version that determines whether this transition is current.
    if (at !== null && previousAt !== null && at < previousAt) return;
    rememberVersion(id, candidate, at ?? previousAt);
    const value = visible(candidate);
    const shown = records.get(id);
    if (value) records.set(id, value);
    else records.delete(id);
    revision += 1;
    if (inFlight) journal.set(id, { revision, value, at });
    if (value || shown) changed(id, shown, value);
  }

  function overlayLive(snapshot: Map<string, AgentRecord>, since: number) {
    for (const [id, entry] of journal) {
      if (entry.revision <= since) continue;
      if (entry.value === null) {
        const fetched = snapshot.get(id);
        const fetchedAt = fetched ? observedAt(fetched) : null;
        // An explicit removal has no timestamp and wins during its read. A
        // versioned archive must not hide an even newer restored page record.
        if (entry.at === null || fetchedAt === null || entry.at >= fetchedAt) snapshot.delete(id);
      }
      else {
        const fetched = snapshot.get(id);
        // Prefer wire events when the daemon doesn't supply ordering timestamps.
        if (!fetched || (timestamp(entry.value.updatedAt) ?? 0) >= (timestamp(fetched.updatedAt) ?? 0)) snapshot.set(id, entry.value);
      }
    }
    return snapshot;
  }

  function refresh(): Promise<void> {
    if (disposed || !active) return Promise.resolve();
    if (inFlight) return inFlight;
    stopTimer();
    const since = revision;
    const requestGeneration = generation;
    const requestActivityGeneration = activityGeneration;
    const interrupted = () => disposed || requestGeneration !== generation || !active || requestActivityGeneration !== activityGeneration;
    const snapshot = new Map<string, AgentRecord>();
    publish({ isRefreshing: true });
    // Establish live delivery before reading pages, so changes during the read are journaled.
    // Deferring at least one microtask also journals synchronous SDK callbacks.
    inFlight = Promise.resolve(observing ?? undefined).then(async () => {
      let truncated = false;
      let pages = 0;
      // Fetch attention first so old unread results are not hidden behind the
      // bounded recent directory. Archive views do not need the active queue.
      for (const attentionOnly of options.includeArchived ? [false] : [true, false]) {
       let cursor: string | undefined;
       const seenCursors = new Set<string>();
       while (!interrupted()) {
        if (snapshot.size >= maxAgents || pages >= 50) { truncated = true; break; }
        const page = await api.list({
          filter: { ...scope, ...(attentionOnly ? { requiresAttention: true } : {}) },
          sort: [{ key: "updated_at", direction: "desc" }],
          page: { limit: Math.min(pageSize, maxAgents - snapshot.size), ...(cursor ? { cursor } : {}) },
          timeout: 12_000,
        });
        if (interrupted()) return;
        pages += 1;
        for (const entry of page.entries) {
          if (attentionOnly && entry.agent.requiresAttention !== true || helper(entry.agent)) continue;
          const known = versions.get(entry.agent.id);
          const candidate = normalizeDirectoryAgent(entry.agent, entry.project, snapshot.get(entry.agent.id) ?? records.get(entry.agent.id) ?? known?.agent ?? undefined);
          const at = observedAt(candidate);
          const live = journal.get(candidate.id);
          const older = at !== null && known?.at !== null && known?.at !== undefined && at < known.at;
          // At equal versions, a live event delivered during this request wins
          // over the response that was already being fetched.
          const liveWins = live && live.revision > since && (live.at === null || at === null || live.at >= at);
          if (older || liveWins) {
            const retained = visible(known?.agent ?? records.get(candidate.id) ?? null);
            if (retained) snapshot.set(candidate.id, retained);
            else snapshot.delete(candidate.id);
            if (snapshot.size >= maxAgents) break;
            continue;
          }
          rememberVersion(candidate.id, candidate, at ?? known?.at ?? null);
          const value = visible(candidate);
          if (!value) { snapshot.delete(candidate.id); continue; }
          const previous = snapshot.get(value.id);
          if (!previous || (timestamp(value.updatedAt) ?? 0) >= (timestamp(previous.updatedAt) ?? 0)) snapshot.set(value.id, value);
          if (snapshot.size >= maxAgents) break;
        }
        if (!page.pageInfo.hasMore) break;
        const next = page.pageInfo.nextCursor;
        // Bound work even if a faulty daemon returns duplicate-only pages forever.
        if (snapshot.size >= maxAgents || pages >= 50 || !next || seenCursors.has(next)) {
          truncated = true;
          break;
        }
        seenCursors.add(next);
        cursor = next;
       }
       if (interrupted()) return;
       if (snapshot.size >= maxAgents || pages >= 50) {
         // Even an exhausted attention query does not prove the ordinary
         // directory has no additional rows when all display slots are used.
         if (attentionOnly) truncated = true;
         break;
       }
      }
      if (interrupted()) return;
      records = overlayLive(snapshot, since);
      publishRecords({ loading: false, error: null, lastSyncedAt: new Date(now()).toISOString(), truncated: truncated || records.size > maxAgents });
    }).catch((error: unknown) => {
      if (interrupted()) return;
      // A failed later page must never erase agents from the last complete sync.
      const retained = new Map(records);
      for (const [id, value] of snapshot) {
        const previous = retained.get(id);
        if (!previous || (timestamp(value.updatedAt) ?? 0) > (timestamp(previous.updatedAt) ?? 0)) retained.set(id, value);
      }
      records = overlayLive(retained, since);
      publishRecords({ loading: false, error: errorMessage(error), truncated: state.truncated || (state.lastSyncedAt === null && snapshot.size > 0) });
    }).finally(() => {
      if (requestGeneration !== generation) return;
      inFlight = null;
      journal.clear();
      if (!disposed) {
        publish({ isRefreshing: false });
        if (active && requestActivityGeneration !== activityGeneration) void refresh();
        else schedule();
      }
    });
    return inFlight;
  }

  return {
    getSnapshot: (): ObservatoryState => { settle(); return state; },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start(isActive = true) {
      if (started) return;
      disposed = false;
      started = true;
      active = isActive;
      if (active) { void observe(); void refresh(); }
    },
    /** Hidden surfaces release their observation; the host stops sending directory events. */
    setActive(isActive: boolean) {
      if (disposed || active === isActive) return;
      active = isActive;
      if (!active) { activityGeneration += 1; stopTimer(); release(); retries = 0; publish({ live: false }); }
      else if (started) { void observe(); void refresh(); }
    },
    refresh,
    stop() {
      if (disposed) return;
      disposed = true;
      started = false;
      generation += 1;
      inFlight = null;
      stopTimer();
      if (notifyTimer !== null) { clearTimeout(notifyTimer); notifyTimer = null; }
      release();
      listeners.clear();
      journal.clear();
    },
  };
}
