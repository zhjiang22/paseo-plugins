import { previewLanguage, setPreviewLanguage } from "./i18n";
import { fixtureStats } from "./stats-fixture";
import { createFixtureLedger } from "./deferred-fixture";
import { quickReplyGroup, quickReplyGuard, quickReplyKey } from "../client/deferred-state";
import { fixtureTokenLive, fixtureTokens } from "./tokens-fixture";
import { fixtureDigest } from "./digest-fixture";
import { fixtureRecapList, fixtureRecapSettings, fixtureRecapStatus, saveRecapSettings, subscribeRecapSettings } from "./recap-fixture";
import { fixtureQuota } from "./quota-fixture";
import { fixtureHeartbeatsResponse, fixtureScheduleList, fixtureScheduleRun } from "./schedules-fixture";
import { fixtureModels, fixtureOverview, fixtureProfiles, fixtureReportJobs, fixtureRunners, fixtureSuggestions, fixtureSuggestionsState, richInsightScenarios, runnerLabelFor } from "./insights-overview-fixture";
import { useEffect, useMemo, useState } from "react";
import * as Lucide from "lucide-react";
import { createPortal } from "react-dom";
import { ScrollView, FlatList, TextInput } from "react-native-web";
import { defaultViewPreferences } from "../shared/preferences";
import { normalizeTimelinePage, projectTimelineRows } from "../shared/timeline";
import { fixtureAnalytics, fixtureArchiveOrigins, fixtureInsight, fixtureInsightState, fixtureProjectAnalytics, fixtureReadReceipts, fixtureTelemetry, fixtureTimeline, longFirstInput, longLatestReply, longFixtureTimeline, nativeChildren, nativeTimeline, rawAgents, subscribeFixtureAgents, updateFixtureAgent, applyAttentionScenario, fixtureLiveExtras, fixtureHeartbeats, ackFixtureStop } from "./fixtures";

let insightSequence = 0;
/** 恢复后续跑's ledger as the stand-in keeps it (server/resume.ts keeps the real one). */
const previewResumes = [];
let previewResumeSequence = 0;
// The UI tests set one Agent's ledger state, as the server's checks leave it (未能确认续跑 after a restart, 心跳被改过).
globalThis.__previewSetResume = entry => {
  const now = new Date().toISOString();
  previewResumes.splice(0, previewResumes.length, ...previewResumes.filter(item => item.agentId !== entry.agentId),
    { scheduleId: `fixture-resume-${++previewResumeSequence}`, stopAt: null, plannedAt: now, wakeAt: now, attempt: 1, reason: null, createdAt: now, updatedAt: now, deliveredAt: null, ...entry });
};
let fixtureRevision = 0;
const revisioned = new Set(["observatory.telemetry.get", "observatory.analytics.get", "observatory.read-state.list", "observatory.results.get", "observatory.stats.get", "observatory.tokens.get", "observatory.digest.get", "observatory.insights.overview", "observatory.quota.get"]);
let preferencesRevision=0;const preferencePages=new Map();let preferenceSnoozes=[];let preferenceSettings={childCompletions:false};
// ?storedQuery= simulates search text synced by an older version (the server now strips it; the client must ignore it too).
const storedQuery=typeof location==="undefined"?null:new URLSearchParams(location.search).get("storedQuery");
const preferenceSnapshot=(key)=>structuredClone({revision:preferencesRevision,view:preferencePages.get(key)?.view??{...defaultViewPreferences(key),...(storedQuery&&!key.endsWith("archives")?{query:storedQuery}:{})},savedViews:preferencePages.get(key)?.savedViews??[],snoozes:preferenceSnoozes.filter(s=>Date.parse(s.until)>Date.now()),error:null,settings:{...preferenceSettings}});
globalThis.__previewRpcCalls = [];
globalThis.__previewAgentOperations = [];
globalThis.__previewTimelineCalls = [];
const timelineListeners = new Map();
globalThis.__previewGetPreferences = preferenceSnapshot;
globalThis.__previewGetAgent = id => structuredClone(rawAgents.find(agent => agent.id === id));
globalThis.__previewTimelineActive = id => timelineListeners.get(id)?.size ?? 0;
globalThis.__previewEmitTimeline = (id,event) => {for(const listener of timelineListeners.get(id)??[])listener({agentId:id,event});};
const scenarioName=()=>new URLSearchParams(globalThis.location?.search??"").get("scenario");
if(scenarioName()==="attention-states")applyAttentionScenario();
/**
 * ?scenario=approvals: in-place approvals (opus-B12) and quick replies (opus-B26) with the host's real request shapes. 审查数据库迁移
 * (Claude) waits on a shell command with no provider actions and a question; 同步订单表结构 (an ACP provider) on an edit with the
 * agent's own choices, one of them lasting. 规划下一轮迭代 asks whether to go on, 整理性能基线 ended on its next step.
 */
function applyApprovalScenario() {
  const now = Date.now(), at = seconds => new Date(now - seconds * 1000).toISOString();
  const review = rawAgents.find(agent => agent.id === "migration-review");
  // Two more after them (codex-obs-send-ui-F1): a command too long to show collapsed, whose end 展开完整内容 brings back, and a Grep
  // whose pattern is its target and whose path is a parameter of its own.
  const tables = `npm run migrate:check -- --dry-run --tables ${Array.from({ length: 450 }, (_, index) => `orders_${String(index).padStart(3, "0")}`).join(",")} && echo 检查结束`;
  review.pendingPermissions = [{ id: "permission-1", provider: "claude", kind: "tool", name: "Bash", title: "执行数据库迁移检查", description: "运行只读检查并核对迁移计划。",
    input: { command: "npm run migrate:check -- --dry-run --env staging", description: "只读检查迁移计划" }, detail: { type: "shell", command: "npm run migrate:check -- --dry-run --env staging" } }, review.pendingPermissions[1],
    { id: "permission-3", provider: "claude", kind: "tool", name: "Bash", title: "检查全部订单分表", input: { command: tables, description: "逐个分表只读检查" }, detail: { type: "shell", command: tables } },
    { id: "permission-4", provider: "claude", kind: "tool", name: "Grep", title: "Grep", input: { pattern: "TODO", path: "db/migrations", output_mode: "content" }, detail: { type: "search", query: "TODO" } }];
  const options = [{ optionId: "allow", name: "Allow", kind: "allow_once" }, { optionId: "allow_always", name: "Always Allow", kind: "allow_always" }, { optionId: "reject", name: "Reject", kind: "reject_once" }];
  rawAgents.splice(5, 0, { ...structuredClone(review), id: "schema-sync", title: "同步订单表结构", provider: "my-acp", model: null, activeTurn: { turnId: "schema-turn", startedAt: at(150) }, updatedAt: at(9),
    pendingPermissions: [{ id: "permission-acp-1", provider: "my-acp", kind: "tool", name: "edit", title: "Edit db/migrations/0042_orders.sql",
      detail: { type: "edit", filePath: "/workspace/commerce-platform/db/migrations/0042_orders.sql", unifiedDiff: "@@ -1,3 +1,4 @@\n CREATE TABLE orders (\n+  tenant_id TEXT NOT NULL,\n   id TEXT PRIMARY KEY," },
      actions: options.map(option => ({ id: option.optionId, label: option.name, behavior: option.kind.startsWith("allow") ? "allow" : "deny" })), metadata: { toolCallId: "acp-call-1", options } }] });
  const telemetry = id => fixtureTelemetry.agents.find(record => record.agentId === id);
  Object.assign(telemetry("iteration-plan"), { replyNudge: "go-ahead" });
  const baseline = telemetry("performance-baseline");
  Object.assign(baseline, { replyAt: baseline.turnEndedAt, replyNudge: "keep-going" });
}
// The quick replies of ?scenario=approvals, sent through a ledger whose host never tells the outcome (send-unknown) or whose answer is lost.
if(["approvals","send-unknown","send-lost-reply"].includes(scenarioName()))applyApprovalScenario();
// ?scenario=deferred: 重构支付服务 runs on a provider that cannot take a message mid-turn, so a send to it would interrupt the turn.
// ?scenario=deferred-held: the same, and the host never tells whether a send arrived (a message queued once the turn ended is held).
if(["deferred","deferred-held"].includes(scenarioName()))Object.assign(rawAgents.find(agent=>agent.id==="payment-root"),{provider:"my-acp",activeTurn:{turnId:"payment-turn",startedAt:rawAgents.find(agent=>agent.id==="payment-root").activeTurn.startedAt}});
// The daemon's message receipts (message-receipts/index.js): a retry of a delivered id succeeds without a second copy, a changed retry is refused.
const deliveredMessages=new Map();const flakyMessages=new Set();
if(richInsightScenarios.has(scenarioName()))fixtureInsightState.jobs.push(...fixtureReportJobs());
let createdSequence=0;

const sdk = {
  agents: {
    create: async input => { globalThis.__previewAgentOperations.push({ type: "create", input }); throw new Error("开发预览不允许创建 Agent"); },
    list: async (options) => ({ entries: rawAgents.filter(agent => options?.filter?.includeArchived || !agent.archivedAt).map(agent => ({ agent: { ...agent } })), pageInfo: { nextCursor: null, hasMore: false } }),
    subscribe: subscribeFixtureAgents,
    ref: agentId => ({ refresh: async () => { const agent = rawAgents.find(agent => agent.id === agentId); return agent ? { agent: { ...agent }, project: null } : null; },
      archive: async () => {const agent=rawAgents.find(item=>item.id===agentId);if(!agent)throw new Error("模拟会话不存在");const archivedAt=new Date().toISOString();globalThis.__previewAgentOperations.push({type:"archive",agentId});const index=fixtureArchiveOrigins.findIndex(item=>item.agentId===agentId);if(index>=0)fixtureArchiveOrigins.splice(index,1);fixtureArchiveOrigins.push({agentId,archivedAt,lastUserMessageAt:agent.lastUserMessageAt??null});updateFixtureAgent(agentId,{archivedAt,updatedAt:archivedAt,status:"closed",requiresAttention:false,attentionReason:null,attentionTimestamp:null});return {archivedAt};},
      send: async (input, options) => {
        globalThis.__previewAgentOperations.push({ type: "send", agentId, input, ...(options ? { options } : {}) });
        const scenario = scenarioName(), key = options?.messageId;
        if (scenario === "send-error") throw new Error("开发预览不允许发送新提示词");
        if (key) {
          const fingerprint = JSON.stringify([agentId, input, options.activeTurnBehavior ?? "interrupt"]), previous = deliveredMessages.get(key);
          if (previous) { if (previous !== fingerprint) throw new Error("agent_request_key_conflict"); return; }
          // ?scenario=send-unknown: the daemon cannot tell whether it went out; ?scenario=send-flaky: the first try of each message is lost.
          if (scenario === "send-unknown" || scenario === "deferred-held") throw new Error("agent_request_outcome_unknown");
          if (scenario === "send-flaky" && !flakyMessages.has(key)) { flakyMessages.add(key); throw new Error("模拟网络中断，这次没有送达"); }
          deliveredMessages.set(key, fingerprint);
        }
        // Like the host: every send clears the pending requests, and a message to a stopped Agent starts a turn.
        const agent = rawAgents.find(item => item.id === agentId), now = new Date().toISOString();
        if (agent) updateFixtureAgent(agentId, { pendingPermissions: [], updatedAt: now, ...(["running", "initializing"].includes(agent.status) ? {} : { status: "running", activeTurn: { turnId: `preview-${key ?? now}`, startedAt: now }, lastUserMessageAt: now }) });
      },
      // Fire and forget like the host (no receipt): the request disappears a moment later; 拒绝并中断 also ends the turn.
      // ?scenario=permission-stuck: the host never drops it, so the panel has to say it is unconfirmed.
      respondToPermission: async ({ requestId, response }) => {
        globalThis.__previewAgentOperations.push({ type: "permission", agentId, requestId, response: structuredClone(response) });
        if (scenarioName() === "permission-stuck" || !rawAgents.find(item => item.id === agentId)?.pendingPermissions.some(request => request.id === requestId)) return;
        setTimeout(() => {
          const agent = rawAgents.find(item => item.id === agentId);
          if (!agent) return;
          const interrupt = response?.behavior === "deny" && response.interrupt === true;
          updateFixtureAgent(agentId, { pendingPermissions: agent.pendingPermissions.filter(request => request.id !== requestId), updatedAt: new Date().toISOString(), ...(interrupt ? { status: "idle", activeTurn: null } : {}) });
        }, 400);
      }, timeline: {
      refetch: async (input = {}) => {globalThis.__previewTimelineCalls.push({agentId,...input});return scenarioName()==="long-history" ? longFixtureTimeline(agentId,input) : fixtureTimeline(agentId,input.direction);},
      subscribe: listener => {const listeners=timelineListeners.get(agentId)??new Set();listeners.add(listener);timelineListeners.set(agentId,listeners);return Object.assign(()=>listeners.delete(listener),{ready:Promise.resolve()});},
    } }),
  },
};
sdk.config = { get: async () => ({ requestId: "fixture-config", config: { agentProfiles: fixtureProfiles } }) };
// The plugin server's ledger for observatory.deferred.* (server/deferred-send.ts there), over the synthetic Agents: it sends with the
// stand-in host's send above, so every delivery is in __previewAgentOperations. ?scenario=send-lost-reply: the first answer to each
// send never reaches the card (an RPC timeout), though the ledger sent it.
const instant = value => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
/**
 * The server's check of a quick reply's turn (`answeringGuard`, server/send-ledger.ts there), over the fixture's telemetry: a
 * round its record cannot vouch for (an error reported, no round of this Agent, or an older one) throws.
 */
const answeringGuard = (agentId, guard, agent) => {
  const title = agent.title || "这个 Agent";
  if (instant(agent.lastUserMessageAt) !== instant(guard.prompt) || agent.activeTurn || agent.status === "running") return `「${title}」已经开始新的一轮，这条快捷回复不再适用`;
  if (agent.status !== "idle" && agent.status !== "closed") return `「${title}」的状态变了，这条快捷回复不再适用`;
  const round = instant(guard.round);
  if (round === null) return null;
  if (fixtureTelemetry.persistenceError) throw new Error(`观测台的记录暂时有问题，核实不了「${title}」最近一轮`);
  const seen = instant(fixtureTelemetry.agents.find(record => record.agentId === agentId)?.turnStartedAt);
  if (seen === null || seen < round) throw new Error(`观测台读不到「${title}」最近一轮的记录`);
  return seen > round ? `「${title}」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用` : null;
};
const fixtureLedger = createFixtureLedger({ agent: id => { const agent = rawAgents.find(item => item.id === id); return agent ? { ...agent } : null; },
  deliver: (agentId, text, options) => sdk.agents.ref(agentId).send(text, options), capabilities: { steerable: ["claude", "codex"], slashSteerable: ["claude"], bases: {} }, guard: answeringGuard });
/** Another device taps the quick reply `text` for this Agent's latest turn, through the same ledger (codex-obs-attn-R3). */
globalThis.__previewOtherDeviceReply = async (agentId, text) => {
  const agent = rawAgents.find(item => item.id === agentId), round = fixtureTelemetry.agents.find(record => record.agentId === agentId)?.turnStartedAt ?? null;
  const words = `${text}。`, prompt = agent?.lastUserMessageAt ?? null;
  return fixtureLedger.send({ agentId, text: words, messageId: `other-device-${Date.now()}`, key: quickReplyKey(words, prompt, round), source: `快捷回复「${text}」`, what: "回复", consent: null,
    group: quickReplyGroup(prompt, round), guard: quickReplyGuard(prompt, round) });
};
/** The plugin's store reports an error (`message`; null clears it): its record may be behind (codex-obs-attn-R3-remaining). */
globalThis.__previewTelemetryError = message => { fixtureTelemetry.persistenceError = message; };
const lostReplies = new Set();
sdk.workspaces = { ref: workspaceId => ({ agents: { create: async input => { globalThis.__previewAgentOperations.push({ type: "create", workspaceId, input }); return { id: `fixture-created-${++createdSequence}` }; } } }) };
export function usePaseo() { return sdk; }
/** Paseo 0.11.1's app-state hooks only work inside a workspace panel and throw anywhere else; the preview renders screens. */
const outsidePanel = () => { throw new Error("Plugin state hooks must run inside a workspace panel"); };
export function useWorkspace() { outsidePanel(); }
export function useAgent() { outsidePanel(); }
/** The host's link opener (Paseo 0.11 `openExternalUrl`): the preview records the URL instead of leaving the page. */
export async function openExternalUrl(url) { globalThis.__previewExternal = url; }
export function useRpc(contract) {
  return useMemo(() => async input => {
    globalThis.__previewRpcCalls.push({ name: contract.name, input: { ...input } });
    let result;
    switch (contract.name) {
      case "i18n.languages": result = { setting: previewLanguage, resolved: previewLanguage, system: "zh-CN", device: "zh-CN", folder: "/fixture/plugin-data/agent-observatory/locales", languages: [{ code: "zh-CN", name: "简体中文", builtIn: true, custom: false, coverage: 1, issues: [] }, { code: "en", name: "English", builtIn: true, custom: false, coverage: 1, issues: [] }] }; break;
      case "observatory.preferences.get": result=preferenceSnapshot(input.viewKey);break;
      case "observatory.deferred.send": {
        result = await fixtureLedger.send(input);
        if (scenarioName() === "send-lost-reply" && !lostReplies.has(input.messageId)) { lostReplies.add(input.messageId); throw new Error("模拟回包丢失：请求超时"); }
        break;
      }
      case "observatory.deferred.enqueue": result = await fixtureLedger.enqueue(input); break;
      case "observatory.deferred.list": result = fixtureLedger.list(input); break;
      case "observatory.deferred.cancel": result = fixtureLedger.cancel(input.messageId); break;
      case "observatory.deferred.resume": result = await fixtureLedger.resume(input.messageId); break;
      case "observatory.preferences.update": {
        if(input.expectedRevision!==preferencesRevision){result={...preferenceSnapshot(input.viewKey),status:"conflict"};break;}
        const old=preferenceSnapshot(input.viewKey);const value={view:{...old.view,...input.view},savedViews:[...old.savedViews]};
        if(input.saveView){const id=input.saveView.id??`view-${Date.now()}`;value.savedViews=[...value.savedViews.filter(v=>v.id!==id),{...input.saveView,id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}];}
        if(input.deleteSavedViewId)value.savedViews=value.savedViews.filter(v=>v.id!==input.deleteSavedViewId);
        if(input.snooze)preferenceSnoozes=[...preferenceSnoozes.filter(s=>s.agentId!==input.snooze.agentId||Date.parse(s.completionAt)!==Date.parse(input.snooze.completionAt)),input.snooze];
        if(input.unsnooze)preferenceSnoozes=preferenceSnoozes.filter(s=>s.agentId!==input.unsnooze.agentId||s.completionAt!==input.unsnooze.completionAt);
        if(input.settings)preferenceSettings={...preferenceSettings,...input.settings};
        preferencePages.set(input.viewKey,value);preferencesRevision++;result={...preferenceSnapshot(input.viewKey),status:"updated"};break;
      }
      case "observatory.results.get": {
        if(scenarioName()==="schedule-session-error"&&input.agentId==="environment-closed")throw new Error("Request failed: acp does not support ACP session resume requestType=plugin.rpc.invoke.request code=handler_error");
        const page=fixtureTimeline(input.agentId);const rows=projectTimelineRows(normalizeTimelinePage(page).rows);const agent=rawAgents.find(a=>a.id===input.agentId);const first=rows.find(r=>r.item.type==="user_message"),last=[...rows].reverse().find(r=>r.item.type==="assistant_message"),user=[...rows].reverse().find(r=>r.item.type==="user_message");
        const source={lastUserMessageAt:agent?.lastUserMessageAt??null,attentionTimestamp:agent?.attentionTimestamp??null};
        if(input.expectedLastUserMessageAt!==undefined&&input.expectedLastUserMessageAt!==source.lastUserMessageAt||input.expectedAttentionTimestamp!==undefined&&input.expectedAttentionTimestamp!==source.attentionTimestamp)throw new Error("模拟结果版本已改变，请刷新查看最新结果");
        const ex=row=>row?{text:row.item.text||"",ref:`${input.agentId}:${page.epoch}:${row.seqStart}-${row.seqEnd}`,at:row.timestamp||null,truncated:false}:null;
        result={agentId:input.agentId,capturedAt:new Date().toISOString(),epoch:page.epoch,source,firstInput:first?{...ex(first),completeOrigin:true}:null,latestUserInput:ex(user),latestReply:ex(last),isRunning:agent?.status==="running",isFinal:agent?.attentionReason==="finished",artifacts:[],testEvidence:[],metrics:{tools:rows.filter(r=>r.item.type==="tool_call").length,failedTools:0,changedFiles:0,userTurns:1},coverage:{firstInputConfirmed:true,truncated:false,rows:rows.length,hasOlder:false,reason:null}};break;
      }
      case "observatory.insights.list": {
        const jobs=fixtureInsightState.jobs.filter(job=>!input.agentId||job.agentId===input.agentId).map(({report,evidence,...job})=>({...job,reportAvailable:!!report,summary:report?.summary??null,health:report?.health??null,findings:report?.findings.length??0,resolvedFindings:Object.values(job.findingFeedback??{}).filter(f=>f.status==="resolved").length}));
        result={...fixtureInsightState,runnerLabel:runnerLabelFor(fixtureInsightState.settings.runner),jobs,revision:insightSequence,unchanged:false,activeCount:jobs.filter(j=>["queued","collecting","analyzing"].includes(j.status)).length,nextScheduledAt:null};break;
      }
      case "observatory.insights.runners": {
        // Like the server: the built-in Grok option carries the saved model and effort while it is the configured runner.
        const saved = fixtureInsightState.settings.runner;
        result = saved?.kind === "grok" ? { ...fixtureRunners, builtin: { ...fixtureRunners.builtin, runner: saved, label: runnerLabelFor(saved), modelLabel: saved.model ?? fixtureRunners.builtin.modelLabel, thinkingLabel: saved.effort ?? fixtureRunners.builtin.thinkingLabel } } : fixtureRunners;
        break;
      }
      case "observatory.insights.models": result = fixtureModels(input.provider); break;
      // server/profiles.ts there: only the fields the sheets use, never the rest of the daemon config.
      case "observatory.profiles.list": result = { profiles: fixtureProfiles.map(({ id, name, provider, model, modeId, thinkingOptionId, featureValues, notes }) => ({ id, name, provider, model, modeId, thinkingOptionId, featureValues, notes })) }; break;
      case "observatory.insights.overview": result = fixtureOverview(input.days, input.utcOffsetMinutes, scenarioName(), fixtureInsightState.settings, runnerLabelFor(fixtureInsightState.settings.runner)); break;
      case "observatory.insights.suggestions": {
        const all = fixtureSuggestions(Date.now(), scenarioName());
        result = { job: input.jobId ? fixtureSuggestionsState.jobs.find(job => job.id === input.jobId) ?? (all.job?.id === input.jobId ? all.job : null) : all.job, history: all.history }; break;
      }
      case "observatory.insights.suggest": {
        if (scenarioName() === "insights-suggest-error") throw new Error("模拟：分析队列已满，请稍后再试。");
        const now = new Date().toISOString(), label = runnerLabelFor(input.runner ?? fixtureInsightState.settings.runner);
        result = { id: `fixture-suggestions-new-${++insightSequence}`, createdAt: now, updatedAt: now, status: "queued", trigger: "manual", stage: "已加入分析队列",
          window: { days: input.days, from: now.slice(0, 10), to: now.slice(0, 10), reports: 0, findings: 0, agents: 0, timeZone: input.timeZone ?? null, ...(input.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: input.utcOffsetMinutes } : {}) },
          runner: { kind: (input.runner ?? fixtureInsightState.settings.runner).kind, label, provider: null, model: null, thinkingOptionId: null, modeId: null, sessionAgentId: null },
          usage: null, error: null, report: null, basis: [] };
        fixtureSuggestionsState.jobs.unshift(result); break;
      }
      case "observatory.insights.suggest-cancel": {
        const job = fixtureSuggestionsState.jobs.find(item => item.id === input.jobId); if (!job) throw new Error("模拟建议任务不存在");
        Object.assign(job, { status: "canceled", stage: "已取消", updatedAt: new Date().toISOString() }); result = job; break;
      }
      case "observatory.insights.action-feedback": {
        const all = fixtureSuggestions(Date.now(), scenarioName());
        if (!all.job || all.job.id !== input.jobId) throw new Error("模拟建议不存在");
        if (!all.job.report.actions.some(action => action.id === input.actionId)) throw new Error("这条建议已不在报告里");
        fixtureSuggestionsState.feedback[input.actionId] = { status: input.status, updatedAt: new Date().toISOString() };
        result = { ...all.job, feedback: { ...fixtureSuggestionsState.feedback } }; break;
      }
      case "observatory.insights.report": result={job:fixtureInsightState.jobs.find(job=>job.id===input.jobId)??null,revision:insightSequence};break;
      case "observatory.insights.feedback": {const job=fixtureInsightState.jobs.find(j=>j.id===input.jobId);job.findingFeedback={...job.findingFeedback,[input.findingId]:{status:input.status,updatedAt:new Date().toISOString()}};insightSequence++;result=job;break;}
      case "observatory.telemetry.get": result = fixtureTelemetry; break;
      case "observatory.quota.get": result = fixtureQuota(Date.now(), scenarioName()); break;
      case "observatory.live.get": result = { mode: "full", unchanged: false, revision: `live-${fixtureLiveExtras.length}`, agents: fixtureLiveExtras }; break;
      // Like the server: whether the read can be trusted travels with it (codex-F16), so 归档已读完成 can use it.
      case "observatory.schedules.heartbeats": result = fixtureHeartbeatsResponse(fixtureHeartbeats, scenarioName()); break;
      case "observatory.steerable.list": result = { providers: ["claude", "codex"], slashSteerable: ["claude"] }; break;
      case "observatory.resume.schedule": {
        // Like server/resume.ts: one waiting resume per Agent, recorded in the ledger the stop card reads.
        const waiting = previewResumes.find(entry => entry.agentId === input.agentId && ["scheduled", "waking", "retrying"].includes(entry.status));
        if (waiting) { result = { status: "scheduled", scheduleId: waiting.scheduleId, runAt: waiting.wakeAt, message: "已经安排过续跑，没有重复安排。要换时间，先取消这一次。", existing: true, entry: waiting }; break; }
        globalThis.__previewAgentOperations.push({ type: "resume", agentId: input.agentId, input: { ...input } });
        const now = new Date().toISOString(), entry = { agentId: input.agentId, scheduleId: `fixture-resume-${++previewResumeSequence}`, stopAt: input.stopAt ?? null, plannedAt: input.at, wakeAt: input.at, attempt: 1, status: "scheduled", reason: null, createdAt: now, updatedAt: now, deliveredAt: null };
        previewResumes.splice(0, previewResumes.length, ...previewResumes.filter(item => item.agentId !== input.agentId), entry);
        result = { status: "scheduled", scheduleId: entry.scheduleId, runAt: input.at, message: "已安排续跑，可以在这张卡片上取消。", entry }; break;
      }
      case "observatory.resume.list": result = { mode: "full", unchanged: false, revision: `resumes-${previewResumeSequence}-${previewResumes.map(entry => entry.status).join(",")}`, generatedAt: new Date().toISOString(),
        entries: previewResumes.filter(entry => !input.agentId || entry.agentId === input.agentId), error: null }; break;
      case "observatory.resume.cancel": {
        const entry = previewResumes.find(item => item.agentId === input.agentId && ["scheduled", "waking", "retrying"].includes(item.status));
        globalThis.__previewAgentOperations.push({ type: "resume-cancel", agentId: input.agentId });
        if (!entry) { result = { status: "failed", message: "这个 Agent 没有在等的续跑。", entry: null }; break; }
        Object.assign(entry, { status: "canceled", reason: "user", updatedAt: new Date().toISOString() });
        result = { status: "canceled", message: "已取消续跑。", entry: { ...entry } }; break;
      }
      case "observatory.providers.bases": result = { bases: {} }; break;
      case "observatory.analytics.get": result = fixtureProjectAnalytics(input.projectId); break;
      case "observatory.stats.get": if (scenarioName() === "stats-error") throw new Error("模拟统计读取失败"); result = fixtureStats(input.range, input.utcOffsetMinutes); break;
      case "observatory.tokens.get": if (scenarioName() === "tokens-error") throw new Error("模拟 Token 统计读取失败"); result = fixtureTokens(input.range, input.utcOffsetMinutes); break;
      case "observatory.tokens.live": if (scenarioName() === "tokens-error") throw new Error("模拟 Token 统计读取失败"); result = fixtureTokenLive(input.windowMinutes, input.utcOffsetMinutes, input.detail); break;
      case "observatory.digest.get": result = fixtureDigest(input.agentId); break;
      case "observatory.recap.list": { const full = fixtureRecapList(); result = input.revision === full.revision ? { mode: "unchanged", revision: full.revision } : full; break; }
      case "observatory.recap.status": result = fixtureRecapStatus(); break;
      case "observatory.schedules.list": { const full = fixtureScheduleList(input.window ?? "recent", scenarioName()); result = input.revision === full.revision ? { mode: "unchanged", unchanged: true, revision: full.revision } : full; break; }
      case "observatory.schedules.run": result = fixtureScheduleRun(input.runId); if (scenarioName() === "schedule-no-reply") result = { ...result, output: null, prompt: null, note: "定时任务记录已不存在，可以读取会话记录查看最后回复。" }; break;
      case "observatory.read-state.list": result = { receipts: [...fixtureReadReceipts], archiveOrigins:[...fixtureArchiveOrigins], error: null }; break;
      case "observatory.read-state.mark": {
        const agent = rawAgents.find(candidate => candidate.id === input.agentId);
        const scenario = new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
        if (scenario === "read-error") { result = { agentId: input.agentId, status: "failed", receipt: null, message: "模拟宿主确认失败，未读状态已保留。" }; break; }
        // Like the server: 知道了 (kind "error", a failure or a stop) clears the attention and records no completion receipt.
        // A stop the host raised no attention for (closed mid-turn) is acknowledged by its time alone, without clearing anything.
        if (input.kind === "error" && input.stopAt && agent && agent.requiresAttention !== true) {
          result = ackFixtureStop(agent.id, input.stopAt) ? { agentId: input.agentId, status: "read", receipt: null, message: "已标记为知道了。" }
            : { agentId: input.agentId, status: "stale", receipt: null, message: "停下的原因已有更新，请刷新后再确认。" };
          break;
        }
        const reasons = input.kind === "error" ? ["finished", "error"] : ["finished"];
        if (!agent || !reasons.includes(agent.attentionReason) || agent.requiresAttention !== true || agent.activeTurn || agent.pendingPermissions.length) {
          result = { agentId: input.agentId, status: "not_unread", receipt: null, message: "当前没有可标为已读的完成结果。" }; break;
        }
        if (agent.attentionTimestamp !== input.attentionTimestamp || (agent.lastUserMessageAt ?? null) !== input.lastUserMessageAt) {
          result = { agentId: input.agentId, status: "stale", receipt: null, message: "完成结果已更新，请刷新后确认。" }; break;
        }
        if (input.kind === "error") {
          if (input.stopAt) ackFixtureStop(agent.id, input.stopAt);
          updateFixtureAgent(agent.id, { requiresAttention: false, attentionReason: null, attentionTimestamp: null });
          result = { agentId: input.agentId, status: "read", receipt: null, message: "已标记为知道了，并同步到 Paseo。" };
          break;
        }
        const receipt = { agentId: input.agentId, completionAt: agent.attentionTimestamp, lastUserMessageAt: agent.lastUserMessageAt ?? null, readAt: new Date().toISOString() };
        const old = fixtureReadReceipts.findIndex(item => item.agentId === input.agentId);
        if (old >= 0) fixtureReadReceipts.splice(old, 1);
        fixtureReadReceipts.unshift(receipt);
        updateFixtureAgent(agent.id, { requiresAttention: false, attentionReason: null, attentionTimestamp: null });
        result = { agentId: input.agentId, status: "read", receipt, message: "已标为已读，并与原生会话同步。" };
        break;
      }
      case "observatory.insights.state": result = { ...fixtureInsightState, jobs: fixtureInsightState.jobs.filter(job => !input.agentId || job.agentId === input.agentId) }; break;
      case "observatory.insights.start": {
        const runner = input.runner ?? fixtureInsightState.settings.runner;
        result = { ...fixtureInsight(input.agentId), id: `fixture-insight-${input.agentId}-${++insightSequence}`,
          runner: { kind: runner.kind === "auto" ? "grok" : runner.kind, label: runnerLabelFor(runner.kind === "auto" ? { kind: "grok" } : runner), provider: runner.kind === "provider" ? runner.provider : null,
            model: runner.kind === "provider" ? runner.model : runner.kind === "grok" || runner.kind === "auto" ? "grok-4.7" : null,
            thinkingOptionId: runner.kind === "provider" ? runner.thinkingOptionId : runner.kind === "grok" || runner.kind === "auto" ? "xhigh" : null, modeId: null,
            sessionAgentId: runner.kind === "grok" || runner.kind === "auto" ? null : "fixture-analysis-session" } };
        const scenario = new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
        if (input.agentId === "mobile-bootstrap") result = { ...result, status: "skipped", report: null, stage: "手动分析至少需要 2 轮对话和 2 次工具调用，当前轨迹尚不足。", eligibility: { eligible: false, turnCount: 1, toolCount: 1, reason: "手动分析至少需要 2 轮对话和 2 次工具调用，当前轨迹尚不足。" } };
        else if (scenario === "insights-progress") result = { ...result, status: "analyzing", report: null, stage: "正在结合工具结果分析执行轨迹" };
        else if (scenario === "insights-failed") result = { ...result, status: "failed", report: null, error: "模拟分析进程中断，请重试。", stage: "分析进程已退出" };
        fixtureInsightState.jobs.unshift(result);
        break;
      }
      case "observatory.insights.configure": if (input.autoEnabled !== undefined) fixtureInsightState.settings.autoEnabled = input.autoEnabled; if (input.runner) fixtureInsightState.settings.runner = input.runner; result = fixtureInsightState.settings; break;
      case "observatory.insights.cancel": {
        const found = fixtureInsightState.jobs.find(job => job.id === input.jobId);
        if (!found) throw new Error("模拟分析任务不存在");
        Object.assign(found, { status: "canceled", stage: "分析已取消", report: null, updatedAt: new Date().toISOString() });
        result = found;
        break;
      }
      case "observatory.history.evidence": {
        const historical = input.agentId === "archived-cycle" || input.agentId === "old-report";
        const timeline = historical ? fixtureTimeline(input.agentId) : null;
        result = { agentId: input.agentId, turns: historical ? 2 : 4, tools: historical ? 2 : 12, toolFailures: historical ? 0 : 1, errors: 0,
          firstTimelineAt: timeline?.rows[0]?.timestamp ?? new Date(Date.now() - 1800_000).toISOString(), lastTimelineAt: timeline?.rows.at(-1)?.timestamp ?? new Date().toISOString(),
          sampleSize: timeline?.rows.length ?? 28, complete: true, hasOlder: false, coverageReason: null, completionEvidence: { kind: "none", at: null } };
        break;
      }
      case "observatory.history.restore": {
        const agent = rawAgents.find(agent => agent.id === input.agentId);
        const countUsers = () => fixtureTimeline(input.agentId).rows.filter(row => row.item.type === "user_message").length;
        const before = { agentId: agent?.id, agentCount: rawAgents.length, userMessages: countUsers() };
        if(agent?.archivedAt){const existing=fixtureArchiveOrigins.findIndex(item=>item.agentId===agent.id);if(existing>=0)fixtureArchiveOrigins.splice(existing,1);fixtureArchiveOrigins.push({agentId:agent.id,archivedAt:agent.archivedAt,lastUserMessageAt:agent.lastUserMessageAt??null});}
        if (agent) updateFixtureAgent(agent.id, { archivedAt: null });
        globalThis.__previewRestoreAudit = { before, after: { agentId: agent?.id, agentCount: rawAgents.length, userMessages: countUsers() } };
        result = { status: "restored", agentId: input.agentId, workspaceId: agent?.workspaceId ?? null, workspaceRestored: false, workspaceAction: null, message: "模拟会话已恢复" }; break;
      }
      // Restores answer at once here, so no job is ever polled; a stale id reads as unknown (the hook then asks the host).
      case "observatory.history.restore.status": result = null; break;
      case "observatory.provider-subagents.list": result = { subagents: input.parentAgentId === "payment-root" ? nativeChildren : [], error: null, truncated: false }; break;
      case "observatory.provider-subagents.timeline": result = { page: nativeTimeline(input.parentAgentId, input.subagentId), error: null }; break;
      // 提醒 (2.17): the preview has no Claude logs and no host labels.
      case "observatory.cache.get": result = { mode: "full", revision: "fixture", agents: [] }; break;
      case "observatory.alerts.labels": result = { state: "off", labels: 0, pins: 0, error: null }; break;
      default: throw new Error(`No development fixture for ${contract.name}`);
    }
    if(contract.name==="observatory.results.get"&&scenarioName()==="long-history"){
      const epoch=`long-${input.agentId}`;
      result={...result,epoch,firstInput:{text:longFirstInput,ref:`${input.agentId}:${epoch}:1-1`,at:new Date(Date.now()-3600000).toISOString(),truncated:false,completeOrigin:true},latestReply:{text:longLatestReply,ref:`${input.agentId}:${epoch}:1200-1200`,at:new Date().toISOString(),truncated:false},metrics:{tools:1197,failedTools:0,changedFiles:32,userTurns:2},coverage:{firstInputConfirmed:true,truncated:false,rows:1200,hasOlder:false,reason:null}};
    }
    if(contract.name==="observatory.results.get"&&scenarioName()==="unknown-origin")result={...result,firstInput:result.firstInput?{...result.firstInput,completeOrigin:false}:null,coverage:{...result.coverage,firstInputConfirmed:false,truncated:true,hasOlder:true,reason:"模拟宿主仅保留部分历史"}};
    // Revisioned host replies (Paseo 0.9 plugin 2.1): fixtures are always complete snapshots.
    if(revisioned.has(contract.name)&&result&&typeof result==="object"&&!("mode" in result))result={...result,mode:"full",unchanged:false,revision:`fixture-${++fixtureRevision}`};
    return contract.output.parse(result);
  }, [contract.name]);
}

// Host stand-ins: real Lucide icons (the host resolves the same names from lucide-react-native and renders
// nothing for unknown ones, so unknown names are reported as preview errors), a themed modal and visible toasts.
export function Icon({ name, size = 16, color = "currentColor" }) {
  const Glyph = Lucide[name] ?? Lucide[`${name}Icon`];
  if (!Glyph) { console.error(`Unknown Lucide icon: ${name}`); return null; }
  return <Glyph size={size} color={color} strokeWidth={1.75} style={{ flexShrink: 0 }} aria-hidden="true" />;
}
export async function copyText(text) { globalThis.__previewClipboard = text; }
export { ScrollView, FlatList, TextInput };
const theme = () => globalThis.__previewTheme;
export function Modal({ title, open, onOpenChange, children }) {
  useEffect(() => { if (!open) return; const key = event => { if (event.key === "Escape") onOpenChange(false); }; document.addEventListener("keydown", key); return () => document.removeEventListener("keydown", key); }, [open, onOpenChange]);
  if (!open) return null;
  const { colors } = theme();
  const phone = innerWidth < 700;
  return createPortal(<div onClick={event => { if (event.target === event.currentTarget) onOpenChange(false); }} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: phone ? "flex-end" : "center", justifyContent: "center", zIndex: 1000 }}>
    <div role="dialog" aria-modal="true" aria-label={title} style={{ width: phone ? "100%" : 460, maxWidth: "100%", maxHeight: phone ? "88vh" : "80vh", display: "flex", flexDirection: "column", background: colors.surface0, border: `1px solid ${colors.border}`, borderRadius: phone ? "14px 14px 0 0" : 12, overflow: "hidden", fontFamily: "inherit" }}>
      <div style={{ display: "flex", alignItems: "center", minHeight: 48, padding: "0 8px 0 16px", borderBottom: `1px solid ${colors.border}` }}>
        <div style={{ flex: 1, color: colors.foreground, fontSize: 15, fontWeight: 500 }}>{title}</div>
        <button aria-label="关闭" onClick={() => onOpenChange(false)} style={{ width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", border: 0, borderRadius: 8, background: "transparent", cursor: "pointer" }}><Icon name="X" size={16} color={colors.foregroundMuted} /></button>
      </div>
      {children}
    </div>
  </div>, document.body);
}
Modal.Content = function Content({ children, contentContainerStyle }) {
  return <ScrollView style={{ flexShrink: 1 }} contentContainerStyle={[{ padding: 24, gap: 16 }, contentContainerStyle]}>{children}</ScrollView>;
};

let toastSequence = 0;
const toastListeners = new Set();
let toasts = [];
function pushToast(message, variant) {
  const id = ++toastSequence;
  toasts = [...toasts.slice(-2), { id, message, variant }];
  globalThis.__previewToasts = [...(globalThis.__previewToasts ?? []), { message, variant }];
  for (const listener of toastListeners) listener();
  setTimeout(() => { toasts = toasts.filter(toast => toast.id !== id); for (const listener of toastListeners) listener(); }, 6000);
}
const toastApi = { show: (message, options) => pushToast(message, options?.variant ?? "default"), error: message => pushToast(message, "error") };
export function useToast() { return toastApi; }
export function ToastHost() {
  const [, setVersion] = useState(0);
  useEffect(() => { const listener = () => setVersion(value => value + 1); toastListeners.add(listener); return () => toastListeners.delete(listener); }, []);
  const { colors } = theme();
  return <div role="status" aria-live="polite" style={{ position: "fixed", left: 0, right: 0, bottom: 20, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, pointerEvents: "none", zIndex: 2000 }}>
    {toasts.map(toast => <div key={toast.id} style={{ maxWidth: "min(420px, calc(100vw - 32px))", padding: "9px 14px", borderRadius: 10, background: colors.surface2, border: `1px solid ${toast.variant === "error" ? colors.statusDanger : colors.border}`, color: toast.variant === "error" ? colors.statusDanger : colors.foreground, fontSize: 13, lineHeight: "19px", boxShadow: "0 6px 24px rgba(0,0,0,0.18)" }}>{toast.message}</div>)}
  </div>;
}


// Host settings controls used by the in-app language, 提醒 and 每轮小结 sections. Only the fixture preview uses DOM elements.
let displaySettingsValues = { runningBar: true };
const displaySettingsListeners = new Set();
function subscribeDisplaySettings(listener) { displaySettingsListeners.add(listener); return () => displaySettingsListeners.delete(listener); }
function saveDisplaySettings(next) { displaySettingsValues = { ...displaySettingsValues, ...next }; for (const listener of displaySettingsListeners) listener(); }
export function useSettings(definition) {
  // 每轮小结's host setting (`recap`): the same values the recap fixtures answer with.
  const [recap, setRecap] = useState(() => ({ ...fixtureRecapSettings }));
  useEffect(() => subscribeRecapSettings(() => setRecap({ ...fixtureRecapSettings })), []);
  // The running bar's host setting (`display`): one shared value, so flipping the switch updates every open detail.
  const [display, setDisplay] = useState(() => ({ ...displaySettingsValues }));
  useEffect(() => subscribeDisplaySettings(() => setDisplay({ ...displaySettingsValues })), []);
  // The language setting starts from the preview's language; any other (提醒, 2.17) from its schema's defaults.
  const [values, setValues] = useState(() => definition?.id && definition.id !== "language" && definition.schema?.parse ? definition.schema.parse({}) : { language: previewLanguage });
  if (definition?.id === "recap") return { status: "ready", revision: "fixture", values: recap, saving: false, saveError: null,
    async save(next) { saveRecapSettings(next); return true; }, async reset() { saveRecapSettings({ enabled: false, suggestions: false, runner: { kind: "grok" } }); return true; }, async reload() {} };
  if (definition?.id === "display") return { status: "ready", revision: "fixture", values: display, saving: false, saveError: null,
    async save(next) { saveDisplaySettings(next); return true; }, async reset() { saveDisplaySettings({ runningBar: true }); return true; }, async reload() {} };
  return { status: "ready", revision: "fixture", values, saving: false, saveError: null,
    async save(next) { setValues(next); if (typeof next.language === "string") setPreviewLanguage(next.language === "auto" ? "zh-CN" : next.language); return true; } };
}
export function SettingsSection({ title, children }) {
  return <section style={{ color: theme().colors.foreground, display: "flex", flexDirection: "column", gap: 8 }}><h3 style={{ fontSize: 14, margin: 0 }}>{title}</h3>{children}</section>;
}
export function SettingsCard({ children }) {
  return <div style={{ border: `1px solid ${theme().colors.border}`, borderRadius: 8, padding: 10, display: "flex", flexDirection: "column", gap: 12 }}>{children}</div>;
}
export function SettingsRow({ label, hint, children, error }) {
  return <div style={{ fontSize: 13 }}><div>{label}</div>{hint && <div style={{ fontSize: 11, color: theme().colors.foregroundMuted, marginTop: 4, overflowWrap: "anywhere" }}>{hint}</div>}{children}{error && <div role="alert">{error}</div>}</div>;
}
export function SettingsSelect({ label, hint, value, options, onValueChange, disabled, error }) {
  return <SettingsRow label={label} hint={hint} error={error}><select aria-label={label} value={value} onChange={event => onValueChange(event.target.value)} disabled={disabled} style={{ marginTop: 8, maxWidth: "100%" }}>{options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></SettingsRow>;
}
export function SettingsSwitch({ label, hint, value, onValueChange, disabled, error }) {
  return <SettingsRow label={label} hint={hint} error={error}><input type="checkbox" role="switch" aria-label={label} aria-checked={value ? "true" : "false"} checked={!!value} disabled={disabled} onChange={event => onValueChange(event.target.checked)} style={{ marginTop: 8 }} /></SettingsRow>;
}
export function SettingsAction({ label, actionLabel, onPress }) {
  return <SettingsRow label={label}><button onClick={onPress}>{actionLabel}</button></SettingsRow>;
}
