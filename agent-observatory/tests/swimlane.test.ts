import assert from "node:assert/strict";
import test from "node:test";
import type { TelemetryEvent } from "../shared/telemetry";
import { buildSwimlanes, eventAgentTitle, swimTicks } from "../shared/swimlane";

const now = Date.parse("2026-09-23T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
let sequence = 0;
const event = (agentId: string, type: TelemetryEvent["type"], minutesAgo: number, durationMs?: number): TelemetryEvent =>
  ({ id: `e${++sequence}`, agentId, agentTitle: `任务 ${agentId}`, at: at(minutesAgo), type, label: type, ...(durationMs === undefined ? {} : { durationMs }) });
const noneLive = new Map<string, "running" | "waiting">();

test("lane titles prefer the directory's current name over the capture-time fallback", () => {
  // Interactive Agents record events before the host names them, so the stored title is the fallback text.
  const unnamed = (agentId: string, type: TelemetryEvent["type"], minutesAgo: number): TelemetryEvent =>
    ({ id: `u${++sequence}`, agentId, agentTitle: "未命名 Agent", at: at(minutesAgo), type, label: type });
  const events = [unnamed("a", "turn_started", 20), unnamed("a", "turn_completed", 10), unnamed("b", "turn_started", 5), unnamed("b", "turn_completed", 2)];
  // Without a directory map the stored title wins (historical behavior, and Agents no longer listed).
  assert.equal(buildSwimlanes(events, noneLive, now, 3_600_000, 10).lanes.find(lane => lane.agentId === "a")!.title, "未命名 Agent");
  // With it, the current directory name overrides the baked-in fallback, retroactively.
  const titles = new Map([["a", "better-paseo"], ["b", "待命的任务"]]);
  const { lanes } = buildSwimlanes(events, noneLive, now, 3_600_000, 10, titles);
  assert.equal(lanes.find(lane => lane.agentId === "a")!.title, "better-paseo");
  assert.equal(lanes.find(lane => lane.agentId === "b")!.title, "待命的任务");
  // An Agent missing from the directory keeps its stored title.
  assert.equal(eventAgentTitle(unnamed("c", "turn_started", 1), titles), "未命名 Agent");
  assert.equal(eventAgentTitle(unnamed("a", "turn_started", 1), titles), "better-paseo");
});

test("finished turns span start to end, falling back to the reported duration when the start was trimmed", () => {
  const { lanes, turns } = buildSwimlanes([
    event("a", "turn_started", 50), event("a", "turn_completed", 40),
    event("b", "turn_failed", 10, 15 * 60_000),
  ], noneLive, now, 3_600_000, 10);
  assert.equal(turns, 2);
  const a = lanes.find(lane => lane.agentId === "a")!, b = lanes.find(lane => lane.agentId === "b")!;
  assert.deepEqual(a.spans, [{ start: now - 50 * 60_000, end: now - 40 * 60_000, kind: "completed", open: false }]);
  assert.deepEqual(b.spans, [{ start: now - 25 * 60_000, end: now - 10 * 60_000, kind: "failed", open: false }]);
  // Lanes are ordered by when their work started.
  assert.deepEqual(lanes.map(lane => lane.agentId), ["a", "b"]);
});

test("open turns and approvals reach now only while the Agent is live in that state", () => {
  const events = [event("run", "turn_started", 20), event("wait", "turn_started", 30), event("wait", "permission_requested", 5), event("lost", "turn_started", 45)];
  const live = new Map<string, "running" | "waiting">([["run", "running"], ["wait", "waiting"]]);
  const { lanes } = buildSwimlanes(events, live, now, 3_600_000, 10);
  assert.deepEqual(lanes.map(lane => lane.agentId), ["wait", "run"]);
  assert.deepEqual(lanes.find(lane => lane.agentId === "run")!.spans, [{ start: now - 20 * 60_000, end: now, kind: "running", open: true }]);
  assert.deepEqual(lanes.find(lane => lane.agentId === "wait")!.spans.map(span => span.kind), ["running", "approval"]);
  // Without a live state a start with no end is dropped rather than drawn forever.
  assert.equal(lanes.some(lane => lane.agentId === "lost"), false);
});

test("spans are clipped to the window, peak concurrency ignores approvals, and extra lanes are counted", () => {
  const events = [
    event("a", "turn_started", 90), event("a", "turn_completed", 30),
    event("b", "turn_started", 40), event("b", "permission_requested", 38), event("b", "permission_resolved", 36), event("b", "turn_completed", 20),
    event("c", "turn_started", 35), event("c", "turn_canceled", 32),
    event("old", "turn_started", 200), event("old", "turn_completed", 120),
  ];
  const { lanes, peak, peakAt, hidden } = buildSwimlanes(events, noneLive, now, 3_600_000, 2);
  assert.equal(peak, 3);
  assert.equal(peakAt, now - 35 * 60_000);
  // Three lanes have work in the window; the two most recently active are shown.
  assert.equal(hidden, 1);
  assert.deepEqual(lanes.map(lane => lane.agentId), ["a", "b"]);
  const clipped = buildSwimlanes(events, noneLive, now, 3_600_000, 10).lanes.find(lane => lane.agentId === "a")!;
  assert.equal(clipped.spans[0]!.start, now - 3_600_000);
});

test("axis ticks land on round local clock times", () => {
  const offset = 480; // UTC+8: 12:00Z is 20:00 local
  assert.deepEqual(swimTicks(now, 3_600_000, offset).map(tick => new Date(tick + offset * 60_000).toISOString().slice(11, 16)), ["19:00", "19:15", "19:30", "19:45", "20:00"]);
  assert.equal(swimTicks(now, 6 * 3_600_000, offset).length, 7);
  assert.deepEqual(swimTicks(now, 24 * 3_600_000, offset).map(tick => new Date(tick + offset * 60_000).getUTCHours()), [20, 0, 4, 8, 12, 16, 20]);
});
