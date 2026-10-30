import { t } from "../shared/text";
import { LanguageSettings } from "./language-settings";
import { AlertSettingsSections } from "./alert-settings";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View, type FlatList as NativeFlatList } from "react-native";
import { usePaseo, type PluginSurfaceProps, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQueryClient } from "@tanstack/react-query";
import { applyArchiveReadOrigin, applyReadReceipt, completionReadState, heldBySnooze, isUnreadCompletion, knownCompletionAt, matchesAgentStatus, matchesStatus, stopUnseen, waitingKind, type AgentRecord, type AgentStatus } from "../shared/model";
import { applyLiveExtras, threadAttention } from "../shared/attention";
import { enrichAgents, type BackgroundState } from "../shared/background";
import { buildDashboardRows, groupDashboardRows, needsAttention } from "../shared/dashboard-model";
import { hiddenEventCount, type TelemetrySnapshot } from "../shared/telemetry";
import { nextRangeChange, nextWindowExit, withinRange, rangeLabels, type TimeRange } from "../shared/time-range";
import type { AnalyticsSnapshot } from "../shared/analytics";
import { decisionSignals } from "../shared/decision-signals";
import { defaultObservatorySettings, isCompletionSnoozed, nextSnoozeExpiry, snoozeToken, type CompletionSnooze, type ViewPreferences } from "../shared/preferences";
import type { ReadReceipt } from "../shared/read-state";
import type { StatsRange } from "../shared/stats";
import { useObservatory } from "./use-observatory";
import { telemetryQueryKey, useTelemetry } from "./use-telemetry";
import { useAnalytics } from "./use-analytics";
import { useViewPreferences } from "./use-view-preferences";
import { readReceiptQueryKey, useReadReceipts } from "./use-read-receipts";
import { useAgentActivity } from "./use-agent-activity";
import { backgroundQueryKey, useBackground } from "./use-background";
import { liveExtrasQueryKey, useLiveExtras } from "./use-live-extras";
import { useHeartbeatCheck, useHeartbeats } from "./use-schedules";
import { archiveReadCandidates, confirmArchive, heartbeatGuard, type ArchiveOffer } from "../shared/schedules";
import { useStats } from "./use-stats";
import { useTokenLive, useTokens } from "./use-tokens";
import { useQuota } from "./use-quota";
import { QuotaChip } from "./quota-card";
import { recapsQueryKey, useRecaps } from "./use-recaps";
import { RecapSettingsSection } from "./recap-settings";
import { AgentDetail } from "./agent-detail";
import { AnalyticsDashboard } from "./analytics-dashboard";
import { InsightsHub } from "./insights";
import { ActivityFeed } from "./activity-feed";
import { StatsBoard, type SessionScopeTarget } from "./stats-board";
import { StatsBreakdown, type BreakdownDimension } from "./stats-breakdown";
import { StatsCompare } from "./stats-compare";
import { TokenBoard } from "./token-board";
import { tokenTotal } from "../shared/tokens";
import { ViewTabs, type ViewTab } from "./view-tabs";
import { Swimlane } from "./swimlane";
import { SessionList, countRunningDescendants, groupTitles, type SessionItem } from "./session-list";
import { LiveDot, PhaseLegend, StatusChip, hueColor } from "./status";
import { FilterSheet, ProjectSheet, RangeSheet, readFilterNames, sessionScopeNames, type FilterState, type SessionScope } from "./filters";
import { ActionMenu, Banner, Button, Chip, ChipBar, EmptyState, IconButton, SearchField, Sheet, Skeleton, Spacer, SplitView, SyncStatus, Toolbar, fontSize, hairline, hueFor, radius, space, useCompactLayout, type MenuAction } from "./kit";
import { checkoutName, statusNames, Switch, useClock } from "./ui";
import { tint, tintAlpha } from "./status";
import type { ScheduleFocus } from "./schedule-focus";

type DashboardProps = PluginSurfaceProps & { workspaceId?: string; initialAgentId?: string; archiveMode?: boolean; onOpenArchive?: () => void; onOpenOverview?: () => void;
  /** Opens 定时运行 on one schedule (from an Agent's 定时任务 card). */ onOpenSchedules?: (focus: ScheduleFocus) => void;
  /** Paseo 0.11 screen params: `agent` selects one Agent, `focus: "attention"` shows 需要处理 (from the sidebar's popover). */ params?: Readonly<Record<string, string>> };
type ScheduleLink = { onOpenSchedules?: (focus: ScheduleFocus) => void };
export type ObservatoryData = ReturnType<typeof useObservatory>;
/** 会话 · 看板 · Token · 明细 (internal value "analytics") · 横评 · 事件 · 分析 */
export type DashboardTab = "agents" | "board" | "tokens" | "analytics" | "compare" | "activity" | "insights";
export type { DashboardRow } from "../shared/dashboard-model";
const noSnoozes: CompletionSnooze[] = [];
// Set when the overview opens the archive page or returns from it; only such a return restores the list position.
// A cold open starts at the top, where 需要处理 and 执行中 are.
let returningAt = 0;
// Search text stays on this device for this app session. Synced, it followed people to other devices and emptied the list there.
const sessionQueries = new Map<string, string>();

export function DashboardSurface(props: DashboardProps) {
  const data = useObservatory({ includeArchived: props.archiveMode === true });
  const [observing, setObserving] = useState(false);
  const telemetry = useTelemetry(props.host.id);
  // Observation analytics (明细 → 观测) is only read while it is on screen.
  const analytics = useAnalytics(props.host.id, observing && props.archiveMode !== true);
  const readReceipts = useReadReceipts();
  // Archived sessions have no running subagents.
  const background = useBackground(props.host.id, props.archiveMode !== true);
  const cache = useQueryClient();
  // Directory events from the owned observation refresh lifecycle data sooner than the fallback polls. A turn that just
  // ended may leave subagents working (后台执行中); the 看板 counts (read only while shown) follow too.
  // A turn's start or end also changes its 每轮小结 (out of date, then 更新中).
  useAgentActivity(() => { for (const queryKey of [telemetryQueryKey(props.host.id), readReceiptQueryKey, backgroundQueryKey(props.host.id), liveExtrasQueryKey(props.host.id), recapsQueryKey(props.host.id), ["agent-observatory", props.host.id, "stats"]]) void cache.invalidateQueries({ queryKey }); });
  return <DashboardView key={props.host.id} {...props} readReceipts={readReceipts.data?.receipts} archiveOrigins={readReceipts.data?.archiveOrigins} readReceiptError={readReceipts.error?.message ?? readReceipts.data?.error ?? undefined} analytics={analytics.data} analyticsLoading={analytics.isPending} analyticsError={analytics.error?.message} data={data} telemetry={telemetry.data} telemetryError={telemetry.error?.message} background={background.data} onAnalyticsVisible={setObserving} onRefresh={() => { void data.refresh(); void telemetry.refetch(); if (observing) void analytics.refetch(); void readReceipts.refetch(); void cache.invalidateQueries({ queryKey: backgroundQueryKey(props.host.id) }); }} />;
}
export function ArchivedSurface(props: DashboardProps) { return <DashboardSurface {...props} archiveMode />; }
export function WorkspaceDashboard(props: PluginWorkspacePanelProps & ScheduleLink) { return <DashboardSurface {...props} />; }

const projectKey = (agent: AgentRecord) => agent.projectId || agent.projectRootPath || agent.projectName;
const checkoutKey = (agent: AgentRecord) => agent.worktreePath || agent.checkoutKind;
const finished = (agent: AgentRecord) => ["completed", "closed", "canceled"].includes(agent.status);

export function DashboardView({ theme, layout, host, navigation, workspaceId, initialAgentId, params, data, telemetry, telemetryError, background, analytics, analyticsLoading, analyticsError, readReceipts, archiveOrigins, readReceiptError, archiveMode = false, onOpenArchive, onOpenOverview, onOpenSchedules, onRefresh, onAnalyticsVisible }: DashboardProps & {
  data: ObservatoryData; readReceipts?: ReadReceipt[]; archiveOrigins?: Array<{agentId:string;archivedAt:string;lastUserMessageAt:string|null}>; readReceiptError?: string; analytics?: AnalyticsSnapshot; analyticsLoading?: boolean; analyticsError?: string; telemetry?: TelemetrySnapshot; telemetryError?: string;
  /** Provider subagents still working after their parent's turn (后台执行中). */ background?: BackgroundState;
  onRefresh: () => void; onAnalyticsVisible?: (visible: boolean) => void;
}) {
  const { colors } = theme;
  const { compact, width: surfaceWidth, onLayout } = useCompactLayout(layout.compact);
  const toast = useToast(), paseo = usePaseo();
  const viewStorageKey = `${host.id}:${workspaceId ?? "global"}:${archiveMode ? "archives" : "overview"}`;
  const preferences = useViewPreferences(viewStorageKey);
  const hydrated = useRef(false);
  const list = useRef<NativeFlatList<SessionItem>>(null);
  const scrollOffset = useRef(0), pendingScroll = useRef<number | null>(null), scrollSave = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [harvestQueue, setHarvestQueue] = useState<Array<{ id: string; token: string }>>([]);
  const [queuePosition, setQueuePosition] = useState(0);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [query, setQuery] = useState("");
  const [readFilter, setReadFilter] = useState<"all" | "unread" | "read">("all");
  const [status, setStatus] = useState<AgentStatus | "all">("all");
  const [focus, setFocus] = useState<"all" | "attention">("all");
  const [workspace, setWorkspace] = useState(workspaceId ?? "all");
  const [project, setProject] = useState("all");
  const [range, setRange] = useState<TimeRange>("7d");
  const [provider, setProvider] = useState("all");
  const [sessionScope, setSessionScope] = useState<SessionScope>("all");
  const [tab, setTab] = useState<DashboardTab>("agents");
  const [view, setView] = useState<"tree" | "list">(archiveMode ? "list" : "tree");
  const [sort, setSort] = useState<"attention" | "recent">(archiveMode ? "recent" : "attention");
  const [evidenceTarget, setEvidenceTarget] = useState<{ agentId: string; ref: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(initialAgentId ?? null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [checkout, setCheckout] = useState("all");
  const [sheet, setSheet] = useState<"filters" | "project" | "range" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 归档已读完成 (opus-B18): the first tap marks the rows, the second archives exactly those still eligible.
  const [archiveMarks, setArchiveMarks] = useState<ReadonlySet<string> | null>(null), [archivingMarked, setArchivingMarked] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [hubPushed, setHubPushed] = useState(false);
  const [statsRange, setStatsRange] = useState<StatsRange>("30d");
  const [dimension, setDimension] = useState<BreakdownDimension>("models");
  const now = useClock(30_000);
  const observing = tab === "analytics" && dimension === "observed";
  // Statistics are read only while 看板 / 明细 / 横评 show them.
  const statsTab = !archiveMode && (tab === "board" || tab === "compare" || (tab === "analytics" && !observing));
  const stats = useStats(host.id, statsRange, statsTab);
  const [liveWindow, setLiveWindow] = useState<30 | 60>(30);
  const tokenTab = !archiveMode && tab === "tokens";
  // 看板 shows today's tokens as a shortcut into the Token view.
  const tokens = useTokens(host.id, statsRange, tokenTab || (!archiveMode && tab === "board")), tokenLive = useTokenLive(host.id, tokenTab, "full", liveWindow);
  // 额度 on the Token page, and its tightest window on 看板's header.
  const quota = useQuota(host.id, !archiveMode && (tokenTab || tab === "board"));
  // 每轮小结 on the session rows (only while the list shows; the archive has none).
  const recaps = useRecaps(host.id, !archiveMode && tab === "agents"), recapMap = recaps.data?.enabled ? recaps.data.byAgent : undefined;
  // Running rows show their live output speed; read only while the session list shows something running.
  const runningCount = useMemo(() => data.agents.filter(agent => agent.status === "running" && !agent.archivedAt).length + (background?.agents.length ?? 0), [data.agents, background]);
  const rowLive = useTokenLive(host.id, !archiveMode && tab === "agents" && runningCount > 0, "agents");
  // Todo progress of running turns and the host's notes (the one-line reasons), read while something runs or waits for you.
  const liveWanted = useMemo(() => !archiveMode && data.agents.some(agent => !agent.archivedAt && (agent.status === "running" || agent.requiresAttention === true || agent.pendingPermissionCount > 0)), [archiveMode, data.agents]);
  const liveExtras = useLiveExtras(host.id, liveWanted);
  // Heartbeats that will wake an Agent: 「22:35 唤醒」 on its row and a card in its detail (opus-B8).
  const heartbeats = useHeartbeats(host.id, tab === "agents" || tab === "activity" || !!selectedId), checkHeartbeats = useHeartbeatCheck(host.id);
  const rates = useMemo(() => new Map((rowLive.data?.agents ?? []).flatMap(agent => agent.agentId && agent.outputPerSec > 0 ? [[agent.agentId, agent.outputPerSec] as const] : [])), [rowLive.data]);
  useEffect(() => { setWorkspace(workspaceId ?? "all"); }, [workspaceId]);
  useEffect(() => { onAnalyticsVisible?.(observing); }, [observing, onAnalyticsVisible]);
  const syncedView: ViewPreferences = useMemo(() => ({ query: "", status, readFilter, workspace, project, checkout, provider, range, sessionScope, view, sort, expanded: [...expanded], scrollOffset: 0, focus }), [status, readFilter, workspace, project, checkout, provider, range, sessionScope, view, sort, expanded, focus]);
  const currentView: ViewPreferences = useMemo(() => ({ ...syncedView, query }), [syncedView, query]);
  const withScroll = (next: ViewPreferences): ViewPreferences => ({ ...next, scrollOffset: Math.round(scrollOffset.current) });
  const applyView = (next: ViewPreferences, restoreScroll = false) => { setQuery(next.query); setStatus(next.status); setReadFilter(next.readFilter); setWorkspace(workspaceId ?? next.workspace); setProject(next.project); setCheckout(next.checkout); setProvider(next.provider); setRange(next.range); setSessionScope(next.sessionScope); setView(next.view); setSort(next.sort); setExpanded(new Set(next.expanded)); setFocus(next.focus ?? "all"); pendingScroll.current = restoreScroll ? next.scrollOffset : 0; };
  useEffect(() => { hydrated.current = false; }, [viewStorageKey]);
  useEffect(() => { if (!preferences.snapshot || hydrated.current) return; applyView({ ...preferences.snapshot.view, query: sessionQueries.get(viewStorageKey) ?? "" }, Date.now() - returningAt < 300_000); hydrated.current = true; }, [preferences.snapshot]);
  useEffect(() => { if (!hydrated.current) return; if (query) sessionQueries.set(viewStorageKey, query); else sessionQueries.delete(viewStorageKey); }, [query, viewStorageKey]);
  useEffect(() => { if (!hydrated.current) return; const timer = setTimeout(() => { void preferences.saveView(withScroll(syncedView)).catch(() => {}); }, 650); return () => clearTimeout(timer); }, [syncedView, preferences.saveView]);
  useEffect(() => () => { if (scrollSave.current) clearTimeout(scrollSave.current); }, []);
  const snoozes = preferences.snapshot?.snoozes ?? noSnoozes;
  // Analysis sessions the observatory starts itself (智能分析 runners) are reached from their reports, not listed as work.
  const loadedAgents = useMemo(() => { const receipts = new Map((readReceipts ?? []).map(receipt => [receipt.agentId, receipt])); const origins = new Map((archiveOrigins ?? []).map(origin => [origin.agentId, origin])); return applyLiveExtras(enrichAgents(data.agents.filter(agent => agent.labels["observatory.role"] !== "insight"), telemetry, background), liveExtras.data?.agents).map(agent => applyReadReceipt(applyArchiveReadOrigin(agent, origins.get(agent.id)), receipts.get(agent.id))); }, [data.agents, telemetry, background, readReceipts, archiveOrigins, liveExtras.data]);
  const agents = useMemo(() => loadedAgents.filter(agent => archiveMode ? !!agent.archivedAt : !agent.archivedAt), [loadedAgents, archiveMode]);
  // Range, snooze and event-window filters change only at exact boundaries; between them the
  // derived lists keep their identity while displayed relative times still tick with `now`.
  const filterClock = useRef<{ at: number; until: number; agents: AgentRecord[]; range: TimeRange; snoozes: readonly CompletionSnooze[]; events?: TelemetrySnapshot["events"] } | null>(null);
  const clock = filterClock.current;
  if (!clock || clock.agents !== agents || clock.range !== range || clock.snoozes !== snoozes || clock.events !== telemetry?.events || now >= clock.until) {
    filterClock.current = { at: now, agents, range, snoozes, events: telemetry?.events, until: Math.min(nextRangeChange(agents, range, now), nextSnoozeExpiry(snoozes, now),
      nextWindowExit((telemetry?.events ?? []).map(event => Date.parse(event.at)), range, now)) };
  }
  const filterNow = filterClock.current!.at;
  const ranged = useMemo(() => agents.filter(agent => withinRange(agent, range, filterNow)), [agents, range, filterNow]);
  const inPlace = useCallback((agent: AgentRecord) => (checkout === "all" || checkoutKey(agent) === checkout) && (project === "all" || projectKey(agent) === project) && (!workspaceId || agent.workspaceId === workspaceId) && (workspace === "all" || agent.workspaceId === workspace) && (provider === "all" || agent.provider === provider), [checkout, project, workspaceId, workspace, provider]);
  const harvestScope = useMemo(() => ranged.filter(inPlace), [ranged, inPlace]);
  const scoped = useMemo(() => harvestScope.filter(agent => sessionScope === "all" || (sessionScope === "history" ? !!agent.archivedAt || finished(agent) : !agent.archivedAt && !finished(agent))), [harvestScope, sessionScope]);
  const projects = useMemo(() => { const found = new Map<string, { id: string; name: string; count: number }>(); for (const agent of ranged) { const key = projectKey(agent); const entry = found.get(key) ?? { id: key, name: agent.projectName, count: 0 }; entry.count++; found.set(key, entry); } return [...found.values()].sort((a, b) => a.name.localeCompare(b.name)); }, [ranged]);
  const workspaces = useMemo(() => {
    const found = new Map<string, { name: string; folder: string }>();
    for (const agent of agents) if (agent.workspaceId && !found.has(agent.workspaceId)) { const folder = agent.cwd?.split("/").filter(Boolean).pop() || t("coreDashboard.workspace"); found.set(agent.workspaceId, { name: agent.workspaceName || folder, folder }); }
    const repeated = new Set([...found.values()].map(item => item.name).filter((name, index, names) => names.indexOf(name) !== index));
    // Workspaces may share a title; the folder tells them apart.
    return [...found.entries()].map(([id, item]) => [id, repeated.has(item.name) ? t("coreDashboard.message", { value1: item.name, value2: item.folder }) : item.name] as const).sort((a, b) => a[1].localeCompare(b[1]));
  }, [agents]);
  const checkouts = useMemo(() => [...new Map(agents.map(a => [checkoutKey(a), checkoutName(a)] as const)).entries()].sort((a, b) => a[1].localeCompare(b[1])), [agents]);
  const providers = useMemo(() => [...new Set(agents.map(a => a.provider))].sort(), [agents]);
  const snoozedAt = useCallback((agent: AgentRecord) => isCompletionSnoozed(agent, snoozes, filterNow), [snoozes, filterNow]);
  // Host-wide settings (shared with the sidebar badge): child Agents' results count only when asked to (opus-F15).
  const settings = preferences.snapshot?.settings ?? defaultObservatorySettings;
  const attentionOf = useCallback((agent: AgentRecord) => needsAttention(agent, snoozedAt(agent), { childCompletions: settings.childCompletions }), [snoozedAt, settings.childCompletions]);
  // 待回复 counts the Agents waiting on your answer to a question; 待审批 the ones waiting on a permission or plan (opus-F12).
  const liveTally = useCallback((list: readonly AgentRecord[]) => { let attention = 0, approvals = 0, running = 0, unread = 0, snoozed = 0, idle = 0; for (const agent of list) { if (attentionOf(agent)) attention++; const waiting = agent.archivedAt ? null : waitingKind(agent); if (waiting && waiting !== "question") approvals++; if (matchesStatus(agent.status, "running")) running++; if (!agent.archivedAt && (waiting === "question" || (agent.status === "idle" && !agent.pendingPermissionCount))) idle++; if (isUnreadCompletion(agent)) { if (heldBySnooze(agent, snoozedAt(agent))) snoozed++; else unread++; } } return { attention, approvals, running, unread, snoozed, idle }; }, [attentionOf, snoozedAt]);
  const counts = useMemo(() => liveTally(harvestScope), [harvestScope, liveTally]);
  // 看板's live pills open the list with every time range: they count the same way over the same Agents (opus-F14).
  const boardCounts = useMemo(() => liveTally(agents.filter(agent => !workspaceId || agent.workspaceId === workspaceId)), [agents, workspaceId, liveTally]);
  // Search and state filters reveal matching descendants (see buildDashboardRows); place filters keep the tree as is.
  const revealing = !!query.trim() || status !== "all" || readFilter !== "all" || focus !== "all";
  const filtered = revealing || workspace !== (workspaceId ?? "all") || project !== "all" || checkout !== "all" || provider !== "all" || sessionScope !== "all";
  // The 未读 list leaves out what the 未读 chip counts as 稍后, by the same rule: a stop not seen yet is never held back (P3-1).
  const { rows } = useMemo(() => buildDashboardRows(scoped.filter(agent => readFilter !== "unread" || showSnoozed || !heldBySnooze(agent, snoozedAt(agent))), { query, status, view, sort, expanded, readFilter, focus: focus === "attention" ? attentionOf : undefined }), [scoped, query, status, view, sort, expanded, readFilter, showSnoozed, snoozedAt, focus, attentionOf]);
  const items = useMemo(() => {
    const grouped = sort === "attention" && !archiveMode;
    const sections = grouped ? groupDashboardRows(rows, attentionOf) : [{ group: "recent" as const, rows, threads: 0 }];
    const result: SessionItem[] = [];
    for (const section of sections) {
      if (grouped) result.push({ kind: "section", key: `section:${section.group}`, group: section.group, title: groupTitles[section.group], count: section.threads });
      // A collapsed thread in 需要处理 for its descendants says why on its parent row (P3-3); unread ones not counted there show apart.
      for (const row of section.rows) {
        const thread = row.node.children.length ? threadAttention(row.node, attentionOf) : null;
        result.push({ kind: "row", key: row.node.agent.id, row, childUnread: thread?.unread ?? 0, childAttention: thread?.count ?? 0, childPhase: thread?.phase ?? null,
          childRunning: row.node.children.length ? countRunningDescendants(row) : 0, snoozed: isUnreadCompletion(row.node.agent) && snoozedAt(row.node.agent) });
      }
    }
    return result;
  }, [rows, sort, archiveMode, attentionOf, snoozedAt]);
  useEffect(() => { if (pendingScroll.current === null || !items.length) return; const offset = pendingScroll.current; pendingScroll.current = null; scrollOffset.current = offset; if (offset > 0) setTimeout(() => list.current?.scrollToOffset({ offset, animated: false }), 0); }, [items.length]);
  const selected = selectedId ? agents.find(agent => agent.id === selectedId) : undefined;
  const scopeIds = useMemo(() => new Set(scoped.filter(agent => matchesAgentStatus(agent, status) && (readFilter === "all" || completionReadState(agent) === readFilter) && (focus === "all" || attentionOf(agent))).map(a => a.id)), [scoped, status, readFilter, focus, attentionOf]);
  const eventSince = range === "all" ? -Infinity : filterNow - (range === "24h" ? 1 : range === "7d" ? 7 : 30) * 86400_000;
  const events = useMemo(() => (telemetry?.events ?? []).filter(event => scopeIds.has(event.agentId) && Date.parse(event.at) >= eventSince), [telemetry, scopeIds, eventSince]);
  // Clearing filters cannot reveal deleted/archived Agents or leave a workspace-scoped page and its time range.
  const availableEventAgents = useMemo(() => new Set(ranged.filter(agent => !workspaceId || agent.workspaceId === workspaceId).map(agent => agent.id)), [ranged, workspaceId]);
  const hiddenEvents = useMemo(() => hiddenEventCount(telemetry?.events ?? [], events, eventSince, availableEventAgents), [telemetry, events, eventSince, availableEventAgents]);
  const signals = useMemo(() => { const labels = new Map<string, string>(); for (const signal of decisionSignals(agents, telemetry?.events ?? [], now)) { if (signal.kind === "quiet") labels.set(signal.agentId, t("coreDashboard.noRecentUpdates")); else if (signal.kind === "repeated_failure") labels.set(signal.agentId, t("coreDashboard.failedTimes", { value1: signal.count })); } return labels; }, [agents, telemetry, now]);
  // A live directory observation is current by definition; polling-only syncs are stale after missing a cycle.
  const stale = !data.live && !!data.lastSyncedAt && now - new Date(data.lastSyncedAt).getTime() > 25000;
  const sync = data.error ? { state: "error" as const, label: t("coreDashboard.syncFailed") } : data.loading && !data.agents.length ? { state: "syncing" as const, label: t("coreDashboard.connecting") } : data.isRefreshing ? { state: "syncing" as const, label: t("coreDashboard.syncing") } : stale ? { state: "stale" as const, label: t("coreDashboard.waitingToSync") } : { state: "live" as const, label: data.live ? t("coreDashboard.live") : t("coreDashboard.synced") };
  const toggle = useCallback((id: string) => setExpanded(previous => { const next = new Set(previous); next.has(id) ? next.delete(id) : next.add(id); return next; }), []);
  async function exportSnapshot() {
    try { await copyText(JSON.stringify({ exportedAt: new Date().toISOString(), host: host.label, agents: scoped, observation: telemetry ? { startedAt: telemetry.startedAt, agents: telemetry.agents.filter(item => scopeIds.has(item.agentId)) } : null }, null, 2)); toast.show(t("coreDashboard.observationSnapshotCopied"), { variant: "success" }); }
    catch { toast.error(t("coreDashboard.couldNotCopyCheckClipboardPermissionsAnd")); }
  }
  const navigatePage = (action?: () => void) => { if (!action) return; returningAt = Date.now(); void preferences.saveView(withScroll(syncedView)).catch(() => {}).finally(action); };
  const onScrollEnd = (offset: number) => {
    const moved = Math.abs(offset - scrollOffset.current) > 40; scrollOffset.current = offset;
    if (!moved || !hydrated.current) return;
    if (scrollSave.current) clearTimeout(scrollSave.current);
    scrollSave.current = setTimeout(() => { void preferences.saveView(withScroll(syncedView)).catch(() => {}); }, 1500);
  };
  function resetFilters() { setReadFilter("all"); setQuery(""); setStatus("all"); setFocus("all"); setShowSnoozed(false); setWorkspace(workspaceId ?? "all"); setProvider("all"); setProject("all"); setSessionScope("all"); setCheckout("all"); }
  function selectAgent(agentId: string) {
    const agent = agents.find(candidate => candidate.id === agentId);
    if (agent) {
      if (!harvestQueue.length && isUnreadCompletion(agent) && !stopUnseen(agent)) { const queue = harvestScope.filter(item => isUnreadCompletion(item) && !stopUnseen(item) && !isCompletionSnoozed(item, snoozes, Date.now())).map(item => ({ id: item.id, token: knownCompletionAt(item)! })); setHarvestQueue(queue); setQueuePosition(Math.max(0, queue.findIndex(item => item.id === agentId))); }
      setSelectedId(agentId); return;
    }
    setSelectedId(null);
    if (!navigation?.openAgent) { toast.error(t("coreDashboard.thisAgentIsNotInTheCurrent")); return; }
    try { Promise.resolve(navigation.openAgent({ agentId })).catch(error => toast.error(t("coreDashboard.couldNotOpenSession", { value1: error instanceof Error ? error.message : t("coreDashboard.tryAgainLater") }))); }
    catch (error) { toast.error(t("coreDashboard.couldNotOpenSession", { value1: error instanceof Error ? error.message : t("coreDashboard.tryAgainLater") })); }
  }
  function selectProject(projectId: string) {
    setReadFilter("all"); setFocus("all"); setProject(projectId); setCheckout("all"); setRange("all"); setSessionScope("all"); setQuery(""); setStatus("all"); setProvider("all");
    setWorkspace(workspaceId ?? "all"); setSelectedId(null); setTab("agents");
  }
  const selectRef = useRef(selectAgent);
  selectRef.current = selectAgent;
  const selectRow = useCallback((agentId: string) => selectRef.current(agentId), []);
  const openFromView = (agentId: string) => { setTab("agents"); selectAgent(agentId); };
  const nextHarvest = (currentId: string) => { const start = harvestQueue.findIndex(item => item.id === currentId); for (let offset = 1; offset <= harvestQueue.length; offset++) { const index = (Math.max(0, start) + offset) % harvestQueue.length; const item = harvestQueue[index]!; const next = agents.find(agent => agent.id === item.id); if (item.id !== currentId && next && isUnreadCompletion(next) && !stopUnseen(next) && knownCompletionAt(next) === item.token && !isCompletionSnoozed(next, snoozes, Date.now())) { setQueuePosition(index); setSelectedId(item.id); return; } } setSelectedId(null); setHarvestQueue([]); toast.show(t("coreDashboard.allUnreadResultsInThisBatchHave"), { variant: "success" }); };
  // A result or a reply that asks you (待回复): the snooze is tied to it, a newer one shows again (opus-F1).
  const snoozeAgent = async (agent: AgentRecord) => { const token = snoozeToken(agent); if (!token) return; await preferences.mutate({ snooze: { agentId: agent.id, completionAt: token, until: new Date(Date.now() + 3600000).toISOString() } }); toast.show(t("coreDashboard.snoozedFor1HourNewResultsWill")); if (harvestQueue.length) nextHarvest(agent.id); };
  // From the 看板 hero: show exactly the sessions behind the tapped live count.
  const showScope = (target: SessionScopeTarget) => {
    resetFilters(); setRange("all"); setSelectedId(null); setTab("agents");
    if (target === "unread") setReadFilter("unread"); else setStatus(target === "approval" ? "waiting" : target);
  };
  const refresh = () => { onRefresh(); if (statsTab) void stats.refetch(); if (tokenTab) { void tokens.refetch(); void tokenLive.refetch(); void quota.refetch(); } };
  const detailQueue = harvestQueue.length ? { index: queuePosition + 1, total: harvestQueue.length } : undefined;
  const detailClosed = () => { setSelectedId(null); setHarvestQueue([]); setEvidenceTarget(null); };
  const openScope = (next: { focus?: "attention"; status?: "running" | "idle"; readFilter?: "unread"; snoozed?: boolean }) => {
    const same = next.focus ? focus === "attention" : next.status ? status === next.status : next.snoozed ? showSnoozed : readFilter === "unread" && !showSnoozed;
    setFocus(!same && next.focus ? "attention" : "all"); setStatus(!same && next.status ? next.status : "all");
    setReadFilter(!same && (next.readFilter || next.snoozed) ? "unread" : "all"); setShowSnoozed(!same && !!next.snoozed); setSessionScope("all");
  };
  // Counts are only meaningful once a snapshot exists.
  const known = data.agents.length > 0 || (!data.loading && !data.error);
  // Opened from the sidebar's popover (screen params): select that Agent, or show 需要处理. Applied once the saved view is
  // restored and the directory has been read, so neither overrides it; `t` makes a repeated tap on the same entry count.
  const handledRequest = useRef<string | null>(null);
  const request = params?.agent || params?.focus === "attention" ? `${params.agent ?? ""}|${params.focus ?? ""}|${params.t ?? ""}` : null;
  useEffect(() => {
    if (!request || handledRequest.current === request || !preferences.snapshot || !hydrated.current || !known) return;
    handledRequest.current = request;
    if (params?.focus === "attention") { resetFilters(); setRange("all"); setTab("agents"); setFocus("attention"); }
    if (params?.agent) { setTab("agents"); setHarvestQueue([]); selectAgent(params.agent); }
  }, [request, preferences.snapshot, known]);
  const filterState: FilterState = { status, readFilter, sessionScope, checkout, workspace, provider };
  const changeFilters = (patch: Partial<FilterState>) => { if (patch.status !== undefined) setStatus(patch.status); if (patch.readFilter !== undefined) { setReadFilter(patch.readFilter); setShowSnoozed(false); } if (patch.sessionScope !== undefined) setSessionScope(patch.sessionScope); if (patch.checkout !== undefined) setCheckout(patch.checkout); if (patch.workspace !== undefined) { setWorkspace(patch.workspace); const chosen = agents.find(agent => agent.workspaceId === patch.workspace); if (chosen) setProject(projectKey(chosen)); } if (patch.provider !== undefined) setProvider(patch.provider); };
  const workspaceDefault = workspaceId ?? "all";
  const applied: Array<{ key: string; label: string; clear: () => void }> = [
    ...(status !== "all" && status !== "running" && status !== "idle" ? [{ key: "status", label: statusNames[status], clear: () => setStatus("all") }] : []),
    ...(readFilter === "read" ? [{ key: "read", label: readFilterNames.read, clear: () => setReadFilter("all") }] : []),
    ...(sessionScope !== "all" ? [{ key: "scope", label: sessionScopeNames[sessionScope], clear: () => setSessionScope("all") }] : []),
    ...(checkout !== "all" ? [{ key: "checkout", label: checkouts.find(([id]) => id === checkout)?.[1] ?? t("coreDashboard.checkout"), clear: () => setCheckout("all") }] : []),
    ...(workspace !== workspaceDefault ? [{ key: "workspace", label: workspaces.find(([id]) => id === workspace)?.[1] ?? t("coreDashboard.workspace"), clear: () => setWorkspace(workspaceDefault) }] : []),
    ...(provider !== "all" ? [{ key: "provider", label: provider, clear: () => setProvider("all") }] : []),
  ];
  const projectLabel = projects.find(item => item.id === project)?.name ?? (project === "all" ? t("coreDashboard.allProjects") : t("coreDashboard.project"));
  const savedViews = preferences.snapshot?.savedViews ?? [];
  const sessionsTab = tab === "agents", listTab = tab === "agents" || tab === "activity";
  const archiveSummary = useMemo(() => { const worktrees = new Set(scoped.filter(a => a.checkoutKind === "worktree").map(a => a.worktreePath)).size; return [t("coreDashboard.sessions", { count: scoped.length }), t("coreDashboard.projects", { count: new Set(scoped.map(projectKey)).size }), worktrees ? t("coreDashboard.worktrees", { count: worktrees }) : null].filter(Boolean).join(" · "); }, [scoped]);
  const banners = [
    data.error && data.agents.length ? <Banner key="sync" theme={theme} tone="danger" message={t("coreDashboard.syncFailedShowingThePreviousResults", { value1: String(data.error) })} action={{ label: t("coreDashboard.retry"), onPress: onRefresh }} /> : null,
    data.truncated ? <Banner key="truncated" theme={theme} message={t("coreDashboard.onlySomeSessionsAreLoadedBecauseThere")} /> : null,
    telemetryError ? <Banner key="telemetry" theme={theme} tone="warning" message={t("coreDashboard.eventHistoryIsTemporarilyUnavailableSessionStatus")} /> : null,
    // The server says in one Chinese sentence whether saving failed or the saved history could not be read back (opus-F74).
    telemetry?.persistenceError ? <Banner key="persist" theme={theme} tone="warning" message={telemetry.persistenceError} /> : null,
    readReceiptError ? <Banner key="receipts" theme={theme} tone="warning" message={t("coreDashboard.readStatusSyncError", { value1: readReceiptError })} /> : null,
    preferences.error ? <Banner key="preferences" theme={theme} tone="warning" message={t("coreDashboard.cannotSaveView", { value1: preferences.error })} /> : null,
  ].filter(Boolean);
  // 归档已读完成 (opus-B18): completed sessions whose result was read, with nothing running above or below them and no heartbeat
  // or limit to come back for. Paseo completes an Agent's heartbeats when it is archived, so only a heartbeat read that covered every
  // schedule file may show a session has none (codex-F16); a failed, erroneous or incomplete read offers nothing and says why.
  const heartbeatState = useMemo(() => heartbeatGuard(heartbeats.data, !!heartbeats.error), [heartbeats.data, heartbeats.error]);
  // Paseo archives an Agent's children with it (and completes their heartbeats): with the list cut short not every child is known.
  const archiveOffer = useMemo((): ArchiveOffer => archiveMode ? { candidates: [], withheld: 0, sparedForChildren: 0 }
    : archiveReadCandidates(agents, harvestScope, heartbeatState, { truncated: data.truncated }), [archiveMode, agents, harvestScope, heartbeatState, data.truncated]);
  const archivable = archiveOffer.candidates;
  const archiveMarked = async () => {
    if (!archiveMarks || archivingMarked) return;
    setArchivingMarked(true);
    // The heartbeats are read again for this tap: one created since the first tap keeps its Agent, and a read that cannot be trusted
    // archives nothing. Only rows still eligible stay in the batch (one that started a new turn meanwhile stays out).
    const plan = confirmArchive(archiveMarks, agents, harvestScope, await checkHeartbeats(), { truncated: data.truncated });
    if (!plan.ok) { setArchivingMarked(false); toast.error(t("coreDashboard.nothingArchived", { value1: plan.reason })); return; }
    const queue = [...plan.ids], total = queue.length;
    let done = 0, failed = 0;
    const worker = async () => { while (queue.length) { const id = queue.shift()!; try { await paseo.agents.ref(id).archive(); done++; } catch { failed++; } } };
    try { await Promise.all(Array.from({ length: Math.min(4, total) }, worker)); }
    finally {
      setArchivingMarked(false); setArchiveMarks(null);
      // Why the rest stayed: a heartbeat of their own, or an Agent below them that archiving would take along.
      const kept = [plan.spared ? t("coreDashboard.haveHeartbeats", { count: plan.spared }) : null, plan.sparedForChildren ? t("coreDashboard.haveSubagentsThatStillNeedAttention", { value1: plan.sparedForChildren }) : null].filter(Boolean).join(t("coreDashboard.message2"));
      const spared = kept ? t("coreDashboard.kept", { value1: kept }) : "";
      if (failed) toast.error(t("coreDashboard.archivedFailedAndCanBeRetried", { value1: done, value2: failed, value3: spared }));
      else if (total) toast.show(t("coreDashboard.archivedCompletedSessionsWithReadResults", { value1: done, value2: spared }), { variant: "success" });
      else toast.show(kept ? t("coreDashboard.nothingArchived2", { value1: kept }) : t("coreDashboard.theseSessionsHaveNewActivityNothingArchived"));
      void data.refresh();
    }
  };
  const detail = selected
    ? <AgentDetail key={`${host.id}:${selected.id}`} hostId={host.id} heartbeats={heartbeats.data?.byAgent.get(selected.id)} agent={selected} agents={loadedAgents} theme={theme} compact={compact} navigation={navigation} onSelectAgent={selectAgent} onClose={detailClosed} telemetry={telemetry} onReadNext={harvestQueue.length ? receipt => nextHarvest(receipt.agentId) : undefined} onSnooze={preferences.ready ? snoozeAgent : undefined} queue={detailQueue} onOpenSchedules={onOpenSchedules} initialEvidenceRef={evidenceTarget?.agentId === selected.id ? evidenceTarget.ref : undefined} />
    : <View style={{ flex: 1, justifyContent: "center" }}><EmptyState theme={theme} icon="PanelRight" title={t("coreDashboard.selectASession")} message={t("coreDashboard.resultsTimelineAndSubtasksAppearHere")} /></View>;
  const empty = data.loading ? <Skeleton theme={theme} rows={6} />
    : data.error ? <EmptyState theme={theme} icon="WifiOff" title={t("coreDashboard.cannotLoadSessionsRightNow")} message={t("coreDashboard.willRetryAutomaticallyWhenTheConnectionReturns")} action={{ label: t("coreDashboard.retry"), onPress: onRefresh, icon: "RefreshCw" }} />
    : readFilter === "unread" && !query.trim() ? <EmptyState theme={theme} icon="Inbox" title={counts.snoozed && !showSnoozed ? t("coreDashboard.allUnreadResultsAreSnoozed") : t("coreDashboard.noUnreadResults")} message={t("coreDashboard.newCompletedTurnsWillAppearHere")} action={{ label: t("coreDashboard.viewAll"), onPress: resetFilters }} />
    : focus === "attention" && !query.trim() ? <EmptyState theme={theme} icon="Inbox" title={t("coreDashboard.noSessionsNeedAttention")} message={t("coreDashboard.newApprovalsIssuesAndUnreadResultsAppear")} action={{ label: t("coreDashboard.viewAll"), onPress: resetFilters }} />
    : filtered ? <EmptyState theme={theme} icon="SearchX" title={t("coreDashboard.noMatchingSessions")} action={{ label: t("coreDashboard.clearFilters"), onPress: resetFilters }} />
    : archiveMode ? <EmptyState theme={theme} icon="Archive" title={t("coreDashboard.noArchivedSessionsInThisTimeRange")} action={range !== "all" ? { label: t("coreDashboard.viewAllTime"), onPress: () => setRange("all") } : undefined} />
    : <EmptyState theme={theme} icon="Orbit" title={t("coreDashboard.noSessionsYet")} message={t("coreDashboard.agentsCreatedInPaseoAppearHereAutomatically")} />;
  // Catalog migration preserves disabled archive wording: disabled: true, hint: `暂不可用：${archiveOffer.reason}`
  const menu: MenuAction[] = [
    ...(archiveMode ? onOpenOverview ? [{ key: "overview", label: t("coreDashboard.backToObservatory"), icon: "ArrowLeft", onPress: () => navigatePage(onOpenOverview) }] : [] : onOpenArchive ? [{ key: "archives", label: t("coreDashboard.archivedSessions"), icon: "Archive", onPress: () => navigatePage(onOpenArchive) }] : []),
    ...(sessionsTab ? [
      { key: "view", label: view === "tree" ? t("coreDashboard.switchToList") : t("coreDashboard.switchToTree"), icon: view === "tree" ? "List" : "ListTree", hint: view === "tree" ? t("coreDashboard.showSubagentsSeparatelyFromTheirParents") : t("coreDashboard.groupSubagentsUnderTheirParents"), onPress: () => setView(view === "tree" ? "list" : "tree") },
      { key: "sort", label: sort === "attention" ? t("coreDashboard.sortByRecentActivity") : t("coreDashboard.sortByAttentionNeeded"), icon: "ArrowDownWideNarrow", onPress: () => setSort(sort === "attention" ? "recent" : "attention") },
      ...(view === "tree" ? [{ key: "expand", label: expanded.size ? t("coreDashboard.collapseAllSubagents") : t("coreDashboard.expandAllSubagents"), icon: "ChevronsUpDown", onPress: () => setExpanded(expanded.size ? new Set() : new Set(scoped.map(agent => agent.id))) }] : []),
    ] : []),
    ...(listTab ? [{ key: "export", label: t("coreDashboard.exportSnapshot"), icon: "Download", hint: t("coreDashboard.copySessionsAndObservationsMatchingTheCurrent"), onPress: () => void exportSnapshot() }] : []),
    ...(sessionsTab && archivable.length ? [{ key: "archive-read", label: t("coreDashboard.archiveCompletedAndRead", { value1: archivable.length }), icon: "Archive",
      hint: t("coreDashboard.archivesCompletedSessionsWhoseResultsAreRead", { value1: archiveOffer.sparedForChildren ? t("coreDashboard.othersHaveSubagentsThatStillNeedAttention", { value1: archiveOffer.sparedForChildren }) : "" }),
      onPress: () => setArchiveMarks(new Set(archivable.map(agent => agent.id))) }]
      // Read sessions are waiting, but the heartbeat read (or a cut session list) cannot show they are safe: disabled, with the reason.
      : sessionsTab && archiveOffer.withheld && archiveOffer.reason ? [{ key: "archive-read", label: t("coreDashboard.archiveCompletedAndRead2"), icon: "Archive", disabled: true, hint: t("coreDashboard.unavailable", { value1: archiveOffer.reason }), onPress: () => {} }] : []),
    ...(sessionsTab ? [{ key: "legend", label: t("coreDashboard.statusLegend"), icon: "Palette", tone: "violet" as const, hint: t("coreDashboard.whatEachColorAndMarkerMeans"), onPress: () => setLegendOpen(true) }] : []),
    ...(!archiveMode ? [{ key: "settings", label: t("coreDashboard.observationSettings"), icon: "Settings2", hint: t("coreDashboard.howAttentionIsCountedAcrossAllPages"), onPress: () => setSettingsOpen(true) }] : []),
    { key: "refresh", label: t("coreDashboard.refresh"), icon: "RefreshCw", disabled: data.isRefreshing, onPress: refresh },
  ];
  // Each view has its own colours. Phones show the unselected views as coloured icons only.
  const tabs: ViewTab<DashboardTab>[] = [
    { value: "agents", label: t("coreDashboard.sessions2"), icon: "MessagesSquare", colors: ["sky", "blue"], count: !compact && known ? scoped.length : undefined },
    { value: "board", label: t("coreDashboard.dashboard"), icon: "LayoutDashboard", colors: ["pink", "fuchsia"] },
    { value: "tokens", label: t("coreDashboard.tokens"), icon: "Coins", colors: ["amber", "orange"] },
    { value: "analytics", label: t("coreDashboard.details"), icon: "ChartColumn", colors: ["violet", "indigo"] },
    { value: "compare", label: t("coreDashboard.compare"), icon: "Swords", colors: ["cyan", "blue"] },
    { value: "activity", label: compact ? t("coreDashboard.events") : t("coreDashboard.eventStream"), icon: "Activity", colors: ["orange", "red"] },
    { value: "insights", label: compact ? t("coreDashboard.analysis") : t("coreDashboard.intelligentAnalysis"), icon: "Sparkles", colors: ["teal", "green"] },
  ];
  const iconTabs = compact && surfaceWidth > 0 && surfaceWidth < 560;
  const statsProps = { theme, compact, stats: stats.data, loading: stats.isPending, error: stats.error?.message, range: statsRange, onRange: setStatsRange, onRefresh: refresh };
  const searching = sessionsTab && compact && (searchOpen || !!query);
  const sessionList = <SessionList items={items} theme={theme} compact={compact} selectedId={selectedId} expanded={expanded} forceExpanded={revealing} now={now} signals={signals} rates={rates}
    heartbeats={heartbeats.data?.byAgent} recaps={recapMap} recapsRevision={recaps.data?.revision} marked={archiveMarks ?? undefined} serverId={host.id} empty={empty} listRef={list} onScrollEnd={onScrollEnd} onToggle={toggle} onSelect={selectRow} />;
  const pushDetail = compact && !!selected && listTab;
  const chrome = !(compact && tab === "insights" && hubPushed);
  return <View onLayout={onLayout} style={{ flex: 1, minHeight: 0, backgroundColor: colors.surface0 }}>
    {pushDetail ? detail : <>
      {chrome ? <Toolbar theme={theme}>
        {archiveMode ? <Text numberOfLines={1} style={{ flexShrink: 1, color: colors.foregroundMuted, fontSize: fontSize.small }}>{archiveSummary}</Text>
          : <ViewTabs theme={theme} value={tab} onChange={setTab} tabs={tabs} iconOnly={iconTabs} accessibilityLabel={t("coreDashboard.view")} />}
        <Spacer />
        {sessionsTab && !compact ? <View style={{ width: 240, flexShrink: 1 }}><SearchField theme={theme} value={query} onChangeText={setQuery} placeholder={t("coreDashboard.searchTasksProjectsOrBranches")} accessibilityLabel={t("coreDashboard.searchSessions")} /></View> : null}
        {sessionsTab && compact ? <IconButton theme={theme} icon="Search" label={t("coreDashboard.search")} active={searching} onPress={() => { if (searching) { setQuery(""); setSearchOpen(false); } else setSearchOpen(true); }} /> : null}
        <View accessibilityLabel={sync.label}>{sync.state === "live" ? <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs + 2 }}>
          <LiveDot color={hueColor(theme, "ok")} size={6} live={data.live} />
          {compact ? null : <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta }}>{sync.label}</Text>}
        </View> : <SyncStatus theme={theme} state={sync.state} label={compact ? undefined : sync.label} />}</View>
        <IconButton theme={theme} icon="Ellipsis" label={t("coreDashboard.moreActions")} onPress={() => setMenuOpen(true)} />
      </Toolbar> : null}
      {searching ? <View style={{ paddingHorizontal: space.md, paddingTop: space.sm }}><SearchField theme={theme} value={query} onChangeText={setQuery} placeholder={t("coreDashboard.searchTasksProjectsOrBranches")} accessibilityLabel={t("coreDashboard.searchSessions")} autoFocus={!query} grow={false} /></View> : null}
      {sessionsTab ? <ChipBar>
        {!archiveMode ? <>
          <StatusChip theme={theme} label={t("coreDashboard.needsAttention")} count={known ? counts.attention : undefined} hue="warn" motion={counts.approvals ? "ping" : undefined} selected={focus === "attention"} onPress={() => openScope({ focus: "attention" })} />
          <StatusChip theme={theme} label={t("coreDashboard.running")} count={known ? counts.running : undefined} hue="run" motion="spin" selected={status === "running"} onPress={() => openScope({ status: "running" })} />
          <StatusChip theme={theme} label={t("coreDashboard.unread")} count={known ? counts.unread : undefined} hue="pink" motion={counts.unread ? "ping" : undefined} selected={readFilter === "unread" && !showSnoozed} onPress={() => openScope({ readFilter: "unread" })} />
          <StatusChip theme={theme} label={t("coreDashboard.awaitingReply")} count={known ? counts.idle : undefined} hue="violet" selected={status === "idle"} onPress={() => openScope({ status: "idle" })} />
          {counts.snoozed > 0 ? <Chip theme={theme} label={t("coreDashboard.snoozed")} count={counts.snoozed} icon="Clock3" selected={showSnoozed} onPress={() => openScope({ snoozed: true })} /> : null}
        </> : null}
        <Chip theme={theme} label={projectLabel} icon="Folder" tone={project !== "all" ? hueFor(projectLabel) : undefined} selected={project !== "all"} onPress={() => setSheet("project")} />
        <Chip theme={theme} label={rangeLabels[range]} icon="Calendar" selected={range !== "7d"} onPress={() => setSheet("range")} />
        <Chip theme={theme} label={t("coreDashboard.filters")} icon="SlidersHorizontal" count={applied.length || undefined} selected={applied.length > 0} onPress={() => setSheet("filters")} />
        {!archiveMode ? <Chip theme={theme} label={t("coreDashboard.legend")} icon="Palette" tone="violet" onPress={() => setLegendOpen(true)} /> : null}
        {applied.map(item => <Chip key={item.key} theme={theme} label={item.label} selected onRemove={item.clear} />)}
        {savedViews.map(saved => <Chip key={saved.id} theme={theme} label={saved.name} icon="Bookmark" onPress={() => applyView(saved.view)} />)}
      </ChipBar> : null}
      {banners.length ? <View style={{ gap: space.sm, paddingHorizontal: space.md, paddingTop: sessionsTab ? 0 : space.sm, paddingBottom: space.sm }}>{banners}</View> : null}
      {sessionsTab && archiveMarks ? <View accessibilityRole="alert" style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, marginHorizontal: space.md, marginBottom: space.sm, padding: space.md,
        borderRadius: radius.lg, borderWidth: hairline, borderColor: tint(hueColor(theme, "red"), 0.5), backgroundColor: tint(hueColor(theme, "red"), tintAlpha(theme)) }}>
        <Text style={{ flexGrow: 1, flexShrink: 1, minWidth: 180, color: colors.foreground, fontSize: fontSize.small, lineHeight: 20 }}>{t("coreDashboard.archivesTheCompletedAndReadSessionsMarked", { value1: archiveMarks.size })}</Text>
        <Button theme={theme} size="sm" label={t("coreDashboard.cancel")} disabled={archivingMarked} onPress={() => setArchiveMarks(null)} />
        <Button theme={theme} size="sm" variant="danger" icon="Archive" label={t("coreDashboard.confirmArchive", { value1: archiveMarks.size })} busy={archivingMarked} onPress={() => void archiveMarked()} />
      </View> : null}
      {sessionsTab ? <SplitView theme={theme} compact={compact} showDetail={false} list={sessionList} detail={detail} />
        : tab === "activity" ? <>
          {hiddenEvents ? <View style={{ paddingHorizontal: space.md, paddingTop: space.md }}><Banner theme={theme} tone="neutral" icon="Filter"
            message={t("coreDashboard.hiddenByFilters", { value1: hiddenEvents })} action={{ label: t("coreDashboard.clearFilters"), onPress: resetFilters }} /></View> : null}
          {!compact && events.length ? <Swimlane theme={theme} events={events} agents={agents} now={now} compact={false} onSelect={selectAgent} inset={space.lg} /> : null}
          <SplitView theme={theme} compact={compact} showDetail={false} list={<ActivityFeed events={events} theme={theme} telemetry={telemetry} onSelect={selectAgent} now={now} selectedId={selectedId} agents={agents} swimlane={compact} />} detail={detail} />
        </>
        : tab === "board" ? <StatsBoard {...statsProps} live={known ? boardCounts : undefined} quota={<QuotaChip theme={theme} quota={quota.data} onPress={() => setTab("tokens")} />} onOpenScope={showScope} onOpenAgent={openFromView} onOpenBreakdown={() => { setDimension("models"); setTab("analytics"); }}
          tokens={tokens.data?.daily.length ? { today: tokenTotal(tokens.data.daily.at(-1)!), onOpen: () => setTab("tokens") } : undefined} />
        : tab === "analytics" ? <StatsBreakdown {...statsProps} dimension={dimension} onDimension={setDimension}
          observed={<AnalyticsDashboard theme={theme} hostId={host.id} compact={compact} agents={agents} analytics={analytics} loading={analyticsLoading} error={analyticsError} onSelectAgent={openFromView} onSelectProject={selectProject} />} />
        : tab === "compare" ? <StatsCompare {...statsProps} />
        : tab === "tokens" ? <TokenBoard theme={theme} compact={compact} range={statsRange} onRange={setStatsRange} onRefresh={refresh} tokens={tokens.data} loading={tokens.isPending} error={tokens.error?.message}
          quota={{ data: quota.data, loading: quota.isPending, error: quota.error?.message, onRefresh: () => { void quota.refetch(); } }}
          live={tokenLive.data} liveError={tokenLive.error?.message} liveWindow={liveWindow} onLiveWindow={setLiveWindow} onOpenAgent={openFromView} />
        : <InsightsHub theme={theme} compact={compact} agents={agents} onSelectAgent={openFromView} onOpenEvidence={target => { setEvidenceTarget(target); openFromView(target.agentId); }} onPush={setHubPushed} />}
    </>}
    <ActionMenu theme={theme} title={t("coreDashboard.moreActions")} open={menuOpen} onClose={() => setMenuOpen(false)} actions={menu} />
    <Sheet title={t("coreDashboard.statusLegend")} open={legendOpen} onClose={() => setLegendOpen(false)}><PhaseLegend theme={theme} /></Sheet>
    <Sheet title={t("coreDashboard.observationSettings")} open={settingsOpen} onClose={() => setSettingsOpen(false)}>
      {/* Catalog migration preserves: 子 Agent 出错、撞额度、空轮或没收尾、等审批或提问时照常计入 */}
      <LanguageSettings />
      <RecapSettingsSection theme={theme} open={settingsOpen} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{t("coreDashboard.countCompletedSubagentsAsNeedsAttention")}</Text>
          <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{t("coreDashboard.offByDefaultTheParentAgentAlready")}</Text>
        </View>
        <Switch theme={theme} label={t("coreDashboard.countCompletedSubagentsAsNeedingAttention")} value={settings.childCompletions} disabled={!preferences.ready}
          onChange={value => { void preferences.mutate({ settings: { childCompletions: value } }).catch(() => toast.error(t("coreDashboard.settingsWereNotSavedTryAgain"))); }} />
      </View>
      <AlertSettingsSections theme={theme} />
    </Sheet>
    <ProjectSheet theme={theme} open={sheet === "project"} onClose={() => setSheet(null)} projects={projects} total={ranged.length} value={project} onChange={value => { setProject(value); setWorkspace(workspaceDefault); setCheckout("all"); }} />
    <RangeSheet theme={theme} open={sheet === "range"} onClose={() => setSheet(null)} value={range} onChange={setRange} />
    <FilterSheet theme={theme} open={sheet === "filters"} onClose={() => setSheet(null)} archiveMode={archiveMode} state={filterState} checkouts={checkouts} workspaces={workspaces} providers={providers} showWorkspace={!workspaceId}
      onChange={changeFilters} onReset={resetFilters} savedViews={savedViews} canSave={preferences.ready}
      onSaveView={name => preferences.mutate({ saveView: { name, view: withScroll(currentView) } }).then(() => { toast.show(t("coreDashboard.viewSaved"), { variant: "success" }); })}
      onApplyView={saved => applyView(saved.view)} onDeleteView={saved => { void preferences.mutate({ deleteSavedViewId: saved.id }).catch(() => {}); }} />
  </View>;
}
