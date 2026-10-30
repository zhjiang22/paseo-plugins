import { currentLanguage } from "../shared/i18n";
import { t, tParts } from "../shared/text";
import { memo, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { AgentRecord } from "../shared/model";
import type { TelemetryEvent } from "../shared/telemetry";
import { buildSwimlanes, swimTicks, type SwimKind } from "../shared/swimlane";
import { Segmented, fontSize, gradient, hairline, hue, isDarkTheme, radius, space, withAlpha, type Hue } from "./kit";
import { Ping } from "./motion";
import { shortDuration } from "./ui";

const windows = { "1h": 3_600_000, "6h": 6 * 3_600_000, "24h": 24 * 3_600_000 } as const;
type Window = keyof typeof windows;
const looks: Record<SwimKind, { hue: Hue; label: string }> = {
  running: { hue: "blue", get label() { return t("secondarySwimlane.running"); } }, completed: { hue: "green", get label() { return t("secondarySwimlane.completed"); } }, failed: { hue: "red", get label() { return t("secondarySwimlane.failed"); } },
  canceled: { hue: "gray", get label() { return t("secondarySwimlane.canceled"); } }, approval: { hue: "amber", get label() { return t("secondarySwimlane.waitingForApproval"); } },
};
const clock = (at: number) => new Date(at).toLocaleTimeString(currentLanguage(), { hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * 并行泳道: one lane per recently active Agent with its turns as bars (green done, red failed, blue still running)
 * and approval waits as amber strips, so overlapping work and stalls show at a glance. Tapping a lane opens the Agent.
 */
export const Swimlane = memo(function Swimlane({ theme, events, agents, now, compact, onSelect, inset = space.md }: {
  theme: PluginTheme; events: readonly TelemetryEvent[]; agents: readonly AgentRecord[]; now: number; compact: boolean; onSelect: (agentId: string) => void; inset?: number;
}) {
  const [range, setRange] = useState<Window>("1h");
  const [width, setWidth] = useState(0);
  const live = useMemo(() => { const result = new Map<string, "running" | "waiting">(); for (const agent of agents) if (agent.status === "running" || agent.status === "waiting") result.set(agent.id, agent.status); return result; }, [agents]);
  const titles = useMemo(() => new Map(agents.map(agent => [agent.id, agent.title] as const)), [agents]);
  const windowMs = windows[range];
  const { lanes, peak, peakAt, turns, hidden } = useMemo(() => buildSwimlanes(events, live, now, windowMs, compact ? 6 : 8, titles), [events, live, now, windowMs, compact, titles]);
  const labelWidth = compact ? 88 : 150, track = Math.max(0, width - labelWidth - space.sm), from = now - windowMs;
  const x = (at: number) => (at - from) / windowMs * track;
  const ticks = swimTicks(now, windowMs, -new Date(now).getTimezoneOffset());
  // Label every n-th tick so clock labels (about 36 px) never collide on narrow tracks.
  const labelEvery = ticks.length > 1 ? Math.max(1, Math.ceil(44 / Math.max(1, x(ticks[1]!) - x(ticks[0]!)))) : 1;
  const grid = isDarkTheme(theme) ? withAlpha("#ffffff", 0.07) : withAlpha("#000000", 0.06);
  return <View style={{ marginHorizontal: inset, marginTop: space.md, padding: space.md, gap: space.sm, borderRadius: 16, borderWidth: hairline, borderColor: withAlpha(hue(theme, "blue"), 0.3), backgroundColor: isDarkTheme(theme) ? theme.colors.surface1 : theme.colors.surface0 }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: space.sm }}>
      <View style={[{ width: 24, height: 24, borderRadius: 8, alignItems: "center", justifyContent: "center" }, gradient(theme, ["blue", "violet"])]}><Icon name="ChartGantt" size={14} color="#ffffff" /></View>
      <Text style={{ flexGrow: 1, color: theme.colors.foreground, fontSize: fontSize.title, fontWeight: "700" }}>{t("secondarySwimlane.parallelLanes")}</Text>
      <Segmented theme={theme} size="sm" value={range} onChange={setRange} accessibilityLabel={t("secondarySwimlane.laneTimeWindow")} options={[{ value: "1h", label: t("secondarySwimlane.hour") }, { value: "6h", label: t("secondarySwimlane.hours") }, { value: "24h", label: t("secondarySwimlane.hours2") }]} />
    </View>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta }}>
      {turns ? tParts(peakAt ? hidden ? "secondarySwimlane.summaryAtHidden" : "secondarySwimlane.summaryAt" : hidden ? "secondarySwimlane.summaryHidden" : "secondarySwimlane.summary", { turns, peak, time: peakAt ? clock(peakAt) : "", hidden }).map((part, index) => part.param === "peak" ? <Text key={index} style={{ color: hue(theme, "violet", "text"), fontWeight: "800" }}>{part.text}</Text> : part.text) : t("secondarySwimlane.noConversationTurnsRecordedInThis")}
    </Text>
    <View onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))} style={{ gap: 4 }}>
      {width > 0 && lanes.length ? <>
        <View style={{ height: 14, marginLeft: labelWidth + space.sm }}>
          {ticks.map((tick, index) => (ticks.length - 1 - index) % labelEvery ? null : <Text key={tick} numberOfLines={1} style={{ position: "absolute", left: x(tick) - 20, width: 40, textAlign: "center", color: theme.colors.foregroundMuted, fontSize: 10, fontVariant: ["tabular-nums"] }}>{clock(tick)}</Text>)}
        </View>
        {lanes.map(lane => {
          const running = lane.spans.some(span => span.open && span.kind === "running");
          const summary = lane.spans.filter(span => span.kind !== "approval").map(span => `${looks[span.kind].label} ${shortDuration(span.end - span.start)}`).join(t("secondarySwimlane.message2"));
          return <Pressable key={lane.agentId} accessibilityRole="button" accessibilityLabel={t("secondarySwimlane.lane", { value1: lane.title, value2: summary || t("secondarySwimlane.waitingForApproval") })} onPress={() => onSelect(lane.agentId)}
            style={state => ({ flexDirection: "row", alignItems: "center", gap: space.sm, height: 24, borderRadius: radius.sm, opacity: state.pressed ? 0.7 : 1 })}>
            <Text numberOfLines={1} style={{ width: labelWidth, color: running ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: running ? "700" : "500" }}>{lane.title}</Text>
            <View style={{ width: track, height: 24 }}>
              <View style={{ position: "absolute", left: 0, right: 0, top: 11, height: 2, borderRadius: 1, backgroundColor: grid }} />
              {ticks.map(tick => <View key={tick} style={{ position: "absolute", left: x(tick), top: 0, bottom: 0, width: hairline, backgroundColor: grid }} />)}
              {lane.spans.map((span, index) => {
                const left = x(span.start), size = Math.max(3, x(span.end) - left), color = hue(theme, looks[span.kind].hue);
                return span.kind === "approval"
                  ? <View key={index} style={{ position: "absolute", left, width: size, top: 1, height: 5, borderRadius: 3, backgroundColor: color }} />
                  : <View key={index} style={[{ position: "absolute", left, width: size, top: 7, height: 10, borderRadius: 5 }, span.kind === "running" ? gradient(theme, ["sky", "blue"], { angle: 90 }) : { backgroundColor: withAlpha(color, span.kind === "canceled" ? 0.6 : 0.9) }]} />;
              })}
              {running ? <View style={{ position: "absolute", left: track - 5, top: 7, width: 10, height: 10, alignItems: "center", justifyContent: "center" }}><Ping size={10} color={hue(theme, "blue")} /><View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: hue(theme, "blue") }} /></View> : null}
            </View>
          </Pressable>;
        })}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: space.md, marginLeft: compact ? 0 : labelWidth + space.sm, marginTop: 2 }}>
          {(["running", "completed", "failed", "approval"] as const).map(kind => <View key={kind} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <View style={{ width: 14, height: kind === "approval" ? 5 : 8, borderRadius: 4, backgroundColor: hue(theme, looks[kind].hue) }} />
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{looks[kind].label}</Text>
          </View>)}
        </View>
      </> : null}
    </View>
  </View>;
});
