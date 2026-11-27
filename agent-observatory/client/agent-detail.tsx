import { joinList } from "../shared/i18n";
import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { usePaseo, useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { ScrollView, copyText, useToast } from "@getpaseo/plugin/client/react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PluginTheme } from "@getpaseo/plugin";
import { acknowledgement, applyReadReceipt, completionReadState, formatTokens, knownCompletionAt, observedRound, ownTurnRunning, parentServerOf, sameResultSource, stopUnseen, waitingKind, type AgentRecord } from "../shared/model";
import { eventLabel, setReplyAnswered, type TelemetrySnapshot } from "../shared/telemetry";
import type { HeartbeatSummary } from "../shared/schedules";
import { getSessionEvidence } from "../shared/history";
import { getAgentResult, mergeAgentResult, type AgentResultState } from "../shared/results";
import { markCompletionRead, type ReadReceipt } from "../shared/read-state";
import { ActionMenu, Banner, BottomBar, Button, IconButton, MetaLine, Skeleton, Spacer, Tabs, Toolbar, compactNumber, fontSize, formatDuration, relativeTime, space, type ButtonVariant, type MenuAction } from "./kit";
import { IdentityLine, InfoButton, KeyValue, PaneLabel, StatRow, checkoutName, providerLine, useClock } from "./ui";
import { EventGlyph, PhaseLine, hueColor, tint } from "./status";
import { Sweep } from "./motion";
import { CodeBlock, TimelineContent } from "./timeline-view";
import { ResultView, permissionRequests } from "./result-view";
import { SubtasksView } from "./subtasks-view";
import { InsightsPanel } from "./insights";
import { SendToAgentSheet } from "./insight-actions";
import { useTimeline } from "./use-timeline";
import { useDigest } from "./use-digest";
import { AgentDigest } from "./agent-digest";
import { readingMemory } from "./reading-cache";
import { readReceiptQueryKey } from "./use-read-receipts";
import { telemetryQueryKey } from "./use-telemetry";
import { useInvalidateAttention } from "./attention-context";
import { recapLook } from "../shared/recap";
import { useRecaps } from "./use-recaps";
import { RecapCard } from "./recap";
import { useForeground } from "./use-foreground";
import { useHostLabels } from "./hosts";
import { useObservatory } from "./use-observatory";
import { RecordedRunResult, ScheduleRunCard } from "./schedule-run-card";
import { heartbeatsQueryKey, useScheduleRun } from "./use-schedules";
import { HeartbeatCard } from "./heartbeat-card";
import { StopCard } from "./stop-card";
import { IssueCard } from "./issue-card";
import { useRestoreSession } from "./use-restore";
import type { ScheduleFocus } from "./schedule-focus";
import { describeRunError, knownRunError } from "../shared/schedules";
import { CacheChip } from "./cache-clock";
import { DeferredList, useDeferredQueue } from "./deferred";
import { isScheduledView } from "./schedule-send";
import { DISPLAY_DEFAULTS, displaySettings } from "../shared/display-settings";

interface AgentDetailProps { hostId: string; agent: AgentRecord;
  /** The page's Agents (for 子任务); the panel passes none and reads the directory only while 子任务 is open. */ agents?: AgentRecord[]; theme: PluginTheme; compact: boolean; navigation?: PluginSurfaceProps["navigation"]; onSelectAgent: (id: string) => void;
  /** Back to the list; without it (the 执行详情 panel shows one Agent) there is nothing to close. */ onClose?: () => void;
  telemetry?: TelemetrySnapshot; onReadNext?: (receipt: ReadReceipt) => void; onSnooze?: (agent: AgentRecord) => Promise<void>; queue?: { index: number; total: number }; initialEvidenceRef?: string;
  /** Opens 定时运行 on this Agent's schedule (and run). */ onOpenSchedules?: (focus: ScheduleFocus) => void;
  /** Heartbeats that wake this Agent (opus-B8). */ heartbeats?: readonly HeartbeatSummary[];
  /** Extra menu entries from the host view, e.g. 在观测台中查看 in the panel. */ extraActions?: readonly MenuAction[] }
// Each tab has its own colour, so the section you are in reads at a glance.
const tabs = [{ value: "result", get label() { return t("coreAgentDetail.result"); }, icon: "FileCheck", tone: "green" }, { value: "digest", get label() { return t("coreAgentDetail.recap"); }, icon: "ChartGantt", tone: "fuchsia" }, { value: "timeline", get label() { return t("coreAgentDetail.timeline"); }, icon: "ListTree", tone: "blue" }, { value: "children", get label() { return t("coreAgentDetail.subtasks"); }, icon: "Workflow", tone: "violet" },
  { value: "diagnostics", get label() { return t("coreAgentDetail.diagnostics"); }, icon: "Stethoscope", tone: "orange" }, { value: "insights", get label() { return t("coreAgentDetail.analysis"); }, icon: "Sparkles", tone: "pink" }] as const;
type DetailTab = typeof tabs[number]["value"];
type Action = { key: string; label: string; icon: string; onPress: () => void; busy?: boolean; disabled?: boolean };
const localTime = (value: string | null) => value ? new Date(value).toLocaleString(currentLanguage(), { hour12: false }) : t("coreAgentDetail.notReported");

export function AgentDetail({ hostId, agent, agents, theme, compact, navigation, onSelectAgent, onClose, telemetry, onReadNext, onSnooze, queue, initialEvidenceRef, onOpenSchedules, heartbeats, extraActions = [] }: AgentDetailProps) {
  const { colors } = theme;
  const toast = useToast();
  const inset = compact ? space.lg : space.xl;
  const [tab, setTab] = useState<DetailTab>(initialEvidenceRef ? "timeline" : "result"), [focusRef, setFocusRef] = useState<string | null>(initialEvidenceRef ?? null), [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { if (initialEvidenceRef) { setFocusRef(initialEvidenceRef); setTab("timeline"); } }, [initialEvidenceRef]);
  const paseo = usePaseo(), memory = useMemo(() => readingMemory(paseo, `detail:${agent.id}`), [paseo, agent.id]);
  // 观测设置 → display: whether a running turn gets the sweeping bar (on while the setting loads, as it always was).
  const display = useSettings(displaySettings);
  // A closed Agent (not loaded) is read once, not polled: each read loads it again, and Paseo 0.14 closes an idle Agent
  // after an hour, so a poll would keep loading and releasing it (a provider process each time for ACP and Codex).
  const closed = agent.rawStatus === "closed";
  const timeline = useTimeline({ agentId: agent.id }, tab === "timeline", !closed);
  const digest = useDigest(agent.id, tab === "digest", ownTurnRunning(agent), closed);
  const getResult = useRpc(getAgentResult), fetchEvidence = useRpc(getSessionEvidence), markRead = useRpc(markCompletionRead), queryCache = useQueryClient();
  const foreground = useForeground(), invalidateAttention = useInvalidateAttention();
  // This Agent's ledger (shared with its quick replies by query key): its scheduled messages show above the result.
  const deferredQueue = useDeferredQueue(agent.id, !agent.archivedAt);
  // 每轮小结 at the top, judged against the turn this detail shows; its 建议回复 goes under the reply.
  const recaps = useRecaps(hostId, !agent.archivedAt && !agent.parentAgentId);
  // Paseo 0.13: an Agent delegated from another connected host has its parent there, not in this list; Paseo opens it on its host.
  const parentServer = parentServerOf(agent, hostId), hostLabels = useHostLabels();
  const parentHost = parentServer ? hostLabels.get(parentServer) ?? null : null;
  const recap = recaps.data?.enabled ? recapLook(recaps.data.byAgent.get(agent.id), { startedAt: agent.observedTurnStartedAt ?? null, endedAt: agent.observedTurnEndedAt ?? null, running: ownTurnRunning(agent) }) : null;
  // A heartbeat's turn leaves the prompt and an unread attention stamp as they were: its completion and round tell it apart (codex-obs-attn-F1).
  const resultKey = ["observatory-result", agent.id, agent.lastUserMessageAt, knownCompletionAt(agent), observedRound(agent)];
  // An Agent a schedule created: its run's recorded reply is shown first. Reading an archived session's result loads it in
  // the host (ACP providers replay it), so for archived ones that waits for 「读取完整结果」.
  const scheduleRunId = agent.labels["paseo.schedule-run"] ?? null, scheduleId = agent.labels["paseo.schedule-id"] ?? null;
  const recordedFirst = !!scheduleRunId && !!agent.archivedAt;
  const [fullResult, setFullResult] = useState(false);
  // Nothing recorded (the schedule file is gone): read the session as for any other archived Agent.
  const recorded = useScheduleRun(recordedFirst && tab === "result" ? scheduleRunId : null, false);
  const waitForTap = recordedFirst && !fullResult && !(recorded.isSuccess && !recorded.data.output);
  const result = useQuery({ queryKey: resultKey, queryFn: async () => { const previous = queryCache.getQueryData<AgentResultState>(resultKey); return mergeAgentResult(previous, await getResult({ agentId: agent.id, expectedLastUserMessageAt: agent.lastUserMessageAt, expectedAttentionTimestamp: agent.attentionTimestamp ?? null, ...(previous?.revision ? { revision: previous.revision } : {}) })); }, enabled: tab === "result" && foreground && !waitForTap, staleTime: 2000,
    // A schedule Agent whose session failed to read shows its recorded reply instead; it retries only when asked.
    // A running turn's reply grows slowly and the directory already says when the turn ends (the key changes then): 15 s is enough (opus-F8).
    refetchInterval: query => !foreground || tab !== "result" || closed || (scheduleRunId && query.state.status === "error") ? false : ownTurnRunning(agent) ? 15000 : 30000, retry: 1 });
  const pendingDetails = useQuery({ queryKey: ["observatory-pending", agent.id], queryFn: () => paseo.agents.ref(agent.id).refresh(), enabled: agent.pendingPermissionCount > 0 && foreground, refetchInterval: agent.pendingPermissionCount > 0 && foreground ? 10000 : false, staleTime: 3000, retry: 1 });
  const evidence = useQuery({ queryKey: ["observatory-session-evidence", agent.id], queryFn: () => fetchEvidence({ agentId: agent.id }), enabled: tab === "diagnostics", staleTime: 60000, retry: 1 });
  const [ownReadReceipt, setOwnReadReceipt] = useState<ReadReceipt | null>(null), [reading, setReading] = useState(false), [archiving, setArchiving] = useState(false);
  const displayedAgent = ownReadReceipt ? applyReadReceipt(agent, ownReadReceipt) : agent, readState = completionReadState(displayedAgent);
  const observed = telemetry?.agents.find(row => row.agentId === agent.id), activity = (telemetry?.events ?? []).filter(row => row.agentId === agent.id).slice(0, 20);
  // What 已读 means here (shared/model.ts `acknowledgement`): a result (unread completion), a reply that asks you (待回复,
  // opus-F1), or an error or stop you have now seen (知道了, opus-F3). All clear the host's attention; only a result leaves a
  // receipt. A stop not seen yet comes first, whatever the turn's outcome (gemini-F7): 知道了 records no result read. On an
  // Agent the host has not loaded nothing is cleared (that would load it): the server's receipt marks it instead (P2-3, P2-4).
  const [seen, setSeen] = useState<string | null>(null);
  const attentionKey = `${agent.attentionTimestamp ?? ""}:${agent.lastUserMessageAt ?? ""}:${agent.stop?.at ?? ""}:${observedRound(agent) ?? ""}`;
  const unseenStop = stopUnseen(agent);
  const ackKind = seen === attentionKey ? null : acknowledgement(agent, readState);
  const acknowledge = async (next = false) => {
    // A turn the host closed mid-way has no native attention to clear: 知道了 then names the stop itself (opus-F34).
    const stopAt = ackKind === "problem" && unseenStop ? agent.stop!.at : null;
    if (reading || !ackKind || (!agent.attentionTimestamp && !stopAt)) return;
    // A result or a question is marked read only once the result it is about is on screen (a turn without a final reply
    // can be marked too: there is nothing more to wait for). A session the host has not loaded may never load (an ACP one
    // cannot be resumed), so its result may stay unreadable: the server checks the exact token then (P2-4). The result on screen
    // must have been read for this very turn: a heartbeat's turn keeps the host's tokens, its completion and round do not (codex-obs-attn-F1).
    const unreadable = !!result.error && agent.rawStatus === "closed";
    // Catalog migration preserves the guarded notice: if (ackKind !== "problem" && !unreadable && (!result.data || !sameResultSource(agent, result.data.source))) { toast.show("结果正在更新，请等最新回复载入后再标记"); void result.refetch(); return; }
    if (ackKind !== "problem" && !unreadable && (!result.data || !sameResultSource(agent, result.data.source))) { toast.show(t("coreAgentDetail.theResultIsUpdatingWaitForThe")); void result.refetch(); return; }
    setReading(true);
    try {
      // A result names the completion shown as unread: after another prompt the host's attention still carries the first,
      // unread one (edge-triggered), and the receipt must name the newer one (codex-F5). So does 知道了 on a stop of an unread
      // result: on an Agent the host has not loaded, it records that result's receipt too (P2-3).
      const completionAt = ackKind === "result" || ackKind === "problem" && readState === "unread" ? knownCompletionAt(agent) : null;
      // A question names its round: a heartbeat's next round asks under the same host tokens, and the server marks only the
      // round still latest there (codex-obs-attn-R2).
      const round = ackKind === "question" ? { startedAt: agent.observedTurnStartedAt ?? null, endedAt: agent.observedTurnEndedAt ?? null } : null;
      const answer = await markRead({ agentId: agent.id, attentionTimestamp: agent.attentionTimestamp ?? null, lastUserMessageAt: agent.lastUserMessageAt,
        ...(ackKind === "problem" ? { kind: "error" as const, ...(stopAt ? { stopAt } : {}) } : {}), ...(completionAt ? { completionAt } : {}), ...(round ? { round } : {}) });
      if (answer.status === "read") {
        setSeen(attentionKey);
        // 知道了 on a stop is (also) recorded with the observed stop: the list and the badge read it again now.
        if (stopAt) void queryCache.invalidateQueries({ queryKey: telemetryQueryKey(hostId) });
        invalidateAttention(hostId);
        // A receipt for 待回复 or a stop (an Agent the host has not loaded) shows at once too; an older one changes nothing.
        const receipt = answer.receipt;
        if (receipt) {
          setOwnReadReceipt(receipt);
          queryCache.setQueryData(readReceiptQueryKey, (previous: { receipts: ReadReceipt[]; error: string | null } | undefined) => ({ ...previous, receipts: [...(previous?.receipts ?? []).filter(item => item.agentId !== agent.id), receipt], error: null }));
        }
        if (next && receipt && ackKind === "result") onReadNext?.(receipt); else toast.show(answer.message, { variant: "success" });
      } else {
        toast.error(answer.message);
        // Stale: another round, prompt or stop since; the page reads the turns again at once rather than at its next poll.
        if (answer.status === "stale") void queryCache.invalidateQueries({ queryKey: telemetryQueryKey(hostId) });
      }
      void queryCache.invalidateQueries({ queryKey: readReceiptQueryKey });
    } catch (error) { toast.error(error instanceof Error ? error.message : t("coreAgentDetail.couldNotSyncReadStatus")); }
    finally { setReading(false); }
  };
  // 已答复 / 待回复: take this Agent off 待回复 without sending it anything, or put it back. Names the reply on screen.
  const setAnswered = useRpc(setReplyAnswered), [answering, setAnswering] = useState(false);
  // 回复: type or dictate an answer here instead of opening the session.
  const [replying, setReplying] = useState(false);
  const markAnswered = async (answered: boolean) => {
    if (!agent.replyAskedAt) return;
    setAnswering(true);
    try {
      const answer = await setAnswered({ agentId: agent.id, replyAt: agent.replyAskedAt, answered });
      if (answer.status === "ok") toast.show(answer.message, { variant: "success" }); else toast.error(answer.message);
      await queryCache.invalidateQueries({ queryKey: telemetryQueryKey(hostId) });
      invalidateAttention(hostId);
    } catch (error) { toast.error(error instanceof Error ? error.message : t("coreAgentDetail.couldNotChangeAnswered")); }
    finally { setAnswering(false); }
  };
  const openConversation = () => { try { Promise.resolve(navigation?.openAgent({ agentId: agent.id })).catch(error => toast.error(t("coreAgentDetail.couldNotOpenSession", { value1: error instanceof Error ? error.message : t("coreAgentDetail.tryAgainLater") }))); } catch (error) { toast.error(t("coreAgentDetail.couldNotOpenSession", { value1: error instanceof Error ? error.message : t("coreAgentDetail.tryAgainLater") })); } };
  const openParent = (agentId: string, serverId: string) => {
    const failed = (error: unknown) => toast.error(t("coreAgentDetail.couldNotOpenParent", { value1: error instanceof Error ? error.message : t("coreAgentDetail.tryAgainLater") }));
    try { Promise.resolve(navigation?.openAgent({ agentId, serverId })).catch(failed); } catch (error) { failed(error); }
  };
  const viewParent = !agent.parentAgentId ? undefined : !parentServer ? () => onSelectAgent(agent.parentAgentId!)
    : navigation ? () => openParent(agent.parentAgentId!, parentServer) : undefined;
  const archiveOriginal = async () => { setArchiving(true); try { await paseo.agents.ref(agent.id).archive(); toast.show(t("coreAgentDetail.archived"), { variant: "success" }); onClose?.(); } catch (error) { toast.error(error instanceof Error ? error.message : t("coreAgentDetail.couldNotArchiveTryAgain")); } finally { setArchiving(false); } };
  // 恢复会话 runs as a job on the server and is read every few seconds: a slow worktree rebuild outlasts the host's 30 s RPC limit (opus-F73).
  const restoring = useRestoreSession(agent.id);
  const restoreOriginal = async () => {
    const answer = await restoring.restore();
    if (answer.status === "restored" || answer.status === "already_active") { toast.show(answer.message, { variant: "success" }); openConversation(); }
    else if (answer.status === "failed") toast.error(answer.message); else toast.show(answer.message);
  };
  const snooze = onSnooze ? () => { void onSnooze(agent).catch(error => toast.error(error instanceof Error ? error.message : t("coreAgentDetail.couldNotSnooze"))); } : undefined;
  const openEvidence = (ref: string) => { setFocusRef(ref); setTab("timeline"); };
  const permissions = permissionRequests(pendingDetails.data?.agent ?? timeline.snapshot);
  const pending = agent.pendingPermissionCount;
  const unread = ackKind === "result";
  const waiting = waitingKind(agent);

  // A question is answered and a plan read in the conversation itself (opus-F12).
  const open: Action | null = navigation ? { key: "open", label: waiting === "question" ? t("coreAgentDetail.answer") : waiting === "plan" ? t("coreAgentDetail.viewPlan") : pending ? t("coreAgentDetail.reviewApproval") : t("coreAgentDetail.openSession"), icon: "ArrowUpRight", onPress: openConversation } : null;
  const read: Action | null = ackKind === "result" ? { key: onReadNext ? "next" : "read", label: onReadNext ? t("coreAgentDetail.markReadAndNext") : t("coreAgentDetail.markRead"), icon: onReadNext ? "ListChecks" : "Check", onPress: () => void acknowledge(!!onReadNext), busy: reading, disabled: result.isPending }
    : ackKind === "question" ? { key: "read", label: t("coreAgentDetail.markRead"), icon: "Check", onPress: () => void acknowledge(false), busy: reading, disabled: result.isPending }
    : ackKind === "problem" ? { key: "read", label: t("coreAgentDetail.gotIt"), icon: "Check", onPress: () => void acknowledge(false), busy: reading } : null;
  const archive: Action | null = !agent.archivedAt && readState === "read" ? { key: "archive", label: t("coreAgentDetail.archive"), icon: "Archive", onPress: () => void archiveOriginal(), busy: archiving } : null;
  const restoreAction: Action | null = agent.archivedAt ? { key: "restore", label: restoring.restoring ? t("coreAgentDetail.restoring") : t("coreAgentDetail.restoreSession"), icon: "History", onPress: () => void restoreOriginal(), busy: restoring.restoring } : null;
  const replyAction: Action | null = !agent.archivedAt && agent.status === "idle"
    ? { key: "reply", label: t("coreAgentDetail.typeAnswer"), icon: "MessageSquareText", onPress: () => setReplying(true) } : null;
  const answeredAction: Action | null = !agent.archivedAt && agent.status === "idle" && agent.replyAskedAt && !agent.replyAnswered
    ? { key: "answered", label: t("coreAgentDetail.markAnswered"), icon: "CircleCheck", onPress: () => void markAnswered(true), busy: answering } : null;
  const snoozeAction: Action | null = (ackKind === "result" || ackKind === "question") && snooze ? { key: "snooze", label: t("coreAgentDetail.snooze"), icon: "Clock3", onPress: snooze } : null;
  const ordered = (agent.archivedAt ? [restoreAction, open] : [open, replyAction, read, compact ? null : answeredAction, compact ? null : snoozeAction, archive]).filter((item): item is Action => !!item);
  const variantOf = (action: Action, index: number): ButtonVariant => index === 0 ? "primary" : action.key === "read" || action.key === "next" || (agent.archivedAt && action.key === "open") ? "secondary" : "ghost";
  const menu: MenuAction[] = [
    ...(unread && onReadNext ? [{ key: "read-only", label: t("coreAgentDetail.markRead"), icon: "Check", hint: t("coreAgentDetail.stayOnThisResult"), disabled: reading || result.isPending, onPress: () => void acknowledge(false) }] : []),
    ...(compact && replyAction && read ? [{ key: "read", label: read.label, icon: read.icon, disabled: read.disabled || read.busy, onPress: read.onPress }] : []),
    ...(compact && answeredAction ? [{ key: "answered", label: answeredAction.label, icon: answeredAction.icon, hint: t("coreAgentDetail.markAnsweredHint"), disabled: answering, onPress: answeredAction.onPress }] : []),
    ...(!agent.archivedAt && agent.replyAnswered ? [{ key: "awaiting", label: t("coreAgentDetail.markAwaitingReply"), icon: "MessageCircleQuestion", hint: t("coreAgentDetail.markAwaitingReplyHint"), disabled: answering, onPress: () => void markAnswered(false) }] : []),
    ...(compact && snoozeAction ? [{ key: "snooze", label: t("coreAgentDetail.snooze"), icon: "Clock3", hint: t("coreAgentDetail.remindIn1HourOrImmediatelyWhen"), onPress: snoozeAction.onPress }] : []),
    // refetch() forces a read even while the query waits, which would load an archived schedule session.
    ...(tab === "result" && !waitForTap ? [{ key: "refresh", label: t("coreAgentDetail.refreshResult"), icon: "RefreshCw", onPress: () => void result.refetch() }] : []),
    ...(viewParent ? [{ key: "parent", label: t("coreAgentDetail.viewParentAgent"), icon: "CornerLeftUp", ...(parentServer ? { hint: t("coreAgentDetail.parentOnHost", { host: parentHost ?? t("coreAgentDetail.anotherHost") }) } : {}), onPress: viewParent }] : []),
    { key: "copy-id", label: t("coreAgentDetail.copyAgentId"), icon: "Copy", onPress: () => { void copyText(agent.id).then(() => toast.show(t("coreAgentDetail.agentIdCopied"))).catch(() => toast.error(t("coreAgentDetail.couldNotCopy"))); } },
    ...extraActions,
  ];
  const header = <View style={{ gap: space.sm, paddingTop: compact ? space.lg : 0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 26 }}>
      <PhaseLine theme={theme} agent={displayedAgent} />
      {!compact && onClose ? <><Spacer /><IconButton theme={theme} icon="X" label={t("coreAgentDetail.closeDetails")} size="sm" onPress={onClose} /></> : null}
    </View>
    <Text selectable numberOfLines={compact ? undefined : 3} style={{ color: colors.foreground, fontSize: fontSize.heading, fontWeight: "600", lineHeight: 26 }}>{agent.title}</Text>
    <IdentityLine theme={theme} agent={agent} compact={compact} />
    <LiveMeta theme={theme} agent={agent} totalRunMs={observed?.totalRunMs} tools={result.data?.metrics.tools} />
    {recap ? <RecapCard theme={theme} look={recap} /> : null}
    {/* 提示缓存倒计时 (2.17): how long this session's prompt cache stays warm, when its own log tells. */}
    {!agent.archivedAt ? <View style={{ flexDirection: "row" }}><CacheChip theme={theme} agentId={agent.id} /></View> : null}
    {agent.background && agent.status === "running" && !agent.activeTurnStartedAt ? <Banner theme={theme} tone="info" icon="Workflow"
      message={t("coreAgentDetail.thisTurnHasEndedSubtasksAreStill", { value1: agent.background.running, value2: agent.background.labels.length ? t("coreAgentDetail.message", { value1: joinList(agent.background.labels) }) : "" })}
      action={{ label: t("coreAgentDetail.viewSubtasks"), onPress: () => setTab("children") }} /> : null}
    {restoring.restoring ? <Banner theme={theme} tone="info" icon="History" message={restoring.progress ?? t("coreAgentDetail.restoringSession")} /> : null}
    {!compact && ordered.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space.sm, paddingTop: space.xs }}>
      {ordered.map((action, index) => <Button key={action.key} theme={theme} label={action.label} icon={action.icon} variant={variantOf(action, index)} busy={action.busy} disabled={action.disabled} onPress={action.onPress} />)}
      <IconButton theme={theme} icon="Ellipsis" label={t("coreAgentDetail.moreActions")} onPress={() => setMenuOpen(true)} />
      {queue ? <MetaLine theme={theme} parts={[t("coreAgentDetail.unread", { value1: queue.index, value2: queue.total })]} /> : null}
    </View> : null}
    {!compact && !ordered.length ? <View style={{ alignItems: "flex-start" }}><IconButton theme={theme} icon="Ellipsis" label={t("coreAgentDetail.moreActions")} onPress={() => setMenuOpen(true)} /></View> : null}
  </View>;
  // Six sections: phones drop the icons and let the row scroll sideways instead of clipping the last tab.
  const tabBar = compact ? <ScrollView horizontal showsHorizontalScrollIndicator={false}><Tabs theme={theme} value={tab} onChange={setTab} options={tabs.map(({ icon: _icon, ...option }) => option)} /></ScrollView>
    : <Tabs theme={theme} value={tab} onChange={setTab} options={tabs} />;
  const scrolled = compact ? <View style={{ gap: space.md }}>{header}{tabBar}</View> : undefined;
  const scheduleCard = scheduleRunId && scheduleId ? <ScheduleRunCard theme={theme} runId={scheduleRunId} scheduleId={scheduleId} running={agent.status === "running"}
    onOpenAll={onOpenSchedules ? () => onOpenSchedules({ scheduleId, runId: scheduleRunId }) : undefined} /> : null;
  // Why the turn stopped (limit / empty / unfinished) and the heartbeats that will wake the Agent, above its reply.
  // 交给另一个 Provider opens the new Agent: in the app when possible, else here.
  const openHandedOver = (id: string) => {
    if (!navigation) { onSelectAgent(id); return; }
    try { Promise.resolve(navigation.openAgent({ agentId: id })).catch(error => toast.error(t("coreAgentDetail.couldNotOpenNewAgent", { value1: error instanceof Error ? error.message : t("coreAgentDetail.tryAgainLater") }))); } catch (error) { toast.error(t("coreAgentDetail.couldNotOpenNewAgent", { value1: error instanceof Error ? error.message : t("coreAgentDetail.tryAgainLater") })); }
  };
  const stopCard = agent.stop ? <StopCard theme={theme} agent={agent} heartbeats={heartbeats} hostId={hostId} onOpenConversation={navigation ? openConversation : undefined} onHandedOver={openHandedOver}
    onScheduled={() => { void queryCache.invalidateQueries({ queryKey: heartbeatsQueryKey(hostId) }); }} /> : null;
  const heartbeatCard = heartbeats?.length ? <HeartbeatCard theme={theme} heartbeats={heartbeats} onOpenAll={onOpenSchedules ? scheduleId => onOpenSchedules({ scheduleId }) : undefined} /> : null;
  // 定时消息 to this Agent (2.17): each with 立即发送 and 取消, gone once it went out.
  const scheduledCard = !agent.archivedAt && deferredQueue.all.some(isScheduledView) ? <View testID="detail-scheduled" style={{ gap: space.xs + 2 }}>
    <PaneLabel theme={theme} icon="AlarmClock" tone="sky">{t("alertsSchedule.detailTitle")}</PaneLabel>
    <DeferredList theme={theme} queue={deferredQueue} only={isScheduledView} />
  </View> : null;
  // 原地打转 / 可能卡住 of the running turn (2.18) leads: it is what needs a look right now.
  const issueCard = agent.issue && agent.status === "running" ? <IssueCard theme={theme} agent={agent} hostId={hostId} onOpenConversation={navigation ? openConversation : undefined} /> : null;
  const lead = issueCard || scheduleCard || stopCard || heartbeatCard || scheduledCard ? <View style={{ gap: space.md }}>{issueCard}{stopCard}{scheduledCard}{scheduleCard}{heartbeatCard}</View> : null;
  // A schedule Agent whose session cannot be read (an ACP session cannot be resumed, the log is gone) still has the reply its run recorded.
  const recordedFallback = !!scheduleRunId && !recordedFirst && !!result.error && !result.data;
  const body = tab === "result" ? waitForTap ? <RecordedRunResult theme={theme} runId={scheduleRunId!} header={scrolled} lead={lead} inset={inset} onLoadFull={() => setFullResult(true)} />
    : recordedFallback ? <RecordedRunResult theme={theme} runId={scheduleRunId!} header={scrolled} lead={lead} inset={inset} loadLabel={t("coreAgentDetail.retryLoadingSession")} loadHint={null} loading={result.isFetching}
      notice={t("coreAgentDetail.couldNotLoadSessionTheReplyRecorded", { value1: describeRunError(result.error?.message)?.summary ?? t("coreAgentDetail.tryAgainLater") })} onLoadFull={() => void result.refetch()} />
    : <ResultView theme={theme} agent={agent} onTypeReply={() => setReplying(true)} data={result.data} loading={result.isPending} error={result.error ? knownRunError(result.error.message) ?? result.error.message : undefined} header={scrolled} lead={lead} inset={inset} pending={pending} permissions={permissions} suggestion={recap?.state === "fresh" ? recap.reply : null} onResolvePermissions={navigation ? openConversation : undefined} onPermissionsChanged={() => void pendingDetails.refetch()} compact={compact} onOpenEvidence={openEvidence} onRefresh={() => void result.refetch()} />
    : tab === "digest" ? <AgentDigest theme={theme} compact={compact} digest={digest.data} loading={digest.isPending} error={digest.error?.message} onRefresh={() => void digest.refetch()}
      onOpenSeq={(epoch, seq) => openEvidence(`${agent.id}:${epoch}:${seq}-${seq}`)} header={scrolled} inset={inset} />
    : tab === "timeline" ? <TimelineContent timeline={timeline} theme={theme} cacheKey={agent.id} focusRef={focusRef} header={scrolled} inset={inset} />
    : tab === "children" ? agents ? <SubtasksView agent={agent} agents={agents} theme={theme} inset={inset} onSelectAgent={onSelectAgent} onViewParent={viewParent} header={scrolled} />
      : <DirectorySubtasks agent={agent} theme={theme} inset={inset} onSelectAgent={onSelectAgent} onViewParent={viewParent} header={scrolled} />
    : <ScrollView contentOffset={{ x: 0, y: memory.scroll }} onScroll={event => { memory.scroll = event.nativeEvent.contentOffset.y; }} scrollEventThrottle={100} contentContainerStyle={{ paddingHorizontal: inset, paddingBottom: space.xxl, gap: space.lg }}>
      {scrolled}
      <View style={{ paddingTop: compact ? 0 : space.lg }}>
        {tab === "insights" ? <InsightsPanel agent={agent} theme={theme} compact={compact} navigation={navigation} onOpenEvidence={({ ref }) => openEvidence(ref)} />
          : <Diagnostics theme={theme} agent={agent} parentHost={parentServer ? parentHost ? `${parentHost} · ${parentServer}` : parentServer : null} compact={compact} observed={observed} activity={activity} evidence={evidence.data} evidenceLoading={evidence.isPending} evidenceError={!!evidence.error} />}
      </View>
    </ScrollView>;
  const actionMenu = <ActionMenu theme={theme} title={t("coreAgentDetail.moreActions")} open={menuOpen} onClose={() => setMenuOpen(false)} actions={menu} />;
  // A running turn sweeps a thin bar across the top of the pane, unless display settings turn it off (its 2px stay either way).
  const blue = hueColor(theme, "run"), runningBar = display.status === "ready" ? display.values.runningBar : DISPLAY_DEFAULTS.runningBar;
  const sweep = runningBar && agent.status === "running" && !agent.archivedAt ? <Sweep color={blue} track={tint(blue, 0.14)} /> : <View style={{ height: 2 }} />;
  // 回复 (输入回复 and 输入或口述回复) on both layouts; keyed, so an unsent answer survives a switch between them.
  const replySheet = <SendToAgentSheet key="reply-sheet" theme={theme} open={replying} onClose={() => setReplying(false)} agentId={agent.id} agentTitle={agent.title || t("coreAgentDetail.thisAgent")} finding={null} reply
    onSent={() => { void queryCache.invalidateQueries({ queryKey: telemetryQueryKey(hostId) }); invalidateAttention(hostId); }} />;
  if (!compact) return <View testID="agent-detail" style={{ flex: 1, minHeight: 0 }}>
    {sweep}
    <View style={{ paddingHorizontal: inset, paddingTop: space.lg - 2, gap: space.md }}>{header}{tabBar}</View>
    {body}
    {actionMenu}
    {replySheet}
  </View>;
  // Awaiting a reply on a phone: answer in Paseo, or type / dictate it here (Mark read moves to the menu).
  const bottom = (agent.archivedAt ? [open, restoreAction] : replyAction ? [open, replyAction] : read ? [read, open] : readState === "read" ? [archive, open] : [open]).filter((item): item is Action => !!item);
  return <View testID="agent-detail" style={{ flex: 1, minHeight: 0 }}>
    <Toolbar theme={theme}>
      {onClose ? <IconButton theme={theme} icon="ChevronLeft" label={t("coreAgentDetail.backToList")} onPress={onClose} /> : null}
      <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.body, fontWeight: "500" }}>{queue ? t("coreAgentDetail.unread", { value1: queue.index, value2: queue.total }) : t("coreAgentDetail.sessionDetails")}</Text>
      <IconButton theme={theme} icon="Ellipsis" label={t("coreAgentDetail.moreActions")} onPress={() => setMenuOpen(true)} />
    </Toolbar>
    {agent.status === "running" && !agent.archivedAt ? sweep : null}
    {body}
    {bottom.length ? <BottomBar theme={theme}>{bottom.map((action, index) => {
      const primary = index === bottom.length - 1;
      return <Button key={action.key} theme={theme} label={action.label} icon={primary ? undefined : action.key === "archive" ? action.icon : undefined} variant={primary ? "primary" : action.key === "archive" ? "ghost" : "secondary"} grow={action.key !== "archive"} busy={action.busy} disabled={action.disabled} onPress={action.onPress} />;
    })}</BottomBar> : null}
    {actionMenu}
    {replySheet}
  </View>;
}

/** The panel's 子任务: the Agent directory is read only while this tab is open, and shared with the page when that is open too. */
function DirectorySubtasks(props: Omit<Parameters<typeof SubtasksView>[0], "agents">) {
  const data = useObservatory({ includeArchived: !!props.agent.archivedAt });
  return <SubtasksView {...props} agents={data.agents} />;
}

/** Provider, usage and totals. A running turn's elapsed time ticks in the phase line instead. */
function LiveMeta({ theme, agent, totalRunMs, tools }: { theme: PluginTheme; agent: AgentRecord; totalRunMs?: number; tools?: number }) {
  const now = useClock(60_000);
  const runtime = !agent.activeTurnStartedAt && totalRunMs ? t("coreAgentDetail.totalRuntime", { value1: formatDuration(totalRunMs) }) : null;
  return <MetaLine theme={theme} numberOfLines={2} parts={[providerLine(agent), runtime, agent.usage.totalTokens !== null ? t("coreAgentDetail.tokenCount", { tokens: compactNumber(agent.usage.totalTokens) }) : null, tools ? t("coreAgentDetail.toolCalls", { count: tools }) : null, agent.archivedAt ? t("coreAgentDetail.archived2", { value1: relativeTime(agent.archivedAt, now) }) : null]} />;
}

const sectionLooks: Record<string, { label: string; icon: string; tone: "blue" | "violet" | "orange" | "teal" }> = {
  context: { get label() { return t("coreAgentDetail.executionContext"); }, icon: "FolderGit2", tone: "blue" }, history: { get label() { return t("coreAgentDetail.sessionHistory"); }, icon: "History", tone: "violet" }, usage: { get label() { return t("coreAgentDetail.usage"); }, icon: "Gauge", tone: "orange" }, observation: { get label() { return t("coreAgentDetail.pluginObservations"); }, icon: "Eye", tone: "teal" }, lifecycle: { get label() { return t("coreAgentDetail.lifecycleEvents"); }, icon: "Activity", tone: "orange" },
};
function Diagnostics({ theme, agent, parentHost, compact, observed, activity, evidence, evidenceLoading, evidenceError }: {
  theme: PluginTheme; agent: AgentRecord;
  /** The parent's host when it is another one (Paseo 0.13 connected hosts): its name and server id. */
  parentHost: string | null; compact: boolean; observed?: TelemetrySnapshot["agents"][number]; activity: TelemetrySnapshot["events"];
  evidence?: { turns: number; tools: number; toolFailures: number; complete: boolean; coverageReason: string | null }; evidenceLoading: boolean; evidenceError: boolean;
}) {
  const now = useClock(30_000);
  const usage = agent.usage;
  const section = (id: string, children: ReactNode, info?: readonly string[]) => { const title = sectionLooks[id]!.label; return <View style={{ gap: space.xs }}>
    <PaneLabel theme={theme} icon={sectionLooks[id]?.icon} tone={sectionLooks[id]?.tone} trailing={info ? <InfoButton theme={theme} title={t("coreAgentDetail.about", { value1: title })} lines={info} /> : undefined}>{title}</PaneLabel>
    {children}
  </View>; };
  return <View style={{ gap: space.xl }}>
    {agent.lastError ? <Banner theme={theme} tone="danger" message={agent.lastError} /> : null}
    {section("context", <View>
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.project")} value={agent.projectName} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.projectRoot")} value={agent.projectRootPath || t("coreAgentDetail.notReported")} mono />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.workspace")} value={agent.workspaceName || agent.workspaceId || t("coreAgentDetail.noWorkspaceAssigned")} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.checkoutType")} value={agent.checkoutKind === "worktree" ? t("coreAgentDetail.separateWorktree") : checkoutName(agent)} />
      {agent.checkoutKind === "worktree" ? <><KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.worktreeName")} value={agent.worktreeName || t("coreAgentDetail.notReported")} /><KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.worktreePath")} value={agent.worktreePath || t("coreAgentDetail.notReported")} mono /></> : null}
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.branch")} value={agent.branch || t("coreAgentDetail.notReportedDetachedHead")} mono={!!agent.branch} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.agentWorkingDirectory")} value={agent.cwd || t("coreAgentDetail.notReported")} mono />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.agentId")} value={agent.id} mono />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.rawRuntimeStatus")} value={agent.rawStatus} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.created")} value={localTime(agent.createdAt)} />
      <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.lastActive")} value={localTime(agent.lastActivityAt)} />
      {agent.parentAgentId ? <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.parentAgent")} value={agent.parentAgentId} mono /> : null}
      {parentHost ? <KeyValue theme={theme} compact={compact} label={t("coreAgentDetail.parentHost")} value={parentHost} /> : null}
    </View>)}
    {section("history", evidenceLoading ? <Skeleton theme={theme} rows={1} /> : evidenceError ? <MetaLine theme={theme} parts={[t("coreAgentDetail.historyEvidenceIsTemporarilyUnavailableSwitchingTabs")]} /> : evidence ? <View style={{ gap: space.sm }}>
      <StatRow theme={theme} stats={[{ label: t("coreAgentDetail.userTurns"), value: String(evidence.turns) }, { label: t("coreAgentDetail.toolRuns"), value: String(evidence.tools) }, { label: t("coreAgentDetail.toolFailures"), value: String(evidence.toolFailures), tone: evidence.toolFailures ? "danger" : undefined }]} />
      <MetaLine theme={theme} numberOfLines={2} parts={[evidence.complete ? t("coreAgentDetail.coversTheFullHistoryKeptByPaseo") : evidence.coverageReason || t("coreAgentDetail.coversOnlyPartOfTheHistory")]} />
    </View> : null)}
    {section("usage", <View style={{ gap: space.sm }}>
      <StatRow theme={theme} stats={[{ label: t("coreAgentDetail.inputTokens"), value: formatTokens(usage.inputTokens) }, { label: t("coreAgentDetail.outputTokens"), value: formatTokens(usage.outputTokens) }, { label: t("coreAgentDetail.cacheHits"), value: formatTokens(usage.cachedInputTokens) }, { label: t("coreAgentDetail.apiEquivalentCost"), value: usage.costUsd === null ? "—" : `$${usage.costUsd.toFixed(4)}` }]} />
      {usage.contextTotal !== null ? <MetaLine theme={theme} parts={[t("coreAgentDetail.context", { value1: formatTokens(usage.contextUsed), value2: formatTokens(usage.contextTotal) })]} /> : null}
    </View>, [t("coreAgentDetail.showsOnlyTheProviderSLatestReported"), t("coreAgentDetail.unreportedMetricsShowAsNot0"), t("coreAgentDetail.apiEquivalentCostIsTheAgentS")])}
    {section("observation", <StatRow theme={theme} stats={[{ label: t("coreAgentDetail.completedTurns"), value: observed ? String(observed.completedTurns) : "—" }, { label: t("coreAgentDetail.failedTurns"), value: observed ? String(observed.failedTurns) : "—", tone: observed?.failedTurns ? "danger" : undefined }, { label: t("coreAgentDetail.totalRuntime2"), value: observed ? formatDuration(observed.totalRunMs) || t("coreAgentDetail.value0Seconds") : "—" }, { label: t("coreAgentDetail.waitingForApproval"), value: observed ? formatDuration(observed.permissionWaitMs) || t("coreAgentDetail.value0Seconds") : "—" }]} />,
      [t("coreAgentDetail.countsFromWhenThePluginBeganObserving")])}
    {activity.length ? section("lifecycle", <View>{activity.map(event => <View key={event.id} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 32 }}>
      <EventGlyph theme={theme} type={event.type} size={14} />
      <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small }}>{eventLabel(event)}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{relativeTime(event.at, now)}</Text>
    </View>)}</View>) : null}
    {Object.keys(agent.labels).length ? <CodeBlock theme={theme} label={t("coreAgentDetail.agentLabels")} value={agent.labels} /> : null}
  </View>;
}
