// Development-only synthetic token ledger (Token 页 / 实时流速). Deterministic per day; the live feed is a function of
// the clock so the chart moves the way the real one does. Magnitudes are those of a busy Claude Code / Codex user who
// also runs Grok CLI, Pi, oh-my-pi and OpenCode (2.14, 2.18).
import { addTokenCounts, emptyTokenCounts, tokenSourceNames } from "../shared/tokens";
import { statsRangeDays, vendorOf } from "../shared/stats";

const DAY = 86_400_000, HOUR = 3_600_000;
const scenario = () => new URLSearchParams(globalThis.location?.search ?? "").get("scenario");
function random(seed) { return () => { seed |= 0; seed = seed + 0x6d2b79f5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const round = Math.round;
const localDay = (at, offset) => new Date(at + offset * 60_000).toISOString().slice(0, 10);
const dayAt = day => Date.parse(`${day}T00:00:00.000Z`);

// [model, source, share of calls, output tok/s, output per call]
const models = [
  ["claude-opus-5-5", "claude", 0.40, 54, 1150], ["gpt-5-codex", "codex", 0.20, 68, 820], ["claude-fable-5-1", "claude", 0.11, 47, 1400],
  ["claude-haiku-4-5", "claude", 0.10, 138, 980], ["claude-sonnet-5", "claude", 0.07, 82, 900], ["gpt-5", "codex", 0.04, 61, 760],
  ["grok-4-fast", "grok", 0.05, 96, 640], ["kimi-k2", "pi", 0.03, 71, 700], ["glm-5.3-flash", "omp", 0.02, 64, 620],
  ["gemini-3-flash-preview", "opencode", 0.02, 88, 540], ["deepseek-v4.1-flash", "codebuddy", 0.02, 82, 480], ["qmodel-max", "qoder", 0.01, 74, 520],
  ["gemini-3-pro", "gemini", 0.01, 70, 600], ["coder-model", "qwen", 0.01, 66, 380],
  ["deepseek-v4-expressive", "cline", 0.01, 60, 420], ["gemini-3-flash", "roo", 0.005, 80, 300], ["kilo-model", "kilo", 0.005, 62, 350],
  ["glm-4.5-air", "hermes", 0.005, 70, 400], ["mimo-v2", "mimo", 0.005, 72, 360], ["deepseek-v4", "dsh", 0.005, 68, 340],
];
const projects = [["acme/web-app", 0.34], ["demo-project", 0.19], ["data-pipeline", 0.15], ["Commerce Platform", 0.12], ["Mobile Experience", 0.1], ["docs-site", 0.06], ["scratch", 0.04]];

function dayCounts(index, days, rand, share = 1, model = null) {
  const age = days - 1 - index, weekday = (index + 3) % 7;
  if (age > 120) return emptyTokenCounts();
  const growth = age < 8 ? 1.35 : age < 30 ? 1 : 0.55, weekend = weekday >= 5 ? 0.45 : 1;
  const idle = rand() < (age < 30 ? 0.06 : 0.3);
  const calls = idle ? 0 : round(1650 * growth * weekend * (0.65 + rand() * 0.7) * share);
  const [, source, , tps, perCall] = model ?? ["", "claude", 1, 58, 1100];
  const output = round(calls * perCall * (0.8 + rand() * 0.4)), gen = round(output * 0.93);
  // Grok logs whole turns without a response time, so its output never enters the speed.
  const timed = source === "grok" ? 0 : gen;
  return { calls, input: round(calls * (source === "codex" || source === "grok" ? 900 : 38)), cacheWrite: round(calls * 4200 * (0.7 + rand() * 0.6)),
    cacheRead: round(calls * 118_000 * (0.8 + rand() * 0.4)), output, reasoning: source === "codex" || source === "grok" ? round(output * 0.31) : 0,
    genMs: round(timed / tps * 1000), genOutput: timed };
}

const row = (key, label, vendor, counts, sessions, lastAt) => ({ ...counts, key, label, vendor, sessions, lastAt });

export function fixtureTokens(range = "30d", offset = 480, now = Date.now()) {
  const days = 400, today = localDay(now, offset), todayAt = dayAt(today), empty = scenario() === "tokens-empty";
  const history = Array.from({ length: days }, (_, index) => {
    const day = new Date(todayAt - (days - 1 - index) * DAY).toISOString().slice(0, 10), rand = random(20260924 + index);
    const byModel = models.map(model => dayCounts(index, days, rand, model[2], model));
    return { day, byModel, total: byModel.reduce((sum, counts) => addTokenCounts(sum, counts), emptyTokenCounts()) };
  });
  if (empty) for (const entry of history) { entry.total = emptyTokenCounts(); entry.byModel = models.map(() => emptyTokenCounts()); }
  // Today is only partly over: scale the last day by the elapsed local time.
  const elapsed = Math.max(0.05, ((now + offset * 60_000) % DAY) / DAY);
  const partial = counts => Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, round(value * elapsed)]));
  const lastDay = history.at(-1); lastDay.byModel = lastDay.byModel.map(partial); lastDay.total = partial(lastDay.total);
  const length = statsRangeDays[range], daily = history.slice(-length), before = history.slice(-2 * length, -length);
  const sum = rows => rows.reduce((total, entry) => addTokenCounts(total, entry.total), emptyTokenCounts());
  const totals = sum(daily), previous = sum(before), allTime = sum(history);
  const totalOf = counts => counts.input + counts.cacheWrite + counts.cacheRead + counts.output;
  const curve = [0.35, 0.22, 0.18, 0.08, 0.04, 0.03, 0.05, 0.14, 0.34, 0.6, 0.92, 1, 0.74, 0.66, 0.9, 0.97, 1, 0.88, 0.62, 0.58, 0.74, 0.86, 0.9, 0.7];
  const weight = curve.reduce((a, b) => a + b, 0), all = totalOf(totals);
  const modelRows = models.map((model, index) => row(model[0], model[0], vendorOf(model[0], null),
    daily.reduce((total, entry) => addTokenCounts(total, entry.byModel[index]), emptyTokenCounts()), round(18 * model[2] * length / 3 + 1), new Date(now - index * 11 * 60_000).toISOString()))
    .filter(entry => entry.calls > 0).sort((a, b) => totalOf(b) - totalOf(a));
  const sourceSessions = { claude: 14, codex: 5, grok: 2, pi: 0.5, omp: 0.5, opencode: 1, codebuddy: 1, qoder: 0.5, gemini: 0.5, qwen: 0.5, cline: 1, roo: 0.2, kilo: 0.2, hermes: 0.3, mimo: 0.3, dsh: 0.2 };
  const sourceRows = ["claude", "codex", "grok", "pi", "omp", "opencode", "codebuddy", "qoder", "gemini", "qwen", "cline", "roo", "kilo", "hermes", "mimo", "dsh"].map(source => row(source, tokenSourceNames[source], null,
    models.reduce((total, model) => model[1] === source ? addTokenCounts(total, modelRows.find(entry => entry.key === model[0]) ?? emptyTokenCounts()) : total, emptyTokenCounts()),
    round(length * sourceSessions[source] + 1), new Date(now - 60_000).toISOString())).filter(entry => entry.calls > 0).sort((a, b) => totalOf(b) - totalOf(a));
  const scale = (counts, share) => Object.fromEntries(Object.entries(emptyTokenCounts()).map(([key]) => [key, round(counts[key] * share)]));
  const projectRows = projects.map(([name, share], index) => row(name, name, null, scale(totals, share), round(length * 6 * share + 1), new Date(now - index * 37 * 60_000).toISOString())).filter(entry => entry.calls > 0);
  // Provider 用量: sessions matched to a Paseo Agent's provider, two custom ones sharing their base's log directory, and logs with no Paseo session.
  const providerShares = [["claude", "anthropic", 0.38], ["claude-team", "anthropic", 0.25], ["codex", "openai", 0.16], ["codex-gateway", "openai", 0.07], ["my-grok", "xai", 0.05], ["pi", "moonshot", 0.02]];
  const providerRows = empty ? [] : [...providerShares.map(([key, vendor, share], index) => row(key, key, vendor, scale(totals, share), round(length * 3 * share + 1), new Date(now - index * 23 * 60_000).toISOString())),
    row("__unmatched__", "未关联会话", null, scale(totals, 0.07), round(length / 3 + 1), new Date(now - 3 * HOUR).toISOString())];
  const paseoTitles = [["payment-root", "重构支付服务"], ["migration-review", "审查数据库迁移"], ["payment-idempotency", "实现幂等请求"], [null, null], ["release-check", "检查发布流水线"], ["perf-baseline", "整理性能基线"], [null, null], ["payment-tests", "补充接口测试"]];
  const sessions = empty ? [] : Array.from({ length: 12 }, (_, index) => {
    const [agentId, title] = paseoTitles[index % paseoTitles.length], model = models[index % models.length];
    const share = 0.16 / (1 + index * 0.55), counts = scale(totals, share);
    return { ...counts, sessionId: `fixture-session-${index + 1}`, source: model[1], model: model[0], project: projects[index % projects.length][0], agentId: index < 8 ? agentId : null,
      title: index < 8 ? title : null, firstAt: new Date(now - (index + 1) * 5 * HOUR).toISOString(), lastAt: new Date(now - index * 47 * 60_000).toISOString(), subagentCalls: round(counts.calls * (index % 3 === 0 ? 0.18 : 0)) };
  });
  const peak = daily.reduce((best, entry) => totalOf(entry.total) > (best ? best.total : -1) ? { day: entry.day, total: totalOf(entry.total) } : best, null);
  return {
    generatedAt: new Date(now).toISOString(), range, utcOffsetMinutes: offset, from: daily[0].day, to: today,
    totals, previous, allTime, daily: daily.map(entry => ({ ...entry.total, day: entry.day })),
    hours: curve.map(value => round(all * value / weight)),
    models: modelRows, sources: sourceRows, projects: empty ? [] : projectRows, providers: providerRows, sessions,
    records: empty ? { peakDay: null, fastest: null, biggest: null } : {
      peakDay: peak && peak.total > 0 ? peak : null,
      fastest: { tps: 186.4, model: "claude-haiku-4-5", at: new Date(now - 2 * DAY - 3 * HOUR).toISOString(), output: 2_840 },
      biggest: { output: 31_906, model: "claude-opus-5-5", at: new Date(now - 4 * DAY - 7 * HOUR).toISOString() } },
    speed: empty ? { p50: null, p90: null } : { p50: 57.8, p90: 121.3 },
    paseoShare: empty ? null : 0.93,
    coverage: {
      earliestAt: empty ? null : new Date(todayAt - 120 * DAY).toISOString(), latestAt: empty ? null : new Date(now - 4_000).toISOString(),
      backfill: empty ? { done: false, files: 287, filesDone: 121, bytes: 1_790_000_000, bytesDone: 752_000_000 } : { done: true, files: 287, filesDone: 287, bytes: 1_790_000_000, bytesDone: 1_790_000_000 },
      roots: [{ source: "claude", path: "~/.claude/projects", files: 163, error: null }, { source: "codex", path: "~/.codex/sessions", files: 124, error: null },
        { source: "grok", path: "~/.grok/sessions", files: 412, error: null }, { source: "pi", path: "~/.pi/agent/sessions", files: 18, error: null },
        { source: "omp", path: "~/.omp/agent/sessions", files: 9, error: null },
        { source: "opencode", path: "~/.local/share/opencode", files: 6, error: null },
        { source: "codebuddy", path: "~/.codebuddy/projects", files: 12, error: null }, { source: "qoder", path: "~/.qoder/projects", files: 4, error: null },
        { source: "gemini", path: "~/.gemini/tmp", files: 3, error: null }, { source: "qwen", path: "~/.qwen/projects", files: 5, error: null },
        { source: "cline", path: "~/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks", files: 7, error: null },
        { source: "roo", path: "~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks", files: 2, error: null },
        { source: "kilo", path: "~/.config/Code/User/globalStorage/kilocode.kilo-code/tasks", files: 1, error: null },
        { source: "hermes", path: "~/.hermes", files: 1, error: null }, { source: "mimo", path: "~/.local/share/mimocode", files: 1, error: null },
        { source: "dsh", path: "~/.dsh/storages/cost-meter", files: 1, error: null },
        { source: "claude", path: "~/.config/claude/projects", files: 0, error: null }],
    },
  };
}

// Live feed: bucket values are a pure function of the bucket index, so consecutive polls agree on the past.
const BUCKET = 10_000;
function bucketOutput(index) {
  const rand = random(index * 7919);
  const wave = 520 + 330 * Math.sin(index / 9) + 260 * Math.sin(index / 23 + 1.3) + 180 * Math.sin(index / 4.1);
  const burst = rand() < 0.08 ? 700 * rand() : 0, lull = Math.sin(index / 61) < -0.82 ? 0.15 : 1;
  return Math.max(0, round((wave + burst) * lull * (0.75 + rand() * 0.5)));
}
const liveAgents = [
  ["fixture-session-1", "claude", "payment-root", "重构支付服务", "claude-opus-5-5", 0.36],
  ["fixture-session-2", "claude", "migration-review", "审查数据库迁移", "claude-sonnet-5", 0.31],
  ["fixture-session-3", "codex", "payment-idempotency", "实现幂等请求", "gpt-5-codex", 0.22],
  ["fixture-session-4", "codex", null, null, "gpt-5-codex", 0.11],
  ["fixture-session-7", "grok", null, null, "grok-4-fast", 0.07],
];
export function fixtureTokenLive(windowMinutes = 30, offset = 480, detail = "full", now = Date.now()) {
  const count = windowMinutes * 6, last = Math.floor(now / BUCKET), first = last - count + 1;
  const quiet = scenario() === "tokens-empty";
  const output = [], input = [], calls = [];
  for (let index = first; index <= last; index++) {
    const value = quiet ? 0 : bucketOutput(index), partial = index === last ? (now % BUCKET) / BUCKET : 1;
    output.push(round(value * partial)); calls.push(value ? Math.max(1, round(value / 380)) : 0); input.push(round(value / 380 * 126_000 * partial));
  }
  const tail = output.slice(-6), perSec = tail.reduce((a, b) => a + b, 0) / 60;
  let peak = null;
  output.forEach((value, index) => { if (!peak || value / 10 > peak.outputPerSec) peak = { outputPerSec: value / 10, at: new Date((first + index) * BUCKET).toISOString() }; });
  const today = fixtureTokens("7d", offset, now).daily.at(-1);
  return {
    generatedAt: new Date(now).toISOString(), bucketMs: BUCKET, start: new Date(first * BUCKET).toISOString(),
    output: detail === "agents" ? [] : output, input: detail === "agents" ? [] : input, calls: detail === "agents" ? [] : calls,
    now: { outputPerSec: round(perSec * 10) / 10, inputPerSec: round(input.slice(-6).reduce((a, b) => a + b, 0) / 60), callsPerMin: calls.slice(-6).reduce((a, b) => a + b, 0) },
    peak: quiet || !peak || peak.outputPerSec === 0 ? null : peak,
    agents: quiet ? [] : liveAgents.map(([sessionId, source, agentId, title, model, share], position) => {
      // Running sessions always write something, so the fixture never has a silent minute that hides their tok/s chips.
      const recent = output.slice(-12).map((value, index) => round(Math.max(value, 240) * share * (0.6 + random(last * 31 + index * 7 + position)() * 0.8)));
      return { sessionId, source, agentId, title, model, outputPerSec: round(recent.slice(-6).reduce((a, b) => a + b, 0) / 60 * 10) / 10, recent,
        output10m: round(output.slice(-60).reduce((a, b) => a + b, 0) * share), calls10m: round(calls.slice(-60).reduce((a, b) => a + b, 0) * share),
        lastCallAt: new Date(now - (position * 7 + 2) * 1000).toISOString() };
    }).sort((a, b) => b.outputPerSec - a.outputPerSec),
    today: { total: today.input + today.cacheWrite + today.cacheRead + today.output, output: today.output, calls: today.calls },
  };
}
