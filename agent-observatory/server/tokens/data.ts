import { t } from "../../shared/text";
import { basename } from "node:path";
import { emptyTokenCounts, WHOLE_TURN_SOURCES, type TokenCounts, type TokenSource } from "../../shared/tokens";
import { DAY, dayOf, hourOf, type LedgerCall } from "./types";

interface SettledBounds { settledFirstAt?: number; settledLastAt?: number }
export interface HourBucket extends TokenCounts, SettledBounds { at: number; source: TokenSource; model: string | null; firstAt?: number; lastAt: number }
export interface SessionHour extends HourBucket { sessionId: string; cwd: string; firstAt: number; subagentCalls: number }
export interface ProjectHour extends TokenCounts, SettledBounds { at: number; cwd: string; lastAt: number }
export interface SessionMeta extends SettledBounds {
  sessionId: string; source: TokenSource; cwd: string; project: string; firstAt: number; lastAt: number;
  models: Record<string, number>; subagentCalls: number;
}
export interface CallRecord { key: string; at: number; model: string | null; output: number; tps: number }
export interface RecordHour {
  at: number; speeds: Record<string, number>; fastest: CallRecord[]; biggest: CallRecord[];
  settledFastest?: CallRecord[]; settledBiggest?: CallRecord[];
}
export interface TokenData {
  hours: Map<string, HourBucket>; days: Map<string, HourBucket>; sessionHours: Map<string, SessionHour>;
  projectHours: Map<string, ProjectHour>; sessions: Map<string, SessionMeta>; recordHours: Map<number, RecordHour>;
  recent: Map<string, LedgerCall>; mutable: Map<string, LedgerCall>; earliestAt: number | null; latestAt: number | null;
  /**
   * Codex subagent threads (`session_meta.source.subagent`): child thread id → parent thread id. Calls keep their own
   * thread's session id (their dedupe keys and stored buckets never change); reads attribute a child to its root
   * session, which also covers threads counted before the parent was known.
   */
  threads: Map<string, string>;
}
export function emptyData(): TokenData {
  return { hours: new Map(), days: new Map(), sessionHours: new Map(), projectHours: new Map(), sessions: new Map(), recordHours: new Map(),
    recent: new Map(), mutable: new Map(), earliestAt: null, latestAt: null, threads: new Map() };
}
export const sessionKey = (source: TokenSource, sessionId: string): string => `${source}:${sessionId}`;
/** Enough for every subagent thread a heavy host keeps (about 200 in October 2026); the oldest links go first. */
export const MAX_THREADS = 20_000;
/** Records a subagent thread's parent; true when the map changed. */
export function noteThread(data: TokenData, child: string, parent: string): boolean {
  if (!child || !parent || child === parent || data.threads.get(child) === parent) return false;
  data.threads.delete(child); data.threads.set(child, parent);
  while (data.threads.size > MAX_THREADS) data.threads.delete(data.threads.keys().next().value!);
  return true;
}
/** The session a call belongs to for attribution: a Codex subagent thread's top-level parent (a few hops, cycle-safe). */
export function rootSession(data: Pick<TokenData, "threads">, source: TokenSource, sessionId: string): string {
  if (source !== "codex" || !data.threads.size) return sessionId;
  let id = sessionId;
  for (let hop = 0; hop < 8; hop++) {
    const parent = data.threads.get(id);
    if (!parent || parent === sessionId) break;
    id = parent;
  }
  return id;
}
export const bucketKey = (at: number, source: TokenSource, model: string | null): string => JSON.stringify([at, source, model]);
export const sessionHourKey = (row: SessionHour): string => JSON.stringify([row.at, row.source, row.sessionId, row.model]);
export const projectHourKey = (row: ProjectHour): string => JSON.stringify([row.at, row.cwd]);
export const projectName = (cwd: string): string => (basename(cwd) || t("serverTokensData.m001")).slice(0, 240);
const countKeys = Object.keys(emptyTokenCounts()) as (keyof TokenCounts)[];
/** Model calls a ledger record stands for: one, or a Grok turn's `modelCalls`. */
export const modelCalls = (call: Pick<LedgerCall, "calls">): number => call.calls !== undefined && call.calls > 1 ? Math.floor(call.calls) : 1;
export function callCounts(call: LedgerCall): TokenCounts {
  return { calls: modelCalls(call), input: call.input, cacheWrite: call.cacheWrite, cacheRead: call.cacheRead, output: call.output, reasoning: call.reasoning,
    genMs: call.start === null ? 0 : call.at - call.start, genOutput: call.start === null ? 0 : call.output };
}
function increment(target: TokenCounts, delta: TokenCounts, sign: number): void {
  for (const key of countKeys) target[key] = Math.max(0, target[key] + sign * delta[key]);
}
/** 4% logarithmic bins bound percentile memory independently of the number of calls. */
export const speedBin = (tps: number): number => Math.round(Math.log(Math.max(0.001, tps)) / Math.log(1.04));
export const binSpeed = (bin: number): number => Math.pow(1.04, bin);
/** Settled calls never change, so the top few per hour stay exact; mutable calls are merged back in on every rebuild. */
export const RECORD_DEPTH = 3;
const sortRecords = (items: CallRecord[], kind: "fastest" | "biggest"): CallRecord[] => items.sort((a, b) =>
  (kind === "fastest" ? b.tps - a.tps : b.output - a.output) || a.at - b.at).slice(0, RECORD_DEPTH);
/**
 * A call's place in the hour's records. 最快的一次 needs a timed response of some length. 最长的一次输出 is one model call's output:
 * a record standing for several calls is not one, nor is a whole-turn record at all (a Grok turn's usage.json sums each turn per
 * model, a CodeBuddy step is logged when it ends; r3-F5).
 */
function callRecord(call: LedgerCall, kind: "fastest" | "biggest"): CallRecord | null {
  const ms = call.start === null ? 0 : call.at - call.start;
  if (kind === "fastest" ? ms < 1000 || call.output < 100 : modelCalls(call) > 1 || WHOLE_TURN_SOURCES[call.source]) return null;
  return { key: call.key, at: call.at, model: call.model, output: call.output, tps: ms ? call.output / ms * 1000 : 0 };
}
function record(data: TokenData, call: LedgerCall, sign: number): void {
  const at = hourOf(call.at), row = data.recordHours.get(at) ?? { at, speeds: {}, fastest: [], biggest: [] };
  data.recordHours.set(at, row);
  const ms = call.start === null ? 0 : call.at - call.start, eligible = ms >= 1000 && call.output >= 100;
  const tps = ms ? call.output / ms * 1000 : 0;
  if (eligible) {
    const key = String(speedBin(tps)); row.speeds[key] = Math.max(0, (row.speeds[key] ?? 0) + sign);
    if (!row.speeds[key]) delete row.speeds[key];
  }
}
/** Only settled candidates may be evicted: mutable calls can slow down or move to another hour. */
function rebuildRecords(data: TokenData, at: number): void {
  const row = data.recordHours.get(at); if (!row) return;
  for (const kind of ["fastest", "biggest"] as const) {
    const items = [...(kind === "fastest" ? row.settledFastest : row.settledBiggest) ?? []];
    for (const call of data.mutable.values()) if (hourOf(call.at) === at) {
      const item = callRecord(call, kind); if (item) items.push(item);
    }
    row[kind] = sortRecords(items, kind);
  }
  if (!row.fastest.length && !row.biggest.length && !Object.keys(row.speeds).length) data.recordHours.delete(at);
}
function settleBounds(row: SettledBounds | undefined, at: number): void {
  if (!row) return;
  row.settledFirstAt = Math.min(row.settledFirstAt ?? at, at);
  row.settledLastAt = Math.max(row.settledLastAt ?? at, at);
}
function rebuildBounds<T extends SettledBounds & { firstAt?: number; lastAt: number }>(row: T | undefined, calls: Iterable<LedgerCall>, matches: (call: LedgerCall) => boolean): void {
  if (!row) return;
  let first = row.settledFirstAt ?? Infinity, last = row.settledLastAt ?? -Infinity;
  for (const call of calls) if (matches(call)) { first = Math.min(first, call.at); last = Math.max(last, call.at); }
  if (Number.isFinite(first)) row.firstAt = first;
  if (Number.isFinite(last)) row.lastAt = last;
}
function rebuildCallBounds(data: TokenData, call: LedgerCall, now: number): void {
  const hour = hourOf(call.at), recent = hour >= dayOf(now) - 91 * DAY, at = recent ? hour : dayOf(call.at);
  const map = recent ? data.hours : data.days, key = bucketKey(at, call.source, call.model);
  rebuildBounds(map.get(key), data.mutable.values(), other => bucketKey(recent ? hourOf(other.at) : dayOf(other.at), other.source, other.model) === key);
  if (!recent) return;
  const id = sessionKey(call.source, call.sessionId), sk = JSON.stringify([hour, call.source, call.sessionId, call.model]);
  rebuildBounds(data.sessions.get(id), data.mutable.values(), other => sessionKey(other.source, other.sessionId) === id);
  rebuildBounds(data.sessionHours.get(sk), data.mutable.values(), other => hourOf(other.at) === hour && other.source === call.source && other.sessionId === call.sessionId && other.model === call.model);
  rebuildBounds(data.projectHours.get(JSON.stringify([hour, call.cwd])), data.mutable.values(), other => hourOf(other.at) === hour && other.cwd === call.cwd);
}
function rebuildCoverage(data: TokenData): void {
  let first = Infinity, last = -Infinity;
  for (const rows of [data.hours, data.days]) for (const row of rows.values()) {
    first = Math.min(first, row.firstAt ?? row.at); last = Math.max(last, row.lastAt);
  }
  data.earliestAt = Number.isFinite(first) ? first : null; data.latestAt = Number.isFinite(last) ? last : null;
}

/** Finalize a file's preceding response; EOF candidates remain mutable and survive checkpoints. */
export function settleCall(data: TokenData, call: LedgerCall, now: number): void {
  const current = data.mutable.get(call.key); if (!current) return;
  data.mutable.delete(call.key);
  const hour = hourOf(current.at), recent = hour >= dayOf(now) - 91 * DAY, at = recent ? hour : dayOf(current.at);
  // A poll can finish across local retention maintenance; settle into the bucket that still owns the counts.
  settleBounds(data.hours.get(bucketKey(hour, current.source, current.model)) ?? data.days.get(bucketKey(at, current.source, current.model)), current.at);
  if (!recent) return;
  settleBounds(data.sessions.get(sessionKey(current.source, current.sessionId)), current.at);
  settleBounds(data.sessionHours.get(JSON.stringify([hour, current.source, current.sessionId, current.model])), current.at);
  settleBounds(data.projectHours.get(JSON.stringify([hour, current.cwd])), current.at);
  const row = data.recordHours.get(hour); if (!row) return;
  for (const kind of ["fastest", "biggest"] as const) {
    const name = kind === "fastest" ? "settledFastest" : "settledBiggest", item = callRecord(current, kind);
    if (item) row[name] = sortRecords([...(row[name] ?? []), item], kind);
  }
}
function apply(data: TokenData, call: LedgerCall, sign: number, now: number): void {
  const delta = callCounts(call), hour = hourOf(call.at), recent = hour >= dayOf(now) - 91 * DAY;
  const at = recent ? hour : dayOf(call.at), map = recent ? data.hours : data.days, key = bucketKey(at, call.source, call.model);
  const bucket = map.get(key) ?? { at, source: call.source, model: call.model, firstAt: call.at, lastAt: call.at, ...emptyTokenCounts() };
  increment(bucket, delta, sign); bucket.firstAt = Math.min(bucket.firstAt ?? call.at, call.at); bucket.lastAt = Math.max(bucket.lastAt, call.at);
  if (bucket.calls) map.set(key, bucket); else map.delete(key);
  if (!recent) return;
  const id = sessionKey(call.source, call.sessionId);
  let meta = data.sessions.get(id);
  if (!meta && sign > 0) {
    meta = { sessionId: call.sessionId, source: call.source, cwd: call.cwd, project: projectName(call.cwd), firstAt: call.at, lastAt: call.at,
      models: Object.create(null) as Record<string, number>, subagentCalls: 0 }; data.sessions.set(id, meta);
  }
  if (meta) {
    meta.firstAt = Math.min(meta.firstAt, call.at); meta.lastAt = Math.max(meta.lastAt, call.at);
    if (call.cwd) { meta.cwd = call.cwd; meta.project = projectName(call.cwd); }
    const model = call.model ?? "unknown";
    Object.defineProperty(meta.models, model, { value: Math.max(0, (Object.hasOwn(meta.models, model) ? meta.models[model] : 0) + sign * delta.calls), enumerable: true, configurable: true, writable: true });
    meta.subagentCalls = Math.max(0, meta.subagentCalls + (call.subagent ? sign * delta.calls : 0));
    const attribution: SessionHour = { at: hour, source: call.source, model: call.model, sessionId: call.sessionId, cwd: call.cwd,
      firstAt: call.at, lastAt: call.at, subagentCalls: 0, ...emptyTokenCounts() };
    const sk = sessionHourKey(attribution), row = data.sessionHours.get(sk) ?? attribution;
    increment(row, delta, sign); row.firstAt = Math.min(row.firstAt, call.at); row.lastAt = Math.max(row.lastAt, call.at);
    row.subagentCalls = Math.max(0, row.subagentCalls + (call.subagent ? sign * delta.calls : 0));
    if (row.calls) data.sessionHours.set(sk, row); else data.sessionHours.delete(sk);
  }
  const project: ProjectHour = { at: hour, cwd: call.cwd, lastAt: call.at, ...emptyTokenCounts() }, pk = projectHourKey(project);
  const row = data.projectHours.get(pk) ?? project;
  increment(row, delta, sign); row.lastAt = Math.max(row.lastAt, call.at);
  if (row.calls) data.projectHours.set(pk, row); else data.projectHours.delete(pk);
  record(data, call, sign);
}
export function addCall(data: TokenData, call: LedgerCall, previous: LedgerCall | null, now: number): void {
  if (previous && hourOf(previous.at) < dayOf(now) - 91 * DAY && data.hours.has(bucketKey(hourOf(previous.at), previous.source, previous.model))) pruneData(data, now);
  if (previous) apply(data, previous, -1, now);
  apply(data, call, 1, now);
  data.mutable.set(call.key, call);
  if (previous) { rebuildCallBounds(data, previous, now); rebuildCallBounds(data, call, now); rebuildCoverage(data); }
  if (previous && hourOf(previous.at) !== hourOf(call.at)) rebuildRecords(data, hourOf(previous.at));
  rebuildRecords(data, hourOf(call.at));
  data.earliestAt = Math.min(data.earliestAt ?? call.at, call.at);
  data.latestAt = Math.max(data.latestAt ?? call.at, call.at);
  if (call.at >= now - 75 * 60_000) data.recent.set(call.key, call);
}
export function pruneData(data: TokenData, now: number): void {
  const cutoff = dayOf(now) - 91 * DAY, oldest = dayOf(now) - 399 * DAY;
  for (const [key, row] of data.hours) if (row.at < cutoff) {
    data.hours.delete(key);
    const day = dayOf(row.at), dk = bucketKey(day, row.source, row.model);
    const daily = data.days.get(dk) ?? { at: day, source: row.source, model: row.model, firstAt: row.firstAt ?? row.at, lastAt: row.lastAt, ...emptyTokenCounts() };
    increment(daily, row, 1); daily.firstAt = Math.min(daily.firstAt ?? row.at, row.firstAt ?? row.at); daily.lastAt = Math.max(daily.lastAt, row.lastAt);
    if (row.settledFirstAt !== undefined) settleBounds(daily, row.settledFirstAt);
    if (row.settledLastAt !== undefined) settleBounds(daily, row.settledLastAt);
    data.days.set(dk, daily);
  }
  for (const [key, row] of data.days) if (row.at < oldest) data.days.delete(key);
  const retained = [...data.sessions.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt).filter(([, row]) => row.lastAt >= cutoff).slice(0, 5000);
  data.sessions = new Map(retained);
  for (const [key, row] of data.sessionHours) if (row.at < cutoff || !data.sessions.has(sessionKey(row.source, row.sessionId))) data.sessionHours.delete(key);
  for (const [key, row] of data.projectHours) if (row.at < cutoff) data.projectHours.delete(key);
  for (const at of data.recordHours.keys()) if (at < cutoff) data.recordHours.delete(at);
  for (const [key, call] of data.recent) if (call.at < now - 75 * 60_000) data.recent.delete(key);
  for (const [key, call] of data.mutable) if (dayOf(call.at) < oldest) data.mutable.delete(key);
  rebuildCoverage(data);
}
