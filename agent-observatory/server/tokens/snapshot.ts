import { t } from "../../shared/text";
import { createHash } from "node:crypto";
import { statsRangeDays, vendorOf, type StatsRange } from "../../shared/stats";
import { addTokenCounts, emptyTokenCounts, MAX_TOKEN_ROOTS, TOKEN_SOURCES, TOKEN_UNMATCHED, tokenSourceNames, tokenTotal, type TokenCounts, type TokenRow, type TokenSession, type TokenSnapshot } from "../../shared/tokens";
import type { StatsDirectory } from "../stats-directory";
import { statsDayText, statsLocalDay, statsLocalHour, statsZone, type StatsDirectoryAgent } from "../stats-types";
import { binSpeed, projectName, rootSession, sessionKey, type CallRecord, type TokenData } from "./data";
import { isTemporaryDirectory } from "./roots";
import { DAY, dayOf, HOUR, iso } from "./types";

/** Byte limits also keep multibyte titles within the relay payload budget. IDs remain usable for navigation. */
function text(value: string, bytes = 96): string {
  if (Buffer.byteLength(value) <= bytes) return value;
  let result = "";
  for (const char of value) { if (Buffer.byteLength(result + char) > bytes - 3) break; result += char; }
  return result + "…";
}
const nullableText = (value: string | null): string | null => value === null ? null : text(value);
function wireKey(value: string): string {
  return Buffer.byteLength(value) <= 160 ? value : `${text(value, 135)}:${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}
interface Breakdown extends TokenCounts { key: string; label: string; vendor: string | null; ids: Set<string>; lastAt: number }
interface Session extends TokenCounts { sessionId: string; source: TokenSession["source"]; cwd: string; firstAt: number; lastAt: number; subagentCalls: number; models: Map<string | null, number> }
function getRow(rows: Map<string, Breakdown>, key: string, label: string, vendor: string | null): Breakdown {
  let row = rows.get(key);
  if (!row) { row = { key, label, vendor, ids: new Set(), lastAt: -Infinity, ...emptyTokenCounts() }; rows.set(key, row); }
  return row;
}
function sortedRows(rows: Map<string, Breakdown>): Breakdown[] {
  return [...rows.values()].sort((a, b) => tokenTotal(b) - tokenTotal(a) || a.key.localeCompare(b.key));
}
/** Project row of sessions run in a system temporary directory (2.14: Grok CLI runs headless in fresh ones by the hundred). */
export const TOKEN_TEMPORARY_PROJECT = "__temporary__";
function projectFor(cwd: string, projects: Map<string, StatsDirectoryAgent>): { key: string; label: string } {
  const agent = projects.get(cwd);
  if (!agent && isTemporaryDirectory(cwd)) return { key: TOKEN_TEMPORARY_PROJECT, label: t("serverTokensSnapshot.m001") };
  return { key: agent?.projectKey || cwd || "unknown", label: agent?.projectName || projectName(cwd) };
}
function projectRows(rows: Breakdown[], limit: number): TokenRow[] {
  const selected = rows.length <= limit ? rows : rows.slice(0, limit - 1);
  if (rows.length > limit) {
    const other: Breakdown = { key: "__other__", label: t("serverTokensSnapshot.m002"), vendor: null, ids: new Set(), lastAt: -Infinity, ...emptyTokenCounts() };
    for (const row of rows.slice(limit - 1)) {
      addTokenCounts(other, row); for (const id of row.ids) other.ids.add(id); other.lastAt = Math.max(other.lastAt, row.lastAt);
    }
    selected.push(other);
  }
  return selected.map(row => ({ ...emptyTokenCounts(), ...Object.fromEntries(Object.keys(emptyTokenCounts()).map(key => [key, row[key as keyof TokenCounts]])),
    key: wireKey(row.key), label: text(row.label), vendor: row.vendor, sessions: row.ids.size, lastAt: Number.isFinite(row.lastAt) ? iso(row.lastAt) : null }));
}
function percentile(speeds: Map<number, number>, quantile: number): number | null {
  let total = 0; for (const n of speeds.values()) total += n;
  if (!total) return null;
  const target = Math.ceil(total * quantile); let count = 0;
  for (const [bin, n] of [...speeds].sort((a, b) => a[0] - b[0])) { count += n; if (count >= target) return binSpeed(bin); }
  return null;
}

/**
 * Projection only: all log reads, retention and directory refresh happen outside an RPC build. Days and hours are the
 * device's (2.14): `timeZone` when this server knows it and it agrees with the offset now (server/stats-types), each
 * UTC hour bucket converted with the offset of its own instant, so a range across a daylight-saving change stays exact;
 * else the fixed `utcOffsetMinutes`. `owners` names the provider of sessions that match no agent but were read from a
 * root that belongs to one custom provider (session key → provider id).
 */
export function buildTokenSnapshot(data: TokenData, input: { range: StatsRange; utcOffsetMinutes: number; timeZone?: string | null }, now: number,
  directory: StatsDirectory, coverage: TokenSnapshot["coverage"], owners: ReadonlyMap<string, string> = new Map()): TokenSnapshot {
  const zone = statsZone(input.utcOffsetMinutes, input.timeZone, now), length = statsRangeDays[input.range];
  // Day numbers (days since 1970-01-01 in the device's calendar), not instants: local midnights move with the offset.
  const localDay = (at: number) => statsLocalDay(at, zone), today = localDay(now);
  const from = today - (length - 1), previousFrom = from - length, oldest = dayOf(now) - 399 * DAY;
  const totals = emptyTokenCounts(), previous = emptyTokenCounts(), allTime = emptyTokenCounts();
  const daily = Array.from({ length }, (_, index) => ({ day: statsDayText(from + index), ...emptyTokenCounts() }));
  const hours = Array<number>(24).fill(0), models = new Map<string, Breakdown>(), sources = new Map<string, Breakdown>(), projects = new Map<string, Breakdown>();
  const agents = new Map<string, StatsDirectoryAgent>(), cwdAgents = new Map<string, StatsDirectoryAgent>();
  for (const agent of [...directory.agents].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))) {
    if (agent.sessionId && !agents.has(agent.sessionId)) agents.set(agent.sessionId, agent);
    if (agent.cwd && !cwdAgents.has(agent.cwd)) cwdAgents.set(agent.cwd, agent);
  }
  const inRange = (at: number): boolean => { if (at > now) return false; const day = localDay(at); return day >= from && day <= today; };
  for (const map of [data.hours, data.days]) for (const bucket of map.values()) {
    if (bucket.at > now || bucket.at < oldest) continue;
    addTokenCounts(allTime, bucket);
    // An hour counts on the local day it starts in. A UTC day bucket (older than 91 days) counts on the local day of its
    // midday, the one most of its hours fall on in any zone.
    const at = map === data.days ? bucket.at + 12 * HOUR : bucket.at, day = localDay(at);
    if (day >= previousFrom && day < from) addTokenCounts(previous, bucket);
    if (day < from || day > today) continue;
    addTokenCounts(totals, bucket); addTokenCounts(daily[day - from], bucket);
    hours[statsLocalHour(at, zone)] += tokenTotal(bucket);
    const model = getRow(models, bucket.model ?? "unknown", bucket.model ?? t("serverTokensSnapshot.m003"), vendorOf(bucket.model, null));
    const source = getRow(sources, bucket.source, tokenSourceNames[bucket.source], null);
    for (const row of [model, source]) { addTokenCounts(row, bucket); row.lastAt = Math.max(row.lastAt, bucket.lastAt); }
  }
  for (const bucket of data.projectHours.values()) {
    if (!inRange(bucket.at)) continue;
    const project = projectFor(bucket.cwd, cwdAgents), row = getRow(projects, project.key, project.label, null);
    addTokenCounts(row, bucket); row.lastAt = Math.max(row.lastAt, bucket.lastAt);
  }
  const sessions = new Map<string, Session>(), providers = new Map<string, Breakdown>(), providerModels = new Map<string, Map<string | null, number>>();
  for (const bucket of data.sessionHours.values()) {
    if (!inRange(bucket.at)) continue;
    // A Codex subagent thread is part of its parent session: all of its calls are subagent calls (2.13).
    const root = rootSession(data, bucket.source, bucket.sessionId), child = root !== bucket.sessionId;
    const id = sessionKey(bucket.source, root), project = projectFor(bucket.cwd, cwdAgents), agent = agents.get(root);
    models.get(bucket.model ?? "unknown")?.ids.add(id); sources.get(bucket.source)?.ids.add(id); projects.get(project.key)?.ids.add(id);
    // No agent: the provider whose own log directory the session came from, if one does (gemini-B9).
    const owner = agent?.provider ?? owners.get(id) ?? owners.get(sessionKey(bucket.source, bucket.sessionId)) ?? null;
    const provider = getRow(providers, owner ?? TOKEN_UNMATCHED, owner ?? t("serverTokensSnapshot.m004"), null);
    addTokenCounts(provider, bucket); provider.lastAt = Math.max(provider.lastAt, bucket.lastAt); provider.ids.add(id);
    if (owner) { const mix = providerModels.get(owner) ?? new Map<string | null, number>(); mix.set(bucket.model, (mix.get(bucket.model) ?? 0) + bucket.calls); providerModels.set(owner, mix); }
    let row = sessions.get(id);
    if (!row) { row = { sessionId: root, source: bucket.source, cwd: bucket.cwd, firstAt: bucket.firstAt, lastAt: bucket.lastAt,
      subagentCalls: 0, models: new Map(), ...emptyTokenCounts() }; sessions.set(id, row); }
    addTokenCounts(row, bucket); row.firstAt = Math.min(row.firstAt, bucket.firstAt);
    if (bucket.lastAt >= row.lastAt) { row.cwd = bucket.cwd; row.lastAt = bucket.lastAt; }
    row.subagentCalls += child ? bucket.calls : bucket.subagentCalls; row.models.set(bucket.model, (row.models.get(bucket.model) ?? 0) + bucket.calls);
  }
  // Per-session detail is kept for 5,000 sessions; anything the session rows miss (never in practice) stays unmatched, so rows add up to the totals.
  const matched = emptyTokenCounts(); for (const row of providers.values()) addTokenCounts(matched, row);
  const rest = Object.fromEntries(Object.keys(matched).map(key => [key, Math.max(0, totals[key as keyof TokenCounts] - matched[key as keyof TokenCounts])])) as TokenCounts;
  if (rest.calls || tokenTotal(rest)) addTokenCounts(getRow(providers, TOKEN_UNMATCHED, t("serverTokensSnapshot.m005"), null), rest);
  for (const [provider, mix] of providerModels) {
    const top = [...mix].sort((a, b) => b[1] - a[1] || (a[0] ?? "").localeCompare(b[0] ?? ""))[0]?.[0] ?? null;
    providers.get(provider)!.vendor = vendorOf(top, provider);
  }
  const unmatched = providers.get(TOKEN_UNMATCHED), providerRanked = sortedRows(new Map([...providers].filter(([key]) => key !== TOKEN_UNMATCHED)));
  // Without the agent directory every session would look unmatched; the row is left out until it has been read.
  const providerRows = (limit: number): TokenRow[] | undefined => directory.loaded ? [...projectRows(providerRanked, limit), ...(unmatched ? projectRows([unmatched], 1) : [])] : undefined;
  let paseoTokens = 0;
  for (const row of sessions.values()) if (agents.has(row.sessionId)) paseoTokens += tokenTotal(row);
  const sessionRows: TokenSession[] = [...sessions.values()].sort((a, b) => tokenTotal(b) - tokenTotal(a) || a.sessionId.localeCompare(b.sessionId)).slice(0, 20).map(row => {
    const agent = agents.get(row.sessionId), model = [...row.models].sort((a, b) => b[1] - a[1] || (a[0] ?? "").localeCompare(b[0] ?? ""))[0]?.[0] ?? null;
    return { ...addTokenCounts(emptyTokenCounts(), row), sessionId: row.sessionId.slice(0, 256), source: row.source, model: nullableText(model),
      project: text(projectFor(row.cwd || data.sessions.get(sessionKey(row.source, row.sessionId))?.cwd || "", cwdAgents).label),
      agentId: agent?.id.slice(0, 256) ?? null, title: nullableText(agent?.title ?? null), firstAt: iso(row.firstAt), lastAt: iso(row.lastAt), subagentCalls: row.subagentCalls };
  });
  let fastest: CallRecord | null = null, biggest: CallRecord | null = null;
  const speeds = new Map<number, number>();
  for (const row of data.recordHours.values()) {
    if (!inRange(row.at)) continue;
    for (const [bin, n] of Object.entries(row.speeds)) speeds.set(Number(bin), (speeds.get(Number(bin)) ?? 0) + n);
    for (const item of row.fastest) if (item.at <= now && (!fastest || item.tps > fastest.tps || item.tps === fastest.tps && item.at < fastest.at)) fastest = item;
    for (const item of row.biggest) if (item.at <= now && (!biggest || item.output > biggest.output || item.output === biggest.output && item.at < biggest.at)) biggest = item;
  }
  const peakDay = daily.reduce<TokenSnapshot["records"]["peakDay"]>((peak, row) => tokenTotal(row) > (peak?.total ?? 0) ? { day: row.day, total: tokenTotal(row) } : peak, null);
  const modelRows = sortedRows(models), projectBreakdown = sortedRows(projects);
  const roots = coverage.roots.slice(0, MAX_TOKEN_ROOTS);
  // More harnesses add diagnostic roots, not more RPC payload allowance. Share the path-text budget across roots;
  // retain every source, file count and error, without reducing the actual directories the ingester watches.
  const rootPathBytes = Math.min(512, Math.floor(8192 / Math.max(1, roots.length)));
  const result: TokenSnapshot = { generatedAt: iso(now), range: input.range, utcOffsetMinutes: input.utcOffsetMinutes, timeZone: zone.name,
    from: statsDayText(from), to: statsDayText(today), totals, previous, allTime, daily, hours,
    models: projectRows(modelRows, 24), sources: projectRows(sortedRows(sources), TOKEN_SOURCES.length), projects: projectRows(projectBreakdown, 24), sessions: sessionRows,
    records: { peakDay, fastest: fastest ? { tps: fastest.tps, model: nullableText(fastest.model), at: iso(fastest.at), output: fastest.output } : null,
      biggest: biggest ? { output: biggest.output, model: nullableText(biggest.model), at: iso(biggest.at) } : null },
    speed: { p50: percentile(speeds, 0.5), p90: percentile(speeds, 0.9) }, paseoShare: tokenTotal(totals) ? Math.min(1, paseoTokens / tokenTotal(totals)) : null,
    coverage: { ...coverage, backfill: { ...coverage.backfill }, roots: roots.map(root => ({ source: root.source, path: text(root.path, rootPathBytes), files: root.files, error: root.error === null ? null : text(root.error, 160) })) } };
  const providerList = providerRows(24); if (providerList) result.providers = providerList;
  // Large valid identifiers cannot be shortened without breaking navigation. Reduce low-ranked rows only if needed.
  let modelLimit = 24, projectLimit = 24, providerLimit = 24;
  while (Buffer.byteLength(JSON.stringify(result)) >= 59_000) {
    if (result.sessions.length > 5) result.sessions.pop();
    else if ((result.providers?.length ?? 0) > 4 && providerLimit >= Math.max(modelLimit, projectLimit)) result.providers = providerRows(--providerLimit);
    else if (result.models.length > 2 && modelLimit >= projectLimit) result.models = projectRows(modelRows, --modelLimit);
    else if (result.projects.length > 2) result.projects = projectRows(projectBreakdown, --projectLimit);
    else if (result.models.length > 2) result.models = projectRows(modelRows, --modelLimit);
    else break;
  }
  return result;
}
