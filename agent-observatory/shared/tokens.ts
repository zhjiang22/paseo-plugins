import { currentLanguage } from "./i18n";
import { t } from "./text";
import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { STATS_RANGES, statsTimeZoneSchema } from "./stats";

/**
 * Token ledger (Token 页 / 实时流速 / per-Agent tokens in 复盘).
 *
 * Paseo does not expose per-call usage to plugins (`lastUsage` is an in-memory snapshot of the latest call or turn,
 * missing for archived agents and most providers), so the server reads the providers' own local session logs, the
 * way ccusage / TokenTracker do:
 * - Claude Code, and custom providers that extend it: `$CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl` and
 *   `<session>/subagents/*.jsonl`; one line per content block, deduplicated by `message.id` + `requestId`.
 * - Codex, and custom providers that extend it: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` and archived sessions'
 *   `$CODEX_HOME/archived_sessions/rollout-*.jsonl` (2.13; a moved rollout keeps its read position), `event_msg` /
 *   `token_count` (`last_token_usage`, deduplicated by `total_token_usage`). A subagent thread's rollout
 *   (`session_meta.source.subagent`) counts for the session that spawned it, as Claude Code's `subagents/` logs do.
 * - Grok CLI (2.14), and ACP providers that run it: `$GROK_HOME/sessions/<encoded cwd>/<session>/usage.json`, the
 *   per-turn totals Grok writes when a turn ends (what `grok usage` prints). One record is one turn of one model and
 *   stands for its `modelCalls` model calls; turns copied into a resumed or forked session are deduplicated by their
 *   content. Grok logs no per-call start, so its turns have no response time and stay out of the output speed. The
 *   observatory's own Grok analyses (a `paseo-insight-*` temporary directory, deleted after each run) are not counted.
 * - Pi (2.14): `$PI_CODING_AGENT_SESSION_DIR`, else `$PI_CODING_AGENT_DIR/sessions` (`~/.pi/agent/sessions`),
 *   `--<cwd>--/<time>_<session>.jsonl`, counted as Pi totals a session: assistant messages, tool results that carry
 *   usage, and compaction / branch summaries; deduplicated by response id (a `/fork` or `/clone` copies messages).
 * - Kimi Code: `$KIMI_CODE_HOME/sessions/<cwd>/<session>/agents/<agent>/wire.jsonl` (default `~/.kimi-code`).
 * - ZCode: `$ZCODE_HOME/cli/db/db.sqlite`, read-only completed steps including WAL (default `~/.zcode`).
 * The directories are the standard ones plus any a custom provider sets in its config or launcher (server/tokens/roots).
 * Everything on the host is counted (not only Paseo-started sessions); sessions are matched to Paseo agents through
 * `persistence.sessionId`. Only counters, model names, working directories and session ids are retained — never
 * prompts, outputs or file contents.
 *
 * Normalisation: `input` is fresh input only (neither written to nor read from the prompt cache); `cacheWrite` and
 * `cacheRead` are the cached parts, so input + cacheWrite + cacheRead is everything the model read and
 * input + cacheWrite + cacheRead + output is the total. Codex and Grok report cached tokens inside their input count;
 * they are split out. `reasoning` is the part of `output` the provider reports as reasoning.
 *
 * Days and hours (2.14) are the device's, as on the statistics pages (shared/stats): its IANA `timeZone` when the server
 * knows that zone, each UTC hour converted with its own offset (exact across daylight-saving changes), else the fixed
 * `utcOffsetMinutes`. The ledger itself is kept by UTC hour.
 */
const count = z.number().int().nonnegative();
const duration = z.number().nonnegative().finite();
const iso = z.iso.datetime();
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rate = z.number().nonnegative().finite();

export const TOKEN_SOURCES = ["claude", "codex", "grok", "pi", "omp", "opencode", "codebuddy", "qoder", "gemini", "qwen", "cline", "roo", "kilo", "hermes", "mimo", "dsh", "kimi", "zcode"] as const;
export type TokenSource = typeof TOKEN_SOURCES[number];
export const tokenSourceNames: Record<TokenSource, string> = { claude: "Claude Code", codex: "Codex", grok: "Grok CLI", pi: "Pi", omp: "oh-my-pi", opencode: "OpenCode", codebuddy: "CodeBuddy", qoder: "Qoder", gemini: "Gemini CLI", qwen: "Qwen Code", cline: "Cline", roo: "Roo Code", kilo: "Kilo Code", hermes: "Hermes", mimo: "MiMoCode", dsh: "DeepSeek Harness", kimi: "Kimi Code", zcode: "ZCode" };
/** Provider breakdown row of the sessions no Paseo agent matches (run in a terminal, or the agent was deleted). */
export const TOKEN_UNMATCHED = "__unmatched__";
/** Sources whose records are written once when the work ends, with no response time: they count in totals but stay out
 * of the live speed and the fastest list. Every source must appear, so adding one forces the decision. */
export const WHOLE_TURN_SOURCES: Readonly<Record<TokenSource, boolean>> = { claude: false, codex: false, grok: true, pi: false, omp: false, opencode: false, codebuddy: true, qoder: false, gemini: true, qwen: false, cline: true, roo: true, kilo: true, hermes: true, mimo: false, dsh: true, kimi: false, zcode: false };
/** Log roots watched at once: the standard ones plus custom providers' config directories (server/tokens/roots). With
 * eighteen sources the defaults can reach 50 (platform host directories included), and the cap must stay above that (a
 * reader capped lower quarantines such a ledger and imports its logs again; a Provider whose discovered roots do not
 * fit is skipped without a notice). */
export const MAX_TOKEN_ROOTS = 64;
/** Codex's folder of archived sessions (a rollout moves there when its session is archived); shown apart in the coverage line. */
export const isArchivedLogRoot = (path: string): boolean => /[\\/]archived_sessions[\\/]?$/.test(path);

export const tokenCountsSchema = z.object({
  /** Model responses (API calls). */
  calls: count,
  input: count, cacheWrite: count, cacheRead: count, output: count, reasoning: count,
  /**
   * Response time summed over calls whose request start is known (previous log line), and those calls' output.
   * Output speed (TPS) = genOutput / genMs × 1000. Response time includes time to first token.
   */
  genMs: duration, genOutput: count,
});
export type TokenCounts = z.infer<typeof tokenCountsSchema>;
export const tokenDaySchema = tokenCountsSchema.extend({ day });
export type TokenDay = z.infer<typeof tokenDaySchema>;

/** One breakdown row (model, source, project). Counts cover the selected range. */
export const tokenRowSchema = tokenCountsSchema.extend({
  key: z.string().min(1).max(1024),
  label: z.string().max(240),
  /** Vendor of the model (see `vendorOf` in ./stats); null for sources and projects. */
  vendor: z.string().max(40).nullable(),
  /** Distinct provider sessions with calls in the range. */
  sessions: count,
  lastAt: iso.nullable(),
});
export type TokenRow = z.infer<typeof tokenRowSchema>;

/** A provider session (one log file plus its subagent logs), matched to a Paseo agent when possible. */
export const tokenSessionSchema = tokenCountsSchema.extend({
  sessionId: z.string().min(1).max(256),
  source: z.enum(TOKEN_SOURCES),
  /** Model with the most calls in the range. */
  model: z.string().max(240).nullable(),
  project: z.string().max(240),
  agentId: z.string().max(256).nullable(),
  title: z.string().max(240).nullable(),
  firstAt: iso, lastAt: iso,
  /** Calls made by the session's subagents (included in the counts). */
  subagentCalls: count,
});
export type TokenSession = z.infer<typeof tokenSessionSchema>;

export const tokenSnapshotSchema = z.object({
  generatedAt: iso,
  range: z.enum(STATS_RANGES),
  utcOffsetMinutes: z.number().int(),
  /** The IANA zone the days and hours were grouped in (2.14); null (or absent from older servers) for the fixed offset. */
  timeZone: statsTimeZoneSchema.nullable().optional(),
  from: day, to: day,
  totals: tokenCountsSchema,
  /** The equally long period right before `from`. */
  previous: tokenCountsSchema,
  allTime: tokenCountsSchema,
  /** One row per local day, oldest first, `from`…`to` inclusive (7 / 30 / 90 rows). */
  daily: z.array(tokenDaySchema).max(90),
  /** Total tokens by local hour of day (0–23) within the range. */
  hours: z.array(count).length(24),
  /** Sorted by total tokens; beyond the limits one "__other__" row (label 其他). */
  models: z.array(tokenRowSchema).max(24),
  sources: z.array(tokenRowSchema).max(TOKEN_SOURCES.length),
  projects: z.array(tokenRowSchema).max(24),
  /**
   * By Paseo provider (2.13): a session counts for the provider of the agent whose `persistence.sessionId` it is, so
   * custom providers that share one log directory are told apart. Ranked by total tokens (beyond 24 one "__other__"
   * row), then one TOKEN_UNMATCHED row (未关联会话) for the sessions no agent matches. Absent while the agent directory
   * has not been read (everything would look unmatched).
   */
  providers: z.array(tokenRowSchema).max(26).optional(),
  /** Top sessions by total tokens in the range. */
  sessions: z.array(tokenSessionSchema).max(20),
  records: z.object({
    peakDay: z.object({ day, total: count }).nullable(),
    /** Fastest call with ≥ 1 s response time and ≥ 100 output tokens. */
    fastest: z.object({ tps: rate, model: z.string().max(240).nullable(), at: iso, output: count }).nullable(),
    /** Call with the most output tokens. */
    biggest: z.object({ output: count, model: z.string().max(240).nullable(), at: iso }).nullable(),
  }),
  /** Per-call output speed percentiles over the range (calls as in `records.fastest`). */
  speed: z.object({ p50: rate.nullable(), p90: rate.nullable() }),
  /** Share of total tokens in the range from sessions matched to Paseo agents (0–1), null without tokens. */
  paseoShare: z.number().min(0).max(1).nullable(),
  coverage: z.object({
    earliestAt: iso.nullable(), latestAt: iso.nullable(),
    /** First import of existing logs; counts grow while it runs. */
    backfill: z.object({ done: z.boolean(), files: count, filesDone: count, bytes: count, bytesDone: count }),
    roots: z.array(z.object({ source: z.enum(TOKEN_SOURCES), path: z.string().max(1024), files: count, error: z.string().max(240).nullable() })).max(MAX_TOKEN_ROOTS),
    /** A budget cut the import (2.12): too many logs, too many bytes, an oversized dedupe index, or a scan stopped early. */
    truncated: z.object({ files: z.boolean(), bytes: z.boolean(), index: z.boolean(), scan: z.boolean() }).optional(),
  }),
});
export type TokenSnapshot = z.infer<typeof tokenSnapshotSchema>;

/**
 * Budgets of the log import (server/tokens/ingester). The defaults are far above a heavy host (about 600 logs, 4.7 GB,
 * 61,000 dedupe keys and 1,600 directory entries in October 2026), so they only stop pathological trees:
 * `files` logs tracked at once (the newest win); `bytes` their total size, i.e. what a first import may read; `index`
 * dedupe keys kept (the newest; older calls then count as copied history); `scanEntries` directory entries one scan visits.
 */
export const TOKEN_IMPORT_LIMITS = { files: 20_000, bytes: 64 * 1024 ** 3, index: 750_000, scanEntries: 250_000 } as const;
export type TokenImportLimits = { -readonly [Key in keyof typeof TOKEN_IMPORT_LIMITS]: number };
const wan = (count: number) => t("sharedTokens.m001", { value1: count / (currentLanguage() === "zh-CN" ? 10_000 : 1_000) });
/** Why the Token page is incomplete, in Chinese, or null when no budget cut the import. */
export function tokenTruncationNotice(truncated: { files: boolean; bytes: boolean; index: boolean; scan: boolean } | undefined, limits: TokenImportLimits = TOKEN_IMPORT_LIMITS): string | null {
  if (!truncated) return null;
  const reasons = [truncated.files ? t("sharedTokens.m002", { value1: wan(limits.files) }) : null, truncated.bytes ? t("sharedTokens.m003", { value1: limits.bytes / 1024 ** 3 }) : null,
    truncated.scan ? t("sharedTokens.m004", { value1: wan(limits.scanEntries) }) : null, truncated.index ? t("sharedTokens.m005", { value1: wan(limits.index) }) : null].filter(Boolean);
  return reasons.length ? t("sharedTokens.m006", { value1: reasons.join(t("sharedTokens.m007")) }) : null;
}

const revision = z.string().min(1).max(80);
const offset = z.number().int().min(-840).max(840);
export const tokenResponseSchema = z.discriminatedUnion("mode", [
  tokenSnapshotSchema.extend({ mode: z.literal("full"), unchanged: z.literal(false), revision }),
  z.object({ mode: z.literal("unchanged"), unchanged: z.literal(true), revision }),
]);
export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export const getTokens = defineRpc({
  name: "observatory.tokens.get",
  // `timeZone` is optional (2.14) as on observatory.stats.get: older clients, and zones this server does not know or whose
  // current offset disagrees with the device's, fall back to the fixed offset.
  input: z.object({ range: z.enum(STATS_RANGES), utcOffsetMinutes: offset, timeZone: statsTimeZoneSchema.optional(), revision: revision.optional() }),
  output: tokenResponseSchema,
});
export type TokenState = TokenSnapshot & { revision?: string };
export function mergeTokens(previous: TokenState | undefined, response: TokenResponse): TokenState {
  if (response.mode === "full") { const { mode: _mode, unchanged: _unchanged, ...snapshot } = response; return { ...snapshot, revision: response.revision }; }
  if (!previous) throw new Error(t("sharedTokens.m008"));
  return previous;
}

/** A session producing output right now (a call ended within the last 10 minutes). */
export const tokenLiveAgentSchema = z.object({
  sessionId: z.string().min(1).max(256),
  source: z.enum(TOKEN_SOURCES),
  agentId: z.string().max(256).nullable(),
  title: z.string().max(240).nullable(),
  model: z.string().max(240).nullable(),
  /** Output tokens per second over the last 2 minutes (spread over each call's response time). */
  outputPerSec: rate,
  /** Output tokens per bucket over the last 2 minutes (12 × 10 s), oldest first — the row's mini chart. */
  recent: z.array(count).length(12),
  output10m: count, calls10m: count,
  lastCallAt: iso,
});
export type TokenLiveAgent = z.infer<typeof tokenLiveAgentSchema>;

/**
 * Live throughput for the last `windowMinutes`. Each call's output is spread evenly over its response time
 * (start → end) across the buckets it overlaps; calls without a known start count in their end bucket. Input is
 * counted in the end bucket. The last bucket is the one containing `generatedAt` (partial).
 */
export const tokenLiveSchema = z.object({
  generatedAt: iso,
  bucketMs: z.literal(10_000),
  /** Start of the first bucket. */
  start: iso,
  output: z.array(count).max(360),
  input: z.array(count).max(360),
  calls: z.array(count).max(360),
  now: z.object({ outputPerSec: rate, inputPerSec: rate, callsPerMin: rate }),
  /** Highest 10 s bucket in the window, as tokens per second. */
  peak: z.object({ outputPerSec: rate, at: iso }).nullable(),
  /** Sorted by outputPerSec, then lastCallAt. */
  agents: z.array(tokenLiveAgentSchema).max(12),
  /** Total tokens since local midnight (for the hero), and output since local midnight. */
  today: z.object({ total: count, output: count, calls: count }),
});
export type TokenLive = z.infer<typeof tokenLiveSchema>;
export const TOKEN_LIVE_WINDOWS = [30, 60] as const;
export const getTokenLive = defineRpc({
  name: "observatory.tokens.live",
  input: z.object({
    windowMinutes: z.union([z.literal(30), z.literal(60)]),
    utcOffsetMinutes: offset,
    /** The device's IANA zone for `today`'s local midnight (2.14), as on observatory.tokens.get. */
    timeZone: statsTimeZoneSchema.optional(),
    /** "agents" returns empty series (for the session list's running rows); "full" everything. */
    detail: z.enum(["full", "agents"]),
  }),
  output: tokenLiveSchema,
});

export function emptyTokenCounts(): TokenCounts {
  return { calls: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, reasoning: 0, genMs: 0, genOutput: 0 };
}
export function addTokenCounts<T extends TokenCounts>(target: T, delta: Partial<TokenCounts>): T {
  for (const key of Object.keys(emptyTokenCounts()) as (keyof TokenCounts)[]) target[key] += delta[key] ?? 0;
  return target;
}
export const tokenTotal = (counts: Pick<TokenCounts, "input" | "cacheWrite" | "cacheRead" | "output">) => counts.input + counts.cacheWrite + counts.cacheRead + counts.output;
/** Everything the model read: fresh input plus cache writes and reads. */
export const tokenInput = (counts: Pick<TokenCounts, "input" | "cacheWrite" | "cacheRead">) => counts.input + counts.cacheWrite + counts.cacheRead;
/** Share of read input served from the prompt cache (0–1), null without input. */
export const cacheHitRate = (counts: Pick<TokenCounts, "input" | "cacheWrite" | "cacheRead">): number | null => {
  const read = tokenInput(counts);
  return read > 0 ? counts.cacheRead / read : null;
};
/** Output tokens per second over calls with a known response time, null below one second of samples. */
export const outputSpeed = (counts: Pick<TokenCounts, "genMs" | "genOutput">): number | null => counts.genMs >= 1000 ? counts.genOutput / counts.genMs * 1000 : null;
