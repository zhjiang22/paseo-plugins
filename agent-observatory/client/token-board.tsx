import { currentLanguage } from "../shared/i18n";
import { t, tParts } from "../shared/text";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import { vendorOf, type StatsBreakdownRow, type StatsRange } from "../shared/stats";
import { bigNumber, percent, weekdayNames } from "../shared/stats-view";
import { cacheHitRate, isArchivedLogRoot, outputSpeed, TOKEN_SOURCES, TOKEN_UNMATCHED, tokenInput, tokenSourceNames, tokenTotal, tokenTruncationNotice, type TokenCounts, type TokenLive, type TokenRow, type TokenSnapshot, type TokenSource } from "../shared/tokens";
import { Banner, EmptyState, ProjectMark, Segmented, Skeleton, aria, fontSize, gradient, hairline, hue, hueFor, radius, relativeTime, space, withAlpha, type Hue } from "./kit";
import { Card, CompositionBar, Donut, InlineBar, StackedColumns, TrendChart } from "./charts";
import { GlassPill, IconDisk, StatsHeader, rowHues, trackFor, vendorHue, vendorLabel } from "./stats-common";
import { KpiTile, type Tile } from "./stats-board";
import { LiveRateCard, perSecond } from "./live-rate";
import { Ping } from "./motion";
import { QuotaCard, quotaInfo, type QuotaCardProps } from "./quota-card";

/** The four kinds of tokens, bottom to top in stacked charts: cache reads dominate, output matters most. */
export const tokenKinds = [
  { key: "cacheRead", get label() { return t("secondaryTokenBoard.cacheRead"); }, hue: "green" }, { key: "cacheWrite", get label() { return t("secondaryTokenBoard.cacheWrite"); }, hue: "sky" },
  { key: "input", get label() { return t("secondaryTokenBoard.newInput"); }, hue: "violet" }, { key: "output", get label() { return t("secondaryTokenBoard.output"); }, hue: "pink" },
] as const satisfies ReadonlyArray<{ key: keyof TokenCounts; label: string; hue: Hue }>;
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const longDay = (day: string) => t("secondaryTokenBoard.message", { value1: Number(day.slice(5, 7)), value2: Number(day.slice(8, 10)), value3: weekdayNames[(new Date(`${day}T00:00:00.000Z`).getUTCDay() + 6) % 7] });
const days: Record<StatsRange, number> = { "7d": 7, "30d": 30, "90d": 90 };
export const tokenInfo = () => [
  t("secondaryTokenBoard.tokensComeFromLocalClaudeCode"),
  t("secondaryTokenBoard.includesAllLocalSessionsFromThese"),
  t("secondaryTokenBoard.grokCliRecordsEachTurnS"),
  t("secondaryTokenBoard.providerUsageLinksLogsToPaseo"),
  t("secondaryTokenBoard.dailyAndHourlyCountsUseThis"),
  t("secondaryTokenBoard.newInputCacheWriteCacheRead"),
  t("secondaryTokenBoard.outputRateTpsOutputTokensResponse"),
  t("secondaryTokenBoard.onlyCountsModelsWorkingDirectoriesAnd"),
  ...quotaInfo,
];
/** Each log source's colour in the source rows: the vendor family it mostly runs (Claude orange, Codex teal, Grok violet), Pi pink, oh-my-pi sky, OpenCode cyan, CodeBuddy blue, Qoder green, Gemini CLI fuchsia, Qwen Code lime. */
const sourceHues: Record<TokenSource, Hue> = { claude: "orange", codex: "teal", grok: "violet", pi: "pink", omp: "sky", opencode: "cyan", codebuddy: "blue", qoder: "green", gemini: "fuchsia", qwen: "lime", cline: "amber", roo: "red", kilo: "gray", hermes: "indigo", mimo: "teal", dsh: "violet", kimi: "violet", zcode: "orange" };
const isTokenSource = (key: string): key is TokenSource => (TOKEN_SOURCES as readonly string[]).includes(key);

function Hero({ theme, snapshot, live, narrow }: { theme: PluginTheme; snapshot: TokenSnapshot; live?: TokenLive; narrow: boolean }) {
  const today = snapshot.daily.at(-1), todayTotal = live?.today.total ?? (today ? tokenTotal(today) : 0), todayOutput = live?.today.output ?? today?.output ?? 0;
  const rate = live?.now.outputPerSec ?? 0, writing = live?.agents.filter(agent => agent.outputPerSec > 0).length ?? 0, hit = today ? cacheHitRate(today) : null;
  const total = tokenTotal(snapshot.totals), n = days[snapshot.range];
  return <View style={[{ borderRadius: 20, padding: space.lg, gap: space.md, overflow: "hidden" }, gradient(theme, ["#F59E0B", "#EC4899", "#8B5CF6"], { angle: 125 })]}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space.md }}>
      <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
        <Text style={{ color: withAlpha("#ffffff", 0.88), fontSize: fontSize.small, fontWeight: "700" }}>{t("secondaryTokenBoard.consumedToday")}</Text>
        <Text numberOfLines={1} adjustsFontSizeToFit style={{ color: "#ffffff", fontSize: narrow ? 30 : 38, lineHeight: narrow ? 36 : 44, fontWeight: "900", letterSpacing: -1, fontVariant: ["tabular-nums"] }}>
          {tParts("secondaryTokenBoard.tokenCount", { count: bigNumber(todayTotal) }).map((part, index) => part.param === "count" ? part.text : <Text key={index} style={{ fontSize: fontSize.title, fontWeight: "800" }}>{part.text}</Text>)}</Text>
        <Text numberOfLines={2} style={{ color: withAlpha("#ffffff", 0.85), fontSize: fontSize.meta }}>{t("secondaryTokenBoard.outputCalls", { value1: bigNumber(todayOutput), value2: bigNumber(live?.today.calls ?? today?.calls ?? 0), value3: hit !== null ? t("secondaryTokenBoard.cacheHit", { value1: percent(hit) }) : "" })}</Text>
      </View>
      <View accessibilityLabel={t("secondaryTokenBoard.tokensPerSecondLive", { value1: perSecond(rate) })} style={{ alignItems: "flex-end", gap: 2, minWidth: 92 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <View style={{ width: 10, height: 10, alignItems: "center", justifyContent: "center" }}><Ping size={10} color="#ffffff" active={rate > 0} /><View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: rate > 0 ? "#ffffff" : withAlpha("#ffffff", 0.5) }} /></View>
          <Icon name="Zap" size={18} color="#FFF3B0" />
          <Text style={{ color: "#ffffff", fontSize: 26, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{perSecond(rate)}</Text>
        </View>
        <Text style={{ color: withAlpha("#ffffff", 0.88), fontSize: fontSize.meta, fontWeight: "700" }}>{t("secondaryTokenBoard.tokSLive")}</Text>
        <Text style={{ color: withAlpha("#ffffff", 0.8), fontSize: 11 }}>{writing ? t("secondaryTokenBoard.sessionsOutputting", { count: writing }) : t("secondaryTokenBoard.noOutputRightNow")}</Text>
      </View>
    </View>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.sm }}>
      <GlassPill label={t("secondaryTokenBoard.lastDays", { count: n })} value={bigNumber(total)} icon="Coins" />
      <GlassPill label={t("secondaryTokenBoard.dailyAverage")} value={bigNumber(total / n)} icon="CalendarDays" />
      {snapshot.speed.p50 !== null ? <GlassPill label={t("secondaryTokenBoard.medianRate")} value={t("secondaryTokenBoard.tokenRate", { rate: perSecond(snapshot.speed.p50) })} icon="Gauge" /> : null}
      {snapshot.paseoShare !== null ? <GlassPill label={t("secondaryTokenBoard.paseoSessions")} value={percent(snapshot.paseoShare)} icon="Orbit" /> : null}
    </View>
  </View>;
}

function tiles(snapshot: TokenSnapshot): Tile[] {
  const { totals, previous: p, daily } = snapshot, n = days[snapshot.range];
  const spark = (pick: (day: TokenSnapshot["daily"][number]) => number) => daily.slice(-14).map(pick);
  const hit = cacheHitRate(totals), speed = outputSpeed(totals), read = tokenInput(totals);
  return [
    { key: "total", label: t("secondaryTokenBoard.totalTokens"), icon: "Coins", colors: ["amber", "orange"], value: bigNumber(tokenTotal(totals)), sub: t("secondaryTokenBoard.dailyAverage2", { value1: bigNumber(tokenTotal(totals) / n) }), current: tokenTotal(totals), previous: tokenTotal(p), spark: spark(tokenTotal) },
    { key: "output", label: t("secondaryTokenBoard.output"), icon: "PenLine", colors: ["pink", "fuchsia"], value: bigNumber(totals.output), sub: totals.reasoning && totals.reasoning <= totals.output ? t("secondaryTokenBoard.includingReasoning", { value1: bigNumber(totals.reasoning) }) : totals.calls ? t("secondaryTokenBoard.perCall", { value1: bigNumber(totals.output / totals.calls) }) : undefined, current: totals.output, previous: p.output, spark: spark(day => day.output) },
    { key: "cacheRead", label: t("secondaryTokenBoard.cacheRead"), icon: "DatabaseZap", colors: ["green", "teal"], value: bigNumber(totals.cacheRead), sub: read ? t("secondaryTokenBoard.ofInput", { value1: percent(totals.cacheRead / read, 1) }) : undefined, current: totals.cacheRead, previous: p.cacheRead, spark: spark(day => day.cacheRead) },
    { key: "cacheWrite", label: t("secondaryTokenBoard.cacheWrite"), icon: "DatabaseBackup", colors: ["sky", "blue"], value: bigNumber(totals.cacheWrite), sub: t("secondaryTokenBoard.newlyWrittenToPromptCache"), current: totals.cacheWrite, previous: p.cacheWrite, spark: spark(day => day.cacheWrite) },
    { key: "input", label: t("secondaryTokenBoard.newInput"), icon: "ArrowDownToLine", colors: ["violet", "indigo"], value: bigNumber(totals.input), sub: t("secondaryTokenBoard.inputWithoutCache"), current: totals.input, previous: p.input, spark: spark(day => day.input) },
    { key: "hit", label: t("secondaryTokenBoard.cacheHitRate"), icon: "Target", colors: ["lime", "green"], value: percent(hit, 1), sub: t("secondaryTokenBoard.input", { value1: bigNumber(read) }), current: hit ?? 0, previous: cacheHitRate(p) ?? 0, spark: spark(day => cacheHitRate(day) ?? 0), ring: hit },
    { key: "speed", label: t("secondaryTokenBoard.outputRate"), icon: "Gauge", colors: ["cyan", "blue"], value: speed === null ? "—" : `${perSecond(speed)}`, sub: snapshot.speed.p50 !== null && snapshot.speed.p90 !== null ? t("secondaryTokenBoard.medianPTokS", { value1: perSecond(snapshot.speed.p50), value2: perSecond(snapshot.speed.p90) }) : t("secondaryTokenBoard.tokenRateUnit"), current: speed ?? 0, previous: outputSpeed(p) ?? 0, spark: spark(day => outputSpeed(day) ?? 0) },
    { key: "calls", label: t("secondaryTokenBoard.modelCalls"), icon: "Repeat2", colors: ["orange", "red"], value: bigNumber(totals.calls), sub: totals.calls ? t("secondaryTokenBoard.inputPerCall", { value1: bigNumber(read / totals.calls) }) : undefined, current: totals.calls, previous: p.calls, spark: spark(day => day.calls) },
  ];
}

function TrendCard({ theme, snapshot }: { theme: PluginTheme; snapshot: TokenSnapshot }) {
  const [metric, setMetric] = useState<"total" | "fresh" | "output" | "speed">("total");
  // Cache reads are ~96 % of all tokens; 非缓存 leaves them out so input, cache writes and output are visible.
  const kinds = metric === "fresh" ? tokenKinds.filter(kind => kind.key !== "cacheRead") : tokenKinds, colors = kinds.map(kind => hue(theme, kind.hue));
  return <Card theme={theme} title={t("secondaryTokenBoard.tokenTrend")} icon="ChartColumnStacked" color="amber" trailing={<Segmented theme={theme} size="sm" value={metric} onChange={setMetric} accessibilityLabel={t("secondaryTokenBoard.trendMetric")} options={[{ value: "total", label: t("secondaryTokenBoard.total") }, { value: "fresh", label: t("secondaryTokenBoard.uncached") }, { value: "output", label: t("secondaryTokenBoard.output") }, { value: "speed", label: t("secondaryTokenBoard.rate") }]} />}>
    {metric === "total" || metric === "fresh" ? <StackedColumns key={metric} theme={theme} colors={colors} names={kinds.map(kind => kind.label)} format={bigNumber}
      columns={snapshot.daily.map(day => ({ label: shortDay(day.day), detail: longDay(day.day), parts: kinds.map(kind => day[kind.key]) }))} />
      : <TrendChart theme={theme} color={metric === "output" ? "pink" : "cyan"} format={metric === "output" ? bigNumber : value => `${perSecond(value)}`}
        points={snapshot.daily.map(day => ({ label: shortDay(day.day), value: metric === "output" ? day.output : outputSpeed(day) ?? 0, detail: longDay(day.day) }))} average={metric === "output"} />}
  </Card>;
}

function CompositionCard({ theme, counts }: { theme: PluginTheme; counts: TokenCounts }) {
  const total = tokenTotal(counts), hit = cacheHitRate(counts);
  return <Card theme={theme} title={t("secondaryTokenBoard.tokenComposition")} icon="PieChart" color="green">
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, flexWrap: "wrap" }}>
      <Donut size={132} stroke={16} gap={3} track={trackFor(theme)} segments={tokenKinds.map(kind => ({ value: counts[kind.key], color: hue(theme, kind.hue) }))}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "900", fontVariant: ["tabular-nums"] }}>{percent(hit)}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("secondaryTokenBoard.cacheHit2")}</Text>
      </Donut>
      <View style={{ flex: 1, minWidth: 180, gap: 6 }}>
        {[...tokenKinds].reverse().map(kind => <View key={kind.key} style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <View style={{ width: 10, height: 10, borderRadius: 3, backgroundColor: hue(theme, kind.hue) }} />
          <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "600" }}>{kind.label}</Text>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{bigNumber(counts[kind.key])}</Text>
          <Text style={{ width: 48, textAlign: "right", color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{percent(total ? counts[kind.key] / total : 0, total && counts[kind.key] / total < 0.1 ? 1 : 0)}</Text>
        </View>)}
        {hit !== null ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, lineHeight: 18 }}>{t("secondaryTokenBoard.ofEveryInputTokensComeDirectly", { value1: Math.round(hit * 100) })}</Text> : null}
      </View>
    </View>
  </Card>;
}

function RowStats({ theme, row }: { theme: PluginTheme; row: TokenCounts }) {
  const speed = outputSpeed(row), hit = cacheHitRate(row);
  return <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{speed !== null ? t("secondaryTokenBoard.rowOutputHitRateCalls", { output: bigNumber(row.output), hit: percent(hit), rate: perSecond(speed), calls: bigNumber(row.calls) }) : t("secondaryTokenBoard.rowOutputHitCalls", { output: bigNumber(row.output), hit: percent(hit), calls: bigNumber(row.calls) })}</Text>;
}
type RowKind = "models" | "projects" | "sources" | "providers";
function rowSubtitle(kind: RowKind, row: TokenRow): string {
  const when = row.lastAt ? ` · ${relativeTime(row.lastAt)}` : "";
  if (row.key === TOKEN_UNMATCHED) return t("secondaryTokenBoard.sessionsRunFromTerminalOrDeleted", { count: row.sessions, value2: when });
  return t("secondaryTokenBoard.sessions", { value1: kind === "models" || kind === "providers" ? `${vendorLabel(row.vendor ?? (kind === "models" ? vendorOf(row.key, null) : null))} · ` : "", value2: row.sessions, value3: when });
}
function TokenRows({ theme, rows, kind, total, limit = 8, hues, ranked = true, empty = t("secondaryTokenBoard.noDataInThisRangeYet") }: {
  theme: PluginTheme; rows: readonly TokenRow[]; kind: RowKind; total: number; limit?: number; hues?: ReadonlyMap<string, Hue>; ranked?: boolean; empty?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const max = Math.max(1, ...rows.map(tokenTotal)), shown = expanded ? rows : rows.slice(0, limit);
  if (!rows.length) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{empty}</Text>;
  return <View>
    {shown.map((row, index) => {
      const color: Hue = row.key === "__other__" || row.key === TOKEN_UNMATCHED ? "gray" : hues?.get(row.key) ?? (kind === "models" ? vendorHue(row.vendor ?? vendorOf(row.key, null)) : kind === "sources" ? (isTokenSource(row.key) ? sourceHues[row.key] : hueFor(row.label)) : hueFor(row.label));
      const value = tokenTotal(row);
      return <View key={row.key} style={{ gap: 5, paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text numberOfLines={1} style={{ width: 22, textAlign: "center", fontVariant: ["tabular-nums"], color: ranked && index < 3 ? hue(theme, color, "text") : theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800" }}>{ranked ? index + 1 : "—"}</Text>
          {kind === "projects" && row.key !== "__other__" ? <ProjectMark theme={theme} name={row.label} size={20} /> : <View style={{ width: 20, height: 20, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: hue(theme, color, "soft") }}><View style={{ width: 9, height: 9, borderRadius: 3, backgroundColor: hue(theme, color) }} /></View>}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: row.key === TOKEN_UNMATCHED ? theme.colors.foregroundMuted : theme.colors.foreground, fontSize: fontSize.body, fontWeight: "600" }}>{row.label}</Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{rowSubtitle(kind, row)}</Text>
          </View>
          <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{bigNumber(value)}</Text>
          <Text style={{ width: 46, textAlign: "right", color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{percent(total ? value / total : 0, total && value / total < 0.1 ? 1 : 0)}</Text>
        </View>
        <View style={{ marginLeft: 18 + 20 + 2 * space.sm, gap: 4 }}>
          <View style={{ width: `${Math.max(4, value / max * 100)}%` }}><CompositionBar height={7} track={trackFor(theme)} segments={tokenKinds.map(item => ({ key: item.key, value: row[item.key], color: hue(theme, item.hue) }))} /></View>
          <RowStats theme={theme} row={row} />
        </View>
      </View>;
    })}
    {rows.length > limit ? <Pressable accessibilityRole="button" accessibilityState={{ expanded }} {...aria({ expanded })} onPress={() => setExpanded(!expanded)} style={{ alignSelf: "center", paddingVertical: 6, paddingHorizontal: 12 }}>
      <Text style={{ color: hue(theme, "amber", "text"), fontSize: fontSize.small, fontWeight: "700" }}>{expanded ? t("secondaryTokenBoard.collapse") : t("secondaryTokenBoard.expandAllMore", { value1: rows.length - limit })}</Text>
    </Pressable> : null}
  </View>;
}

/**
 * Provider 用量 (2.13): sessions matched to Paseo agents, by the agent's provider, so custom providers sharing one log
 * directory are told apart; the sessions nothing matches stand apart as 未关联会话.
 */
function ProviderCard({ theme, snapshot, total }: { theme: PluginTheme; snapshot: TokenSnapshot; total: number }) {
  const rows = snapshot.providers;
  const ranked = useMemo(() => rows?.filter(row => row.key !== TOKEN_UNMATCHED) ?? [], [rows]), unmatched = rows?.find(row => row.key === TOKEN_UNMATCHED);
  // rowHues reads only key, vendor and label: a provider's colour follows its models' vendor, neighbours take adjacent hues.
  const hues = useMemo(() => rowHues(ranked as unknown as readonly StatsBreakdownRow[], "provider"), [ranked]);
  const named = ranked.filter(row => row.key !== "__other__").length;
  return <Card theme={theme} title={t("secondaryTokenBoard.providerUsage")} icon="Network" color="violet" trailing={rows ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryTokenBoard.providers", { count: named })}</Text> : undefined}>
    {!rows ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryTokenBoard.readingThePaseoSessionDirectoryTo")}</Text> : <>
      <TokenRows theme={theme} rows={ranked} kind="providers" total={total} limit={6} hues={hues} empty={t("secondaryTokenBoard.noUsageLinkedToPaseoSessions")} />
      {unmatched ? <TokenRows theme={theme} rows={[unmatched]} kind="providers" total={total} ranked={false} /> : null}
    </>}
  </Card>;
}

function SessionsCard({ theme, snapshot, onOpenAgent }: { theme: PluginTheme; snapshot: TokenSnapshot; onOpenAgent?: (agentId: string) => void }) {
  const total = tokenTotal(snapshot.totals), max = Math.max(1, ...snapshot.sessions.map(tokenTotal));
  return <Card theme={theme} title={t("secondaryTokenBoard.sessionsUsingTheMostTokens")} icon="Flame" color="red" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryTokenBoard.top", { value1: snapshot.sessions.length })}</Text>}>
    {snapshot.sessions.length ? <View>{snapshot.sessions.map((session, index) => {
      const value = tokenTotal(session), color = hue(theme, vendorHue(vendorOf(session.model, null)));
      const title = session.title ?? (session.agentId ? t("secondaryTokenBoard.unnamedAgent") : t("secondaryTokenBoard.sessionNotLinkedToPaseo", { value1: session.sessionId.slice(0, 8) }));
      const body = <View style={{ gap: 4, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: trackFor(theme) }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <Text numberOfLines={1} style={{ width: 22, textAlign: "center", fontVariant: ["tabular-nums"], color: index < 3 ? hue(theme, "red", "text") : theme.colors.foregroundMuted, fontSize: fontSize.small, fontWeight: "800" }}>{index + 1}</Text>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text numberOfLines={1} style={{ color: session.title ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: fontSize.body, fontWeight: "600" }}>{title}</Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{[session.project, session.model ?? tokenSourceNames[session.source], session.subagentCalls ? t("secondaryTokenBoard.subagentCalls", { value1: bigNumber(session.subagentCalls) }) : null, relativeTime(session.lastAt)].filter(Boolean).join(" · ")}</Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{bigNumber(value)}</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{percent(total ? value / total : 0, 1)}</Text>
          </View>
        </View>
        <View style={{ marginLeft: 18 + space.sm }}><InlineBar value={value} max={max} color={color} track={trackFor(theme)} height={5} /></View>
      </View>;
      return session.agentId && onOpenAgent ? <Pressable key={session.sessionId} accessibilityRole="button" accessibilityLabel={t("secondaryTokenBoard.openTokens", { value1: title, value2: bigNumber(value) })} onPress={() => onOpenAgent(session.agentId!)} style={state => ({ opacity: state.pressed ? 0.7 : 1 })}>{body}</Pressable> : <View key={session.sessionId}>{body}</View>;
    })}</View> : <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.small }}>{t("secondaryTokenBoard.noSessionUsageInThisRange")}</Text>}
  </Card>;
}

function RhythmCard({ theme, snapshot }: { theme: PluginTheme; snapshot: TokenSnapshot }) {
  const peak = snapshot.hours.reduce((best, value, hour) => value > (snapshot.hours[best] ?? 0) ? hour : best, 0);
  const records = snapshot.records;
  const item = (icon: string, colors: readonly [Hue, Hue], label: string, value: string, sub: string) => <View key={label} style={{ flexDirection: "row", alignItems: "center", gap: space.sm, minWidth: 160, flexGrow: 1, flexBasis: 0 }}>
    <IconDisk theme={theme} icon={icon} colors={colors} size={30} />
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{label}</Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: fontSize.body, fontWeight: "800", fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{sub}</Text>
    </View>
  </View>;
  return <Card theme={theme} title={t("secondaryTokenBoard.hoursAndRecords")} icon="Clock" color="violet">
    <StackedColumns theme={theme} height={90} colors={[hue(theme, "violet")]} names={[t("secondaryTokenBoard.tokensChart")]} format={bigNumber} highlight={snapshot.hours[peak] ? peak : undefined} labelEvery={6}
      columns={snapshot.hours.map((value, hour) => ({ label: String(hour).padStart(2, "0"), detail: `${String(hour).padStart(2, "0")}:00–${String(hour + 1).padStart(2, "0")}:00`, parts: [value] }))} />
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md }}>
      {item("CalendarCheck", ["amber", "orange"], t("secondaryTokenBoard.busiestDay"), records.peakDay ? bigNumber(records.peakDay.total) : "—", records.peakDay ? longDay(records.peakDay.day) : t("secondaryTokenBoard.noRecordsYet"))}
      {item("Rocket", ["cyan", "blue"], t("secondaryTokenBoard.fastestCall"), records.fastest ? t("secondaryTokenBoard.tokenRate", { rate: perSecond(records.fastest.tps) }) : "—", records.fastest ? `${records.fastest.model ?? t("secondaryTokenBoard.unknownModel")} · ${relativeTime(records.fastest.at)}` : t("secondaryTokenBoard.noRecordsYet"))}
      {item("ScrollText", ["pink", "fuchsia"], t("secondaryTokenBoard.longestOutput"), records.biggest ? bigNumber(records.biggest.output) : "—", records.biggest ? `${records.biggest.model ?? t("secondaryTokenBoard.unknownModel")} · ${relativeTime(records.biggest.at)}` : t("secondaryTokenBoard.noRecordsYet"))}
    </View>
  </Card>;
}

function Coverage({ theme, snapshot }: { theme: PluginTheme; snapshot: TokenSnapshot }) {
  const { backfill, roots, earliestAt } = snapshot.coverage, cut = tokenTruncationNotice(snapshot.coverage.truncated);
  // A source this host does not have (no directory, nothing found) is left out quietly; Grok keeps one usage file per session.
  const parts = [...roots.filter(root => root.files || root.error).map(root => `${tokenSourceNames[root.source]}${isArchivedLogRoot(root.path) ? t("secondaryTokenBoard.archived") : ""} ${root.files} ${root.source === "grok" ? t("secondaryTokenBoard.sessions2") : t("secondaryTokenBoard.logs")}${root.error ? t("secondaryTokenBoard.message2", { value1: root.error }) : ""}`), earliestAt ? t("secondaryTokenBoard.earliest", { value1: new Date(earliestAt).toLocaleDateString(currentLanguage()) }) : null, snapshot.paseoShare !== null ? t("secondaryTokenBoard.paseoSessionsAccountFor", { value1: percent(snapshot.paseoShare) }) : null].filter(Boolean);
  return <View style={{ gap: space.sm }}>
    {!backfill.done ? <View accessibilityLabel={t("secondaryTokenBoard.importingHistoricalLogs", { value1: percent(backfill.bytes ? backfill.bytesDone / backfill.bytes : 0) })} style={{ gap: 6, padding: space.md, borderRadius: radius.lg, backgroundColor: hue(theme, "amber", "soft"), borderWidth: 1, borderColor: hue(theme, "amber", "line") }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Icon name="History" size={16} color={hue(theme, "amber")} />
        <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: fontSize.small, fontWeight: "700" }}>{t("secondaryTokenBoard.importingHistoricalLogs", { value1: percent(backfill.bytes ? backfill.bytesDone / backfill.bytes : 0) })}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{t("secondaryTokenBoard.files", { value1: backfill.filesDone, value2: backfill.files })}</Text>
      </View>
      <View style={{ height: 6, borderRadius: 3, backgroundColor: trackFor(theme), overflow: "hidden" }}>
        <View style={[{ height: 6, width: `${Math.max(3, backfill.bytes ? backfill.bytesDone / backfill.bytes * 100 : 0)}%`, borderRadius: 3 }, gradient(theme, ["amber", "pink"], { angle: 90 })]} />
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("secondaryTokenBoard.numbersGrowDuringImportOnceComplete")}</Text>
    </View> : null}
    {roots.some(root => root.error) ? <Banner theme={theme} tone="warning" message={roots.filter(root => root.error).map(root => t("secondaryTokenBoard.message3", { value1: tokenSourceNames[root.source], value2: root.error })).join(t("secondaryTokenBoard.message4"))} /> : null}
    {cut ? <Banner theme={theme} tone="warning" message={cut} /> : null}
    {parts.length ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, textAlign: "center" }}>{parts.join(" · ")}</Text> : null}
  </View>;
}

export interface TokenBoardProps {
  theme: PluginTheme; compact: boolean; range: StatsRange; onRange: (range: StatsRange) => void; onRefresh: () => void;
  tokens?: TokenSnapshot; loading: boolean; error?: string;
  live?: TokenLive; liveError?: string; liveWindow: 30 | 60; onLiveWindow: (minutes: 30 | 60) => void;
  onOpenAgent?: (agentId: string) => void;
  /** 额度 (2.13): the host's provider usage windows with history and forecasts (client/use-quota), shown at the top. */
  quota?: Omit<QuotaCardProps, "theme" | "compact">;
}
/** Token 页: personal token statistics from the local provider logs, with the live speed chart. */
export function TokenBoard({ theme, compact, range, onRange, onRefresh, tokens, loading, error, live, liveError, liveWindow, onLiveWindow, onOpenAgent, quota }: TokenBoardProps) {
  const [width, setWidth] = useState(0);
  const inset = compact ? space.md : space.xl, wide = width >= 900, columns = width >= 900 ? 4 : width >= 560 ? 3 : 2;
  const pair = (left: ReactNode, right: ReactNode, ratio = 1.4) => wide ? <View style={{ flexDirection: "row", gap: space.lg, alignItems: "stretch" }}><View style={{ flex: ratio, minWidth: 0 }}>{left}</View><View style={{ flex: 1, minWidth: 0 }}>{right}</View></View> : <>{left}{right}</>;
  let body: ReactNode;
  if (!tokens) body = loading ? <Skeleton theme={theme} rows={6} /> : <EmptyState theme={theme} icon={error ? "WifiOff" : "Coins"} tone={error ? "danger" : "warning"} title={error ? t("secondaryTokenBoard.tokenStatisticsAreTemporarilyUnavailable") : t("secondaryTokenBoard.noTokenDataYet")} message={error ?? t("secondaryTokenBoard.localClaudeCodeCodexGrokCli")} action={{ label: t("secondaryTokenBoard.retry"), onPress: onRefresh, icon: "RefreshCw" }} />;
  else {
    const total = tokenTotal(tokens.totals);
    body = <>
      {error ? <Banner theme={theme} tone="warning" message={t("secondaryTokenBoard.tokenStatisticsSyncFailedShowingThe", { value1: error })} action={{ label: t("secondaryTokenBoard.retry"), onPress: onRefresh }} /> : null}
      <Hero theme={theme} snapshot={tokens} live={live} narrow={width > 0 && width < 420} />
      <LiveRateCard theme={theme} live={live} error={liveError} windowMinutes={liveWindow} onWindow={onLiveWindow} onOpenAgent={onOpenAgent} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", margin: -space.xs }}>{tiles(tokens).map(tile => <KpiTile key={tile.key} theme={theme} tile={tile} width={`${100 / columns}%`} />)}</View>
      {pair(<TrendCard theme={theme} snapshot={tokens} />, <CompositionCard theme={theme} counts={tokens.totals} />)}
      {/* Providers sit above projects: together they balance the taller model list on wide screens. */}
      {pair(<Card theme={theme} title={t("secondaryTokenBoard.modelUsage")} icon="Cpu" color="cyan" trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>{t("secondaryTokenBoard.models", { count: tokens.models.filter(row => row.key !== "__other__").length })}</Text>}>
        <TokenRows theme={theme} rows={tokens.models} kind="models" total={total} />
        {tokens.sources.length > 1 ? <View style={{ borderTopWidth: hairline, borderTopColor: theme.colors.border, paddingTop: space.sm }}><TokenRows theme={theme} rows={tokens.sources} kind="sources" total={total} /></View> : null}
      </Card>, <View style={{ gap: space.lg }}>
        <ProviderCard theme={theme} snapshot={tokens} total={total} />
        <Card theme={theme} title={t("secondaryTokenBoard.projectUsage")} icon="FolderGit2" color="blue"><TokenRows theme={theme} rows={tokens.projects} kind="projects" total={total} limit={6} /></Card>
      </View>, 1.2)}
      {pair(<SessionsCard theme={theme} snapshot={tokens} onOpenAgent={onOpenAgent} />, <RhythmCard theme={theme} snapshot={tokens} />, 1.2)}
      <Coverage theme={theme} snapshot={tokens} />
    </>;
  }
  return <ScrollView style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ paddingHorizontal: inset, paddingTop: space.md, paddingBottom: space.xxl }}>
    <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ gap: space.lg, width: "100%", maxWidth: 1180, alignSelf: "center" }}>
      <StatsHeader theme={theme} compact={compact} range={range} onRange={onRange} generatedAt={tokens?.generatedAt} info={tokenInfo()} infoTitle={t("secondaryTokenBoard.aboutTokenStatistics")} />
      {quota ? <QuotaCard theme={theme} compact={compact || (width > 0 && width < 560)} {...quota} /> : null}
      {body}
    </View>
  </ScrollView>;
}
