import { createLocaleService } from "./server/i18n-server";
import { BUILTIN_CATALOGS } from "./server/locales";
import { t } from "./shared/text";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createProcessBridge, registerProviderSubagents } from "./server/provider-subagents";
import { TelemetryStore } from "./server/telemetry";
import { getTelemetry } from "./shared/telemetry";
import { getAnalytics } from "./shared/analytics";
import { createAnalyticsEnrichment } from "./server/analytics-enrichment";
import { registerInsights } from "./server/insights";
import { isInsightAgent } from "./server/insight-runner-lifecycle";
import type { AgentTimelineItem, PaseoApi } from "./server/paseo-types";
import { registerHistory } from "./server/history";
import { registerResults } from "./server/results";
import { registerPreferences } from "./server/preferences";
import { registerReadState } from "./server/read-state";
import { StatsStore } from "./server/stats-store";
import { StatsDirectory } from "./server/stats-directory";
import { registerTokens } from "./server/tokens";
import { registerDigest } from "./server/digest";
import { getStats } from "./shared/stats";
import { finalReplyText, nudgeSentence, replyAsksUser, replyNudge } from "./shared/reply";
import { turnStop } from "./shared/stop-reason";
import { findChangeRequest } from "./shared/change-request";
import type { TimelineItem } from "./shared/timeline";
import { createReplyCheck } from "./server/reply-check";
import { registerSchedules } from "./server/schedules";
import { registerBackground } from "./server/background";
import { registerAttention } from "./server/attention";
import { registerResume } from "./server/resume";
import { getSteerableProviders, steerableReply } from "./shared/steer";
import { answeringGuard, createSendLedger, handingOver, registerSendLedger } from "./server/send-ledger";
import { readSendCapabilities } from "./server/steerable-providers";
import { resolvePaseoHome } from "./server/paseo-home";
import { createInterruptGrace } from "./server/interrupts";
import { registerQuota } from "./server/quota";
import { lifecycleHub, turnRead } from "./server/lifecycle-hub";
import { hookTimeline } from "./server/turn-timeline";
import { DeviceZone } from "./server/device-zone";
import { scheduleInsightSweeps } from "./server/grok-runner";
import { registerProfiles } from "./server/profiles";
import { registerClientChunks } from "./server/ui-chunk";
import { alertSettings, defaultAlertSettings, type AlertSettings } from "./shared/alerts";
import { bridgeLabelHost, registerSidebarLabels, SidebarLabels } from "./server/sidebar-labels";
import { registerCacheClock } from "./server/cache-clock";
import { providerBasesReader } from "./server/provider-bases";
import { registerRecaps } from "./server/recap";

/** How the host recorded the end of a closed Agent's last turn (its attention, kept after the close); null when it shows none. */
async function closedTurnEnd(paseo: PaseoApi, agentId: string): Promise<{ at: string; outcome: "completed" | "failed" } | null> {
  const agent = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent as { attentionReason?: unknown; attentionTimestamp?: unknown } | undefined;
  const at = typeof agent?.attentionTimestamp === "string" && Number.isFinite(Date.parse(agent.attentionTimestamp)) ? agent.attentionTimestamp : null;
  if (!at) return null;
  return agent?.attentionReason === "finished" ? { at, outcome: "completed" } : agent?.attentionReason === "error" ? { at, outcome: "failed" } : null;
}

export default function contribute(host: PluginServerContext) {
  const locales = createLocaleService(host, { pluginId: "agent-observatory", builtins: BUILTIN_CATALOGS });
  const telemetry = new TelemetryStore();
  // The ledger every message to an Agent goes through (server/send-ledger.ts); every RPC below hands it the daemon API. A quick
  // reply carries the turn it answers, checked against what the plugin observed right before it goes out (codex-obs-attn-R3).
  const deferred = createSendLedger({ guard: answeringGuard(telemetry) });
  // The daemon API from the latest call or hook: the ledger's deliveries (scheduled ones too) and the label sync run without one.
  let daemon: PaseoApi | null = null, onFirstDaemon = () => {};
  const handover = { use(paseo: PaseoApi | null | undefined) {
    deferred.use(paseo);
    if (!paseo) return;
    const first = !daemon;
    daemon = paseo;
    // The label sync waited for a handle since it was turned on (or since a reload): it runs now rather than at the next minute.
    if (first) onFirstDaemon();
  } };
  // One host handler per lifecycle event, shared by every module below: the host clones a hook's input once per handler (opus-F15).
  const hub = lifecycleHub(handingOver(host, handover));
  const server = hub.server;
  // 提醒 (2.17): the chime, the sidebar labels; one host setting of their own, read by the badge's summary and the label sync.
  let alerts: AlertSettings = defaultAlertSettings;
  const alertStore = server.registerSettings(alertSettings);
  // The UI chunk the resident client fetches on first use (shared/ui-chunk.ts): in parts, each reply under 128 KiB.
  registerClientChunks(server);
  // One bridge to the host session for every raw request (subagents, restore, clear attention, schedules).
  const bridge = createProcessBridge();
  const directory = new StatsDirectory();
  // The devices' time zone (clients report it with their reads): a limit notice without a zone, a background analysis's day
  // window and the token days are read in it, not in the daemon's (grok-F2).
  const zones = new DeviceZone();
  // Provider subagents that keep working after their parent's turn ended (后台执行中).
  const background = registerBackground(server, { directory, bridge });
  const stats = new StatsStore({ telemetry, agents: directory, background: background.tracker });
  const tokens = registerTokens(server, { directory, zones });
  // 额度: the host's provider usage windows (only `providers.listUsage()`), sampled every 10 minutes with history and forecasts.
  const removeQuota = registerQuota(server);
  const removeDigest = registerDigest(server, { tokens: tokens.source, telemetry });
  // 定时运行 shares the once-a-minute Agent walk with 看板 and Token; its ledger records runs in the background (opus-F11).
  const schedules = registerSchedules(server, { directory });
  const statsRemovers: Array<() => void> = [];
  let statsClosed = false;
  const analytics = createAnalyticsEnrichment(telemetry);
  registerProviderSubagents(server, bridge);
  registerProfiles(server);
  const removeInsights = registerInsights(server, { zone: () => zones.device() });
  // 每轮小结 and 建议回复, off unless the host setting `recap` turns them on: written from a top-level Agent's own turn-end hook
  // with the analysis runners. A recap names the turn it describes as the plugin saw it (the quick replies' round), and is
  // forgotten once the Agent is archived or gone from the directory.
  const recaps = registerRecaps(server, {
    observedTurn: async agentId => {
      const snapshot = await telemetry.snapshot(agentId), row = snapshot.persistenceError ? undefined : snapshot.agents.find(item => item.agentId === agentId);
      return row ? { startedAt: row.turnStartedAt, endedAt: row.turnEndedAt } : null;
    },
    directoryAgents: () => directory,
  });
  // Grok analyses cut short by a reload or a restart leave their excerpt directory and Grok session behind (opus-F71).
  const stopInsightSweeps = scheduleInsightSweeps(swept => {
    if (swept.directories || swept.sessions || swept.indexed) console.log(t("serverLifecycle.cleanup", { directories: swept.directories, sessions: swept.sessions, indexed: swept.indexed, megabytes: (swept.bytes / 1048576).toFixed(1) }));
  });
  const removeHistory = registerHistory(server, bridge);
  // Telemetry checks 知道了 on a stop and the completion a 标记已读 receipt is for (opus-F34, codex-F5).
  const readState = registerReadState(server, bridge, telemetry);
  const preferences = registerPreferences(server);
  const removeResults=registerResults(server,async id=>(await telemetry.snapshot(id)).agents[0]??null,(id,reply)=>{void telemetry.recordReply(id,reply.userAt,{at:reply.at,asks:reply.asks,link:reply.link,nudge:reply.nudge??null});});
  const replyCheck = createReplyCheck(telemetry, directory, { zone: () => zones.current() });
  // 恢复后续跑 keeps a ledger and checks the heartbeats behind it until the prompt went in (grok-F5, opus-F38). After a restart
  // cut a wake short, the session's own provider log is one proof the prompt went in (codex-obs-resume-F2).
  const resume = registerResume(server, bridge, { zone: () => zones.current(), noteZone: zone => zones.note(zone), logs: tokens.source });
  // 需要处理 for the sidebar badge, computed with the page's own rules (and the running turns' todo progress).
  const attention = registerAttention(server, {
    telemetry: () => telemetry.snapshot(), background: () => background.tracker.snapshot(), isLive: id => background.tracker.isLive(id),
    receipts: () => readState.store.snapshot(), preferences: () => preferences.store.attentionInputs(),
    // The sidebar's 定时运行 row shows failed runs of the last 24 hours.
    scheduleFailures: sinceMs => schedules.failuresSince(sinceMs),
    // The badge polls most often: its reads carry the device's zone.
    noteZone: zone => zones.note(zone),
    // While the chime is on, the summary carries its events (shared/alerts.ts).
    alerts: () => alerts,
  });
  // 同步到侧栏标签: the same 需要处理 rules, written into the host's own workspace labels over the plugin's session.
  const labels = new SidebarLabels({
    host: () => daemon ? bridgeLabelHost(bridge, daemon) : null,
    waiting: async () => {
      if (!daemon) return null;
      await Promise.race([attention.attach(daemon).catch(() => {}), new Promise<void>(resolve => { const timer = setTimeout(resolve, 4_000); timer.unref?.(); })]);
      return attention.workspaces();
    },
    log: message => console.warn(`agent-observatory: ${message}`),
  });
  const stopLabelWatch = attention.onChange(() => labels.poke());
  onFirstDaemon = () => labels.poke();
  registerSidebarLabels(server, labels);
  const applyAlerts = (next: AlertSettings) => { alerts = next; attention.keep(next.sidebarLabels); labels.configure({ labels: next.sidebarLabels, pin: next.sidebarPin }); };
  const stopAlertWatch = alertStore.subscribe(state => { if (state.status === "ready") applyAlerts(state.values); });
  void alertStore.read().then(state => applyAlerts(state.status === "ready" ? state.values : defaultAlertSettings)).catch(() => applyAlerts(defaultAlertSettings));
  // 提示缓存倒计时: Claude-based sessions (by `extends`) from their own Claude Code logs, as the token scans indexed them.
  registerCacheClock(server, { directory, bases: providerBasesReader(), transcript: sessionId => tokens.source.claudeTranscript(sessionId), discover: paseo => tokens.discover(paseo) });
  // Which providers take a message mid-turn on this host (client/send-plan.ts): the built-ins plus custom ids extending them,
  // those that also take a steered slash command (Claude and the ids built on it), and the built-in each custom id extends
  // (`bases`: how it runs a command, codex-obs-send-ui-F3).
  let capabilities: { at: number; value: ReturnType<typeof readSendCapabilities> } | null = null;
  server.handle(getSteerableProviders, async () => {
    if (!capabilities || Date.now() - capabilities.at > 5 * 60_000) capabilities = { at: Date.now(), value: readSendCapabilities({ PASEO_HOME: resolvePaseoHome() }) };
    return steerableReply(await capabilities.value);
  });
  // 拒绝并中断 makes some providers end the turn as failed; that turn was the user's choice, not an error.
  const interrupts = createInterruptGrace();
  const outcomeOf = (agentId: string, turnId: string | null, outcome: { kind: "completed" | "failed" | "canceled" }) => interrupts.outcome(agentId, outcome.kind, turnId);
  const observeWork = (paseo: PaseoApi, agent: { id: string }, record: () => unknown) => {
    handover.use(paseo);
    void background.tracker.attach(paseo); tokens.discover(paseo);
    // Analysis helpers have their own usage; avoid counting their turns as productive work.
    // A failed label lookup must not drop the event: unknown counts as ordinary work.
    void isInsightAgent(paseo, agent).catch(() => false).then(insight => { if (!insight && !statsClosed) return record(); }).catch(() => {});
  };
  // A lifecycle hook proves the Agent is loaded right now; only such Agents are ever asked for their subagents or todos.
  const live = (agent: { id: string }) => background.tracker.markLive(agent.id);
  const removers = [
    server.on("agent.created", ({ agent }, { paseo }) => { live(agent); observeWork(paseo, agent, () => telemetry.record({ type: "created", agent })); }),
    server.on("agent.turn_started", ({ agent, turnId }, { paseo }) => { live(agent); attention.turnStarted(agent.id); schedules.nudge(agent.id); observeWork(paseo, agent, () => telemetry.record({ type: "turn_started", agent, turnId })); }),
    server.on("agent.turn_ended", (ended, { paseo }) => {
      // The conversation the hub read for this turn (Paseo 0.16 no longer types the hook's own `timeline`).
      const { agent, turnId, outcome } = ended, timeline = hookTimeline<TimelineItem>(ended);
      // A message queued for the end of this turn goes out shortly, before the ledger's next poll.
      deferred.notify(agent.id, paseo);
      // Decided at once: the grace after 拒绝并中断 must not run out while the insight-label lookup below is slow.
      const kind = outcomeOf(agent.id, turnId, outcome);
      live(agent); attention.turnEnded(agent.id); schedules.nudge(agent.id);
      observeWork(paseo, agent, async () => {
        const items = timeline;
        // Only whether the final reply asks the user, and why the turn stopped (a limit, nothing, mid-way), are kept; never text.
        // The one sentence a quick reply would answer stays in memory for the popover, which shows it above the buttons.
        const stop = turnStop({ outcome: kind, error: outcome.kind === "failed" ? outcome.error.message : null, items, now: Date.now(), hostZone: zones.current() ?? undefined });
        const reply = kind === "completed" ? finalReplyText(items) : null;
        // Only the link to a merge or pull request the reply mentions is kept (opus-B16).
        const answered = reply !== null && stop?.kind !== "quota";
        // 快捷回复 (opus-B26) keeps only what the reply invites (go on / finish), by the same rule as 待回复.
        attention.noteAsk(agent.id, answered ? nudgeSentence(reply) : null, new Date().toISOString());
        const event = await telemetry.recordEvent({ type: "turn_ended", agent, turnId, outcome: kind, asks: answered ? replyAsksUser(reply) : null, nudge: answered ? replyNudge(reply) : null, stop, link: findChangeRequest(reply) });
        if (event) analytics.captureEnd(event, agent, paseo);
      });
    }),
    server.on("agent.permission_requested", ({ agent, request }, { paseo }) => { live(agent); observeWork(paseo, agent, () => telemetry.record({ type: "permission_requested", agent, requestId: request.id })); }),
    server.on("agent.permission_resolved", ({ agent, requestId, resolution }, { paseo }) => {
      // One waiting for the approval to be handled goes out once the turn has ended too.
      deferred.notify(agent.id, paseo);
      live(agent);
      if (resolution.behavior === "deny" && resolution.interrupt === true) interrupts.note(agent.id);
      observeWork(paseo, agent, () => telemetry.record({ type: "permission_resolved", agent, requestId, allowed: resolution.behavior === "allow" }));
    }),
    server.on("agent.archived", ({ agent }, { paseo }) => { background.tracker.markClosed(agent.id); observeWork(paseo, agent, () => telemetry.record({ type: "archived", agent })); }),
    // 0.11: the host closed (unloaded) the Agent. It is no longer loaded, and a turn still open will never end on its own.
    // 0.14 closes an Agent after an hour idle, so the host's record of how its last turn ended is read first (refresh() loads nothing).
    server.on("agent.closed", ({ agent }, { paseo }) => { background.tracker.markClosed(agent.id); attention.closedAgent(agent.id);
      const closedAt = Date.now();
      observeWork(paseo, agent, async () => telemetry.record({ type: "closed", agent, closedAt, ended: await closedTurnEnd(paseo, agent.id) })); }),
  ];
  // The backfill boundary is established before synchronous stats observation begins.
  void stats.ready.then(() => {
    if (statsClosed) return;
    statsRemovers.push(
      server.on("agent.turn_started", ({ agent }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "turn_started", agentId: agent.id }))),
      server.on("agent.turn_ended", (event, { paseo }) => {
        const { agent, turnId, outcome } = event, timeline = hookTimeline<AgentTimelineItem>(event), kind = outcomeOf(agent.id, turnId, outcome);
        // 0.13: the hub read the end of the conversation (lifecycle-hub.ts); rows keep their keys from read to read.
        const read = turnRead(event);
        observeWork(paseo, agent, () => stats.record({ type: "turn_ended", agentId: agent.id, outcome: kind, timeline,
          positions: read?.positions, partial: read ? !read.complete : false }));
      }),
      server.on("agent.permission_requested", ({ agent, request }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "permission_requested", agentId: agent.id, requestId: request.id }))),
      server.on("agent.permission_resolved", ({ agent, requestId }, { paseo }) => observeWork(paseo, agent, () => stats.record({ type: "permission_resolved", agentId: agent.id, requestId }))),
    );
  });
  // 「等这一轮结束再发」 and sending now (`observatory.deferred.*`).
  registerSendLedger(server, deferred);
  server.handle(getStats, (input, { paseo }) => { zones.note(input.timeZone); void background.tracker.attach(paseo); tokens.discover(paseo); return stats.read(input, paseo); });
  server.handle(getTelemetry, (input, { paseo }) => { void background.tracker.attach(paseo); tokens.discover(paseo); void replyCheck.refresh(paseo); return telemetry.read(input); });
  server.handle(getAnalytics, (input, { paseo }) => { zones.note(input.timeZone); analytics.refreshRecent(paseo); return telemetry.analyticsRead(input); });
  return async () => {
    locales.dispose();
    deferred.stop();
    stopAlertWatch(); stopLabelWatch();
    statsClosed = true;
    replyCheck.close();
    attention.close();
    for (const remove of statsRemovers) remove();
    for (const remove of removers) remove();
    hub.close();
    analytics.close();
    removeHistory();
    stopInsightSweeps();
    await Promise.all([removeInsights(), recaps.close(), readState.close(), preferences.close(), Promise.resolve(removeResults()), telemetry.close(), stats.close(), tokens.close(), removeDigest(), schedules.close(), background.close(), removeQuota(), resume.close(), zones.close(), labels.close()]);
    bridge.dispose();
  };
}
