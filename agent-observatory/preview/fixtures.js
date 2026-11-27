// Development-only synthetic records. No production host or account data is read.
import { normalizeAgent } from "../shared/model";
import { emptyActivityMetrics } from "../shared/analytics";

const base = Date.now();
const ago = (seconds) => new Date(base - seconds * 1000).toISOString();
const source = (id, title, status, extra = {}) => {
  const record = {
  id, title, status, provider: "codex", model: "gpt-5.5", workspaceId: "commerce", workspaceName: "Checkout v2",
  projectId: "commerce-platform", projectName: "Commerce Platform", projectRootPath: "/workspace/commerce-platform",
  cwd: "/workspace/commerce-platform", parentAgentId: null, createdAt: ago(14_400), updatedAt: ago(20),
  lastUserMessageAt: ago(700), activeTurn: null, archivedAt: null, pendingPermissions: [],
  lastUsage: { inputTokens: 24_600, outputTokens: 4_180, cachedInputTokens: 16_240, totalCostUsd: 0.1842,
    contextWindowUsedTokens: 41_800, contextWindowMaxTokens: 200_000 }, ...extra,
  };
  if (id.startsWith("payment-")) {
    record.workspaceId = "commerce-payments-v2";
    record.workspaceName = "Checkout v2";
    record.cwd = "/workspace/worktrees/commerce-platform/payments-v2";
    record.checkout = { cwd: record.cwd, isGit: true, currentBranch: "feature/payments-v2", isPaseoOwnedWorktree: true,
      mainRepoRoot: "/workspace/commerce-platform", worktreeRoot: record.cwd };
  } else if (!record.checkout) {
    record.checkout = { cwd: record.cwd, isGit: true, currentBranch: "main", isPaseoOwnedWorktree: false,
      mainRepoRoot: null, worktreeRoot: record.projectRootPath || record.cwd };
  }
  if (record.attentionReason === "finished" && !record.attentionTimestamp) record.attentionTimestamp = record.updatedAt;
  return record;
};

export const rawAgents = [
  source("payment-root", "重构支付服务", "running", { activeTurn: { startedAt: ago(486) }, updatedAt: ago(2), labels: { initiative: "checkout-v2", owner: "platform" } }),
  source("payment-idempotency", "实现幂等请求", "running", { parentAgentId: "payment-root", activeTurn: { startedAt: ago(194) }, updatedAt: ago(5) }),
  source("payment-validation", "验证重复请求", "idle", { parentAgentId: "payment-idempotency", attentionReason: "finished", requiresAttention: true, updatedAt: ago(42) }),
  source("payment-tests", "补充接口测试", "idle", { parentAgentId: "payment-root", attentionReason: "finished", requiresAttention: false, updatedAt: ago(92) }),
  source("migration-review", "审查数据库迁移", "running", { provider: "claude", model: "sonnet", activeTurn: { startedAt: ago(244) }, updatedAt: ago(12),
    pendingPermissions: [{ id: "permission-1", kind: "tool", title: "执行数据库迁移检查", description: "运行只读检查并核对迁移计划。" },
      { id: "permission-2", kind: "question", title: "确认迁移目标环境", description: "选择预发布环境后继续。" }] }),
  source("release-check", "检查发布流水线", "error", { projectId: "delivery-systems", projectName: "Delivery Systems", projectRootPath: "/workspace/delivery", workspaceId: "delivery", workspaceName: "Release checks", cwd: "/workspace/delivery", updatedAt: ago(51), lastError: "测试数据库连接超时。已保留失败上下文，可在时间线查看。" }),
  source("iteration-plan", "规划下一轮迭代", "idle", { provider: "claude", model: "opus", projectId: "mobile-experience", projectName: "Mobile Experience", projectRootPath: "/workspace/mobile-experience", workspaceId: "mobile", workspaceName: "Sprint planning", cwd: "/workspace/mobile-experience", updatedAt: ago(530) }),
  source("performance-baseline", "整理性能基线", "idle", { attentionReason: "finished", requiresAttention: true, updatedAt: ago(196) }),
  source("mobile-bootstrap", "准备移动端测试", "initializing", { projectId: "mobile-experience", projectName: "Mobile Experience", projectRootPath: "/workspace/mobile-experience", workspaceId: "mobile", workspaceName: "Sprint planning", cwd: "/workspace/mobile-experience", createdAt: ago(8), updatedAt: ago(8) }),
  source("migration-draft", "更新迁移草案", "canceled", { updatedAt: ago(780) }),
  // Two sessions a schedule created (Paseo labels them): one still listed, one archived after its run (定时 badge, 定时任务 card).
  source("environment-closed", "归档环境诊断", "closed", { updatedAt: ago(1_280), labels: { "paseo.schedule-id": "7e2b90c4", "paseo.schedule-run": "b3f1a2c4-6d5e-4f70-8a9b-0c1d2e3f4a5b" } }),
  source("old-report", "上周版本报告", "closed", { createdAt: ago(2 * 86_400), lastUserMessageAt: ago(90_000), archivedAt: ago(86_400), updatedAt: ago(86_400),
    labels: { "paseo.schedule-id": "9c41d2aa", "paseo.schedule-run": "5d0e2c1a-7f43-4b8e-9a61-2f5c8d7e3b10" } }),
  source("renamed-project-check", "核对项目名称与工作区", "idle", { projectId: "growth-engine", projectName: "Growth Studio", projectRootPath: "/workspace/legacy-growth-engine", workspaceId: "growth-experiment", workspaceName: "Experiment 14", cwd: "/workspace/legacy-growth-engine", updatedAt: ago(240) }),
  source("archived-cycle", "十二天前的归档迭代", "closed", { projectId: "growth-engine", projectName: "Growth Studio", projectRootPath: "/workspace/legacy-growth-engine", workspaceId: "growth-experiment", workspaceName: "Experiment 14", cwd: "/workspace/legacy-growth-engine",
    createdAt: ago(14 * 86_400), lastUserMessageAt: ago(12 * 86_400 + 300), attentionReason: "finished", attentionTimestamp: ago(12 * 86_400), requiresAttention: false,
    archivedAt: ago(86_400), updatedAt: ago(86_400) }),
];

/**
 * ?scenario=attention-states: what needs you, each with its own look — a question with choices, a plan to approve, a usage
 * limit with its reset, a turn that stopped after a tool call, a running turn's todo progress and a full context window,
 * a merge request a reply linked and a heartbeat that will wake an Agent. The other scenarios are unchanged.
 */
export function applyAttentionScenario() {
  const set = (id, changes) => Object.assign(rawAgents.find(agent => agent.id === id), changes);
  set("migration-review", { pendingPermissions: [{ id: "question-1", kind: "question", title: "确认迁移目标环境",
    input: { questions: [{ question: "迁移先在哪个环境执行？", header: "环境", options: [{ label: "预发布" }, { label: "生产" }, { label: "两边都跑" }] }] } }] });
  rawAgents.splice(5, 0, source("orders-split", "拆分订单服务", "running", { provider: "claude", model: "opus", activeTurn: { startedAt: ago(300) }, updatedAt: ago(30),
    pendingPermissions: [{ id: "plan-1", kind: "plan", title: "批准计划", input: { plan: "# 订单服务拆成读写两层\n1. 抽出查询接口\n2. 迁移写路径" } }] }));
  set("payment-root", { lastUsage: { inputTokens: 176_000, outputTokens: 9_400, cachedInputTokens: 150_000, totalCostUsd: 2.41, contextWindowUsedTokens: 176_000, contextWindowMaxTokens: 200_000 } });
  // Its last turn's end was missed (read back later from the timeline): the host's attention is still from the turn before.
  set("renamed-project-check", { attentionReason: "finished", requiresAttention: true, attentionTimestamp: ago(900) });
  const reset = new Date(base + 6 * 3_600_000); reset.setMinutes(0, 0, 0);
  const records = new Map(fixtureTelemetry.agents.map(record => [record.agentId, record]));
  fixtureTelemetry.agents.push({ ...records.get("payment-root"), agentId: "orders-split" });
  Object.assign(records.get("performance-baseline"), { stop: { kind: "quota", resetAt: reset.toISOString(), at: ago(196) } });
  Object.assign(records.get("renamed-project-check"), { turnStartedAt: ago(700), turnEndedAt: null, outcome: null, stop: { kind: "unfinished", resetAt: null, at: ago(240) } });
  // Stops as a real host leaves them: a turn that ends on a limit notice, an empty turn or a tool call still ends "completed"
  // (the host's attention is set, unread), for a top-level Agent and for a subagent, which counts as well (gemini-F7).
  const stopped = (id, title, extra, turn) => {
    rawAgents.push(source(id, title, "idle", { attentionReason: "finished", requiresAttention: true, ...extra }));
    fixtureTelemetry.agents.push({ ...records.get("performance-baseline"), agentId: id, stop: null, turnStartedAt: extra.lastUserMessageAt, turnEndedAt: extra.updatedAt, outcome: "completed", ...turn });
  };
  stopped("contract-sync", "同步接口契约", { provider: "claude", model: "sonnet", lastUserMessageAt: ago(1_020), updatedAt: ago(380) }, { stop: { kind: "silent", resetAt: null, at: ago(380) } });
  // The notice gave a clock time without a zone: the reset is read in the device's zone, a guess (grok-F2).
  stopped("payment-refund-limit", "核对退款限额", { parentAgentId: "payment-root", provider: "claude", model: "opus", lastUserMessageAt: ago(610), updatedAt: ago(130) },
    { stop: { kind: "quota", resetAt: new Date(reset.getTime() - 3_600_000).toISOString(), resetGuessed: true, at: ago(130) } });
  // The host closed (unloaded) this one mid-turn, e.g. on a daemon restart: no attention of its own, only 知道了 here (opus-F34).
  rawAgents.push(source("nightly-index", "重建搜索索引", "closed", { projectId: "delivery-systems", projectName: "Delivery Systems", projectRootPath: "/workspace/delivery", workspaceId: "delivery", workspaceName: "Release checks", cwd: "/workspace/delivery",
    lastUserMessageAt: ago(1_500), updatedAt: ago(1_200), requiresAttention: false }));
  fixtureTelemetry.agents.push({ ...records.get("payment-root"), agentId: "nightly-index", turnStartedAt: ago(1_500), turnEndedAt: null, outcome: null, stop: { kind: "unfinished", resetAt: null, at: ago(1_200), closedMidTurn: true } });
  Object.assign(records.get("iteration-plan"), { link: { url: "https://git.example.com/mobile/app/-/merge_requests/128", label: "!128", kind: "mr" } });
  fixtureLiveExtras.push({ agentId: "payment-root", todo: { done: 3, total: 7, current: "补充幂等测试", at: ago(20) }, note: null, noteAt: null },
    { agentId: "iteration-plan", todo: null, note: "要不要先把登录改版排进这一轮？", noteAt: ago(500) });
  const wake = new Date(base + 86_400_000); wake.setHours(9, 0, 0, 0);
  fixtureHeartbeats.push({ scheduleId: "hb-iteration", agentId: "iteration-plan", name: "每天早上跟进迭代", status: "active", cadence: "每天 09:00", timezone: null,
    expression: "0 9 * * *", maxRuns: null, once: false, nextRunAt: wake.toISOString(), onceAt: null, runs: 3, lastRun: { status: "succeeded", startedAt: ago(86_400), endedAt: ago(86_100), error: null } });
}
/** Live extras and heartbeats the attention-states scenario fills in; empty otherwise. */
export const fixtureLiveExtras = [];
export const fixtureHeartbeats = [];

/** ?scenario=background: 整理性能基线 finished its turn while a subagent still works (后台执行中). */
export const fixtureBackground = { available: true, revision: "fixture-background", agents: [{ agentId: "performance-baseline", running: 1,
  since: ago(95), updatedAt: new Date(Math.floor(base / 60_000) * 60_000).toISOString(), labels: ["整理压测脚本"] }] };

// A tiny synthetic host store lets the real UI observe native read-state changes.
// Helpers are exported only into this development fixture bundle.
let fixtureRevision = 0;
const fixtureListeners = new Set();
const agentListeners = new Set();
export const fixtureReadReceipts = [];
export const fixtureArchiveOrigins = [];
export const getFixtureRevision = () => fixtureRevision;
export function subscribeFixtureChanges(listener) { fixtureListeners.add(listener); return () => fixtureListeners.delete(listener); }
export function subscribeFixtureAgents(listener) { agentListeners.add(listener); return () => agentListeners.delete(listener); }
export function updateFixtureAgent(agentId, changes) {
  const agent = rawAgents.find(candidate => candidate.id === agentId);
  if (!agent) return null;
  Object.assign(agent, changes);
  fixtureRevision++;
  for (const listener of agentListeners) listener({ kind: "upsert", agent: { ...agent } });
  for (const listener of fixtureListeners) listener();
  return agent;
}
/**
 * 知道了 on a stop, as the server records it (opus-F34): on the observed stop itself, only while `stopAt` is that stop. The
 * preview's mark handler calls it with `input.stopAt`; a stop the host raised no attention for is seen only this way.
 */
export function ackFixtureStop(agentId, stopAt) {
  const record = fixtureTelemetry.agents.find(item => item.agentId === agentId);
  if (!record?.stop || record.stop.at !== stopAt) return false;
  if (!record.stop.seenAt) {
    record.stop = { ...record.stop, seenAt: new Date().toISOString() };
    fixtureRevision++;
    for (const listener of fixtureListeners) listener();
  }
  return true;
}
export function readFixtureInNative(agentId) {
  const agent = rawAgents.find(candidate => candidate.id === agentId);
  if (!agent || agent.attentionReason !== "finished" || agent.pendingPermissions.length || agent.activeTurn) return false;
  updateFixtureAgent(agentId, { requiresAttention: false, attentionReason: null, attentionTimestamp: null });
  return true;
}
/** A new turn ends with a result; with `asks`, its reply asks the user something (待回复), as 规划下一轮迭代's does. */
export function completeFixtureAgent(agentId, { asks = false } = {}) {
  const agent = rawAgents.find(candidate => candidate.id === agentId);
  if (!agent) return null;
  const at = new Date(Math.max(Date.now(), Date.parse(agent.attentionTimestamp ?? agent.updatedAt) + 1)).toISOString();
  const lastUserMessageAt = new Date(Date.parse(at) - 1000).toISOString();
  const observed = fixtureTelemetry.agents.find(record => record.agentId === agentId);
  if (observed) Object.assign(observed, { turnStartedAt: lastUserMessageAt, turnEndedAt: at, outcome: "completed", ...(asks ? { replyAt: at, replyAsks: true } : {}) });
  const sequence = (agent.previewReply?.seq ?? 1000) + 1;
  return updateFixtureAgent(agentId, { status: "idle", activeTurn: null, pendingPermissions: [], lastUserMessageAt, attentionReason: "finished", requiresAttention: true, attentionTimestamp: at, updatedAt: at,
    previewReply: { seq: sequence, at, text: `新一轮结果：${agent.title} 已更新，当前结果版本 ${sequence}。` } });
}

export function fixtureAgents(includeArchived = true) {
  return rawAgents.filter(agent => includeArchived || !agent.archivedAt).map(agent => normalizeAgent(agent));
}

export const fixtureTelemetry = {
  startedAt: ago(7_200), persistenceError: null,
  agents: rawAgents.filter(agent => !agent.archivedAt).map(agent => ({ agentId: agent.id, turnStartedAt: agent.attentionReason === "finished" ? agent.lastUserMessageAt : ago(3_600), turnEndedAt: agent.attentionReason === "finished" ? agent.attentionTimestamp : ago(2_800),
    outcome: "completed", completedTurns: 4, failedTurns: agent.id === "release-check" ? 1 : 0, canceledTurns: 0,
    totalRunMs: 813_420, permissionWaitMs: 32_000,
    // 规划下一轮迭代 ended its turn with a question (待回复); 核对项目名称与工作区 stopped without a known result (空闲).
    ...(agent.id === "iteration-plan" ? { turnStartedAt: agent.lastUserMessageAt, turnEndedAt: agent.updatedAt, replyAt: agent.updatedAt, replyAsks: true } : {}) })),
  events: [
    ["migration-review", "permission_requested", "等待审批或回答", 12],
    ["payment-root", "turn_started", "开始执行新一轮任务", 48],
    ["payment-validation", "turn_completed", "完成重复请求验证", 92],
    ["release-check", "turn_failed", "执行失败 · 已保留上下文", 183],
    ["payment-tests", "turn_completed", "接口测试已完成", 240],
    ["payment-idempotency", "turn_started", "开始实现幂等请求", 420],
    ["performance-baseline", "turn_completed", "性能基线整理完成", 560],
    ["migration-draft", "turn_canceled", "任务已取消", 780],
    ["iteration-plan", "created", "创建新的 Agent", 940],
    ["payment-root", "permission_resolved", "请求已批准", 1_140],
    ["payment-root", "turn_completed", "完成上一轮任务", 1_460],
    ["payment-root", "turn_started", "开始配置检查", 1_840],
    ["release-check", "created", "创建发布检查 Agent", 2_520],
    ["payment-root", "created", "创建支付服务 Agent", 3_200],
  ].map(([agentId, type, label, seconds], index) => ({ id: `fixture-event-${index}`, agentId,
    agentTitle: rawAgents.find(agent => agent.id === agentId)?.title ?? agentId, at: ago(seconds), type, label,
    ...(type === "turn_completed" ? { durationMs: 86_420 } : {}) })),
};

const fixtureHour = Math.floor(base / 3_600_000) * 3_600_000;
const fixtureDay = Math.floor(base / 86_400_000) * 86_400_000;
function bucket(at, index, daily = false) {
  const hour = new Date(at).getUTCHours();
  const activity = daily ? 26 + (index * 17 % 48) : hour < 6 ? index % 3 : hour < 19 ? 4 + (index * 7 % 17) : 2 + index % 7;
  return { ...emptyActivityMetrics(), bucketStart: new Date(at).toISOString(), eventCount: activity * 3,
    started: activity, completed: Math.max(0, activity - 2), failed: activity ? index % 3 : 0, canceled: activity ? index % 2 : 0,
    runMs: activity * 54_300, runSamples: activity, waitMs: (index % 4) * 12_000,
    inputTokens: activity ? 14_000 + (index * 7381 % 52_000) : null, outputTokens: activity ? 1_400 + index * 157 % 9_000 : null,
    cachedTokens: activity ? 8_000 + index * 3301 % 28_000 : null, costUsd: activity ? 0.04 + index * 13 % 90 / 100 : null,
    usageSamples: activity ? 2 + index % 4 : 0 };
}
export const fixtureAnalytics = {
  startedAt: new Date(fixtureDay - 27 * 86_400_000).toISOString(), updatedAt: new Date(base).toISOString(), persistenceError: null,
  usageBasis: "provider_reported_snapshot", usageAggregation: "peak_per_bucket", agentsTruncated: false,
  coverageResolutionMs: 60_000,
  // The browser's own clock, as a server laying 明细 → 观测 out in the device's zone would send it (opus-F40).
  zone: { name: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } })(), offsets: [[0, -new Date().getTimezoneOffset()]] },
  coverageIntervals: [
    { start: new Date(fixtureDay - 27 * 86_400_000).toISOString(), end: new Date(fixtureDay - 2 * 86_400_000 + 3 * 3_600_000).toISOString() },
    { start: new Date(fixtureDay - 2 * 86_400_000 + 5 * 3_600_000).toISOString(), end: new Date(base).toISOString() },
  ],
  hours: Array.from({ length: 168 }, (_, index) => bucket(fixtureHour - (167 - index) * 3_600_000, index)).filter(item => {
    const at = Date.parse(item.bucketStart), gap = fixtureDay - 2 * 86_400_000 + 3 * 3_600_000;
    return at < gap || at >= gap + 2 * 3_600_000;
  }),
  days: Array.from({ length: 28 }, (_, index) => bucket(fixtureDay - (27 - index) * 86_400_000, index, true)),
  agents: rawAgents.map((agent, index) => ({ ...emptyActivityMetrics(), agentId: agent.id, provider: agent.provider,
    workspaceId: agent.workspaceId, projectId: agent.projectId, projectName: agent.projectName, projectRootPath: agent.projectRootPath,
    eventCount: 24 + index * 3, started: 6 + index, completed: 5 + index, failed: agent.id === "release-check" ? 2 : 0,
    runMs: 124_000 + index * 9_000, runSamples: 5 + index, waitMs: 24_000 + index * 2_000,
    inputTokens: 21_000 + index * 1210, outputTokens: 2800 + index * 320, cachedTokens: 12_000 + index * 760,
    costUsd: 0.08 + index * 0.021, usageSamples: 5 + index })),
  usage: Array.from({ length: 48 }, (_, index) => {
    const agent = rawAgents[index % rawAgents.length];
    return { id: `fixture-usage-${index}`, agentId: agent.id, provider: agent.provider, workspaceId: agent.workspaceId,
      projectId: agent.projectId, at: ago(index * 312), inputTokens: 21_000 + index * 721 % 39_000,
      outputTokens: 2100 + index * 179 % 6_000, cachedTokens: 9000 + index * 413 % 16_000, costUsd: index % 4 === 0 ? null : 0.092 + index * 0.007 };
  }),
};

export function fixtureProjectAnalytics(projectId) {
  if (!projectId) return fixtureAnalytics;
  const agents = fixtureAnalytics.agents.filter(agent => agent.projectId === projectId);
  const ratio = agents.length / fixtureAnalytics.agents.length;
  const share = row => ({ ...row, eventCount: Math.floor(row.eventCount * ratio), started: Math.floor(row.started * ratio), completed: Math.floor(row.completed * ratio), failed: Math.floor(row.failed * ratio), canceled: Math.floor(row.canceled * ratio), runMs: Math.floor(row.runMs * ratio), runSamples: Math.floor(row.runSamples * ratio), waitMs: Math.floor(row.waitMs * ratio) });
  return { ...fixtureAnalytics, projectId, projectHistoryTruncated: false, agents, usage: fixtureAnalytics.usage.filter(sample => sample.projectId === projectId), hours: fixtureAnalytics.hours.map(share), days: fixtureAnalytics.days.map(share) };
}

export const fixtureInsightState = { settings: { autoEnabled: false, minTurns: 3, minTools: 3, cooldownHours: 6, runner: { kind: "auto" } },
  jobs: [], persistenceError: null, available: true };
export function fixtureInsight(agentId) {
  const agent = rawAgents.find(agent => agent.id === agentId) ?? rawAgents[0];
  return { id: `fixture-insight-${agentId}`, agentId, agentTitle: agent.title, projectName: agent.projectName,
    createdAt: ago(5), updatedAt: ago(0), status: "completed", trigger: "manual", stage: "模拟分析完成",
    eligibility: { eligible: true, turnCount: 4, toolCount: 12, reason: "模拟会话包含足够轨迹" },
    coverage: { rows: 28, truncated: false, oldestAt: ago(1800), newestAt: ago(0), characters: 4200 },
    report: { summary: "模拟报告：任务拆分清晰，核心接口验证已经完成；测试环境稳定性仍需要关注。",
      health: "watch", confidence: "medium", findings: [{ id: "fixture-finding", severity: "medium", category: "efficiency",
        title: "复用已通过的测试结果", detail: "模拟轨迹中存在重复验证，可将无变化的检查合并。", evidence: [`${agentId}:fixture-${agentId}:5-5`],
        recommendation: "在代码变更后运行受影响的测试，并在合并前执行完整回归。" }],
      strengths: ["主任务与子任务分工明确", "失败保留了可检查的执行上下文"], nextActions: ["确认数据库连接后复验异常路径"],
      limitations: ["这是开发预览模拟数据，未调用真实 AI 模型。"] },
    evidence: [{ ref: `${agentId}:fixture-${agentId}:5-5`, at: ago(300), kind: "tool_call", toolName: "exec_command",
      text: "$ npm run test -- --runInBand\nPASS payments/idempotency.test.ts\n✓ repeated request returns its original order\n✓ conflicting payload is rejected\n✓ concurrent retries preserve one order\nTests: 18 passed, 18 total\n原始执行输出：本轮接口测试通过，未检测到重复订单。" }],
    model: "grok-4.7", effort: "xhigh", usage: null, error: null };
}

const row = (seq, item) => ({ seqStart: seq, seqEnd: seq, timestamp: ago(500 - seq * 25), item });
/** 检查发布流水线's verbose rerun: one output with two connection resets 211 lines apart (查找 steps from one to the other inside it). */
const verboseIntegrationRun = ["> delivery@3.2.0 test:integration --verbose", "[db] ECONNRESET staging-database:5432 (retry 1/3)",
  ...Array.from({ length: 210 }, (_, index) => `  ✓ release check ${String(index + 1).padStart(3, "0")} passed (${12 + index % 40} ms)`),
  "[db] ECONNRESET staging-database:5432 (retry 3/3), giving up", "Tests: 1 failed, 210 passed, 211 total"].join("\n");
const page = (rows, agentId, older = false) => ({ epoch: `fixture-${agentId}`, rows,
  startCursor: { epoch: `fixture-${agentId}`, seq: rows[0]?.seqStart ?? 0 },
  endCursor: { epoch: `fixture-${agentId}`, seq: rows.at(-1)?.seqEnd ?? 0 },
  hasOlder: !older, hasNewer: false, reset: false, gap: false,
  agent: rawAgents.find(agent => agent.id === agentId) ?? null });

export function fixtureTimeline(agentId, direction = "tail") {
  if (agentId === "archived-cycle" || agentId === "old-report") {
    const age = agentId === "archived-cycle" ? 12 * 86_400 : 90_000;
    return page([
      row(1, { type: "user_message", text: "保留这个历史迭代的上下文，检查实验配置。" }),
      row(2, { type: "tool_call", callId: `${agentId}-read`, name: "read_file", status: "completed", detail: { type: "read", filePath: "config/experiment.json", output: '{"experiment":"14","enabled":true}' } }),
      row(3, { type: "assistant_message", text: "已检查历史配置，实验参数一致。" }),
      row(4, { type: "user_message", text: "继续验证结果，并记录归档前的总结。" }),
      row(5, { type: "tool_call", callId: `${agentId}-test`, name: "exec_command", status: "completed", detail: { type: "shell", command: "npm run test:experiment", output: "6 experiment tests passed", exitCode: 0 } }),
      row(6, { type: "assistant_message", text: "历史迭代已完成，原会话保留两轮交互与测试证据。" }),
    ].map((item, index) => ({ ...item, timestamp: ago(age + 600 - index * 60) })), agentId, true);
  }
  if (direction === "before") return page([row(0, { type: "assistant_message", text: "历史上下文：已完成需求拆解，接下来验证支付服务的幂等性。" })], agentId, true);
  if (agentId === "release-check") return page([
    row(1, { type: "user_message", text: "检查本次发布的测试与数据库连接。" }),
    row(2, { type: "tool_call", callId: "failure-command", name: "exec_command", status: "failed", detail: { type: "shell", command: "npm run test:integration", output: "Connection timed out: staging-database:5432", exitCode: 1 } }),
    row(3, { type: "tool_call", callId: "verbose-command", name: "exec_command", status: "failed", detail: { type: "shell", command: "npm run test:integration -- --verbose", output: verboseIntegrationRun, exitCode: 1 } }),
    row(4, { type: "error", message: "集成测试未通过：数据库连接超时。" }),
  ], agentId);
  const items = [
    row(1, { type: "user_message", text: "为支付接口增加幂等保障，补充回归测试，并确认移动端重试不会产生重复订单。" }),
    row(2, { type: "todo", items: [{ id: "plan-1", text: "梳理现有请求链路与边界条件", status: "completed" }, { id: "plan-2", text: "实现幂等校验并补充接口测试", status: "in_progress" }, { id: "plan-3", text: "运行回归测试并检查异常路径", status: "pending" }] }),
    row(3, { type: "reasoning", text: "先确认请求重试与写入事务的边界，再验证缓存失效时的重复提交行为。" }),
    row(4, { type: "tool_call", callId: "read-config", name: "read_file", status: "completed", detail: { type: "read", filePath: "src/payments/create-order.ts", output: "export async function createOrder(request) {\n  return transaction(() => persistOrder(request));\n}" } }),
    row(5, { type: "tool_call", callId: "fixture-command", name: "exec_command", status: "completed", detail: { type: "shell", command: "npm run test -- --runInBand", cwd: rawAgents.find(agent => agent.id === agentId)?.cwd ?? "/workspace/commerce-platform", output: "PASS payments/idempotency.test.ts\n✓ returns the original order for a repeated request\n✓ rejects conflicting payloads with the same request key\nTests: 18 passed, 18 total", exitCode: 0 } }),
    row(6, { type: "tool_call", callId: "fixture-subagent", name: "spawn_agent", status: "running", detail: { type: "sub_agent", description: "验证数据库唯一约束", childSessionId: "native-database", log: "正在检查并发写入边界。" } }),
    row(7, { type: "assistant_message", text: "幂等校验已经接入，18 项接口测试通过。正在等待子任务返回并发写入验证结果。" }),
    row(8, { type: "tool_call", callId: "fixture-live-command", name: "exec_command", status: "running", detail: { type: "shell", command: "npm run test:concurrency", output: "Running 120 concurrent requests…" } }),
  ];
  const reply = rawAgents.find(agent => agent.id === agentId)?.previewReply;
  if (reply) items.push({ ...row(reply.seq, { type: "assistant_message", text: reply.text }), timestamp: reply.at });
  return page(items, agentId);
}

export const longFirstInput = "最初需求：为支付链路提供可靠的幂等保障，并保留每一步验证的证据。";
export const longLatestReply = ["最终结果：长会话中的最新结论优先展示。", ...Array.from({ length: 70 }, (_, index) => `验证记录 ${index + 1}：重复请求、并发写入与重试边界均保留了可核对的结果。`), "结果末尾：长内容完整可读。"].join("\n\n");
export function longFixtureTimeline(agentId, { direction = "tail", cursor } = {}) {
  const all = Array.from({ length: 1200 }, (_, index) => ({ seqStart: index + 1, seqEnd: index + 1, timestamp: ago(3600 - index * 2),
    item: { type: "tool_call", callId: `long-${index}`, name: "read_file", status: "completed", detail: { type: "read", filePath: `src/check-${index}.ts`, output: `检查 ${index} 已完成` } } }));
  all[0].item = { type: "user_message", text: longFirstInput };
  all[1197].item = { type: "user_message", text: "最后请汇总本轮验证结果。" };
  all[1199].item = { type: "assistant_message", text: longLatestReply };
  const end = direction === "before" ? Math.max(0, Number(cursor?.seq ?? 1201) - 1) : all.length;
  const selected = all.slice(Math.max(0, end - 100), end);
  return { epoch: `long-${agentId}`, rows: selected, startCursor: { epoch: `long-${agentId}`, seq: selected[0]?.seqStart ?? 0 }, endCursor: { epoch: `long-${agentId}`, seq: selected.at(-1)?.seqEnd ?? 0 },
    hasOlder: end > 100, hasNewer: end < all.length, reset: false, gap: false, agent: rawAgents.find(agent => agent.id === agentId) };
}

export const nativeChildren = [
  { id: "native-database", parentAgentId: "payment-root", parentSubagentId: null, provider: "codex", title: "验证数据库唯一约束", description: "验证数据库唯一约束", status: "running", createdAt: ago(200), updatedAt: ago(8) },
  { id: "native-retry", parentAgentId: "payment-root", parentSubagentId: "native-database", provider: "codex", title: "检查并发重试边界", description: "检查并发重试边界", status: "completed", createdAt: ago(180), updatedAt: ago(35) },
  { id: "native-infrastructure", parentAgentId: "payment-root", parentSubagentId: null, provider: "claude", title: "检查测试环境", description: "检查测试环境", status: "failed", createdAt: ago(160), updatedAt: ago(50) },
];

export function nativeTimeline(agentId, childId) {
  return page([
    row(1, { type: "user_message", text: "验证请求重试与数据库唯一约束的边界行为。" }),
    row(2, { type: "tool_call", callId: `${childId}-test`, name: "exec_command", status: "completed", detail: { type: "shell", command: "npm run test:constraints", output: "12 constraint tests passed", exitCode: 0 } }),
    row(3, { type: "assistant_message", text: "子任务验证已通过：重复请求只产生一条订单记录。" }),
  ], agentId, true);
}
