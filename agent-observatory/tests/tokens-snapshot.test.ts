import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { emptyTokenCounts, MAX_TOKEN_ROOTS, TOKEN_SOURCES, TOKEN_UNMATCHED, tokenSnapshotSchema, tokenTotal, type TokenSnapshot } from "../shared/tokens";
import { StatsDirectory } from "../server/stats-directory";
import type { StatsDirectoryAgent } from "../server/stats-types";
import { addCall, binSpeed, emptyData, noteThread, pruneData, rootSession, settleCall, speedBin } from "../server/tokens/data";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { DAY, type LedgerCall } from "../server/tokens/types";

const now = Date.parse("2026-09-23T20:00:00.000Z");
const coverage: TokenSnapshot["coverage"] = { earliestAt: null, latestAt: null,
  backfill: { done: true, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, roots: [] };
function call(key: string, at = now - 1000, patch: Partial<LedgerCall> = {}): LedgerCall {
  return { key, source: "claude", sessionId: "session", cwd: "/work/project", at, start: at - 1000, model: "claude-sonnet",
    input: 10, cacheWrite: 20, cacheRead: 30, output: 100, reasoning: 0, subagent: false, ...patch };
}
function agent(id: string, patch: Partial<StatsDirectoryAgent> = {}): StatsDirectoryAgent {
  return { id, createdAt: "2026-09-01T00:00:00.000Z", provider: "claude", model: null, parentAgentId: null, projectKey: "named-project",
    projectName: "观测项目", status: "idle", archivedAt: null, title: "观测会话", requiresAttention: false, attentionReason: null,
    pendingPermissions: 0, activeTurn: false, contextUsed: null, contextMax: null, sessionId: "session", cwd: "/work/project", ...patch };
}

test("token snapshot has complete empty local days and nullable records", () => {
  const result = tokenSnapshotSchema.parse(buildTokenSnapshot(emptyData(), { range: "7d", utcOffsetMinutes: 480 }, now, new StatsDirectory(), coverage));
  assert.equal(result.from, "2026-09-18"); assert.equal(result.to, "2026-09-24"); assert.equal(result.daily.length, 7);
  assert.deepEqual(result.totals, emptyTokenCounts()); assert.deepEqual(result.previous, emptyTokenCounts());
  assert.deepEqual(result.records, { peakDay: null, fastest: null, biggest: null }); assert.deepEqual(result.speed, { p50: null, p90: null });
  assert.equal(result.paseoShare, null); assert.deepEqual(result.hours, Array(24).fill(0));
});

test("token snapshot shifts UTC buckets into local days and hours", () => {
  const data = emptyData();
  addCall(data, call("before", Date.parse("2026-09-23T15:59:00Z")), null, now);
  addCall(data, call("after", Date.parse("2026-09-23T16:01:00Z"), { output: 200 }), null, now);
  const directory = new StatsDirectory();
  const utc = buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, directory, coverage);
  const east = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 480 }, now, directory, coverage));
  assert.equal(utc.daily.at(-1)?.calls, 2); assert.equal(east.daily.at(-2)?.calls, 1); assert.equal(east.daily.at(-1)?.calls, 1);
  assert.equal(utc.to, "2026-09-23"); assert.equal(east.to, "2026-09-24"); assert.equal(east.hours[23], 160); assert.equal(east.hours[0], 260);
  for (const utcOffsetMinutes of [-840, -210, 330, 840]) tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes }, now, directory, coverage));
});

test("previous period includes old daily storage and allTime uses retained 400 days", () => {
  const data = emptyData();
  for (const daysAgo of [0, 89, 90, 91, 92, 179, 180, 399, 400]) addCall(data, call(`old-${daysAgo}`, now - daysAgo * DAY), null, now);
  pruneData(data, now);
  const result = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "90d", utcOffsetMinutes: 0 }, now, new StatsDirectory(), coverage));
  assert.equal(result.totals.calls, 2); assert.equal(result.previous.calls, 4); assert.equal(result.allTime.calls, 8);
  assert.equal(result.daily[0].calls, 1); assert.equal(result.daily.at(-1)?.calls, 1); assert.equal(result.from, "2026-06-26");
});

test("breakdowns union sessions, merge exact cwd matches, and retain range-local session models", () => {
  const data = emptyData(), directory = new StatsDirectory();
  directory.agents = [agent("paseo", { archivedAt: "2026-09-23T10:00:00Z" }), agent("nearby", { cwd: "/work/project-extra", projectName: "别的项目", sessionId: "unused" })];
  addCall(data, call("one", now - 1000, { model: "gpt-5.5", output: 800, subagent: true }), null, now);
  addCall(data, call("two", now - 2000, { model: "claude-sonnet", output: 100 }), null, now);
  addCall(data, call("three", now - 3000, { model: "claude-sonnet", output: 100 }), null, now);
  addCall(data, call("other", now - 4000, { source: "codex", sessionId: "other", cwd: "/work/project/child", model: "gpt-5.5", output: 500 }), null, now);
  addCall(data, call("older", now - 20 * DAY, { model: "older-model", output: 10000 }), null, now);
  const result = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, directory, coverage));
  assert.equal(result.models.find(row => row.key === "gpt-5.5")?.vendor, "openai"); assert.equal(result.models.find(row => row.key === "gpt-5.5")?.sessions, 2);
  assert.equal(result.models.find(row => row.key === "claude-sonnet")?.sessions, 1); assert.equal(result.sources.find(row => row.key === "claude")?.sessions, 1);
  assert.equal(result.projects.find(row => row.key === "named-project")?.label, "观测项目"); assert.equal(result.projects.find(row => row.label === "child")?.sessions, 1);
  const session = result.sessions[0]; assert.equal(session.agentId, "paseo"); assert.equal(session.title, "观测会话"); assert.equal(session.model, "claude-sonnet");
  assert.equal(session.subagentCalls, 1); assert.equal(session.calls, 3); assert.equal(session.firstAt, new Date(now - 3000).toISOString());
  assert.equal(result.paseoShare, 1180 / 1740); assert.equal(result.totals.calls, 4); assert.equal(result.allTime.calls, 5);
});

test("other rows conserve token counts and count a session only once across omitted models", () => {
  const data = emptyData();
  for (let i = 0; i < 30; i++) addCall(data, call(`call-${i}`, now - 1000 - i, { model: `model-${String(i).padStart(2, "0")}`, cwd: `/work/project-${i}`, output: 3000 - i * 90 }), null, now);
  const result = buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, new StatsDirectory(), coverage);
  for (const rows of [result.models, result.projects]) {
    assert.equal(rows.length, 24); assert.equal(rows.at(-1)?.key, "__other__"); assert.equal(rows.at(-1)?.label, "其他");
    assert.equal(rows.at(-1)?.sessions, 1); assert.equal(rows.at(-1)?.calls, 7); assert.equal(rows.reduce((sum, row) => sum + tokenTotal(row), 0), tokenTotal(result.totals));
  }
  assert.equal(result.sessions.length, 1); assert.equal(result.sessions[0].calls, 30);
});

test("fastest and speed percentiles share eligibility while biggest considers all calls", () => {
  const data = emptyData();
  for (let i = 1; i <= 10; i++) addCall(data, call(`speed-${i}`, now - i * 10000, { output: i * 100, start: now - i * 10000 - 1000 }), null, now);
  addCall(data, call("unknown-start", now - 1, { output: 9000, start: null }), null, now);
  addCall(data, call("short", now - 2, { output: 2000, start: now - 102 }), null, now);
  addCall(data, call("little", now - 3, { output: 99, start: now - 1003 }), null, now);
  addCall(data, call("old-fastest", now - 20 * DAY, { output: 20000, start: now - 20 * DAY - 1000 }), null, now);
  const result = buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, new StatsDirectory(), coverage);
  assert.equal(result.records.fastest?.tps, 1000); assert.equal(result.records.biggest?.output, 9000);
  assert.equal(result.speed.p50, binSpeed(speedBin(500))); assert.equal(result.speed.p90, binSpeed(speedBin(900)));
  assert.equal(result.records.peakDay?.day, "2026-09-23");
});

test("最长的一次输出 is one model call's output: never a Grok turn record, nor any record of several calls (r3-F5)", () => {
  const data = emptyData(), at = (ms: number) => new Date(ms).toISOString();
  addCall(data, call("single", now - 5000, { output: 30_000 }), null, now);
  // A Grok turn of six model calls: its output is the six together, more than any one of them wrote.
  addCall(data, call("grok-turn", now - 4000, { source: "grok", sessionId: "grok-session", model: "grok-test", start: null, output: 50_000, calls: 6 }), null, now);
  // usage.json sums each turn per model even where it counts one call; and several calls are not one from any source.
  addCall(data, call("grok-one", now - 3000, { source: "grok", sessionId: "grok-session", model: "grok-test", start: null, output: 60_000 }), null, now);
  addCall(data, call("several", now - 2000, { source: "pi", model: "pi-test", output: 70_000, calls: 2 }), null, now);
  const read = () => buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, new StatsDirectory(), coverage);
  assert.deepEqual(read().records.biggest, { output: 30_000, model: "claude-sonnet", at: at(now - 5000) });
  // Settled calls keep their own records: the same rule holds there.
  for (const key of ["single", "grok-turn", "grok-one", "several"]) settleCall(data, data.mutable.get(key)!, now);
  assert.deepEqual(read().records.biggest, { output: 30_000, model: "claude-sonnet", at: at(now - 5000) });
  assert.equal(read().totals.calls, 1 + 6 + 1 + 2, "they still count everywhere else");
});

test("snapshot is independent from mutable storage and directory records", () => {
  const data = emptyData(), directory = new StatsDirectory(); directory.agents = [agent("one")]; addCall(data, call("one"), null, now);
  const before = JSON.stringify([...data.hours.values()]);
  const first = buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, directory, coverage);
  assert.deepEqual(first, buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, directory, coverage));
  first.totals.calls++; first.daily.at(-1)!.calls++; first.sessions[0].calls++; first.models[0].calls++; first.coverage.backfill.files++;
  assert.equal(JSON.stringify([...data.hours.values()]), before); assert.equal(coverage.backfill.files, 0);
});

test("90-day snapshot keeps worst-case Unicode metadata below 60 KB without losing breakdown totals", context => {
  const data = emptyData(), directory = new StatsDirectory(); directory.loaded = true;
  for (let i = 0; i < 2000; i++) {
    const id = `${String(i).padStart(4, "0")}${"会".repeat(250)}`, cwd = `/work/${"项".repeat(240)}-${i % 60}`;
    // Every fourth session has no agent (未关联会话); providers carry 1,000-character ids.
    if (i % 4) directory.agents.push(agent(id, { sessionId: id, cwd, title: "标".repeat(240), projectKey: `${"键".repeat(1000)}-${i % 60}`, projectName: "目".repeat(240), provider: `${"供".repeat(1000)}-${i % 60}` }));
    addCall(data, call(`fixture-${i}`, now - i % 90 * DAY - i, { sessionId: id, cwd, model: `${"模".repeat(240)}-${i % 60}`,
      source: TOKEN_SOURCES[i % TOKEN_SOURCES.length]!, input: 123456789, cacheRead: 987654321, output: 99999999 }), null, now);
  }
  const roots: TokenSnapshot["coverage"]["roots"] = Array.from({ length: MAX_TOKEN_ROOTS }, (_, index) => ({ source: TOKEN_SOURCES[index % TOKEN_SOURCES.length]!, path: "/" + "路".repeat(1023), files: 5000, error: "错".repeat(240) }));
  const result = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "90d", utcOffsetMinutes: 480 }, now, directory, { ...coverage, roots }));
  const bytes = Buffer.byteLength(JSON.stringify(result)); context.diagnostic(`Worst-case token snapshot: ${bytes} bytes, ${result.sessions.length} sessions, ${result.models.length} model rows.`);
  assert.ok(bytes < 60_000); assert.equal(result.daily.length, 90); assert.ok(result.sessions.length <= 20); assert.ok(result.sessions.length >= 5);
  assert.equal(result.coverage.roots.length, MAX_TOKEN_ROOTS, "the payload budget must not hide monitored roots");
  assert.equal(result.sources.length, TOKEN_SOURCES.length, "every harness remains represented");
  assert.ok(result.sessions.every(row => row.agentId === null || directory.agents.some(entry => entry.id === row.agentId)));
  assert.equal(result.providers!.at(-1)!.key, TOKEN_UNMATCHED);
  for (const rows of [result.models, result.projects, result.sources, result.providers!]) assert.equal(rows.reduce((sum, row) => sum + tokenTotal(row), 0), tokenTotal(result.totals));
});

test("Provider 用量 ranks sessions by their agent's provider, tells providers sharing one log folder apart and keeps unmatched sessions apart", () => {
  const data = emptyData(), directory = new StatsDirectory(); directory.loaded = true;
  directory.agents = [agent("team", { provider: "claude-team", sessionId: "s-team" }), agent("relay", { provider: "claude-relay", sessionId: "s-relay" }),
    agent("gateway", { provider: "codex-gateway", sessionId: "s-codex" }), agent("idle", { provider: "claude-idle", sessionId: "never-logged" })];
  // Both Claude providers write to the same ~/.claude: one log source, two providers.
  addCall(data, call("t1", now - 1000, { sessionId: "s-team", model: "claude-sonnet", output: 100 }), null, now);
  addCall(data, call("t2", now - 2000, { sessionId: "s-team", model: "claude-sonnet", output: 100 }), null, now);
  addCall(data, call("r1", now - 3000, { sessionId: "s-relay", model: "claude-opus", output: 5000 }), null, now);
  addCall(data, call("c1", now - 4000, { source: "codex", sessionId: "s-codex", model: "gpt-5.5", output: 900 }), null, now);
  addCall(data, call("x1", now - 5000, { sessionId: "terminal-run", output: 300 }), null, now);
  const result = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, directory, coverage));
  assert.equal(result.sources.length, 2, "by log source the two Claude providers are one row");
  assert.deepEqual(result.providers!.map(row => [row.key, row.label, row.vendor, row.calls, row.sessions]), [
    ["claude-relay", "claude-relay", "anthropic", 1, 1], ["codex-gateway", "codex-gateway", "openai", 1, 1], ["claude-team", "claude-team", "anthropic", 2, 1],
    [TOKEN_UNMATCHED, "未关联会话", null, 1, 1]]);
  assert.equal(result.providers!.reduce((sum, row) => sum + tokenTotal(row), 0), tokenTotal(result.totals));
  // Until the agent directory has been read every session would look unmatched: no rows at all.
  assert.equal(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, new StatsDirectory(), coverage).providers, undefined);
});

test("Codex subagent threads count for the session that spawned them, through any depth and without loops", () => {
  const data = emptyData(), directory = new StatsDirectory(); directory.loaded = true;
  directory.agents = [agent("parent-agent", { provider: "codex-gateway", sessionId: "root-thread", title: "派出子 Agent 的会话" })];
  addCall(data, call("root", now - 4000, { source: "codex", sessionId: "root-thread", model: "gpt-5.5", output: 100 }), null, now);
  addCall(data, call("child", now - 3000, { source: "codex", sessionId: "child-thread", model: "gpt-5.5", output: 200, subagent: true }), null, now);
  // Counted before 2.13 knew the parent: no subagent flag, attributed when read all the same.
  addCall(data, call("grandchild", now - 2000, { source: "codex", sessionId: "grandchild-thread", model: "gpt-5.5", output: 300 }), null, now);
  addCall(data, call("loop", now - 1000, { source: "codex", sessionId: "loop-a", model: "gpt-5.5", output: 50 }), null, now);
  for (const [child, parent] of [["child-thread", "root-thread"], ["grandchild-thread", "child-thread"], ["loop-a", "loop-b"], ["loop-b", "loop-a"]]) noteThread(data, child, parent);
  const result = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, directory, coverage));
  const root = result.sessions.find(session => session.sessionId === "root-thread")!;
  assert.equal(root.agentId, "parent-agent"); assert.equal(root.calls, 3); assert.equal(root.subagentCalls, 2); assert.equal(root.output, 600);
  assert.ok(!result.sessions.some(session => session.sessionId === "child-thread" || session.sessionId === "grandchild-thread"));
  assert.equal(result.models.find(row => row.key === "gpt-5.5")!.sessions, 2, "a parent and its threads are one session (the loop is another)");
  assert.deepEqual(result.providers!.map(row => [row.key, row.calls]), [["codex-gateway", 3], [TOKEN_UNMATCHED, 1]]);
  assert.equal(rootSession(data, "codex", "loop-a"), "loop-b"); assert.equal(rootSession(data, "claude", "child-thread"), "child-thread", "Claude subagents already log under their parent");
  assert.equal(noteThread(data, "x", "x"), false);
});

test("sessions run in fresh temporary directories are one 临时目录 project, unless a Paseo agent names their project", () => {
  const data = emptyData(), directory = new StatsDirectory(); directory.loaded = true;
  const temp = (name: string) => join(tmpdir(), name);
  directory.agents = [agent("in-temp", { sessionId: "agent-run", cwd: temp("agent-scratch"), projectKey: "scratch-key", projectName: "临时实验" })];
  for (const [index, cwd] of [temp("grok-AbCdEf12"), temp("grok-GhIjKl34"), "/tmp/run-1/sub", temp("agent-scratch"), "/home/me/app"].entries())
    addCall(data, call(`t${index}`, now - 1000 - index, { sessionId: index === 3 ? "agent-run" : `s${index}`, cwd, output: 100 * (index + 1) }), null, now);
  const result = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, now, directory, coverage));
  assert.deepEqual(result.projects.map(row => [row.key, row.label, row.sessions]).sort(), [["/home/me/app", "app", 1], ["__temporary__", "临时目录", 3], ["scratch-key", "临时实验", 1]]);
  assert.equal(result.sessions.find(row => row.sessionId === "s0")?.project, "临时目录");
});
