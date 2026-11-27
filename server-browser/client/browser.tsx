import { translator } from '../shared/i18n';
import { t } from '../shared/text';
import { openExternalUrl, useRpc, type PluginSurfaceProps, type PluginWorkspacePanelProps } from '@getpaseo/plugin/client';
import { Icon, useToast } from '@getpaseo/plugin/client/react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Image, KeyboardAvoidingView, PanResponder, PixelRatio, Platform, Pressable, Text, View, type GestureResponderEvent } from 'react-native';
import {
  actionRpc, agentRpc, deleteOrphanRpc, diagnosticsRpc, frameRpc, inputRpc, optionsRpc, orphanRpc, portsRpc, servicesRpc, stopOrphanRpc, readPageRpc, startRpc, stateRpc,
  type BrowserAction, type BrowserAgentPort, type BrowserInputEvent, type BrowserService, type BrowserTarget, type BrowserFrameQuality as FrameQuality, type BrowserFrameResult, type BrowserOverviewItem, type BrowserProfile, type BrowserReading, type BrowserSession, type BrowserWorkspace,
} from '../shared/browser';
import { bindInput, contextHolds, editDraft, emptyDraft, followBatch, frameInScope, frameMatchesSession, sameTarget, type InputRequest } from './input-target';
import { dropAll, droppedMessage, enqueueInput, nextInputSeq, settleBatch, splitText, takeBatch, type QueuedInput } from './input-queue';
import { frameCache, retainFrameHost } from './frame-cache';
import { bindFrameKeyboard, bindFrameWheel, cancelFrameComposition, focusFrame } from './web';
import { AddressField, BusyPill, InputDock, ModeSwitch, StageMessage, TabCountButton, useSheetPresence } from './chrome';
import { computeViewportLayout, mapViewportPoint } from './viewport-geometry';
import { BrowserOverview, recallFrame, rememberFrame, useAppForeground, useBrowserOverview } from './overview';
import { agentStatus, currentAgentActivity, linkedAgent, pageHost } from './overview-model';
import { BrowserAgentTabs } from './agent-tabs';
import { buildAgentTabGroups, controlLooks, projectColorIdentity, tabGlyph } from './agent-tabs-model';
import { effectiveQuality, frameDelay, frameLimits, frameTargetMs, initialPacing, recordFrame, type FramePacing } from './frame-pacing';
import { deviceOpenableUrl } from './local-open';
import { ActionMenu, Badge, Banner, BottomBar, Button, IconButton, MetaLine, ProjectMark, StatusDot, fontSize, hairline, hue, radius, space, toneColor, useCompactLayout, withAlpha, type MenuAction, type Tone } from './kit';
import { StateGlyph } from './looks';
import { SwipeShield } from './swipe-shield';
import { Ping } from './motion';
import { PORTS_POLL_MS, mergePorts, portsRequest, type PortsData } from './agent-ports-model';
import type { AgentPortsView } from './agent-ports';
import { ActivitySheet, AgentSheet, DialogSheet, OrphansSheet, DiagnosticsSheet, PageTabsSheet, ReadingSheet, ResourcesSheet, ServicesSheet, StopSheet, TakeoverSheet, ViewSheet, WorkspacePickerSheet, qualityLabel, type FrameMetrics, type TakeoverAction } from './tools';

type Theme = PluginSurfaceProps['theme'];
type Frame = NonNullable<BrowserFrameResult['frame']>;
type PageCheck = { name: string; status: 'ok' | 'warning' | 'error'; detail: string };
type SheetName = 'menu' | 'tabs' | 'view' | 'reading' | 'diagnostics' | 'activity' | 'resources' | 'agent' | 'stop' | 'dialog' | 'orphans' | 'services' | 'takeover';
type ScreenProps = PluginSurfaceProps & {
  onOpenLanguage?: () => void;
  workspaceId: string;
  workspaceTitle: string;
  workspace: BrowserWorkspace;
  overviewItem?: BrowserOverviewItem;
  overviewItems: BrowserOverviewItem[];
  onSelectWorkspace: (id: string) => void;
  onOpenOverview: () => void;
  onPickWorkspace: () => void;
  profiles: BrowserProfile[];
  /** Phone-style chrome: one top row, navigation in a bottom bar while in manual control. */
  compactChrome: boolean;
};
const noItems: BrowserOverviewItem[] = [];

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? t("browserUi.connectionTemporarilyUnavailable"));
  const raw = message.replace(/^Request failed:\s*/i, '').replace(/\s+requestType=\S+\s+code=\S+[\s\S]*$/, '').trim();
  // i18n-ignore: match legacy server errors, not display text.
  if (/agent.*busy|正在.*操作|takeover/i.test(raw)) return t("browserUi.theCurrentActionIsFinishingTryTaking");
  if (/timeout|timed out/i.test(raw)) return t("browserUi.theServerIsRespondingSlowlyTryAgain");
  if (/disconnect|offline|closed.*connection|not connected/i.test(raw)) return t("browserUi.disconnectedFromTheServerReconnectToContinue");
  return raw.length > 240 ? `${raw.slice(0, 240)}…` : raw;
}
/** React Native types know only `auto` and `pointer`; the web also shows `progress` while a click waits for the next picture. */
const webCursor = (cursor: string) => (Platform.OS === 'web' ? { cursor } : {}) as object;
/** The end of a long text, which is where typing happens. */
const lastChars = (text: string, count: number) => { const chars = Array.from(text); return chars.length > count ? `…${chars.slice(-count).join('')}` : text; };
const compositionDropped = () => t("browserUi.thePageOrControllerChangedUnconfirmedInput");
/** The pill of a request in flight takes the colour of what it waits for: handing to the Agent violet, taking over amber, page work blue. */
const busyTone = (kind: string | null): Tone => kind === 'agent' ? controlLooks.agent.hue : kind === 'manual' || kind === 'takeover' ? controlLooks.manual.hue : 'info';

/** Placeholder chrome while the first workspace list loads: the browser's shape, no fake content. */
function BrowserSkeleton({ theme, compact, children }: { theme: Theme; compact: boolean; children?: ReactNode }) {
  const { colors } = theme;
  const block = (width: number | `${number}%`, height = 20, key?: string) => <View key={key} style={{ width, height, borderRadius: radius.sm, backgroundColor: colors.surface2 }} />;
  return <View accessibilityRole="progressbar" accessibilityLabel={t("browserUi.loading")} style={{ flex: 1, minHeight: 0 }}>
    {!compact && <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, height: 40, paddingHorizontal: space.md, borderBottomWidth: hairline, borderBottomColor: colors.border }}>{block(20)}{block(140)}{block(110)}</View>}
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, height: compact ? 48 : 40, paddingHorizontal: space.md, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
      {compact ? <>{block(28, 28)}{block('55%', 16)}</> : <>{['a', 'b', 'c'].map((key) => block(20, 20, key))}{block('60%', 28)}</>}
    </View>
    {children ? <View style={{ padding: space.md }}>{children}</View> : null}
    <View style={{ flex: 1, backgroundColor: colors.surface1 }} />
  </View>;
}

function BrowserShell(props: PluginSurfaceProps & { fixedWorkspaceId?: string; onOpenOverview?: () => void; onOpenLanguage?: () => void }) {
  const getOptions = useRpc(optionsRpc);
  useEffect(() => retainFrameHost(props.host.id), [props.host.id]);
  const options = useQuery({ queryKey: ['server-browser', props.host.id, 'options', translator().language, translator().hash], queryFn: () => getOptions({}), staleTime: 15_000, retry: 1, refetchOnWindowFocus: false });
  // A host keeps recent tabs mounted with display:none; their zero-size layout pauses polling.
  const [visible, setVisible] = useState(true);
  const [shortWindow, setShortWindow] = useState(false);
  const layout = useCompactLayout(props.layout.compact);
  const overview = useBrowserOverview(props.host.id, visible);
  const [selectedId, setSelectedId] = useState(props.fixedWorkspaceId || '');
  const [view, setView] = useState<'browser' | 'overview'>('browser');
  const [picking, setPicking] = useState(false);
  const [orphanOpen, setOrphanOpen] = useState(false);
  const workspaces = useMemo(() => {
    const items = new Map((options.data?.workspaces ?? []).map((workspace) => [workspace.id, workspace]));
    for (const item of overview.data?.items ?? []) items.set(item.workspace.id, item.workspace);
    return [...items.values()];
  }, [options.data?.workspaces, overview.data?.items]);
  useEffect(() => {
    if (!overview.data || !workspaces.length || workspaces.some((workspace) => workspace.id === selectedId)) return;
    const live = overview.data.items.find((item) => item.session.status === 'running') || overview.data.items[0];
    setSelectedId(live?.workspace.id || workspaces[0].id);
  }, [props.fixedWorkspaceId, overview.data, workspaces, selectedId]);
  const workspaceId = selectedId || props.fixedWorkspaceId || '';
  const workspace = workspaces.find((item) => item.id === workspaceId) || { id: workspaceId, title: t("browserUi.workspace") };
  const items = overview.data?.items ?? noItems;
  const overviewItem = items.find((item) => item.workspace.id === workspaceId);
  const select = useCallback((id: string) => { setSelectedId(id); setView('browser'); setPicking(false); }, []);
  const openOverview = useCallback(() => setView('overview'), []);
  const pickWorkspace = useCallback(() => setPicking(true), []);
  const refetchOverview = overview.refetch, refetchOptions = options.refetch;
  const refresh = useCallback(() => { void refetchOptions(); void refetchOverview({ cancelRefetch: false }); }, [refetchOptions, refetchOverview]);
  const started = useMemo(() => new Set(items.filter((item) => item.session.status !== 'idle').map((item) => item.workspace.id)), [items]);
  const failure = overview.error || options.error;
  const loading = !overview.data && !failure;
  const pickerPresent = useSheetPresence(picking ? 'picker' : null);
  const { theme } = props, compact = layout.compact;
  let content: ReactNode;
  if (view === 'overview' && (workspaceId || items.length)) content = <BrowserOverview theme={theme} compact={compact} hostId={props.host.id} items={items} loading={loading} error={failure ? errorMessage(failure) : null}
    selectedId={workspaceId} onSelect={select} onBack={workspaceId ? () => setView('browser') : undefined} onAddWorkspace={pickWorkspace}
    stale={overview.stale} active={overview.active} pending={overview.isFetching} checkedAt={overview.data?.checkedAt} onRefresh={refresh} onOpenOrphans={() => setOrphanOpen(true)} />;
  else if (workspaceId) content = <BrowserScreen key={`${props.host.id}:${workspaceId}`} {...props} workspaceId={workspaceId} workspaceTitle={workspace.title} workspace={workspace}
    overviewItem={overviewItem} overviewItems={items} onSelectWorkspace={select} onOpenOverview={openOverview} onPickWorkspace={pickWorkspace}
    profiles={options.data?.profiles ?? []} compactChrome={compact || shortWindow} />;
  else if (failure) content = <BrowserSkeleton theme={theme} compact={compact}><Banner theme={theme} tone="danger" message={errorMessage(failure)} action={{ label: t("browserUi.retry"), onPress: refresh }} /></BrowserSkeleton>;
  else if (!loading && !workspaces.length) content = <StageMessage theme={theme} icon="FolderOpen" tone="info" title={t("browserUi.noWorkspacesYet")} message={t("browserUi.openAProjectInPaseoToStart")} />;
  else content = <BrowserSkeleton theme={theme} compact={compact} />;
  return <View testID="server-browser-shell" onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setVisible(width > 0 && height > 0); setShortWindow(height > 0 && height < 500); layout.onLayout(event); }} style={{ flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: theme.colors.surface0 }}>
    {content}
    {!workspaceId ? <View style={{ position: 'absolute', right: space.md, top: space.md }}><Button theme={theme} label={t("browserUi.orphanedBrowsers")} icon="MonitorOff" onPress={() => setOrphanOpen(true)} /></View> : null}
    {orphanOpen ? <StandaloneOrphans theme={theme} hostId={props.host.id} onClose={() => setOrphanOpen(false)} /> : null}
    {pickerPresent('picker') ? <WorkspacePickerSheet theme={theme} open={picking} onClose={() => setPicking(false)} workspaces={workspaces} running={started} selectedId={workspaceId} onSelect={select} /> : null}
  </View>;
}

function StandaloneOrphans({ theme, hostId, onClose }: { theme: Theme; hostId: string; onClose: () => void }) {
  const list = useRpc(orphanRpc), stop = useRpc(stopOrphanRpc), remove = useRpc(deleteOrphanRpc);
  const [stopping, setStopping] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ['server-browser', hostId, 'orphans', translator().language, translator().hash], queryFn: () => list({}), staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  return <OrphansSheet theme={theme} open onClose={onClose} items={query.data?.items ?? []} loading={query.isFetching} error={error || (query.error ? errorMessage(query.error) : null)} stopping={stopping} deleting={deleting} onRefresh={() => { setError(null); void query.refetch(); }}
    onStop={(id) => { setStopping(id); setError(null); void stop({ workspaceId: id }).then(() => { frameCache.delete(hostId, id); void query.refetch(); }).catch((failure) => setError(errorMessage(failure))).finally(() => setStopping(null)); }}
    onDelete={(id) => { setDeleting(id); setError(null); void remove({ workspaceId: id }).then(() => { frameCache.delete(hostId, id); void query.refetch(); }).catch((failure) => setError(errorMessage(failure))).finally(() => setDeleting(null)); }} />;
}

export function ServerBrowserSurface(props: PluginSurfaceProps & { onOpenLanguage?: () => void }) { return <BrowserShell key={props.host.id} {...props} />; }
export function ServerBrowserWorkspacePanel(props: PluginWorkspacePanelProps & { onOpenOverview?: () => void; onOpenLanguage?: () => void }) { return <BrowserShell key={`${props.host.id}:${props.workspaceId}`} {...props} fixedWorkspaceId={props.workspaceId} />; }

function BrowserScreen({ theme, host, layout, navigation, workspaceId, workspaceTitle, workspace, overviewItem, overviewItems, onSelectWorkspace, onOpenOverview, onPickWorkspace, onOpenLanguage, profiles, compactChrome }: ScreenProps) {
  const readState = useRpc(stateRpc);
  const start = useRpc(startRpc);
  const capture = useRpc(frameRpc);
  const act = useRpc(actionRpc);
  const connectAgent = useRpc(agentRpc);
  const diagnose = useRpc(diagnosticsRpc);
  const readPage = useRpc(readPageRpc);
  const listOrphans = useRpc(orphanRpc);
  const stopOrphan = useRpc(stopOrphanRpc);
  const deleteOrphan = useRpc(deleteOrphanRpc);
  const sendInput = useRpc(inputRpc);
  const listServices = useRpc(servicesRpc);
  const listPorts = useRpc(portsRpc);
  const queryClient = useQueryClient();
  const toast = useToast();
  const [session, setSession] = useState<BrowserSession | null>(null);
  const [displayedId, setDisplayedId] = useState<string | null>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [stageHidden, setStageHidden] = useState(false);
  const appActive = useAppForeground() && !stageHidden;
  const [busy, setBusy] = useState<string | null>(null);
  const [busyKind, setBusyKind] = useState<'agent' | 'manual' | 'takeover' | 'reading' | 'diagnostics' | 'other' | null>(null);
  const [address, setAddress] = useState('');
  const [text, setText] = useState('');
  const [profileId, setProfileId] = useState('');
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const present = useSheetPresence(sheet);
  const [inputOpen, setInputOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [quality, setQuality] = useState<FrameQuality>('sharp');
  const [frameMetrics, setFrameMetrics] = useState<FrameMetrics | null>(null);
  const [pageChecks, setPageChecks] = useState<PageCheck[] | null>(null);
  const [readingMode, setReadingMode] = useState<'article' | 'visible'>('article');
  const [readingQuery, setReadingQuery] = useState('');
  const [reading, setReading] = useState<BrowserReading | null>(null);
  const [readingError, setReadingError] = useState<string | null>(null);
  const [openingAgent, setOpeningAgent] = useState(false);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [stoppingOrphan, setStoppingOrphan] = useState<string | null>(null);
  const [deletingOrphan, setDeletingOrphan] = useState<string | null>(null);
  // An input method composing on the frame, and a short note when a click came before the new picture.
  const [composing, setComposing] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [takeover, setTakeover] = useState<{ then: TakeoverAction; target: BrowserTarget | null; editable: boolean } | null>(null);
  const orphans = useQuery({ queryKey: ['server-browser', host.id, 'orphans', translator().language, translator().hash], queryFn: () => listOrphans({}), enabled: sheet === 'orphans' && appActive, staleTime: 0, gcTime: 0, retry: false, refetchOnWindowFocus: false });
  const services = useQuery({ queryKey: ['server-browser', host.id, 'services', workspaceId, translator().language, translator().hash], queryFn: () => listServices({ workspaceId }), enabled: (sheet === 'services' || sheet === 'tabs') && appActive, staleTime: 5000, gcTime: 30_000, retry: false, refetchOnWindowFocus: false });
  // Ports Agents opened: polled only while a sheet that shows them is open and the app is in front; an unchanged list
  // costs a revision check. A host that cannot list ports (not Linux) is asked once per opening.
  const portsKey = useMemo(() => ['server-browser', host.id, 'ports', workspaceId], [host.id, workspaceId]);
  const ports = useQuery({ queryKey: portsKey, queryFn: async () => { const previous = queryClient.getQueryData<PortsData>(portsKey); return mergePorts(previous, await listPorts(portsRequest(workspaceId, previous))); },
    enabled: (sheet === 'services' || sheet === 'tabs') && appActive, refetchInterval: (query) => query.state.data?.supported === false ? false : PORTS_POLL_MS, refetchIntervalInBackground: false,
    staleTime: 2000, gcTime: 30_000, retry: false, refetchOnWindowFocus: false });
  const [frameNode, setFrameNode] = useState<unknown>(null);
  // The last picture whose image finished loading: stays under the next one until it loads, so typing never flashes blank.
  const [loadedFrame, setLoadedFrame] = useState<Frame | null>(null);
  const loadedFrameRef = useRef<Frame | null>(null);
  loadedFrameRef.current = loadedFrame;
  // The picture a page change took away: drawn under the stage, never clickable, until the next picture has loaded, so a
  // navigation, click or tab switch never blanks the stage while the new picture is on its way.
  const [staleFrame, setStaleFrame] = useState<Frame | null>(null);
  // The last frame this app saw of this browser: shown dimmed until the live frame arrives, so switching feels instant.
  const [placeholder, setPlaceholder] = useState(() => recallFrame(host.id, workspaceId));
  const alive = useRef(true);
  const sessionRef = useRef<BrowserSession | null>(null);
  const frameIdRef = useRef<string | null>(null);
  const displayedRef = useRef<BrowserTarget | null>(null);
  const frameRef = useRef<Frame | null>(null);
  const viewerId = useRef(`viewer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`);
  const pressTarget = useRef<BrowserTarget | null>(null);
  const scrollTarget = useRef<BrowserTarget | null>(null);
  const actionBusyRef = useRef(false);
  const frameBusyRef = useRef(false);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const addressFocused = useRef(false);
  const addressDraft = useRef(emptyDraft());
  const inputDraft = useRef(emptyDraft());
  const panTarget = useRef<BrowserTarget | null>(null);
  const pressLocation = useRef<{ x: number; y: number } | null>(null);
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const pacingRef = useRef<FramePacing>(initialPacing);
  // Revision of the session last delivered by a frame poll; any other session update clears it.
  const sessionRevisionRef = useRef<string | null>(null);
  // Unchanged sessions are no longer re-sent, so the uptime counter is extended locally from this moment.
  const sessionReceivedAtRef = useRef(0);
  const limitsRef = useRef(frameLimits(stageSize, PixelRatio.get()));
  limitsRef.current = frameLimits(stageSize, PixelRatio.get());
  const metricsVisibleRef = useRef(false);
  metricsVisibleRef.current = sheet === 'view';
  const suppressFrameClick = useRef(false);
  // Live input (keys, text, wheel, clicks): queued against the page context it was made on, one batch in flight at a time.
  const liveQueue = useRef<QueuedInput[]>([]);
  const liveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveInFlight = useRef(false);
  const liveSeq = useRef(0);
  const liveBusySince = useRef(0);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The batch on its way, and the page context an open input method composition was started on (it is sent only there).
  const liveInFlightTarget = useRef<BrowserTarget | null>(null);
  const compositionTarget = useRef<BrowserTarget | null>(null);
  const composingRef = useRef(false);
  const frameNodeRef = useRef<unknown>(null);
  frameNodeRef.current = frameNode;
  const controllerRef = useRef<{ canControl: boolean; canType: boolean; scale: number }>({ canControl: false, canType: false, scale: 1 });
  const appActiveRef = useRef(appActive);
  appActiveRef.current = appActive;
  const colors = theme.colors;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (liveTimer.current) clearTimeout(liveTimer.current); if (hintTimer.current) clearTimeout(hintTimer.current); dropAll(liveQueue.current); };
  }, []);
  useEffect(() => {
    if (!profileId && profiles.length) setProfileId(profiles[0].id);
  }, [profileId, profiles]);
  useEffect(() => { if (frame) rememberFrame(host.id, workspaceId, frame); }, [frame, host.id, workspaceId]);

  const serialize = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    const promise = queueRef.current.catch(() => {}).then(() => {
      if (!alive.current) throw new Error(t("browserUi.theCurrentPageHasClosed"));
      return task();
    });
    queueRef.current = promise.catch(() => {});
    return promise;
  }, []);
  const clearFrame = useCallback(() => {
    setPlaceholder(undefined);
    const lastLoaded = loadedFrameRef.current;
    if (lastLoaded) setStaleFrame(lastLoaded);
    displayedRef.current = null; frameRef.current = null; frameIdRef.current = null;
    setDisplayedId(null); setFrame(null); setLoadedFrame(null);
  }, []);
  // Input that did not reach the page is always reported. Losses that come together (queued keys and an open composition
  // when the page changes) are shown together rather than one replacing the other.
  const lossRef = useRef<{ text: string; at: number } | null>(null);
  const reportLoss = useCallback((message: string) => {
    const previous = lossRef.current, now = Date.now();
    const text = previous && now - previous.at < 1500 && !previous.text.includes(message) ? `${previous.text}${message}` : message;
    lossRef.current = { text, at: now };
    setError(text);
  }, []);
  /** The page context an input method composition was started on has ended: drop it unsent and free the slot. */
  const dropComposition = useCallback(() => {
    compositionTarget.current = null; composingRef.current = false;
    cancelFrameComposition(frameNodeRef.current);
    setComposing(null);
    reportLoss(compositionDropped());
  }, [reportLoss]);
  const updateSession = useCallback((value: BrowserSession, revision: string | null = null) => {
    if (!alive.current) return;
    setPlaceholder(undefined);
    // An open composition stays with the context it started on and is never moved to another document or tab. A batch on
    // its way for that context settles it when its answer comes (it may carry the context on), so this waits for it.
    const riding = !!liveInFlightTarget.current && sameTarget(liveInFlightTarget.current, compositionTarget.current);
    if (composingRef.current && !riding && !contextHolds(compositionTarget.current, value)) dropComposition();
    sessionRevisionRef.current = revision;
    sessionReceivedAtRef.current = Date.now();
    const previousUrl = sessionRef.current?.url;
    // Own input only spends the picture for clicks; a different tab, document, viewport or controller clears it.
    if (!frameInScope(frameRef.current, value)) clearFrame();
    const previousTab = sessionRef.current?.tabs.find((tab) => tab.active)?.id;
    sessionRef.current = value;
    setSession(value);
    if (value.url !== previousUrl || value.tabs.find((tab) => tab.active)?.id !== previousTab || value.status === 'recovering') {
      setReading(null);
      setPageChecks(null);
    }
    // An idle address bar always shows the page; an unsubmitted edit left behind on blur lasts until the page moves on.
    if (!addressFocused.current && (!addressDraft.current.dirty || value.url !== previousUrl)) { addressDraft.current = emptyDraft(); setAddress(value.url); }
    if (value.status !== 'running') { frameCache.delete(host.id, workspaceId); setStaleFrame(null); }
    if (value.error) {
      setFrameError(value.error);
      if (value.status === 'error') setError(value.error);
    }
  }, [clearFrame, dropComposition, host.id, workspaceId]);

  const stateMutation = useMutation({ gcTime: 0, mutationFn: () => readState({ workspaceId }) });
  // A live frame stream must not retain several minutes of JPEGs in the query cache.
  const captureMutation = useMutation({ gcTime: 0, mutationFn: () => serialize(() => capture({
    workspaceId, viewerId: viewerId.current, after: frameIdRef.current, quality: effectiveQuality(qualityRef.current, pacingRef.current), ...limitsRef.current,
    ...(sessionRevisionRef.current ? { sessionRevision: sessionRevisionRef.current } : {}),
  })) });
  const startMutation = useMutation({ gcTime: 0, mutationFn: () => serialize(() => start({ workspaceId })) });
  const actionMutation = useMutation({ gcTime: 0, mutationFn: (input: InputRequest) => serialize(() => act({ workspaceId, ...input })) });
  const agentMutation = useMutation({ gcTime: 0, mutationFn: (selectedProfile: string) => serialize(() => connectAgent({ workspaceId, ...(selectedProfile ? { profileId: selectedProfile } : {}) })) });
  const diagnosticsMutation = useMutation({ gcTime: 0, mutationFn: () => serialize(() => diagnose({ workspaceId })) });
  const readingMutation = useMutation({ gcTime: 0, mutationFn: (input: { mode: 'article' | 'visible'; query?: string }) => serialize(() => readPage({ workspaceId, ...input, maxChars: 16000 })) });

  const refreshFrame = useCallback(async (force = false) => {
    if (!alive.current || !appActiveRef.current || frameBusyRef.current || (!force && actionBusyRef.current)) return;
    frameBusyRef.current = true;
    const requestedAt = Date.now();
    try {
      const result = await captureMutation.mutateAsync();
      if (!alive.current) return;
      // An omitted session is unchanged since the revision this viewer holds.
      if (result.session) updateSession(result.session, result.sessionRevision ?? null);
      const current = sessionRef.current;
      // The previous picture keeps keyboard input bound to this page until the new one has loaded.
      if (result.frame && frameInScope(result.frame, current)) { frameIdRef.current = result.frame.id; frameRef.current = result.frame; setFrame(result.frame); }
      const previous = pacingRef.current;
      const latency = Date.now() - requestedAt;
      pacingRef.current = recordFrame(previous, { requestedAt, latency, changed: !!result.frame });
      if (metricsVisibleRef.current) setFrameMetrics({ latency, interval: previous.previousRequestAt ? requestedAt - previous.previousRequestAt : null, kilobytes: result.frame ? Math.round(result.frame.dataUrl.length / 1024) : null, scale: result.frame?.scale ?? null, degraded: pacingRef.current.degrade > 0 });
      setFrameError(current?.error ?? null);
    } catch (failure) {
      if (!alive.current) return;
      setFrameError(errorMessage(failure));
      clearFrame();
      pacingRef.current = recordFrame(pacingRef.current, { requestedAt, latency: Date.now() - requestedAt, changed: false, failed: true });
    } finally { frameBusyRef.current = false; }
  }, [captureMutation.mutateAsync, updateSession, clearFrame]);
  const refreshRef = useRef(refreshFrame);
  refreshRef.current = refreshFrame;

  // Metadata polling also observes dialogs while a page action is waiting for a response.
  // Keep idle/starting/error views in sync with another device and refresh immediately on foreground return.
  useEffect(() => {
    if (!appActive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const sync = async () => {
      try {
        const value = await stateMutation.mutateAsync();
        if (cancelled || !alive.current) return;
        updateSession(value);
        if (!paused && (value.status === 'running' || value.status === 'recovering')) void refreshRef.current();
      } catch (failure) { if (!cancelled && alive.current) { clearFrame(); frameCache.clearHost(host.id); setError(errorMessage(failure)); } }
      if (!cancelled) timer = setTimeout(sync, sessionRef.current?.status === 'starting' || sessionRef.current?.dialog ? 1000 : 3000);
    };
    void sync();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [workspaceId, appActive, paused, stateMutation.mutateAsync, updateSession, clearFrame, host.id]);

  useEffect(() => {
    if (paused || !appActive || (session?.status !== 'running' && session?.status !== 'recovering')) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const next = async () => {
      const cycleStarted = Date.now();
      await refreshRef.current();
      const targetInterval = frameDelay(pacingRef.current, qualityRef.current, sessionRef.current?.status === 'recovering');
      if (!cancelled) timer = setTimeout(next, Math.max(100, targetInterval - (Date.now() - cycleStarted)));
    };
    timer = setTimeout(next, frameTargetMs[quality]);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [paused, appActive, session?.status, quality]);

  async function perform(action: BrowserAction, label = t("browserUi.working"), capturedTarget?: BrowserTarget | null) {
    if (actionBusyRef.current || !alive.current) return false;
    const request = bindInput(action, capturedTarget === undefined ? displayedRef.current : capturedTarget);
    if (!request) { setError(t("browserUi.theViewIsUpdatingTryAgainShortly")); void refreshFrame(true); return false; }
    // Typing that is still waiting goes first: it was made before this command.
    pumpRef.current();
    actionBusyRef.current = true;
    pacingRef.current = { ...pacingRef.current, unchanged: 0 };
    setBusy(label); setBusyKind(action.kind === 'takeover' ? 'takeover' : action.kind === 'mode' ? action.mode : 'other'); setError(null);
    const invalidates = ['navigate', 'back', 'forward', 'reload', 'demo', 'stop', 'newTab', 'openPort', 'tab', 'closeTab', 'viewport', 'devicePreset', 'restart', 'fitWidth', 'takeover'].includes(action.kind);
    const addressed = action.kind === 'navigate' || (action.kind === 'takeover' && action.then.kind === 'navigate');
    if (invalidates) { clearFrame(); setReading(null); setPageChecks(null); }
    try {
      const value = await actionMutation.mutateAsync(request);
      if (!alive.current) return false;
      updateSession(value);
      if (addressed) { addressDraft.current = emptyDraft(); setAddress(value.url); }
      else if (invalidates && !addressDraft.current.dirty) setAddress(value.url);
      if (value.status === 'running') await refreshFrame(true);
      return true;
    } catch (failure) {
      if (alive.current) { clearFrame(); setError(errorMessage(failure)); await refreshFrame(true); }
      return false;
    } finally {
      actionBusyRef.current = false;
      if (alive.current) setBusy(null);
    }
  }

  async function startBrowser() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy(t("browserUi.startingTheBrowser")); setBusyKind('other'); setError(null); setFrameError(null);
    try {
      const value = await startMutation.mutateAsync();
      if (!alive.current) return;
      updateSession(value); setPaused(false); await refreshFrame(true);
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  async function openAgent() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy(session?.agentId ? t("browserUi.connectingToTheAgent") : t("browserUi.preparingTheAgent")); setBusyKind('agent'); setError(null);
    try {
      const result = await agentMutation.mutateAsync(profileId);
      if (!alive.current) return;
      updateSession(result.session);
      setSheet(null);
      if (result.created) toast.show(t("browserUi.browserAgentConnected"), { variant: 'success' });
      navigation?.openAgent({ agentId: result.agentId, serverId: host.id });
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  async function openConnectedAgent() {
    if (openingAgent) return;
    setOpeningAgent(true); setError(null);
    try {
      const current = await stateMutation.mutateAsync();
      if (!alive.current) return;
      updateSession(current);
      if (current.agentAvailability === 'unknown') { setError(t("browserUi.theAgentStatusIsUnavailableRefreshShortly")); return; }
      if (!current.agentId || current.agentAvailability === 'unavailable') { setSheet('agent'); return; }
      navigation?.openAgent({ agentId: current.agentId, serverId: host.id });
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { if (alive.current) setOpeningAgent(false); }
  }

  async function inspectPage() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy(t("browserUi.checkingTheCurrentPage")); setBusyKind('diagnostics'); setError(null);
    try {
      const result = await diagnosticsMutation.mutateAsync();
      if (!alive.current) return;
      updateSession({ ...result.session, health: result.health }); setPageChecks(result.checks);
    } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  async function extractPage() {
    if (actionBusyRef.current) return;
    actionBusyRef.current = true; setBusy(t("browserUi.readingTheCurrentPage")); setBusyKind('reading'); setReadingError(null); setReading(null);
    try {
      const result = await readingMutation.mutateAsync({ mode: readingMode, ...(readingQuery.trim() ? { query: readingQuery.trim() } : {}) });
      if (alive.current) setReading(result);
    } catch (failure) { if (alive.current) setReadingError(errorMessage(failure)); }
    finally { actionBusyRef.current = false; if (alive.current) setBusy(null); }
  }

  function selectQuality(value: FrameQuality) {
    qualityRef.current = value; setQuality(value);
    // An explicit choice is honoured again until the link proves slow.
    pacingRef.current = { ...pacingRef.current, unchanged: 0, degrade: 0, fast: 0 }; frameIdRef.current = null;
    if (!paused && appActive) void refreshFrame();
  }
  const pageUrl = deviceOpenableUrl(session?.url);
  async function openOnDevice(url: string) {
    try { await openExternalUrl(url); } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
  }

  const flashHint = useCallback((message: string) => {
    setHint(message);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => { hintTimer.current = null; if (alive.current) setHint(null); }, 1800);
  }, []);
  /**
   * Send the next batch of live input. Keys and text keep going on the page context they were typed on without waiting
   * for a new picture; when that context ends (another tab or document, the Agent, a dialog, another device's input) the
   * rest is dropped and you are told, never replayed on the new page. An Agent read that is finishing only delays it.
   */
  const pumpInput = useCallback(() => {
    if (liveInFlight.current || !alive.current) return;
    if (liveTimer.current) { clearTimeout(liveTimer.current); liveTimer.current = null; }
    const batch = takeBatch(liveQueue.current);
    if (!batch.length) return;
    liveInFlight.current = true;
    pacingRef.current = { ...pacingRef.current, unchanged: 0 };
    const seq = nextInputSeq(liveSeq.current, sessionRef.current), sent = batch[0].target;
    liveSeq.current = seq;
    liveInFlightTarget.current = sent;
    void serialize(() => sendInput({ workspaceId, viewerId: viewerId.current, seq, target: sent, events: batch.map((entry) => entry.event) })).then((result) => {
      if (!alive.current) return;
      liveInFlightTarget.current = null;
      // A composition open on this context follows it on, or ends with it, before the new session is looked at.
      if (composingRef.current && compositionTarget.current) {
        const next = followBatch(compositionTarget.current, sent, result);
        if (next) compositionTarget.current = next; else dropComposition();
      }
      updateSession(result.session);
      const { retry, dropped } = settleBatch(liveQueue.current, batch, result);
      if (retry) {
        liveBusySince.current ||= Date.now();
        if (Date.now() - liveBusySince.current < 8000) { liveTimer.current = setTimeout(() => { liveTimer.current = null; pumpRef.current(); }, 200); return; }
        const lost = [...dropAll(liveQueue.current)];
        reportLoss(droppedMessage(lost) ?? t("browserUi.theAgentIsStillUsingTheBrowser"));
        return;
      }
      liveBusySince.current = 0;
      // Every key that did not reach the page is reported, a page dialog included; nothing is replayed later.
      const message = droppedMessage(dropped, result.status === 'blocked' ? 'dialog' : 'page');
      if (message) reportLoss(message);
      // Show what the input did, or the page it no longer fits.
      void refreshRef.current(true);
    }).catch((failure) => {
      liveInFlightTarget.current = null;
      if (!alive.current) return;
      // The outcome is unknown: nothing that was waiting is sent on its own.
      for (const entry of batch) entry.done?.(false);
      dropAll(liveQueue.current);
      setError(errorMessage(failure));
      void refreshRef.current(true);
    }).finally(() => {
      liveInFlight.current = false;
      if (alive.current && liveQueue.current.length && !liveTimer.current) liveTimer.current = setTimeout(() => { liveTimer.current = null; pumpRef.current(); }, 0);
    });
  }, [serialize, sendInput, workspaceId, updateSession, dropComposition, reportLoss]);
  const pumpRef = useRef(pumpInput);
  pumpRef.current = pumpInput;
  /** Queue live input made on `target`. A short pause lets a burst of keys travel together; nothing waits while a batch is on its way. */
  const queueLive = useCallback((event: BrowserInputEvent, target: BrowserTarget, done?: (delivered: boolean) => void) => {
    enqueueInput(liveQueue.current, { event, target: { ...target }, done });
    if (!liveTimer.current && !liveInFlight.current) liveTimer.current = setTimeout(() => { liveTimer.current = null; pumpRef.current(); }, 30);
  }, []);
  /** Queue one piece of live input against the picture it was made on (`eventTarget`, or the one on screen now). */
  const enqueueLive = useCallback((event: BrowserInputEvent, done?: (delivered: boolean) => void, eventTarget?: BrowserTarget | null) => {
    const target = eventTarget === undefined ? displayedRef.current : eventTarget;
    if (!target || !controllerRef.current.canType) {
      if (event.kind !== 'scroll') reportLoss(t("browserUi.theViewIsUpdatingYourInputWas"));
      void refreshRef.current(true); done?.(false); return;
    }
    queueLive(event, target, done);
  }, [queueLive, reportLoss]);
  // A composition starts on the picture on screen and its text may only ever go to that page context.
  const onComposing = useCallback((value: string | null) => {
    if (value !== null && !composingRef.current) compositionTarget.current = displayedRef.current ? { ...displayedRef.current } : null;
    if (value === null) compositionTarget.current = null;
    composingRef.current = value !== null;
    setComposing(value);
  }, []);
  const onComposed = useCallback((value: string) => {
    const target = compositionTarget.current;
    compositionTarget.current = null;
    // Sent with the context it started on: the server refuses it if that has changed since; a batch on its way decides first.
    const riding = !!target && !!liveInFlightTarget.current && sameTarget(liveInFlightTarget.current, target);
    if (!target || (!riding && !contextHolds(target, sessionRef.current))) { reportLoss(compositionDropped()); return; }
    for (const part of splitText(value)) queueLive({ kind: 'text', text: part }, target);
  }, [queueLive, reportLoss]);
  const queueScroll = useCallback((displayX: number, displayY: number, eventTarget?: BrowserTarget | null) => {
    if (!controllerRef.current.canControl) return;
    const scale = controllerRef.current.scale, clamp = (value: number) => Math.round(Math.max(-3000, Math.min(3000, value * scale)));
    const deltaX = clamp(displayX), deltaY = clamp(displayY);
    if (Math.abs(deltaX) + Math.abs(deltaY) < 1) return;
    enqueueLive({ kind: 'scroll', deltaX, deltaY }, undefined, eventTarget ?? displayedRef.current);
  }, [enqueueLive]);
  // On Android the SwipeShield's scroll views own drags while you control the page, so the drawer cannot take them.
  const shieldRef = useRef(false);
  const panResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponderCapture: (_event, gesture) => {
      if (gesture.numberActiveTouches <= 1) panTarget.current = displayedRef.current ? { ...displayedRef.current } : null;
      return false;
    },
    onMoveShouldSetPanResponderCapture: (_event, gesture) => controllerRef.current.canControl && !shieldRef.current && Math.abs(gesture.dx) + Math.abs(gesture.dy) > 10,
    onPanResponderGrant: () => { suppressFrameClick.current = true; pressLocation.current = null; },
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_event, gesture) => { suppressFrameClick.current = true; if (panTarget.current) queueScroll(-gesture.dx, -gesture.dy, panTarget.current); panTarget.current = null; },
    onPanResponderTerminate: () => { suppressFrameClick.current = true; },
  }), [queueScroll]);

  const running = session?.status === 'running';
  const recovering = session?.status === 'recovering';
  const hasBrowser = !!session && (running || recovering);
  const manualMode = running && session.mode === 'manual';
  const manual = manualMode && !session.agentBusy && !busy;
  // frameLive: a loaded picture of the current page context; typing, scrolling and page commands use it. frameReady: it is
  // also the latest picture (no input since), which a click needs.
  const frameLive = !!frame && !!displayedId && frameInScope(frame, session) && !frameError;
  const frameReady = frameLive && displayedId === frame?.id && frameMatchesSession(frame, session);
  const canType = !!manualMode && frameLive && !session?.dialog;
  const canControl = canType;
  const canClick = canType && frameReady;
  const geometry = computeViewportLayout({ containerWidth: stageSize.width, containerHeight: stageSize.height, frameWidth: frame?.width || session?.width || 0, frameHeight: frame?.height || session?.height || 0 });
  controllerRef.current = { canControl, canType, scale: geometry.scale > 0 ? 1 / geometry.scale : 1 };
  // The keyboard stays bound while you control the page, through picture refreshes; keys typed between pictures still count.
  const keyboardOn = !!manualMode && !session?.dialog;
  shieldRef.current = Platform.OS === 'android' && keyboardOn && stageSize.width > 0 && stageSize.height > 0;
  useEffect(() => {
    if (!keyboardOn || !frameNode) return;
    const wheel = bindFrameWheel(frameNode, queueScroll);
    const keyboard = bindFrameKeyboard(frameNode, (action) => enqueueLive(action), { onComposing, onComposed, onCompositionDropped: () => { compositionTarget.current = null; composingRef.current = false; if (alive.current) reportLoss(compositionDropped()); } });
    return () => { wheel(); keyboard(); };
  }, [keyboardOn, frameNode, queueScroll, enqueueLive, onComposing, onComposed, reportLoss]);
  const agentControlled = running && session.mode === 'agent';

  function pressFrame(event: GestureResponderEvent) {
    if (suppressFrameClick.current) { suppressFrameClick.current = false; return; }
    if (agentControlled) { toast.show(t("browserUi.switchToManualToInteractWithThe")); return; }
    if (!canControl || !frame || geometry.scale <= 0 || !session) return;
    // Native onPress has local coordinates. React Native Web dispatches its final
    // click as a MouseEvent, so keep the normalized responder position from press-in.
    const position = Number.isFinite(event.nativeEvent.locationX) && Number.isFinite(event.nativeEvent.locationY)
      ? { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY }
      : pressLocation.current;
    pressLocation.current = null;
    if (!position) return;
    focusFrame(frameNode, position);
    // The picture on screen predates your last input: the page may have changed under that spot, so this click waits for you.
    if (!canClick || !pressTarget.current || pressTarget.current.viewRevision !== frame.viewRevision) { pressTarget.current = null; flashHint(t("browserUi.theViewIsUpdatingClickAgainOn")); return; }
    const point = mapViewportPoint(position, geometry, { frameWidth: frame.width, frameHeight: frame.height });
    if (point) enqueueLive({ kind: 'click', x: point.x, y: point.y }, undefined, pressTarget.current);
    pressTarget.current = null;
  }
  /** Back, forward, reload or an address: right away under manual control; from Agent mode after the takeover sheet confirms it. */
  function navigateOrTakeOver(then: TakeoverAction, label: string, target?: BrowserTarget | null, editable = false) {
    if (session?.mode === 'manual') { void perform(then, label, target); return; }
    setTakeover({ then, target: target === undefined ? displayedRef.current : target, editable }); setSheet('takeover');
  }
  function navigate() {
    const url = address.trim();
    if (!url || url === 'about:blank' || !running || busy) return;
    addressFocused.current = false;
    navigateOrTakeOver({ kind: 'navigate', url }, t("browserUi.openingThePage"), addressDraft.current.dirty ? addressDraft.current.target : undefined);
  }
  // The confirmation is for the page shown when the sheet opened; another document or tab there voids it.
  const takeoverStale = !!takeover && (!takeover.target || !session || session.activeTabId !== takeover.target.tabId || (!!takeover.target.documentScope && !!session.documentScope && takeover.target.documentScope !== session.documentScope));
  function confirmTakeover(then: TakeoverAction) {
    const request = takeover;
    if (takeoverStale) return;
    setSheet(null);
    if (!request) return;
    void perform({ kind: 'takeover', then }, t("browserUi.takingManualControl"), request.target);
  }
  function openService(service: BrowserService) {
    if (!service.url) return;
    setSheet(null);
    void perform({ kind: 'newTab', url: service.url }, t("browserUi.opening", { value1: service.name })).then((done) => { if (done) toast.show(t("browserUi.openedInANewTab", { value1: service.name }), { variant: 'success' }); });
  }
  /** Only the port goes to the server, which opens the address it found for it (and nothing that is not in its list). */
  function openPort(port: BrowserAgentPort) {
    if (!port.openable) return;
    setSheet(null);
    void perform({ kind: 'openPort', port: port.port }, t('agentPorts.opening', { port: port.port })).then((done) => { if (done) toast.show(t('agentPorts.opened', { port: port.port }), { variant: 'success' }); });
  }
  const portsView = (disabled: boolean): AgentPortsView => ({ data: ports.data, error: ports.error ? errorMessage(ports.error) : null, disabled, onOpen: openPort });
  async function sendText() {
    const value = text;
    if (!value || !canType) return;
    // Long text goes in whole-character pieces; what did not reach the page stays in the tray.
    const parts = splitText(value), target = inputDraft.current.target;
    const delivered = await Promise.all(parts.map((part) => new Promise<boolean>((resolve) => enqueueLive({ kind: 'text', text: part }, resolve, target))));
    const rest = parts.filter((_part, index) => !delivered[index]).join('');
    if (rest === value) return;
    setText((current) => current === value ? rest : current);
    if (!rest) inputDraft.current = emptyDraft();
  }

  const linked = linkedAgent(overviewItem, session);
  const tabGroups = useMemo(() => {
    const items = session ? overviewItems.map((item) => item.workspace.id === workspaceId ? { ...item, session } : item) : overviewItems;
    return buildAgentTabGroups(items, workspace);
  }, [overviewItems, session, workspaceId, workspace]);
  const projectIdentity = projectColorIdentity(workspace);
  const selectedAgentTab = tabGroups.flatMap((group) => group.tabs).find((tab) => tab.workspaceId === workspaceId);
  const matchWindow = async () => {
    if (!manual || stageSize.width <= 0 || stageSize.height <= 0) return;
    setSheet(null);
    const matched = await perform({ kind: 'viewport', width: Math.max(320, Math.min(2560, Math.floor(stageSize.width))), height: Math.max(320, Math.min(1600, Math.floor(stageSize.height))) }, t("browserUi.matchingTheWindow"));

  };
  const setMode = (mode: 'agent' | 'manual') => { if (mode === 'agent') setInputOpen(false); void perform({ kind: 'mode', mode }, mode === 'manual' ? t("browserUi.switchingToManualControl") : t("browserUi.handingOverToTheAgent")); };
  const activeTab = session?.tabs.find((tab) => tab.active);
  const agentTabId = currentAgentActivity(session)?.tabId;
  const glyph = selectedAgentTab ? tabGlyph(selectedAgentTab.state, selectedAgentTab.mode) : null;
  const viewHint = [qualityLabel(quality), paused ? t("browserUi.paused") : null, session && hasBrowser ? t("browserUi.formatted", { value1: session.width, value2: session.height }) : null, geometry.scale > 0 ? t("browserUi.display", { value1: Math.round(geometry.scale * 100) }) : null].filter(Boolean).join(t("browserUi.detailSeparator"));
  const uptimeSeconds = (session?.runtime?.uptimeSeconds || 0) + (session?.status === 'running' ? Math.max(0, (Date.now() - sessionReceivedAtRef.current) / 1000) : 0);

  // Manual-only actions appear once the viewer has taken over; while the Agent is in control they would all be disabled.
  const takenOver = hasBrowser && session.mode === 'manual';
  const menu: MenuAction[] = [];
  if (session?.dialog) menu.push({ key: 'dialog', label: t("browserUi.pageDialog"), icon: 'MessageSquareWarning', tone: 'warning', onPress: () => setSheet('dialog') });
  if (compactChrome && takenOver) menu.push({ key: 'forward', label: t("browserUi.forward"), icon: 'ArrowRight', disabled: !manual, onPress: () => { void perform({ kind: 'forward' }, t("browserUi.goingForward")); } });
  if (compactChrome && hasBrowser && !takenOver) menu.push({ key: 'tabs', label: t("browserUi.tabs", { value1: session.tabs.length }), icon: 'Layers', onPress: () => setSheet('tabs') });
  // Phones show no navigation bar while the Agent drives; these ask to take over first.
  if (compactChrome && running && agentControlled) {
    menu.push({ key: 'takeover-back', label: t("browserUi.takeManualControlAndGoBack"), icon: 'ArrowLeft', tone: controlLooks.manual.hue, disabled: !!busy, onPress: () => navigateOrTakeOver({ kind: 'back' }, t("browserUi.goingBack")) });
    menu.push({ key: 'takeover-reload', label: t("browserUi.takeManualControlAndReload"), icon: 'RotateCw', tone: controlLooks.manual.hue, disabled: !!busy, onPress: () => navigateOrTakeOver({ kind: 'reload' }, t("browserUi.reloading")) });
    menu.push({ key: 'takeover-open', label: t("browserUi.takeManualControlAndOpenAUrl"), icon: 'Globe', tone: controlLooks.manual.hue, disabled: !!busy, onPress: () => navigateOrTakeOver({ kind: 'navigate', url: '' }, t("browserUi.openingThePage"), undefined, true) });
  }
  if (hasBrowser) menu.push({ key: 'services', label: t('agentPorts.menuLabel'), icon: 'Server', tone: 'green', hint: t('agentPorts.menuHint'), onPress: () => setSheet('services') });
  if (takenOver) {
    menu.push({ key: 'match', label: t("browserUi.matchWindow"), icon: 'Scan', tone: 'teal', disabled: !manual, onPress: () => { void matchWindow(); } });
    menu.push({ key: 'fit', label: t("browserUi.fullWidth"), icon: 'Columns2', tone: 'teal', disabled: !manual, onPress: () => { void perform({ kind: 'fitWidth' }, t("browserUi.fittingThePageWidth")); } });
  }
  if (hasBrowser) menu.push({ key: 'view', label: t("browserUi.view"), icon: 'SlidersHorizontal', tone: 'cyan', hint: viewHint, onPress: () => setSheet('view') });
  if (pageUrl) {
    menu.push({ key: 'device', label: t("browserUi.openInThisDeviceSBrowser"), icon: 'ArrowUpRight', tone: 'blue', hint: t("browserUi.theSameUrlWithoutTheServerBrowser"), onPress: () => { void openOnDevice(pageUrl); } });
    if (navigation?.openBrowser) menu.push({ key: 'paseo', label: t("browserUi.openInPaseoSLocalBrowser"), icon: 'AppWindow', tone: 'blue', onPress: () => { try { navigation.openBrowser!({ url: pageUrl, workspaceId, serverId: host.id }); } catch (failure) { setError(errorMessage(failure)); } } });
  }
  if (session?.agentId && session.agentAvailability !== 'unavailable') { if (compactChrome && navigation) menu.push({ key: 'agent', label: t("browserUi.openLinkedAgent"), icon: 'Bot', tone: controlLooks.agent.hue, hint: t("browserUi.formatted2", { value1: linked?.title || t("browserUi.linkedAgent"), value2: agentStatus(linked) }), disabled: openingAgent, onPress: () => { void openConnectedAgent(); } }); }
  else if (hasBrowser) menu.push({ key: 'agent', label: session?.agentId && session.agentAvailability === 'unavailable' ? t("browserUi.reconnectBrowserAgent") : t("browserUi.connectBrowserAgent"), icon: 'BotMessageSquare', tone: controlLooks.agent.hue, disabled: !running, onPress: () => setSheet('agent') });
  if (hasBrowser) {
    menu.push({ key: 'reading', label: t("browserUi.readPage"), icon: 'BookOpenText', tone: 'indigo', disabled: !running, onPress: () => setSheet('reading') });
    menu.push({ key: 'diagnostics', label: t("browserUi.pageDiagnostics"), icon: 'Stethoscope', tone: 'green', onPress: () => setSheet('diagnostics') });
  }
  menu.push({ key: 'activity', label: t("browserUi.activity"), icon: 'History', tone: 'pink', onPress: () => setSheet('activity') });
  menu.push({ key: 'orphans', label: t("browserUi.orphanedBrowsers"), icon: 'MonitorOff', tone: 'amber', onPress: () => setSheet('orphans') });
  menu.push({ key: 'resources', label: t("browserUi.resourcesAndRecovery"), icon: 'HardDrive', tone: 'gray', onPress: () => setSheet('resources') });
  if (onOpenLanguage) menu.push({ key: 'language', label: t("browserUi.language"), icon: 'Languages', onPress: () => { setSheet(null); onOpenLanguage(); } });
  if (takenOver) {
    menu.push({ key: 'demo', label: t("browserUi.openDemoPage"), icon: 'FlaskConical', disabled: !manual, onPress: () => { void perform({ kind: 'demo' }, t("browserUi.openingTheDemoPage")); } });
    if (activeTab) menu.push({ key: 'close-tab', label: t("browserUi.closeCurrentTab"), icon: 'X', disabled: !manual || activeTab.pinned, hint: activeTab.pinned ? t("browserUi.pinnedUnpinItInTabsFirst") : undefined, onPress: () => { void perform({ kind: 'closeTab', tabId: activeTab.id }, t("browserUi.closingTheTab")); } });
    menu.push({ key: 'stop', label: t("browserUi.closeBrowser"), icon: 'Power', tone: 'danger', disabled: !manual, onPress: () => setSheet('stop') });
  }

  const modeSwitch = hasBrowser ? <ModeSwitch theme={theme} compact={compactChrome} mode={session.mode} disabled={!running || !!busy} onChange={setMode} /> : null;
  const size = compactChrome ? 'md' : 'sm';
  // From Agent mode these stay usable: they open the takeover sheet first.
  const navigable = !!running && !busy && (session?.mode === 'agent' || !session?.agentBusy);
  const back = <IconButton theme={theme} icon="ArrowLeft" label={t("browserUi.back")} size={size} disabled={!navigable} testID="server-browser-back" onPress={() => navigateOrTakeOver({ kind: 'back' }, t("browserUi.goingBack"))} />;
  const reload = <IconButton theme={theme} icon="RotateCw" label={t("browserUi.reloadPage")} size={size} disabled={!navigable} testID="server-browser-reload" onPress={() => navigateOrTakeOver({ kind: 'reload' }, t("browserUi.reloading"))} />;
  const addressField = <AddressField theme={theme} value={address} onChangeText={(value) => { addressDraft.current = editDraft(addressDraft.current, value, displayedRef.current); setAddress(value); }} onSubmit={navigate} editable={navigable} busy={!!busy} compact={compactChrome} onFocusChange={(focused) => { addressFocused.current = focused; if (!focused && !addressDraft.current.dirty && sessionRef.current) setAddress(sessionRef.current.url); }} />;
  const tabsButton = hasBrowser ? <TabCountButton theme={theme} size={size} count={session.tabs.length} onPress={() => setSheet('tabs')} /> : null;
  const keyboardButton = hasBrowser && session.mode === 'manual' ? <IconButton theme={theme} icon="Keyboard" label={t("browserUi.pageKeyboardInput")} size={size} active={inputOpen} disabled={!canControl} testID="server-browser-keyboard" onPress={() => setInputOpen((open) => !open)} /> : null;
  const moreButton = <IconButton theme={theme} icon="Ellipsis" label={t("browserUi.moreActions")} size={size} testID="server-browser-menu" onPress={() => setSheet('menu')} />;

  const permission = linked?.needsPermission ? `permission:${linked.id}` : null;
  const login = session?.health?.state === 'login_required' && agentControlled ? `login:${session.url}` : null;
  const banner = error ? <Banner theme={theme} tone="danger" message={error} {...(session?.dialog ? { action: { label: t("browserUi.viewDialog"), onPress: () => setSheet('dialog') } } : {})} onDismiss={() => { lossRef.current = null; setError(null); }} />
    : session?.dialog ? <Banner theme={theme} tone="warning" icon="MessageSquareWarning" message={t("browserUi.thePageIsWaitingForAResponse")} action={{ label: t("browserUi.viewDialog"), onPress: () => setSheet('dialog') }} />
    : permission && dismissed !== permission ? <Banner theme={theme} tone="warning" icon="Hand" message={t("browserUi.isWaitingForApproval", { value1: linked?.title || t("browserUi.agent") })} action={navigation ? { label: t("browserUi.openAgent"), onPress: () => { void openConnectedAgent(); } } : undefined} onDismiss={() => setDismissed(permission)} />
    : login && dismissed !== login ? <Banner theme={theme} tone="orange" icon="LogIn" message={t("browserUi.thePageMayRequireLogin")} action={{ label: t("browserUi.takeManualControl"), onPress: () => setMode('manual') }} onDismiss={() => setDismissed(login)} />
    : null;

  const shown = frame && !recovering && !frameError ? frame : null;
  const ghost = !shown && placeholder && !recovering && !frameError && !session ? placeholder : null;
  const stale = staleFrame && running && !recovering && !frameError ? staleFrame : null;
  const staleGeometry = stale ? computeViewportLayout({ containerWidth: stageSize.width, containerHeight: stageSize.height, frameWidth: stale.width, frameHeight: stale.height }) : null;
  const ghostGeometry = ghost ? computeViewportLayout({ containerWidth: stageSize.width, containerHeight: stageSize.height, frameWidth: ghost.width, frameHeight: ghost.height }) : null;
  let stageState: ReactNode = null;
  if (!shown && !ghost) {
    if (recovering) stageState = <StageMessage theme={theme} busy tone="warning" icon="RefreshCw" title={t("browserUi.recoveringTheBrowser")} />;
    else if (frameError && running) stageState = <StageMessage theme={theme} tone="danger" icon="WifiOff" title={t("browserUi.viewDisconnected")} message={frameError} action={{ label: t("browserUi.reconnect"), icon: 'RefreshCw', tone: 'info', testID: 'server-browser-frame-retry', onPress: () => { void refreshFrame(); } }} />;
    else if (!session) stageState = <StageMessage theme={theme} busy tone="info" icon="Globe" title={t("browserUi.connectingToTheBrowser")} />;
    else if (running && !stale) stageState = <StageMessage theme={theme} busy tone="info" icon="Globe" title={t("browserUi.fetchingTheView")} />;
    else stageState = <StageMessage theme={theme} tone={session.status === 'starting' ? 'info' : 'gray'} icon="Globe" title={session.status === 'starting' ? t("browserUi.browserIsStarting") : t("browserUi.browserHasNotStarted")} message={workspace.projectTitle ? t("browserUi.workspaceIdentity", { project: workspace.projectTitle, workspace: workspaceTitle }) : workspaceTitle}
      action={{ label: busy || t("browserUi.startBrowser"), icon: busy ? undefined : 'Play', primary: true, busy: !!busy, disabled: !!busy || stateMutation.isPending, testID: 'server-browser-start', onPress: () => { void startBrowser(); } }} />;
  }

  const identity = <Pressable testID="server-browser-workspace-picker" accessibilityRole="button" accessibilityLabel={t("browserUi.allBrowsersCurrently", { value1: selectedAgentTab?.accessibilityLabel || workspaceTitle })} onPress={onOpenOverview} hitSlop={{ top: 4, bottom: 4 }}
    style={(state) => ({ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 40, paddingRight: space.xs, borderRadius: radius.md, opacity: state.pressed ? 0.7 : 1 })}>
    <Icon name="ChevronLeft" size={18} color={colors.foregroundMuted} />
    <ProjectMark theme={theme} name={projectIdentity} size={22} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs + 2 }}>
        <Text testID="server-browser-identity-workspace" numberOfLines={1} style={{ flexShrink: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: '500' }}>{selectedAgentTab?.title || t("browserUi.manualBrowsing")}</Text>
        {glyph ? <StateGlyph theme={theme} look={glyph} size={14} /> : null}
      </View>
      <MetaLine theme={theme} parts={[workspace.projectTitle || workspaceTitle, session && hasBrowser ? pageHost(session.url) : workspaceTitle]} />
    </View>
  </Pressable>;

  return <KeyboardAvoidingView testID="server-browser-screen" behavior={layout.platform === 'ios' ? 'padding' : undefined} style={{ flex: 1, minHeight: 0, overflow: 'hidden', backgroundColor: colors.surface0 }}>
    <View testID="server-browser-toolbar" style={{ backgroundColor: colors.surface0, borderBottomWidth: hairline, borderBottomColor: colors.border }}>
      {compactChrome ? <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 48, paddingLeft: space.xs + 2, paddingRight: space.sm }}>
        {identity}
        {modeSwitch}
        {moreButton}
      </View> : <>
        <View testID="server-browser-agent-toolbar" style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, height: 40, paddingHorizontal: space.sm }}>
          <IconButton theme={theme} icon="LayoutGrid" label={t("browserUi.allBrowsers")} size="sm" testID="server-browser-workspace-picker" onPress={onOpenOverview} />
          <BrowserAgentTabs theme={theme} groups={tabGroups} selectedWorkspaceId={workspaceId} onSelect={onSelectWorkspace} />
          <IconButton theme={theme} icon="Plus" label={t("browserUi.openAnotherWorkspaceSBrowser")} size="sm" testID="server-browser-workspace-add" onPress={onPickWorkspace} />
          {!!session?.agentId && !!navigation && <Button theme={theme} label={session.agentAvailability === 'unavailable' ? t("browserUi.reconnectAgent") : t("browserUi.openAgent")} icon="Bot" size="sm" variant="ghost" tone={controlLooks.agent.hue} busy={openingAgent} accessibilityLabel={t("browserUi.openLinkedAgent2", { value1: linked?.title || t("browserUi.linkedAgent"), value2: agentStatus(linked) })} testID="server-browser-identity-open-agent" onPress={() => { void openConnectedAgent(); }} />}
        </View>
        <View testID="server-browser-nav" style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, height: 40, paddingHorizontal: space.sm, borderTopWidth: hairline, borderTopColor: colors.border }}>
          {back}
          <IconButton theme={theme} icon="ArrowRight" label={t("browserUi.forward")} size="sm" disabled={!navigable} testID="server-browser-forward" onPress={() => navigateOrTakeOver({ kind: 'forward' }, t("browserUi.goingForward"))} />
          {reload}
          <View style={{ width: space.xs }} />
          {addressField}
          {tabsButton}
          {keyboardButton}
          {modeSwitch}
          {moreButton}
        </View>
      </>}
    </View>

    <View testID="server-browser-stage" onLayout={(event) => { const { width, height } = event.nativeEvent.layout; setStageHidden(width <= 0 || height <= 0); setStageSize((current) => current.width === width && current.height === height ? current : { width, height }); }}
      {...panResponder.panHandlers} style={{ flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative', backgroundColor: colors.surface1 }}>
      <SwipeShield enabled={keyboardOn} width={stageSize.width} height={stageSize.height} onSwipe={(dx, dy) => { suppressFrameClick.current = true; queueScroll(-dx, -dy); }}>
      {/* The page edge shows who drives it: violet while the Agent is in control, amber while you are. */}
      {shown ? <View pointerEvents="none" style={{ position: 'absolute', left: geometry.offsetX - 2, top: geometry.offsetY - 2, width: geometry.imageWidth + 4, height: geometry.imageHeight + 4, borderWidth: 2, borderColor: withAlpha(hue(theme, controlLooks[session?.mode === 'manual' ? 'manual' : 'agent'].hue), 0.6) }} /> : null}
      {stale && staleGeometry ? <View pointerEvents="none" style={{ position: 'absolute', left: staleGeometry.offsetX, top: staleGeometry.offsetY, width: staleGeometry.imageWidth, height: staleGeometry.imageHeight }}>
        <Image fadeDuration={0} accessibilityLabel={t("browserUi.lastPageView")} source={{ uri: stale.dataUrl }} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
      </View> : null}
      {/* Every picture is a new Image; fadeDuration 0 stops Android fading each one in from the stage background. */}
      {/* The frame node stays mounted while the browser runs, so keyboard focus survives every picture change; without a picture it shrinks to 1 px. */}
      {hasBrowser ? <Pressable ref={setFrameNode} testID="server-browser-frame" accessibilityRole="imagebutton" accessibilityLabel={agentControlled ? t("browserUi.pageViewControlledByTheAgent") : t("browserUi.pageViewClickToTypeOrSwipe")} disabled={!shown}
        onPressIn={(event) => { suppressFrameClick.current = false; pressTarget.current = displayedRef.current ? { ...displayedRef.current } : null; const { locationX, locationY } = event.nativeEvent; pressLocation.current = Number.isFinite(locationX) && Number.isFinite(locationY) ? { x: locationX, y: locationY } : null; }} onPress={pressFrame}
        style={shown ? { position: 'absolute', inset: 0, ...(agentControlled ? { cursor: 'auto' } : manualMode && !canClick ? webCursor('progress') : null) } : { position: 'absolute', left: 0, top: 0, width: 1, height: 1, opacity: 0 }}>
        {shown ? <View pointerEvents="none" style={{ position: 'absolute', left: geometry.offsetX, top: geometry.offsetY, width: geometry.imageWidth, height: geometry.imageHeight }}>
          {loadedFrame && loadedFrame.id !== shown.id ? <Image key={loadedFrame.id} fadeDuration={0} accessibilityLabel={t("browserUi.previousPageView")} source={{ uri: loadedFrame.dataUrl }} resizeMode="contain" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }} /> : null}
          <Image key={shown.id} fadeDuration={0} testID="server-browser-image" accessibilityLabel={t("browserUi.serverPage")} source={{ uri: shown.dataUrl }} resizeMode="contain" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}
            onLoad={() => { if (frameRef.current?.id === shown.id && frameInScope(shown, sessionRef.current)) { displayedRef.current = { tabId: shown.tabId, viewRevision: shown.viewRevision, ...(shown.inputScope ? { inputScope: shown.inputScope } : {}), ...(shown.documentScope ? { documentScope: shown.documentScope } : {}) }; setDisplayedId(shown.id); setLoadedFrame(shown); setStaleFrame(null); } }} onError={() => { setFrameError(t("browserUi.viewFailedToLoad")); clearFrame(); }} />
        </View> : null}
      </Pressable> : null}
      </SwipeShield>
      {/* The slot that composes is invisible, so what the input method holds is shown here until it is committed. */}
      {composing !== null && shown ? <View pointerEvents="none" testID="server-browser-composing" style={{ position: 'absolute', top: space.sm, right: space.sm, zIndex: 6, maxWidth: '70%', flexDirection: 'row', alignItems: 'center', gap: space.xs, padding: 3, paddingLeft: space.sm, borderRadius: radius.md, backgroundColor: colors.surface0, borderWidth: hairline, borderColor: withAlpha(toneColor(theme, 'warning', 'mark'), 0.5) }}>
        <View style={{ width: 10, height: 10, alignItems: 'center', justifyContent: 'center' }}><Ping size={8} color={toneColor(theme, 'warning', 'mark')} /><StatusDot theme={theme} tone="warning" size={8} /></View>
        <Badge theme={theme} solid tone="warning" icon="Languages" label={composing ? t("browserUi.composingInput", { value1: lastChars(composing, 16) }) : t("browserUi.composingInput2")} />
      </View> : null}
      {ghost && ghostGeometry ? <View pointerEvents="none" style={{ position: 'absolute', left: ghostGeometry.offsetX, top: ghostGeometry.offsetY, width: ghostGeometry.imageWidth, height: ghostGeometry.imageHeight, opacity: 0.45 }}>
        <Image fadeDuration={0} accessibilityLabel={t("browserUi.lastPageView")} source={{ uri: ghost.dataUrl }} resizeMode="contain" style={{ width: '100%', height: '100%' }} />
      </View> : null}
      {stageState}
      {running && !session.dialog ? <View pointerEvents="none" style={{ position: 'absolute', bottom: space.sm, right: space.sm, paddingHorizontal: space.sm, paddingVertical: space.xs, borderRadius: radius.md, backgroundColor: colors.surface0 }}><MetaLine theme={theme} parts={[t("browserUi.viewers", { count: session.viewerCount ?? 0 })]} /></View> : null}
      {banner ? <View style={{ position: 'absolute', top: space.sm, left: space.sm, right: space.sm, zIndex: 10, borderRadius: radius.md, backgroundColor: colors.surface0 }}>{banner}</View> : null}
      {busy && hasBrowser ? <BusyPill theme={theme} label={busy} tone={busyTone(busyKind)} /> : hint && hasBrowser ? <BusyPill theme={theme} icon="MousePointerClick" label={hint} tone="info" /> : ghost || (stale && !loadedFrame) ? <BusyPill theme={theme} label={t("browserUi.fetchingTheView")} tone="info" /> : running && session.mode === 'manual' && session.agentBusy ? <BusyPill theme={theme} label={t("browserUi.waitingForTheAgentToFinishThe")} tone="info" />
        : paused && running ? <BusyPill theme={theme} icon="Pause" label={t("browserUi.viewPausedTapToResume")} tone="warning" onPress={() => { setPaused(false); void refreshFrame(); }} /> : null}
    </View>

    {inputOpen && hasBrowser && session.mode === 'manual' ? <InputDock theme={theme} text={text} onChangeText={(value) => { inputDraft.current = editDraft(inputDraft.current, value, displayedRef.current); setText(value); }} enabled={canType} onSend={() => { void sendText(); }} onClose={() => setInputOpen(false)}
      onKey={(key) => enqueueLive({ kind: 'key', key })} onScroll={(direction) => enqueueLive({ kind: 'scroll', deltaX: 0, deltaY: direction * 520 })} /> : null}
    {compactChrome && hasBrowser && session.mode === 'manual' ? <BottomBar theme={theme}>{back}{reload}{addressField}{tabsButton}{keyboardButton}</BottomBar> : null}

    {present('menu') ? <ActionMenu theme={theme} title={t("browserUi.moreActions")} open={sheet === 'menu'} onClose={() => setSheet((current) => current === 'menu' ? null : current)} actions={menu} /> : null}
    {session && present('tabs') ? <PageTabsSheet theme={theme} open={sheet === 'tabs'} onClose={() => setSheet((current) => current === 'tabs' ? null : current)} tabs={session.tabs} manual={!!manual && frameLive} agentMode={session.mode !== 'manual'} maxTabs={session.settings?.maxTabs || 20} agentTabId={agentTabId}
      onSelect={(tabId) => { setSheet(null); if (!session.tabs.find((tab) => tab.id === tabId)?.active) void perform({ kind: 'tab', tabId }, t("browserUi.switchingTabs")); }}
      onCloseTab={(tabId) => { void perform({ kind: 'closeTab', tabId }, t("browserUi.closingTheTab")); }} onPin={(tabId, pinned) => { void perform({ kind: 'pin', tabId, pinned }); }}
      onNewTab={() => { setSheet(null); void perform({ kind: 'newTab' }, t("browserUi.creatingATab")); }}
      services={{ items: services.data?.items ?? [], loading: services.isFetching, error: services.error ? errorMessage(services.error) : null, onOpen: openService }}
      ports={portsView(!manual || !frameLive || session.tabs.length >= (session.settings?.maxTabs || 20))} /> : null}
    {present('services') ? <ServicesSheet theme={theme} open={sheet === 'services'} onClose={() => setSheet((current) => current === 'services' ? null : current)} items={services.data?.items ?? []} loading={services.isFetching} error={services.error ? errorMessage(services.error) : null}
      manual={!!manual && frameLive && (session?.tabs.length ?? 0) < (session?.settings?.maxTabs || 20)} agentMode={session?.mode !== 'manual'} onOpen={openService} onRefresh={() => { void services.refetch(); void ports.refetch(); }}
      ports={portsView(!(manual && frameLive && (session?.tabs.length ?? 0) < (session?.settings?.maxTabs || 20)))} /> : null}
    {takeover && present('takeover') ? <TakeoverSheet theme={theme} open={sheet === 'takeover'} onClose={() => setSheet((current) => current === 'takeover' ? null : current)} request={takeover.then} editable={takeover.editable} stale={takeoverStale} busy={!!busy && busyKind === 'takeover'} onConfirm={confirmTakeover} /> : null}
    {present('view') ? <ViewSheet theme={theme} open={sheet === 'view'} onClose={() => setSheet((current) => current === 'view' ? null : current)} quality={quality} onQuality={selectQuality} manual={!!manual && frameLive} agentMode={session?.mode !== 'manual'}
      onMatch={() => { void matchWindow(); }} onFitWidth={() => { setSheet(null); void perform({ kind: 'fitWidth' }, t("browserUi.fittingThePageWidth")); }} onPreset={(preset) => { setSheet(null); void perform({ kind: 'devicePreset', preset }, t("browserUi.switchingDeviceEmulation")); }}
      paused={paused} onTogglePause={() => { setPaused((value) => !value); if (paused) void refreshFrame(); }} onRefresh={() => { void refreshFrame(); }}
      devicePreset={session?.devicePreset} viewerCount={session?.viewerCount} metrics={frameMetrics} viewport={session && hasBrowser ? { width: session.width, height: session.height } : null} scale={geometry.scale} /> : null}
    {present('reading') ? <ReadingSheet theme={theme} open={sheet === 'reading'} onClose={() => setSheet((current) => current === 'reading' ? null : current)} mode={readingMode} onMode={(mode) => { setReadingMode(mode); setReading(null); }} query={readingQuery} onQuery={setReadingQuery}
      onRun={() => { void extractPage(); }} canRun={running && !busy} busy={!!busy && busyKind === 'reading'} reading={reading} error={readingError} /> : null}
    {present('diagnostics') ? <DiagnosticsSheet theme={theme} open={sheet === 'diagnostics'} onClose={() => setSheet((current) => current === 'diagnostics' ? null : current)} health={session?.health ?? null} checks={pageChecks} onRun={() => { void inspectPage(); }} canRun={running && !busy}
      busy={!!busy && busyKind === 'diagnostics'} manual={session?.mode === 'manual'} onTakeOver={() => { setSheet(null); setMode('manual'); }} /> : null}
    {present('activity') ? <ActivitySheet theme={theme} open={sheet === 'activity'} onClose={() => setSheet((current) => current === 'activity' ? null : current)} session={session} /> : null}
    {present('resources') ? <ResourcesSheet theme={theme} open={sheet === 'resources'} onClose={() => setSheet((current) => current === 'resources' ? null : current)} session={session} uptimeSeconds={uptimeSeconds} manual={!!manual && frameLive} agentMode={session?.mode !== 'manual'} failure={session?.runtime?.lastFailure ? errorMessage(session.runtime.lastFailure) : null}
      onAutoRecover={(value) => { void perform({ kind: 'settings', settings: { autoRecover: value } }).then((done) => { if (done) toast.show(value ? t("browserUi.automaticRecoveryEnabled") : t("browserUi.automaticRecoveryDisabled")); }); }}
      onCleanup={() => { void perform({ kind: 'cleanup' }, t("browserUi.cleaningUpExpiredFiles")).then((done) => { if (done) toast.show(t("browserUi.expiredFilesCleanedUp"), { variant: 'success' }); }); }} /> : null}
    {present('agent') ? <AgentSheet theme={theme} open={sheet === 'agent'} onClose={() => setSheet((current) => current === 'agent' ? null : current)} profiles={profiles} profileId={profileId} onProfile={setProfileId} onConnect={() => { void openAgent(); }} canConnect={running && !busy && session?.agentAvailability !== 'unknown'} busy={!!busy && busyKind === 'agent'} /> : null}
    {session?.dialog && present('dialog') ? <DialogSheet key={session.dialog.id} theme={theme} open={sheet === 'dialog'} onClose={() => setSheet((current) => current === 'dialog' ? null : current)} dialog={session.dialog} manual={session.mode === 'manual'} busy={dialogBusy} onTakeOver={() => setMode('manual')}
      onRespond={(accept, promptText) => { const dialogId = session.dialog!.id; setDialogBusy(true); void act({ workspaceId, action: { kind: 'handleDialog', dialogId, accept, ...(promptText !== undefined ? { promptText } : {}) } }).then((value) => { if (alive.current) { updateSession(value); setSheet(null); void refreshFrame(true); } }).catch((failure) => { if (alive.current) { setError(errorMessage(failure)); setSheet(null); } }).finally(() => { if (alive.current) setDialogBusy(false); }); }} /> : null}
    {present('orphans') ? <OrphansSheet theme={theme} open={sheet === 'orphans'} onClose={() => setSheet((current) => current === 'orphans' ? null : current)} items={orphans.data?.items ?? []} loading={orphans.isFetching} error={orphans.error ? errorMessage(orphans.error) : null} stopping={stoppingOrphan} deleting={deletingOrphan} onRefresh={() => { void orphans.refetch(); }}
      onStop={(id) => { setStoppingOrphan(id); void stopOrphan({ workspaceId: id }).then(() => { frameCache.delete(host.id, id); void orphans.refetch(); }).catch((failure) => { if (alive.current) setError(errorMessage(failure)); }).finally(() => { if (alive.current) setStoppingOrphan(null); }); }}
      onDelete={(id) => { setDeletingOrphan(id); void deleteOrphan({ workspaceId: id }).then(() => { frameCache.delete(host.id, id); toast.show(t("browserUi.browserDataDeleted"), { variant: 'success' }); void orphans.refetch(); }).catch((failure) => { if (alive.current) setError(errorMessage(failure)); }).finally(() => { if (alive.current) setDeletingOrphan(null); }); }} /> : null}
    {present('stop') ? <StopSheet theme={theme} open={sheet === 'stop'} onClose={() => setSheet((current) => current === 'stop' ? null : current)} onConfirm={() => { setSheet(null); void perform({ kind: 'stop' }, t("browserUi.closingTheBrowser")).then((done) => { if (done) toast.show(t("browserUi.browserClosed")); }); }} /> : null}
  </KeyboardAvoidingView>;
}
