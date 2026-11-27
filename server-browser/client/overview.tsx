import { translator } from '../shared/i18n';
import { t } from '../shared/text';
import { useRpc, type PluginSurfaceProps } from '@getpaseo/plugin/client';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useEffect, useMemo, useState } from 'react';
import { AppState, Image, Pressable, Text, View } from 'react-native';
import { frameCache } from './frame-cache';
import { frameRpc, overviewRpc, type BrowserActivity, type BrowserOverviewItem, type BrowserSession } from '../shared/browser';
import { buildAgentTabGroups, controlLooks, type BrowserAgentTab } from './agent-tabs-model';
import { Banner, Button, ChipBar, EmptyState, IconButton, MetaLine, ProjectMark, Row, SearchField, SectionHeader, Skeleton, Spacer, SyncStatus, Toolbar, fontSize, hairline, hue, hueFor, radius, relativeTime, space, toneColor, type Tone } from './kit';
import { ControlMark, StateChip, StateGlyph, StatePill } from './looks';
import { OVERVIEW_POLL_MS, actionTitle, browserBadge, isForeground, matchesOverviewFilter, matchesOverviewSearch, mergeOverview, overviewCounts, overviewRequest, pageHost, recentActivity, staleDelay, type Look, type OverviewData, type OverviewFilter } from './overview-model';


type Theme = PluginSurfaceProps['theme'];
type Interaction = { pressed: boolean; hovered?: boolean };
type Frame = { dataUrl: string; width: number; height: number; capturedAt: number };

export function useAppForeground(): boolean {
  const [foreground, setForeground] = useState(() => isForeground(AppState.currentState));
  useEffect(() => {
    const listener = AppState.addEventListener('change', (state) => setForeground(isForeground(state)));
    return () => listener.remove();
  }, []);
  return foreground;
}

/** `visible`: false while the host keeps this panel mounted in a hidden tab. */
export function useBrowserOverview(hostId: string, visible = true) {
  const read = useRpc(overviewRpc);
  const queryClient = useQueryClient();
  const active = useAppForeground() && visible;
  const locale = translator();
  const queryKey = useMemo(() => ['server-browser', hostId, 'overview', locale.language, locale.hash], [hostId, locale.language, locale.hash]);
  const query = useQuery({
    queryKey, enabled: active,
    queryFn: async () => { const previous = queryClient.getQueryData<OverviewData>(queryKey); return mergeOverview(previous, await read(overviewRequest(previous))); },
    refetchInterval: active ? OVERVIEW_POLL_MS : false, refetchIntervalInBackground: false, retry: false, refetchOnWindowFocus: false, staleTime: 2000, gcTime: 10_000,
  });
  useEffect(() => {
    if (query.error) frameCache.clearHost(hostId);
    else if (query.data) frameCache.retain(hostId, new Set(query.data.items.filter((item) => item.session.status === 'running').map((item) => item.workspace.id)));
  }, [hostId, query.data, query.error]);
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    const delay = staleDelay(query.dataUpdatedAt, Date.now());
    setExpired(active && !!query.dataUpdatedAt && delay <= 0);
    if (!active || !query.dataUpdatedAt || delay <= 0) return;
    const timer = setTimeout(() => setExpired(true), delay);
    return () => clearTimeout(timer);
  }, [active, query.dataUpdatedAt]);
  return { ...query, active, stale: !active || !!query.error || (!!query.data && expired) };
}

/** Last frame each viewer received in this app session: instant thumbnails and a placeholder while switching back. */
export function rememberFrame(hostId: string, workspaceId: string, frame: Frame): void { frameCache.set(hostId, workspaceId, frame); }
export function recallFrame(hostId: string, workspaceId: string): Frame | undefined { return frameCache.get(hostId, workspaceId); }

/** Small thumbnails have no full-frame fallback; stopped/offline cards unmount their query and release it immediately. */
function Thumbnail({ theme, hostId, item, enabled }: { theme: Theme; hostId: string; item: BrowserOverviewItem; enabled: boolean }) {
  const { colors } = theme;
  const capture = useRpc(frameRpc);
  const running = item.session.status === 'running';
  const thumbnail = useQuery({
    queryKey: ['server-browser', hostId, 'thumbnail', item.workspace.id, item.session.url, item.session.title], enabled: enabled && running,
    queryFn: async () => (await capture({ workspaceId: item.workspace.id, quality: 'smooth', maxWidth: 480, maxHeight: 320 })).frame ?? null,
    staleTime: 60_000, gcTime: 0, retry: false, refetchOnWindowFocus: false,
  });
  const frame = enabled && running ? thumbnail.data : null;
  return <View style={{ aspectRatio: 16 / 10, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
    {frame ? <Image fadeDuration={0} accessibilityIgnoresInvertColors source={{ uri: frame.dataUrl }} resizeMode="cover" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      : <View style={{ alignItems: 'center', gap: space.xs }}>
        <Icon name={running ? 'Globe' : item.session.status === 'error' ? 'CircleAlert' : 'MonitorOff'} size={20} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, maxWidth: 200 }}>{running ? pageHost(item.session.url) : idleThumbnail(item.session.status) ?? t("browserOverview.browserHasNotStarted")}</Text>
      </View>}
  </View>;
}
const idleThumbnail = (status: BrowserSession['status']): string | undefined => ({ starting: t("browserOverview.browserIsStarting"), recovering: t("browserOverview.browserIsRecovering"), error: t("browserOverview.browserError") } as Partial<Record<BrowserSession['status'], string>>)[status];

/** Project, workspace (and page) behind the mark of who controls the running browser. */
function ControlMeta({ theme, item, parts }: { theme: Theme; item: BrowserOverviewItem; parts: readonly (string | null | undefined)[] }) {
  const mode = item.session.status === 'running' ? item.session.mode : null;
  return <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 1 }}>
    {mode ? <ControlMark theme={theme} mode={mode} /> : null}
    <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={parts} /></View>
  </View>;
}

type Entry = { item: BrowserOverviewItem; tab: BrowserAgentTab };
/** A thumbnail card: its state on the picture, the project mark (`hueFor`, as in every plugin) by the title, who controls it in the meta line. */
const OverviewCard = memo(function OverviewCard({ theme, hostId, entry, width, selected, thumbnails, onSelect }: {
  theme: Theme; hostId: string; entry: Entry; width: number; selected: boolean; thumbnails: boolean; onSelect: (id: string) => void;
}) {
  const { colors } = theme, { item, tab } = entry, badge = browserBadge(item);
  return <Pressable testID={`server-browser-overview-card-${item.workspace.id}`} accessibilityRole="button" accessibilityLabel={badge ? t("browserOverview.viewBrowserWithStatus", { project: item.workspace.projectTitle || t("browserOverview.untitledProject"), workspace: item.workspace.title, title: tab.title, status: badge.label }) : t("browserOverview.viewBrowser", { project: item.workspace.projectTitle || t("browserOverview.untitledProject"), workspace: item.workspace.title, title: tab.title })} accessibilityState={{ selected }}
    onPress={() => onSelect(item.workspace.id)}
    style={(state) => ({ width, borderRadius: radius.lg, overflow: 'hidden', borderWidth: selected ? 2 : hairline, borderColor: selected ? colors.foregroundMuted : badge && !quietLook(badge) ? toneColor(theme, badge.tone, 'line') : colors.border, backgroundColor: (state as Interaction).hovered || state.pressed ? colors.surface1 : colors.surface0 })}>
    <View>
      {thumbnails && item.session.status === 'running' ? <Thumbnail theme={theme} hostId={hostId} item={item} enabled /> : <View style={{ aspectRatio: 16 / 10, backgroundColor: colors.surface2, alignItems: 'center', justifyContent: 'center' }}><Icon name="MonitorOff" size={20} color={colors.foregroundMuted} /></View>}
      {badge ? <View pointerEvents="none" style={{ position: 'absolute', top: space.sm, left: space.sm }}><StatePill theme={theme} look={badge} floating /></View> : null}
    </View>
    <View style={{ gap: 3, paddingHorizontal: space.md, paddingTop: 10, paddingBottom: space.md, borderTopWidth: hairline, borderTopColor: colors.border }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <ProjectMark theme={theme} name={tab.identity} size={20} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: '500' }}>{tab.title}</Text>
      </View>
      <ControlMeta theme={theme} item={item} parts={[item.workspace.projectTitle || t("browserOverview.untitledProject"), item.workspace.title]} />
      <MetaLine theme={theme} parts={[item.session.status === 'running' ? pageHost(item.session.url) : null]} />
    </View>
  </Pressable>;
});
const quietLook = (look: Look) => look.tone === 'neutral' || look.tone === 'gray';

const filters: readonly { value: OverviewFilter; label: string; tone?: Tone; motion?: 'spin' | 'ping' }[] = [{ value: 'all', get label() { return t("browserOverview.all"); } }, { value: 'agent', get label() { return t("browserOverview.agentWorking"); }, tone: 'info', motion: 'spin' }, { value: 'takeover', get label() { return t("browserOverview.needsTakeover"); }, tone: 'warning', motion: 'ping' }];

/** All browsers: a thumbnail grid on wide layouts, a list on phones. Selecting only switches what this viewer watches. */
export function BrowserOverview({ theme, compact, hostId, items, loading, error, selectedId, onSelect, onBack, onAddWorkspace, stale, active, pending, checkedAt, onRefresh, onOpenOrphans }: {
  theme: Theme; compact: boolean; hostId: string; items: BrowserOverviewItem[]; loading: boolean; error: string | null; selectedId: string; onSelect: (id: string) => void; onBack?: () => void; onAddWorkspace: () => void;
  stale: boolean; active: boolean; pending: boolean; checkedAt?: number; onRefresh: () => void; onOpenOrphans: () => void;
}) {
  const [filter, setFilter] = useState<OverviewFilter>('all');
  const [search, setSearch] = useState('');
  const [width, setWidth] = useState(0);
  const counts = useMemo(() => overviewCounts(items), [items]);
  const sections = useMemo(() => buildAgentTabGroups(items).map((group) => {
    const entries = group.tabs.flatMap((tab): Entry[] => {
      const item = items.find((candidate) => candidate.workspace.id === tab.workspaceId);
      return item && matchesOverviewFilter(item, filter) && matchesOverviewSearch(item, search) ? [{ item, tab }] : [];
    });
    return { key: group.projectKey, title: group.projectTitle, identity: group.identity, entries };
  }).filter((section) => section.entries.length), [items, filter, search]);
  const columns = Math.max(1, Math.floor((width - 2 * space.lg + space.md) / (248 + space.md)));
  const cardWidth = columns > 0 && width > 0 ? Math.floor((width - 2 * space.lg - space.md * (columns - 1)) / columns) : 248;
  const sync = !active ? { state: 'stale' as const, get label() { return t("browserOverview.paused"); } } : error ? { state: 'error' as const, get label() { return t("browserOverview.disconnected"); } } : stale ? { state: 'stale' as const, get label() { return t("browserOverview.needsUpdate"); } } : pending && !checkedAt ? { state: 'syncing' as const, get label() { return t("browserOverview.loading"); } } : { state: 'live' as const, label: checkedAt ? t("browserOverview.updated", { value1: relativeTime(checkedAt) }) : t("browserOverview.live") };
  const filterChips = filters.map((option) => <StateChip key={option.value} theme={theme} label={option.label} count={counts[option.value]} tone={option.tone} motion={option.motion} selected={filter === option.value} testID={`server-browser-overview-filter-${option.value}`} onPress={() => setFilter(option.value)} />);
  return <View testID="server-browser-overview" style={{ flex: 1, minHeight: 0 }}>
    <Toolbar theme={theme}>
      {onBack ? <IconButton theme={theme} icon="ChevronLeft" label={t("browserOverview.backToBrowser")} testID="server-browser-overview-back" onPress={onBack} /> : null}
      {compact ? <SearchField theme={theme} value={search} onChangeText={setSearch} placeholder={t("browserOverview.searchProjectsAgentsOrPages")} accessibilityLabel={t("browserOverview.searchProjectsWorkspacesAgentsOrPages")} /> : <>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>{filterChips}</View>
        <Spacer />
        <View style={{ width: 260 }}><SearchField theme={theme} value={search} onChangeText={setSearch} placeholder={t("browserOverview.searchProjectsAgentsOrPages")} accessibilityLabel={t("browserOverview.searchProjectsWorkspacesAgentsOrPages")} /></View>
      </>}
      <IconButton theme={theme} icon="MonitorOff" label={t("browserOverview.orphanedBrowsers")} testID="server-browser-overview-orphans" onPress={onOpenOrphans} />
      <View testID="server-browser-overview-freshness"><SyncStatus theme={theme} state={sync.state} label={compact ? undefined : sync.label} /></View>
      <IconButton theme={theme} icon="RefreshCw" label={t("browserOverview.refreshBrowserOverview")} disabled={!active} testID="server-browser-overview-refresh" onPress={onRefresh} />
      {compact ? <IconButton theme={theme} icon="Plus" label={t("browserOverview.openAnotherWorkspaceSBrowser")} testID="server-browser-workspace-add" onPress={onAddWorkspace} />
        : <Button theme={theme} label={t("browserOverview.openWorkspace")} icon="Plus" size="sm" testID="server-browser-workspace-add" onPress={onAddWorkspace} />}
    </Toolbar>
    {compact ? <ChipBar theme={theme} border>{filterChips}</ChipBar> : null}
    <ScrollView testID="server-browser-overview-list" style={{ flex: 1 }} keyboardShouldPersistTaps="handled" onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      contentContainerStyle={{ paddingHorizontal: compact ? space.xs : space.lg - space.md, paddingBottom: space.xl, paddingTop: space.xs }}>
      {error && !items.length ? <View style={{ padding: space.md }}><Banner theme={theme} tone="danger" message={error} action={{ get label() { return t("browserOverview.retry"); }, onPress: onRefresh }} /></View> : null}
      {loading && !items.length && !error ? <Skeleton theme={theme} rows={4} /> : null}
      {!loading && !items.length && !error ? <EmptyState theme={theme} icon="MonitorSmartphone" title={t("browserOverview.noServerBrowsersYet")} message={t("browserOverview.chooseAWorkspaceToGetStarted")} action={{ get label() { return t("browserOverview.openWorkspace"); }, icon: 'Plus', onPress: onAddWorkspace }} /> : null}
      {!!items.length && !sections.length ? <View testID="server-browser-overview-empty"><EmptyState theme={theme} icon="SearchX" tone="gray" title={t("browserOverview.noMatchingBrowsers")} action={{ get label() { return t("browserOverview.clearFilters"); }, onPress: () => { setFilter('all'); setSearch(''); } }} /></View> : null}
      {compact ? sections.map((section) => <View key={section.key}>
        <SectionHeader theme={theme} title={section.title} count={section.entries.length} icon="Folder" tone={hueFor(section.identity)} />
        {section.entries.map((entry) => <OverviewRow key={entry.item.workspace.id} theme={theme} entry={entry} selected={entry.item.workspace.id === selectedId} onSelect={onSelect} />)}
      </View>) : sections.length ? <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.md, padding: space.md }}>
        {sections.flatMap((section) => section.entries).map((entry) => <OverviewCard key={entry.item.workspace.id} theme={theme} hostId={hostId} entry={entry} width={cardWidth} selected={entry.item.workspace.id === selectedId} thumbnails={active && !error} onSelect={onSelect} />)}
      </View> : null}
    </ScrollView>
  </View>;
}

const OverviewRow = memo(function OverviewRow({ theme, entry, selected, onSelect }: { theme: Theme; entry: Entry; selected: boolean; onSelect: (id: string) => void }) {
  const { item, tab } = entry, badge = browserBadge(item);
  return <Row theme={theme} title={tab.title} titleLines={1} selected={selected} testID={`server-browser-overview-card-${item.workspace.id}`} accessibilityLabel={badge ? t("browserOverview.viewBrowserWithStatus", { project: item.workspace.projectTitle || t("browserOverview.untitledProject"), workspace: item.workspace.title, title: tab.title, status: badge.label }) : t("browserOverview.viewBrowser", { project: item.workspace.projectTitle || t("browserOverview.untitledProject"), workspace: item.workspace.title, title: tab.title })}
    leading={<ProjectMark theme={theme} name={tab.identity} size={20} />} trailing={badge ? <StatePill theme={theme} look={badge} /> : undefined}
    subtitle={<ControlMeta theme={theme} item={item} parts={[item.workspace.title, pageHost(item.session.url)]} />} onPress={() => onSelect(item.workspace.id)} />;
});

const activityLooks: Record<BrowserActivity['status'], Look> = {
  running: { get label() { return t("browserOverview.inProgress"); }, tone: 'info', icon: 'LoaderCircle', motion: 'spin' }, completed: { get label() { return t("browserOverview.complete"); }, tone: 'success', icon: 'CircleCheck' }, failed: { get label() { return t("browserOverview.failed"); }, tone: 'danger', icon: 'CircleX' },
};
/** Recent page operations of this plugin run: result (blue running, green done, red failed), who did it (Agent violet, 人工 amber) and the target page — never typed text. */
export function BrowserActivityList({ theme, session }: { theme: Theme; session: BrowserSession | null }) {
  const activities = recentActivity(session);
  if (!activities.length) return <View testID="server-browser-activity"><EmptyState theme={theme} icon="History" tone="pink" title={t("browserOverview.noActivityYet")} message={t("browserOverview.onlyPageActionsFromThisPluginRun")} /></View>;
  return <View testID="server-browser-activity" style={{ gap: space.xxs }}>
    <View testID="server-browser-activity-list">
      {activities.map((activity) => {
        const look = activityLooks[activity.status], source = controlLooks[activity.source === 'agent' ? 'agent' : 'manual'];
        return <Row key={activity.id} theme={theme} testID={`server-browser-activity-row-${activity.id}`} titleLines={1}
          title={actionTitle(activity.actionId ?? activity.action)} leading={<StateGlyph theme={theme} look={look} size={16} />}
          trailing={<Text style={{ color: activity.status === 'running' ? toneColor(theme, 'info') : activity.status === 'failed' ? toneColor(theme, 'danger') : theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: activity.status === 'completed' ? '400' : '500' }}>{activity.status === 'running' ? t("browserOverview.inProgress") : activity.status === 'failed' ? t("browserOverview.failed2", { value1: relativeTime(activity.endedAt || activity.startedAt) }) : relativeTime(activity.endedAt || activity.startedAt)}</Text>}
          subtitle={<View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 1 }}>
            <ControlMark theme={theme} mode={activity.source === 'agent' ? 'agent' : 'manual'} />
            <Text style={{ color: hue(theme, source.hue, 'text'), fontSize: fontSize.meta, fontWeight: '500' }}>{activity.source === 'agent' ? t("browserOverview.agent") : t("browserOverview.human")}</Text>
            <View style={{ flex: 1, minWidth: 0 }}><MetaLine theme={theme} parts={[activity.pageTitle || t("browserOverview.currentPage"), pageHost(activity.pageUrl)]} /></View>
          </View>} />;
      })}
    </View>
    <View style={{ paddingHorizontal: space.md }}><MetaLine theme={theme} parts={[t("browserOverview.last12Actions"), t("browserOverview.inputContentsExcluded")]} /></View>
  </View>;
}
