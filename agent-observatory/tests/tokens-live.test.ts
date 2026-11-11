import assert from "node:assert/strict";
import test from "node:test";
import { StatsDirectory } from "../server/stats-directory";
import type { StatsDirectoryAgent } from "../server/stats-types";
import { addCall, emptyData, noteThread } from "../server/tokens/data";
import { buildTokenLive } from "../server/tokens/live";
import { iso } from "../server/tokens/types";
import { type LedgerCall } from "../server/tokens/types";
import { tokenLiveSchema } from "../shared/tokens";

const NOW = Date.parse("2026-09-23T12:00:05Z"), full = { windowMinutes: 60, utcOffsetMinutes: 0, detail: "full" } as const;
const call = (extra: Partial<LedgerCall> = {}): LedgerCall => ({ key: "one", source: "codex", sessionId: "s", cwd: "/repo", model: "gpt-5", at: NOW,
  start: NOW - 25_000, input: 20, cacheRead: 30, cacheWrite: 50, output: 2500, reasoning: 500, subagent: false, ...extra });
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

test("live spreads output across complete and partial buckets, with input and calls at the end", () => {
  const data = emptyData(); addCall(data, call(), null, NOW);
  addCall(data, call({ key: "point", start: null, output: 10 }), null, NOW);
  const result = tokenLiveSchema.parse(buildTokenLive(data, full, NOW, new StatsDirectory()));
  assert.equal(result.output.length, 360); assert.deepEqual(result.output.slice(-3), [1000, 1000, 510]);
  assert.equal(sum(result.output), 2510); assert.equal(sum(result.input), 200); assert.equal(result.input.at(-1), 200);
  assert.equal(sum(result.calls), 2); assert.equal(result.calls.at(-1), 2);
  assert.equal(result.now.outputPerSec, 2510 / 60); assert.equal(result.now.inputPerSec, 200 / 60); assert.equal(result.now.callsPerMin, 2);
  assert.equal(result.peak?.outputPerSec, 100);
  assert.deepEqual(result.agents[0].recent.slice(-3), [1000, 1000, 510]);
  assert.deepEqual(result.today, { calls: 2, total: 2710, output: 2510 });
});

test("cumulative rounding conserves small token counts and boundary impulses", () => {
  const data = emptyData(), now = Math.floor(NOW / 10_000) * 10_000;
  addCall(data, call({ at: now, start: now - 30_000, output: 7 }), null, now);
  addCall(data, call({ key: "point", at: now, start: null, output: 3 }), null, now);
  const result = buildTokenLive(data, { ...full, windowMinutes: 30 }, now, new StatsDirectory());
  assert.equal(result.output.length, 180); assert.deepEqual(result.output.slice(-4), [2, 3, 2, 3]);
  assert.equal(sum(result.output), 10); assert.equal(result.calls.at(-1), 2);
});

test("now and agent rates use exact trailing intervals rather than complete chart buckets", () => {
  const data = emptyData(); addCall(data, call({ at: NOW - 30_000, start: NOW - 150_000, output: 1200 }), null, NOW);
  const result = buildTokenLive(data, full, NOW, new StatsDirectory());
  assert.equal(result.now.outputPerSec, 5); assert.equal(result.now.inputPerSec, 100 / 60); assert.equal(result.now.callsPerMin, 1);
  assert.equal(result.agents[0].outputPerSec, 7.5); assert.equal(result.agents[0].output10m, 1200);
});

test("agent detail omits series, ranks recent sessions, and resolves directory titles", () => {
  const data = emptyData(), directory = new StatsDirectory();
  directory.agents = [{ id: "agent", sessionId: "fast", title: "本地会话", createdAt: "2026-09-23T00:00:00Z" } as StatsDirectoryAgent];
  addCall(data, call({ sessionId: "slow", output: 100 }), null, NOW);
  addCall(data, call({ key: "fast", sessionId: "fast", output: 500 }), null, NOW);
  addCall(data, call({ key: "old", sessionId: "old", at: NOW - 601_000, start: null }), null, NOW);
  data.recent.set("future", call({ key: "future", sessionId: "future", at: NOW + 1 }));
  const result = tokenLiveSchema.parse(buildTokenLive(data, { ...full, detail: "agents" }, NOW, directory));
  assert.deepEqual(result.output, []); assert.deepEqual(result.input, []); assert.deepEqual(result.calls, []); assert.equal(result.peak, null);
  assert.deepEqual(result.agents.map(agent => agent.sessionId), ["fast", "slow"]);
  assert.equal(result.agents[0].agentId, "agent"); assert.equal(result.agents[0].title, "本地会话");
});

test("today shifts UTC hour buckets to UTC+8 local midnight", () => {
  const data = emptyData(), now = Date.parse("2026-09-23T01:00:00Z");
  addCall(data, call({ at: Date.parse("2026-09-22T20:00:00Z"), start: null }), null, now);
  addCall(data, call({ key: "before", at: Date.parse("2026-09-22T15:00:00Z"), start: null }), null, now);
  const utc = buildTokenLive(data, full, now, new StatsDirectory()), china = buildTokenLive(data, { ...full, utcOffsetMinutes: 480 }, now, new StatsDirectory());
  assert.equal(utc.today.calls, 0); assert.equal(china.today.calls, 1); assert.equal(china.today.total, 2600);
});

test("empty live windows retain aligned buckets and nullable peak", () => {
  const result = tokenLiveSchema.parse(buildTokenLive(emptyData(), full, NOW, new StatsDirectory()));
  assert.equal(result.output.length, 360); assert.equal(Date.parse(result.start) % 10_000, 0); assert.equal(result.peak, null);
  assert.deepEqual(result.now, { outputPerSec: 0, inputPerSec: 0, callsPerMin: 0 }); assert.deepEqual(result.agents, []);
});

test("a busy 60-minute projection fits the payload budget and remains a memory-only operation", context => {
  const data = emptyData(), directory = new StatsDirectory();
  directory.refresh = () => { throw new Error("must not refresh inside projection"); };
  for (let i = 0; i < 1000; i++) data.recent.set(String(i), call({ key: String(i), sessionId: `s${i % 20}`, at: NOW - i * 1000, start: NOW - i * 1000 - 15000, output: 600 }));
  const times = [];
  let result = buildTokenLive(data, full, NOW, directory);
  for (let i = 0; i < 30; i++) { const start = performance.now(); result = buildTokenLive(data, full, NOW, directory); times.push(performance.now() - start); }
  tokenLiveSchema.parse(result); const bytes = Buffer.byteLength(JSON.stringify(result));
  assert.ok(bytes < 12_000); assert.equal(result.agents.length, 12); times.sort((a, b) => a - b);
  context.diagnostic(`1000-call live projection: ${bytes} bytes; median ${times[15].toFixed(2)} ms (timing is diagnostic, not a flaky assertion).`);
});

test("a Codex subagent thread's output shows on the row of the session that spawned it", () => {
  const data = emptyData(), directory = new StatsDirectory();
  directory.agents = [{ id: "agent", sessionId: "parent", title: "派出子 Agent 的会话", createdAt: "2026-09-23T00:00:00Z" } as StatsDirectoryAgent];
  addCall(data, call({ key: "own", sessionId: "parent", output: 300 }), null, NOW);
  addCall(data, call({ key: "child", sessionId: "child", output: 500, subagent: true }), null, NOW);
  noteThread(data, "child", "parent");
  const result = tokenLiveSchema.parse(buildTokenLive(data, { ...full, detail: "agents" }, NOW, directory));
  assert.deepEqual(result.agents.map(agent => [agent.sessionId, agent.agentId, agent.title, agent.output10m, agent.calls10m]), [["parent", "agent", "派出子 Agent 的会话", 800, 2]]);
});

test("a whole-turn source joins its agent row with ten-minute totals but no fabricated rate", () => {
  const data = emptyData();
  // A CodeBuddy step ends a minute ago with no response time; a Codex call is still streaming.
  addCall(data, call({ key: "cb-step", source: "codebuddy", sessionId: "cb", start: null, at: NOW - 60_000, output: 900 }), null, NOW);
  addCall(data, call({ key: "cx", source: "codex", sessionId: "cx", at: NOW - 500, start: NOW - 20_000, output: 300 }), null, NOW);
  const result = tokenLiveSchema.parse(buildTokenLive(data, full, NOW, new StatsDirectory()));
  // The chart and the now-rate stay timing-true: only the Codex call spread into them.
  assert.equal(sum(result.output), 300); assert.equal(result.now.outputPerSec, 300 / 60); assert.equal(result.now.callsPerMin, 1);
  assert.ok(result.peak === null || result.peak.outputPerSec < 90, "the whole-turn step must not read as a burst in the chart");
  // Both sessions appear as rows; the whole-turn row shows its ten-minute totals and an arrival rate (the step's
  // output lands in the trailing window it completed in), with the sparkline as one self-scaled pulse.
  const cb = result.agents.find(row => row.source === "codebuddy")!, cx = result.agents.find(row => row.source === "codex")!;
  assert.deepEqual([cb.output10m, cb.outputPerSec, sum(cb.recent)], [900, 7.5, 900]);
  assert.deepEqual([cx.output10m, cx.outputPerSec], [300, 2.5]);
  assert.equal(cb.lastCallAt, iso(NOW - 60_000));
});
