/** Turn and approval spans per Agent for the 事件 swimlane (pure; tested in tests/swimlane.test.ts). */
import type { TelemetryEvent } from "./telemetry";

export type SwimKind = "completed" | "failed" | "canceled" | "running" | "approval";
export interface SwimSpan { start: number; end: number; kind: SwimKind; open: boolean }
export interface SwimLane { agentId: string; title: string; spans: SwimSpan[]; lastAt: number }
export interface Swimlanes { lanes: SwimLane[]; peak: number; peakAt: number | null; turns: number; hidden: number }

const ends: Partial<Record<TelemetryEvent["type"], SwimKind>> = { turn_completed: "completed", turn_failed: "failed", turn_canceled: "canceled" };

/**
 * The directory's current name first: events bake in the capture-time title, and interactive Agents get theirs only
 * after creation, so the stored fallback (「未命名 Agent」) would otherwise stick forever.
 */
export function eventAgentTitle(event: Pick<TelemetryEvent, "agentId" | "agentTitle">, titles?: ReadonlyMap<string, string>): string {
  return titles?.get(event.agentId) || event.agentTitle;
}

/**
 * Builds lanes for the window ending at `now`. A finished turn spans from its start event, or from its end minus the
 * reported duration when the start fell out of the bounded event log. Turns and approvals still open extend to `now`
 * only while the Agent is live in that state, so a lost end event never draws an endless bar.
 */
export function buildSwimlanes(events: readonly TelemetryEvent[], live: ReadonlyMap<string, "running" | "waiting">, now: number, windowMs: number, limit: number, titles?: ReadonlyMap<string, string>): Swimlanes {
  const from = now - windowMs;
  const byAgent = new Map<string, { title: string; spans: SwimSpan[]; turn?: number; approval?: number }>();
  const sorted = [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const event of sorted) {
    const at = Date.parse(event.at);
    if (!Number.isFinite(at)) continue;
    const state = byAgent.get(event.agentId) ?? { title: eventAgentTitle(event, titles), spans: [] };
    state.title = eventAgentTitle(event, titles);
    byAgent.set(event.agentId, state);
    const kind = ends[event.type];
    if (event.type === "turn_started") state.turn = at;
    else if (kind) { state.spans.push({ start: state.turn ?? at - (event.durationMs ?? 0), end: at, kind, open: false }); state.turn = undefined; }
    else if (event.type === "permission_requested") state.approval ??= at;
    else if (event.type === "permission_resolved" && state.approval !== undefined) { state.spans.push({ start: state.approval, end: at, kind: "approval", open: false }); state.approval = undefined; }
  }
  const lanes: SwimLane[] = [];
  for (const [agentId, state] of byAgent) {
    const status = live.get(agentId);
    if (state.turn !== undefined && status) state.spans.push({ start: state.turn, end: now, kind: "running", open: true });
    if (state.approval !== undefined && status === "waiting") state.spans.push({ start: state.approval, end: now, kind: "approval", open: true });
    const spans = state.spans.filter(span => span.end >= from && span.start <= now).map(span => ({ ...span, start: Math.max(from, span.start), end: Math.min(now, Math.max(span.start, span.end)) }));
    if (spans.length) lanes.push({ agentId, title: state.title || agentId, spans, lastAt: Math.max(...spans.map(span => span.end)) });
  }
  // Peak concurrency over turn spans (approvals overlap their own turn and are not extra work).
  const edges = lanes.flatMap(lane => lane.spans.filter(span => span.kind !== "approval").flatMap(span => [[span.start, 1], [span.end, -1]] as const)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0, peak = 0, peakAt: number | null = null;
  for (const [at, change] of edges) { current += change; if (current > peak) { peak = current; peakAt = at; } }
  const turns = lanes.reduce((sum, lane) => sum + lane.spans.filter(span => span.kind !== "approval").length, 0);
  const shown = [...lanes].sort((a, b) => b.lastAt - a.lastAt).slice(0, limit)
    .sort((a, b) => Math.min(...a.spans.map(span => span.start)) - Math.min(...b.spans.map(span => span.start)) || a.agentId.localeCompare(b.agentId));
  return { lanes: shown, peak, peakAt, turns, hidden: lanes.length - shown.length };
}

/** Axis ticks on round clock times: every 15 min for an hour, hourly up to 6 h, then every 4 h. */
export function swimTicks(now: number, windowMs: number, utcOffsetMinutes: number): number[] {
  const step = windowMs <= 3_600_000 ? 900_000 : windowMs <= 6 * 3_600_000 ? 3_600_000 : 4 * 3_600_000;
  const offset = utcOffsetMinutes * 60_000, from = now - windowMs;
  const ticks: number[] = [];
  for (let tick = Math.ceil((from + offset) / step) * step - offset; tick <= now; tick += step) ticks.push(tick);
  return ticks;
}
