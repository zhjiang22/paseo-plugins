// Did a turn stop on the provider's usage limit, even though it "completed"? Claude Code, Codex and others print the
// limit as the whole reply ("You've hit your limit · resets 3pm"), so the turn ends normally with that text. This
// tells such a notice from a reply that merely talks about rate limits, and reads when the limit resets.
//
// Ported from Agent Observatory's stop-reason classifier in the same collection, where it was tuned on real notices.
// Patterns match what providers and users write, so some are Chinese; they are data, not interface text.

import { failureKind, type FailureKind } from "../shared/failure";
import { isTurnStart } from "../shared/turn-start";
import type { RawItem } from "../shared/normalize";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** When it comes back, right after a limit phrase ("… Please try again in 20s", "· resets 5am", "| 1791696000"). */
const THEN_RESET = String.raw`(?:\s*[.,:;!|·∙—–-])*\s*(?:(?:please\s+)?(?:try again|retry|wait)\b|(?:(?:your\s+)?(?:limit|quota|usage)\s+(?:will\s+)?)?(?:resets?|available again)\b)|\s*\|\s*\d{10,13}\b`;
/** Notices that name the user's own limit: they count whole, at any length up to MAX_NOTICE. */
const LIMIT_STRICT = [
  /^(you['’]ve|you have) (hit|reached|exceeded) your ((usage|rate|session|weekly|daily|monthly|5-hour|five-hour|opus|sonnet|haiku|fable|plan|spend|credit|extra)[ -])*limits?\b/i,
  /^you['’]re out of (usage |extra usage )?credits\b/i,
  new RegExp(String.raw`^(\d+-hour|five-hour|weekly|daily|session) limit (reached|exceeded|hit)(?:\s*[.!。]?\s*$|${THEN_RESET})`, "i"),
];
/** Openings a reply about rate-limit work may also start with: in a reply they count only short and with a reset time. */
const LIMIT_LOOSE = [
  /^(you['’]ve|you have) (hit|reached|exceeded) (your|the) [\p{L}\p{N}'’ .-]{0,40}?\blimits?\b/iu,
  /^(claude( ai| code)?|codex|gemini|grok|cursor)?\s*((usage|rate|session|weekly|daily|5-hour|five-hour)[ -])+limits? (reached|exceeded|hit)\b/i,
  /^(rate|usage) limit(ed)? ?(reached|exceeded|hit)?\b.{0,40}(try again|resets?|retry)/i,
  /^(当前账[号户]|你的账[号户]|您的账[号户]|你|您)?(已经?)?(达到|用完|用尽|超出|超过)了?\s*(当前|本周|本月|今日|今天|每日|每周|\d+\s*小时|五小时)?\s*的?\s*(使用|用量|调用|请求)?\s*(额度|限额|上限|配额)/,
  /^(本周|本月|今日|今天|当前)?的?(使用|用量|调用)?(额度|配额|限额)已经?(用完|用尽|耗尽|达到上限)/,
];
const LIMIT_LOOSE_REPLY = [
  new RegExp(String.raw`^(you['’]ve|you have) (hit|reached|exceeded) (your|the) [\p{L}\p{N}'’ -]{0,40}?\blimits?(?:${THEN_RESET})`, "iu"),
  new RegExp(String.raw`^(claude( ai| code)?|codex|gemini|grok|cursor)?\s*((usage|rate|session|weekly|daily|5-hour|five-hour)[ -])+limits? (reached|exceeded|hit)(?:${THEN_RESET})`, "i"),
  new RegExp(String.raw`^(rate|usage) limit(ed)?( (reached|exceeded|hit))?(?:${THEN_RESET})`, "i"),
  ...LIMIT_LOOSE.slice(3),
];
const SHORT_NOTICE = 300;
const ZH_ACCOUNT = /^(你|您)(的账[号户])?已|(当前|你的|您的)账[号户]/;
const ZH_RETURNS = /[将会](于|在)[^，。,.；;！!？?]{0,24}(恢复|重置)|(后|之后)(恢复|重置)(使用)?(?=[。！!，,；;\s]|$)|(恢复|重置)时间/;
/** How a reply describes a change it made: never a limit notice. */
const ZH_WORK = /现在会|时会|会自动|已经?(加上|加了|补上|补了|添加|新增|实现|改为|改成)|改为|改成|新增|实现了/;
/** In an error message the vocabulary may be broader: it is never ordinary prose. */
const LIMIT_ERROR = /\b(rate[ _-]?limit(ed)?|usage[ _-]?limit|quota|insufficient_quota|too many requests|limit (reached|exceeded)|resource[ _-]?exhausted)\b|\b429\b|额度|限额|配额|限流|用量上限/i;
// i18n-ignore: full-width punctuation providers print before a notice; data, not interface text.
const LIMIT_IN_ERROR = [...LIMIT_STRICT, ...LIMIT_LOOSE].map((pattern) => new RegExp(pattern.source.replace(/^\^/, "(?:^|[\\s:：>\\]】)])"), pattern.flags));
/** The context window is a limit too, but not one a wait resolves. */
export const CONTEXT_FULL = /context (window|length)|max(imum)?[ _-]?(output[ _-]?)?tokens|prompt is too long|上下文/i;
const MAX_NOTICE = 800;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const HALF_DAY = 43_200_000;
const DAY = /^(?:d|天)/i;
const HOUR = /^(?:h|小时)/i;
const SECOND = /^(?:s|秒)/i;

function zoneOffsetMinutes(at: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return Math.round((Date.UTC(value("year"), value("month") - 1, value("day"), value("hour") % 24, value("minute"), value("second")) - Math.floor(at / 1000) * 1000) / 60_000);
}

/** Every UTC instant at which the clock in `zone` reads this wall time (two in a repeated fall-back hour). */
function wallInstants(year: number, month: number, day: number, hour: number, minute: number, zone: string): number[] {
  const wall = Date.UTC(year, month, day, hour, minute);
  const offsets = new Set([-HALF_DAY, 0, HALF_DAY].map((shift) => zoneOffsetMinutes(wall + shift, zone)));
  const exact = [...offsets].map((offset) => wall - offset * 60_000).filter((at) => at + zoneOffsetMinutes(at, zone) * 60_000 === wall).sort((a, b) => a - b);
  return exact.length ? exact : [wall - zoneOffsetMinutes(wall - HALF_DAY, zone) * 60_000];
}

function validZone(zone: string | undefined): string | null {
  if (!zone || zone.length > 64 || !/^[A-Za-z][\w+-]*(\/[\w+-]+){0,2}$/.test(zone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

function zonedDate(at: number, zone: string): { year: number; month: number; day: number } {
  const shifted = new Date(at + zoneOffsetMinutes(at, zone) * 60_000);
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth(), day: shifted.getUTCDate() };
}

/**
 * When the limit resets, from the notice: an epoch after `|`, an ISO time, "try again in 2h 30m", or a clock time
 * ("resets 3pm (America/New_York)", "resets Mon 9am", "resets Oct 12, 9am"). A clock time without a zone is read in
 * `zone` and marked guessed. Null when nothing within the next eight days is found.
 */
export function parseReset(notice: string, now: number, zone?: string): { at: number; guessed: boolean } | null {
  const plausible = (at: number | null | undefined, guessed = false) => (at !== null && at !== undefined && Number.isFinite(at) && at >= now - 3_600_000 && at <= now + 8 * 86_400_000 ? { at, guessed } : null);
  const epoch = /\|\s*(\d{10,13})\b/.exec(notice);
  if (epoch) {
    const value = Number(epoch[1]);
    const found = plausible(value < 1e12 ? value * 1000 : value);
    if (found) return found;
  }
  const iso = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2}))\b/.exec(notice);
  if (iso) {
    const found = plausible(Date.parse(iso[1]!));
    if (found) return found;
  }
  const relative =
    /\b(?:try again|retry|resets?|available again|wait)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b\s*(?:and\s*|,\s*)?)+)/i.exec(notice) ??
    /(\d+(?:\.\d+)?\s*(?:天|小时|分钟|秒)(?:\s*\d+(?:\.\d+)?\s*(?:天|小时|分钟|秒))*)\s*(?:后|之后)(?:重置|恢复|再试)/.exec(notice);
  if (relative) {
    let total = 0;
    for (const [, amount, unit] of relative[1]!.matchAll(/(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s|天|小时|分钟|秒)(?![a-z])/gi)) {
      const name = unit!.toLowerCase();
      total += Number(amount) * (DAY.test(name) ? 86_400_000 : HOUR.test(name) ? 3_600_000 : SECOND.test(name) ? 1000 : 60_000);
    }
    const found = total > 0 ? plausible(now + total) : null;
    if (found) return found;
  }
  const clock =
    /\b(?:resets?|reset at|available|try again at|again at|until)\s+(?:on\s+|at\s+)?(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s+)?(?:(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4}),?\s+)?(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b(?:\s*\(([^)]+)\))?/i.exec(notice);
  if (!clock) return null;
  const [, weekdayName, monthName, dayText, yearText, hourText, minuteText, meridiem, zoneText] = clock;
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (!meridiem && !minuteText) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const named = validZone(zoneText?.trim());
  const guessed = !named;
  const timeZone = named ?? validZone(zone) ?? "UTC";
  const today = zonedDate(now, timeZone);
  const upcoming = (instants: readonly number[]) => instants.find((at) => at >= now) ?? [...instants].reverse().find((at) => at >= now - 60_000);
  if (monthName) {
    const month = MONTHS.indexOf(monthName.toLowerCase().slice(0, 3));
    const day = Number(dayText);
    const on = (year: number) => (new Date(Date.UTC(year, month, day)).getUTCDate() === day ? wallInstants(year, month, day, hour, minute, timeZone) : []);
    if (yearText) {
      const instants = on(Number(yearText));
      return plausible(upcoming(instants) ?? instants[instants.length - 1], guessed);
    }
    const instants = on(today.year);
    const recent = upcoming(instants) ?? [...instants].reverse().find((at) => at >= now - 3_600_000);
    return plausible(recent ?? upcoming(on(today.year + 1)), guessed);
  }
  for (let offset = 0; offset <= 7; offset++) {
    const date = new Date(Date.UTC(today.year, today.month, today.day + offset));
    if (weekdayName && WEEKDAYS[date.getUTCDay()] !== weekdayName.toLowerCase().slice(0, 3)) continue;
    const at = upcoming(wallInstants(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, timeZone));
    if (at !== undefined) return plausible(at, guessed);
  }
  return null;
}

export interface LimitNotice {
  resetAt: string | null;
  resetGuessed?: true;
}

/**
 * A limit notice in a closing reply ("reply": anchored and short), in one message judged alone ("strict": only notices
 * that name the user's own limit), or in an error message ("error": broader). Null when it is not one.
 */
export function quotaNotice(value: string | null | undefined, source: "reply" | "strict" | "error", now: number, zone?: string): LimitNotice | null {
  const notice = text(value).trim();
  if (!notice || notice.length > (source === "error" ? 4000 : MAX_NOTICE) || CONTEXT_FULL.test(notice)) return null;
  const reset = () => parseReset(notice, now, zone);
  let found: ReturnType<typeof parseReset> | undefined;
  if (source === "error") {
    if (!LIMIT_ERROR.test(notice) && !LIMIT_IN_ERROR.some((pattern) => pattern.test(notice))) return null;
  } else if (!LIMIT_STRICT.some((pattern) => pattern.test(notice))) {
    if (source === "strict" || notice.length > SHORT_NOTICE || ZH_WORK.test(notice) || !LIMIT_LOOSE_REPLY.some((pattern) => pattern.test(notice))) return null;
    found = reset();
    if (!found && !ZH_ACCOUNT.test(notice) && !ZH_RETURNS.test(notice)) return null;
  }
  found ??= reset();
  return found ? { resetAt: new Date(found.at).toISOString(), ...(found.guessed ? { resetGuessed: true as const } : {}) } : { resetAt: null };
}

/** A provider error printed as the reply (Claude Code's "API Error: …", Paseo's "[System Error] …"). */
const ERROR_REPLY = /^(?:API Error\b|\[System Error\])/i;

const NEUTRAL = new Set(["todo", "notification", "compaction", "plugin", "user_message", "reasoning"]);
const RETRY = /^provider retry\b/i;

/**
 * Whether the turn that just ended (its items, oldest first, back to the turn start) stopped on a limit: a failure
 * that names one, or a completed turn whose closing reply is a limit notice. Canceled turns are the user's doing.
 */
export function turnLimit(input: { outcome: "completed" | "failed" | "canceled"; error?: string | null; items: readonly RawItem[]; now: number; zone?: string }): (LimitNotice & { kind: "limit" | "context" }) | null {
  if (input.outcome === "canceled") return null;
  let start = 0;
  for (let index = input.items.length - 1; index >= 0; index--) {
    if (isTurnStart(input.items[index]!)) {
      start = index + 1;
      break;
    }
  }
  const turn = input.items.slice(start);
  const inError = (message: string): (LimitNotice & { kind: "limit" | "context" }) | null => {
    if (CONTEXT_FULL.test(message)) return { kind: "context", resetAt: null };
    const notice = quotaNotice(message, "error", input.now, input.zone);
    return notice ? { kind: "limit", ...notice } : null;
  };
  if (input.outcome === "failed") {
    const reason = text(input.error).trim();
    if (reason) return inError(reason);
    for (let index = turn.length - 1; index >= 0; index--) if (turn[index]!.type === "error") return inError(text(turn[index]!.message));
    return null;
  }
  let index = turn.length - 1;
  while (index >= 0 && (NEUTRAL.has(turn[index]!.type) || turn[index]!.type === "error")) {
    const item = turn[index]!;
    if (item.type === "error" && !RETRY.test(text(item.message).trim())) {
      const found = inError(text(item.message));
      if (found) return found;
    }
    index--;
  }
  const parts: string[] = [];
  for (let cursor = index; cursor >= 0 && turn[cursor]!.type === "assistant_message"; cursor--) parts.unshift(text(turn[cursor]!.text));
  const reply = parts.join("").trim();
  if (!reply) return null;
  if (ERROR_REPLY.test(reply)) return inError(reply);
  const notice = quotaNotice(reply, "reply", input.now, input.zone) ?? (parts.length > 1 ? quotaNotice(parts[parts.length - 1], "strict", input.now, input.zone) : null);
  return notice ? { kind: "limit", ...notice } : null;
}

/** The closing reply of a turn, when it is a provider error printed as text. */
function errorReply(items: readonly RawItem[]): string | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (isTurnStart(item)) return null;
    if (NEUTRAL.has(item.type) || item.type === "error") continue;
    const reply = item.type === "assistant_message" ? text(item.text).trim() : "";
    return ERROR_REPLY.test(reply) ? reply : null;
  }
  return null;
}

/**
 * What went wrong in a turn that "completed": the provider's limit or a full context (see turnLimit), or another
 * provider error printed as the reply, classified the way the failure button classifies a failed turn.
 */
export function turnTrouble(input: { items: readonly RawItem[]; now: number; zone?: string }): (LimitNotice & { kind: FailureKind }) | null {
  const limit = turnLimit({ outcome: "completed", items: input.items, now: input.now, zone: input.zone });
  if (limit) return limit;
  const reply = errorReply(input.items);
  return reply ? { kind: failureKind("error", null, reply) ?? "error", resetAt: null } : null;
}
