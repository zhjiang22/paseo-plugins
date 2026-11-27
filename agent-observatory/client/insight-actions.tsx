import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { usePaseo, useRpc } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { listProfiles } from "../shared/profiles";
import { useQuery } from "@tanstack/react-query";
import type { InsightReport } from "../shared/insights";
import type { SuggestionAction } from "../shared/insight-overview";
import type { AgentRecord } from "../shared/model";
import { Badge, Banner, Button, MetaLine, Sheet, Skeleton, TextField, fontSize, hue, radius, space, withAlpha } from "./kit";
import { PaneLabel } from "./ui";
import { insightsQueryPrefix } from "./use-insight-overview";
import { BUILTIN_SEND, capabilitiesFromReply, getSteerableProviders, type SendCapabilities } from "../shared/steer";
import { defaultModelOf, providerModelId } from "../shared/provider-model";
import { checkSend, ledgerInput, outgoingMessage, sendChecked, type LedgerAnswer, type OutgoingMessage, type SendCheck, type SendConfirmation } from "./send-check";
import { isSlashCommand, type Consent, type SendPlan } from "./send-plan";
import { onItsWay, type DeferredView } from "../shared/deferred-rpc";
import { DeferredList, useDeferredQueue } from "./deferred";
import { SOURCES, ledgerNotice, messageKey, onItsWayLabel, rememberUnanswered, requestId, settleRequest, unansweredId, isReplyMessage } from "./deferred-state";
import { SchedulePicker, scheduleWhen } from "./schedule-send";

/**
 * How running turns take a message on this host: the providers that steer (the built-ins plus custom ids extending them),
 * those that also take a steered slash command (Claude-based) and the built-in each custom id extends (how it runs a
 * command, codex-obs-send-ui-F3); cached for minutes.
 */
export function useSteerableProviders(enabled: boolean) {
  const read = useRpc(getSteerableProviders);
  return useQuery({ queryKey: [...insightsQueryPrefix, "send-capabilities"], enabled, staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry: 1,
    queryFn: async (): Promise<SendCapabilities> => capabilitiesFromReply(await read({})) });
}

type Finding = InsightReport["findings"][number];
const severityNames: Record<Finding["severity"], string> = { get high() { return t("coreInsightActions.highPriority"); }, get medium() { return t("coreInsightActions.mediumPriority"); }, get low() { return t("coreInsightActions.lowPriority"); } };

/** The follow-up an analysed Agent receives for one finding; the user edits it before sending. */
export function findingMessage(finding: Finding): string {
  return [t("coreInsightActions.observatoryAnalysisFoundAnIssueInYour"), "", t("coreInsightActions.message", { value1: finding.title, value2: severityNames[finding.severity] }), finding.detail, "",
    t("coreInsightActions.recommendation", { value1: finding.recommendation }), "", t("coreInsightActions.ifYouDecideThisIsNotAn")].join("\n");
}
/** A task prompt for a suggestion without one. */
export function actionPrompt(action: SuggestionAction): string {
  return action.task ?? [action.title, "", action.why, ...(action.steps.length ? ["", t("coreInsightActions.steps"), ...action.steps.map((step, index) => `${index + 1}. ${step}`)] : []),
    ...(action.instruction ? ["", t("coreInsightActions.rulesToAddToTheInstructions"), action.instruction] : [])].join("\n");
}

/** A message that certainly never went out: the text is free to be sent again, under a new id. */
const NEVER_SENT: ReadonlySet<DeferredView["state"]> = new Set(["canceled", "discarded", "expired"]);
/** The ledger's rows for findings sent to an Agent, here and beside the analysis. */
export const isFindingMessage = (view: DeferredView) => view.source.startsWith(SOURCES.finding);

/** How a finding's message is named in the ledger's list: its row shows beside that finding's 发给这个 Agent. */
// i18n-ignore: persisted ledger source format matches existing messages across language changes.
export const findingSource = (finding: Pick<Finding, "title">) => `${SOURCES.finding}「${finding.title}」`.slice(0, 200);
type Problem = { tone: "danger" | "warning"; message: string; retry: boolean };

/**
 * 发给这个 Agent: send a finding as a follow-up message to the analysed Agent (explicit, editable), through the plugin server's
 * ledger (`observatory.deferred.send`). A running turn is steered where the provider supports it; otherwise, and while a
 * request waits, the user confirms first that it interrupts (opus-F10), with 「等这一轮结束再发」 / 「等审批处理完再发」 beside it.
 * The confirmation is bound to the turn and the exact pending requests (codex-F4, r3-F1): the server sends only while it
 * still covers what sending would do, and asks again otherwise. One message keeps one id across its tries, also after an
 * answer was lost; the same text on its way (here, on another screen or device) locks the send, and its row has 仍然发送 /
 * 取消排队.
 */
export function SendToAgentSheet({ theme, open, onClose, agentId, agentTitle, finding, reply = false, onSent }: { theme: PluginTheme; open: boolean; onClose: () => void; agentId: string; agentTitle: string;
  finding: Finding | null;
  /**
   * 回复: the user's own answer to an Agent awaiting a reply instead of a finding. The sheet opens empty and focused,
   * says how to dictate into it (the system's dictation: any text field takes it), and lists only these replies.
   */
  reply?: boolean; onSent?: () => void }) {
  const paseo = usePaseo(), toast = useToast(), { colors } = theme;
  // Without the host's lists only the built-in steering providers steer; a custom one is asked about first.
  const query = useSteerableProviders(open), capabilities = query.data ?? (query.isError ? BUILTIN_SEND : undefined);
  const deferred = useDeferredQueue(agentId, open);
  // The list as last drawn, for a tap on buttons drawn before it (the four plugins' r5-F1).
  const listed = useRef(deferred.all);
  listed.current = deferred.all;
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [problem, setProblem] = useState<Problem | null>(null);
  // The plan for the Agent's state when the sheet opened, for its note; the server plans again when it sends.
  const [check, setCheck] = useState<SendCheck | null>(null), [confirming, setConfirming] = useState<SendConfirmation | null>(null);
  // 定时发 (2.17): the time picker is open.
  const [scheduling, setScheduling] = useState(false);
  // The message being sent: every try of this text goes out with its id; another text is another message.
  const source = reply ? SOURCES.reply : SOURCES.finding;
  const message = useRef<OutgoingMessage | null>(null), slash = isSlashCommand(text), body = text.trim(), key = messageKey(source, body);
  // A finding's message is written afresh each time the sheet opens. A reply keeps what was typed or dictated while the sheet
  // closes and opens again for this Agent; it is cleared once it went out or was queued (`finished`), and for another Agent.
  useEffect(() => { if (open && (finding || reply)) { if (finding && !reply) setText(findingMessage(finding)); setProblem(null); setConfirming(null); setScheduling(false); message.current = null; } }, [open, finding?.id, reply]);
  useEffect(() => { if (reply) setText(""); }, [agentId]);
  useEffect(() => {
    if (!open || !capabilities) return;
    let live = true;
    void checkSend(paseo, { agentId, text: text.trim(), what: t("coreInsightActions.message2") }, capabilities).then(next => { if (live) setCheck(next); }).catch(() => { if (live) setCheck(null); });
    return () => { live = false; };
    // A slash command plans differently; any other edit does not change the plan.
  }, [open, agentId, capabilities, slash]);
  // This text on its way, or this sheet's message already out: what the ledger shows decides, not this sheet.
  const onWay = onItsWay(deferred.all, agentId, key);
  const own = message.current?.text === body ? deferred.all.find(view => view.messageId === message.current!.messageId) ?? null : null;
  const delivered = own?.state === "sent" || own?.state === "maybe-sent" ? own : null;
  // Settled or on its way, the confirmation shown before goes first; a lost try the list now shows is done with after it.
  useEffect(() => {
    if (!own || NEVER_SENT.has(own.state)) return;
    setConfirming(null);
    if (own.state !== "sent" && own.state !== "maybe-sent") return;
    setProblem(null);
    if (unansweredId(agentId, own.key) === own.messageId) settleRequest(agentId, own.key);
  }, [own?.messageId, own?.state, agentId]);
  const current = (): OutgoingMessage => {
    const kept = message.current, record = kept && listed.current.find(view => view.messageId === kept.messageId);
    if (!kept || kept.text !== body || record && NEVER_SENT.has(record.state))
      message.current = outgoingMessage(agentId, body, { what: t("coreInsightActions.message2"), key, source: reply ? SOURCES.reply : findingSource({ title: finding?.title ?? body.split("\n")[0]! }), messageId: requestId(agentId, key, listed.current) });
    return message.current!;
  };
  /** Whether the list drawn last shows this text on its way, or this sheet's message settled: then nothing is sent again. */
  const taken = (next: OutgoingMessage) => {
    const way = onItsWay(listed.current, agentId, next.key), mine = listed.current.find(view => view.messageId === next.messageId);
    return !!way || mine?.state === "sent" || mine?.state === "maybe-sent";
  };
  const lost = (next: OutgoingMessage, reason: unknown) => {
    if (next.tried) rememberUnanswered(agentId, next.key, next.messageId);
    const words = (reason instanceof Error ? reason.message : String(reason)).replace(/[。.]$/, "");
    setProblem({ tone: "danger", retry: true, message: next.tried ? t("coreInsightActions.noSendResultReceivedIfTheMessage", { value1: words }) : words });
  };
  /** The message went out or is on its way (queued, scheduled): the sheet closes, and a reply starts empty next time. */
  const finished = () => { if (reply) setText(""); onClose(); };
  /**
   * The ledger's answer for this message, sent now or queued, by its state (codex-obs-send-ui-R2): sent, or queued to go out
   * when the turn ends, closes the sheet; sending says so and stays; held waits for the user (its row below has the reason,
   * 仍然发送 and 取消); maybe-sent is not a success (the banner below asks to look first); canceled, expired and discarded say
   * how it ended. Another copy of this text on its way answers for it.
   */
  const answeredWith = (next: OutgoingMessage, view: DeferredView, sentWords: string) => {
    if (view.messageId !== next.messageId) {
      // Sent a moment ago or on its way: its row below says so.
      toast.show(view.state === "sent" ? t("coreInsightActions.thisMessageWasJustSent") : t("coreInsightActions.thisMessageSeeBelow", { value1: onItsWayLabel(view) }), { variant: view.state === "maybe-sent" ? "warning" : "success" });
      if (view.state === "sent") finished();
      return;
    }
    const notice = ledgerNotice(view, agentTitle);
    if (notice.kind === "sent" || view.state === "queued") {
      toast.show(notice.kind === "sent" ? sentWords : notice.text, { variant: "success" });
      if (notice.kind === "sent") onSent?.();
      finished(); return;
    }
    if (notice.kind === "waiting" || notice.kind === "attention" || notice.kind === "uncertain") toast.show(notice.text, { variant: notice.tone === "danger" ? "error" : notice.tone });
    else setProblem({ tone: notice.tone === "danger" ? "danger" : "warning", message: notice.text, retry: false });
  };
  const answered = (next: OutgoingMessage, answer: LedgerAnswer, plan: SendPlan) => {
    if ("message" in answer) { setProblem({ tone: answer.status === "busy" ? "warning" : "danger", message: answer.message, retry: answer.status === "busy" }); return; }
    answeredWith(next, answer.view, plan.kind === "steer" ? t("coreInsightActions.joinedSCurrentTurn", { value1: agentTitle }) : t("coreInsightActions.sentTo", { value1: agentTitle }));
  };
  const send = async (consent: Consent | null = null) => {
    if (!capabilities || !body || busy) return;
    const next = current();
    if (taken(next)) { setConfirming(null); return; }
    setBusy(true); setProblem(null);
    try {
      const result = await sendChecked(paseo, next, capabilities, deferred.send, consent);
      if ("confirm" in result) { setCheck(result.confirm.check); setConfirming(result.confirm); return; }
      settleRequest(agentId, next.key);
      setConfirming(null);
      answered(next, result.answered, result.plan);
    } catch (reason) {
      setConfirming(null);
      lost(next, reason);
    } finally { setBusy(false); }
  };
  // 「等这一轮结束再发」: queued under the message's one id; the row beside the analysis follows it.
  const defer = async () => {
    if (!body || busy) return;
    const next = current();
    if (taken(next)) { setConfirming(null); return; }
    setBusy(true); setProblem(null);
    try {
      next.tried = true;
      const view = await deferred.enqueue(ledgerInput(next));
      settleRequest(agentId, next.key);
      setConfirming(null);
      answeredWith(next, view, t("coreInsightActions.sentTo", { value1: agentTitle }));
    } catch (reason) {
      setConfirming(null);
      lost(next, reason);
    } finally { setBusy(false); }
  };
  // 定时发: queued for a time under the message's one id; from then on it goes as 「等这一轮结束再发」 does.
  const schedule = async (at: number) => {
    if (!body || busy) return;
    const next = current();
    if (taken(next)) { setConfirming(null); setScheduling(false); return; }
    setBusy(true); setProblem(null);
    try {
      next.tried = true;
      const view = await deferred.enqueue({ ...ledgerInput(next), notBefore: at });
      settleRequest(agentId, next.key);
      setConfirming(null); setScheduling(false);
      if (view.messageId === next.messageId && view.state === "queued" && view.notBefore !== undefined) {
        toast.show(t("alertsSchedule.scheduledMessage", { title: agentTitle, when: scheduleWhen(view.notBefore) }), { variant: "success" });
        finished();
      } else answeredWith(next, view, t("coreInsightActions.sentTo", { value1: agentTitle }));
    } catch (reason) {
      setConfirming(null); setScheduling(false);
      lost(next, reason);
    } finally { setBusy(false); }
  };
  const plan = confirming?.check.plan ?? check?.plan, offer = confirming?.offer;
  const locked = !!onWay || !!delivered;
  return <Sheet title={reply ? t("coreInsightActions.replyToAgent", { title: agentTitle }) : t("coreInsightActions.sendToThisAgent")} open={open} onClose={onClose}>
    <MetaLine theme={theme} numberOfLines={2} parts={[t("coreInsightActions.willReceiveThisMessageInItsOriginal", { value1: agentTitle }), plan?.note]} />
    <TextField theme={theme} label={reply ? t("coreInsightActions.yourAnswer") : t("coreInsightActions.message2")} value={text} onChangeText={setText} multiline minHeight={reply ? 140 : 200} autoFocus={reply}
      {...(reply ? { placeholder: t("coreInsightActions.yourAnswerPlaceholder"), hint: t("coreInsightActions.dictationHint") } : {})} />
    {confirming?.check.plan.confirm ? <Banner theme={theme} tone="warning" message={confirming.check.plan.confirm} /> : null}
    {offer ? <Text style={{ color: colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 17 }}>{t("coreInsightActions.message3", { value1: offer.label, value2: offer.note })}</Text> : null}
    {problem ? <Banner theme={theme} tone={problem.tone} message={problem.message} /> : null}
    {delivered ? <Banner theme={theme} tone={delivered.state === "sent" ? "success" : "warning"} message={delivered.state === "sent" ? t("coreInsightActions.thisMessageHasBeenDeliveredEditingIts") : t("coreInsightActions.thisMessageMayAlreadyHaveArrivedOpen")} /> : null}
    <DeferredList theme={theme} queue={deferred} only={reply ? isReplyMessage : isFindingMessage} />
    {scheduling && !locked ? <SchedulePicker theme={theme} busy={busy} onClose={() => setScheduling(false)} onPick={at => void schedule(at)} /> : null}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "flex-end" }}>
      <Button theme={theme} tone="sky" variant={scheduling ? "secondary" : "ghost"} icon="AlarmClock" label={t("alertsSchedule.scheduleButton")} disabled={busy || !body || locked || plan?.kind === "unavailable"}
        testID="send-schedule" onPress={() => setScheduling(!scheduling)} />
      {confirming ? <>
        <Button theme={theme} label={t("coreInsightActions.cancel")} onPress={() => setConfirming(null)} />
        {offer ? <Button theme={theme} tone="info" icon="Clock3" label={offer.label} busy={busy} disabled={busy || locked} onPress={() => void defer()} /> : null}
        <Button theme={theme} variant="danger" icon="Send" label={confirming.check.plan.label} busy={busy} disabled={busy || !body || !capabilities || locked} onPress={() => void send(confirming.consent)} />
      </> : <>
        <Button theme={theme} label={t("coreInsightActions.cancel")} onPress={onClose} />
        <Button theme={theme} variant="primary" icon="Send" label={onWay ? onItsWayLabel(onWay) : problem?.retry ? t("coreInsightActions.retry") : plan?.kind === "steer" ? t("coreInsightActions.joinThisTurn") : t("coreInsightActions.send")} busy={busy}
          disabled={busy || !body || !capabilities || plan?.kind === "unavailable" || locked} onPress={() => void send()} />
      </>}
    </View>
  </Sheet>;
}

interface ProfileEntry { id: string; name: string; provider: string; model?: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown>; notes?: string }
/** One workspace per project for hand-offs: the main checkout when an Agent ran there, else the newest Agent's. */
export function projectWorkspaces(agents: readonly AgentRecord[]) {
  const byProject = new Map<string, AgentRecord>();
  const rank = (agent: AgentRecord) => agent.checkoutKind === "main" ? 2 : agent.checkoutKind === "directory" ? 1 : 0;
  for (const agent of agents) {
    if (!agent.workspaceId || agent.labels["observatory.role"] === "insight") continue;
    const current = byProject.get(agent.projectName);
    if (!current || rank(agent) > rank(current) || rank(agent) === rank(current) && (agent.lastActivityAt ?? "") > (current.lastActivityAt ?? "")) byProject.set(agent.projectName, agent);
  }
  return [...byProject.values()].sort((a, b) => a.projectName.localeCompare(b.projectName, currentLanguage()));
}

/**
 * 交给 Agent: start a new Agent in a project's workspace with a suggestion's task, using one of the host's profiles
 * exactly as configured (its mode included). Nothing runs until the user presses 开始.
 */
export function HandoffSheet({ theme, open, onClose, action, agents, onCreated }: { theme: PluginTheme; open: boolean; onClose: () => void; action: SuggestionAction | null;
  agents: readonly AgentRecord[]; onCreated: (agentId: string) => void }) {
  const paseo = usePaseo(), toast = useToast(), profileList = useRpc(listProfiles), { colors } = theme;
  const profiles = useQuery({ queryKey: [...insightsQueryPrefix, "profiles"], enabled: open, staleTime: 60_000, retry: 1,
    queryFn: async () => (await profileList({})).profiles as ProfileEntry[] });
  const workspaces = useMemo(() => projectWorkspaces(agents), [agents]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null), [profileId, setProfileId] = useState<string | null>(null);
  const [text, setText] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || !action) return;
    setText(actionPrompt(action)); setError(null);
    const target = workspaces.find(item => action.projects.includes(item.projectName)) ?? workspaces[0];
    setWorkspaceId(target?.workspaceId ?? null);
  }, [open, action?.id]);
  useEffect(() => {
    const list = profiles.data ?? [];
    if (!profileId && list.length) setProfileId((list.find(item => /实现|implement/i.test(`${item.name} ${item.id}`)) ?? list[0]!).id);
  }, [profiles.data]);
  const profile = profiles.data?.find(item => item.id === profileId);
  const workspace = workspaces.find(item => item.workspaceId === workspaceId);
  const start = async () => {
    if (!profile || !workspace?.workspaceId || !action) return;
    setBusy(true); setError(null);
    try {
      // The SDK takes "provider/model" and throws on a bare provider: a profile without a model runs the provider's default
      // one, and a provider that lists no models runs as "default" (gemini-F3).
      const model = profile.model || defaultModelOf((await paseo.providers.snapshot().catch(() => null))?.entries?.find(entry => entry.provider === profile.provider)?.models ?? undefined);
      const handle = await paseo.workspaces.ref(workspace.workspaceId).agents.create({
        config: { provider: providerModelId(profile.provider, model), ...(profile.modeId ? { modeId: profile.modeId } : {}),
          ...(profile.thinkingOptionId ? { thinkingOptionId: profile.thinkingOptionId } : {}), ...(profile.featureValues ? { featureValues: profile.featureValues } : {}) },
        prompt: text.trim(), title: action.title.slice(0, 60), labels: { "observatory.from-suggestion": action.id.slice(0, 80) } });
      toast.show(t("coreInsightActions.assignedToANewAgent", { value1: action.title }), { variant: "success" }); onCreated(handle.id); onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("coreInsightActions.couldNotCreate")); }
    finally { setBusy(false); }
  };
  const pill = (selected: boolean) => ({ flexDirection: "row" as const, alignItems: "center" as const, gap: space.sm, padding: space.sm, borderRadius: radius.md, borderWidth: selected ? 1.5 : 1,
    borderColor: selected ? hue(theme, "violet") : colors.border, backgroundColor: selected ? withAlpha(hue(theme, "violet"), 0.1) : "transparent" });
  return <Sheet title={t("coreInsightActions.assignToAgent")} open={open} onClose={onClose}>
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>{t("coreInsightActions.whichProject")}</PaneLabel>
      {workspaces.length ? workspaces.slice(0, 12).map(item => <Pressable key={item.workspaceId} accessibilityRole="radio" accessibilityLabel={t("coreInsightActions.project", { value1: item.projectName })} aria-checked={item.workspaceId === workspaceId}
        onPress={() => setWorkspaceId(item.workspaceId)} style={state => [pill(item.workspaceId === workspaceId), { opacity: state.pressed ? 0.8 : 1 }]}>
        <Icon name="FolderGit2" size={14} color={hue(theme, "violet")} />
        <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{item.projectName}</Text>
        <Text numberOfLines={1} style={{ maxWidth: 160, color: colors.foregroundMuted, fontSize: 11 }}>{item.branch ?? item.workspaceName ?? ""}</Text>
      </Pressable>) : <Banner theme={theme} tone="warning" message={t("coreInsightActions.noWorkspaceAvailableYetRunAnAgent")} />}
    </View>
    <View style={{ gap: space.sm }}>
      <PaneLabel theme={theme}>{t("coreInsightActions.whichProfile")}</PaneLabel>
      {profiles.isPending ? <Skeleton theme={theme} rows={2} /> : null}
      {profiles.error ? <Banner theme={theme} tone="danger" message={t("coreInsightActions.couldNotLoadProfiles", { value1: profiles.error.message })} /> : null}
      {profiles.data && !profiles.data.length ? <Banner theme={theme} tone="warning" message={t("coreInsightActions.noProfilesOnThisHostYetAdd")} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
        {(profiles.data ?? []).map(item => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={t("coreInsightActions.profileName", { name: item.name })} aria-checked={item.id === profileId} onPress={() => setProfileId(item.id)}
          style={state => [pill(item.id === profileId), { opacity: state.pressed ? 0.8 : 1 }]}>
          <Text style={{ color: colors.foreground, fontSize: fontSize.small, fontWeight: item.id === profileId ? "700" : "500" }}>{item.name}</Text>
        </Pressable>)}
      </View>
      {profile ? <MetaLine theme={theme} parts={[profile.provider, profile.model, profile.thinkingOptionId, profile.modeId ? t("coreInsightActions.mode", { value1: profile.modeId }) : null]} /> : null}
    </View>
    <TextField theme={theme} label={t("coreInsightActions.task")} value={text} onChangeText={setText} multiline minHeight={180} />
    {action?.projects.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.xs }}>{action.projects.map(name => <Badge key={name} theme={theme} label={name} tone="violet" />)}</View> : null}
    {error ? <Banner theme={theme} tone="danger" message={error} /> : null}
    <View style={{ flexDirection: "row", gap: space.sm, justifyContent: "flex-end" }}>
      <Button theme={theme} label={t("coreInsightActions.cancel")} onPress={onClose} />
      <Button theme={theme} variant="primary" icon="Rocket" label={t("coreInsightActions.start")} busy={busy} disabled={busy || !profile || !workspace || !text.trim()} onPress={() => void start()} />
    </View>
  </Sheet>;
}
