import { TextParts } from "./core-text";
import { currentLanguage } from "../shared/i18n";
import { t } from "../shared/text";
import { memo, useEffect, useMemo, useRef } from "react";
import { Text, View } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { FlatList } from "@getpaseo/plugin/client/react-native";
import type { AgentRecord } from "../shared/model";
import { eventLabel, type TelemetryEvent, type TelemetrySnapshot } from "../shared/telemetry";
import { eventAgentTitle } from "../shared/swimlane";
import { EmptyState, MetaLine, Row, fontSize, hairline, hue, relativeTime, space } from "./kit";
import { InfoButton, shortDuration } from "./ui";
import { EventGlyph } from "./status";
import { Enter } from "./motion";
import { Swimlane } from "./swimlane";

const binMs = 150_000;

/** Last hour at a glance: 24 thin bars, 2.5 minutes each; empty bins stay a hairline. */
function Pulse({ theme, events, now, telemetry }: { theme: PluginTheme; events: readonly TelemetryEvent[]; now: number; telemetry?: TelemetrySnapshot }) {
  const bins = useMemo(() => { const result = Array<number>(24).fill(0); for (const event of events) { const ago = now - Date.parse(event.at); const index = 23 - Math.floor(ago / binMs); if (ago >= 0 && index >= 0 && index < 24) result[index]!++; } return result; }, [events, now]);
  const total = bins.reduce((sum, bin) => sum + bin, 0), peak = Math.max(1, ...bins);
  const bar = hue(theme, "orange");
  return <View style={{ paddingHorizontal: space.md, paddingTop: space.md, paddingBottom: space.sm, gap: space.sm }}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
      <Text style={{ flex: 1, color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontWeight: "500" }}><TextParts id="coreActivityFeed.recentEvents" values={{ count: <Text style={{ fontVariant: ["tabular-nums"], fontWeight: "400" }}>{t("coreActivityFeed.events", { count: total })}</Text> }} /></Text>
      <InfoButton theme={theme} title={t("coreActivityFeed.aboutEventHistory")} lines={[telemetry ? t("coreActivityFeed.recordingStarted", { value1: new Date(telemetry.startedAt).toLocaleString(currentLanguage()) }) : t("coreActivityFeed.connectingToEventHistory"), t("coreActivityFeed.keepsTheLatest500LifecycleEventsShown"), t("coreActivityFeed.eachBarCovers25MinutesSee")]} />
    </View>
    <View accessibilityLabel={t("coreActivityFeed.eventsInTheLastHourTwoAnd", { value1: total })} style={{ flexDirection: "row", alignItems: "flex-end", gap: 3, height: 28, borderBottomWidth: hairline, borderBottomColor: theme.colors.border }}>
      {bins.map((bin, index) => <View key={index} style={{ flex: 1, height: bin ? Math.max(3, bin / peak * 26) : 0, borderTopLeftRadius: 2, borderTopRightRadius: 2, backgroundColor: bar, opacity: 0.85 }} />)}
    </View>
  </View>;
}

/** Events that arrive while the feed is open slide in at the top. */
const EventRow = memo(function EventRow({ event, theme, time, selected, fresh, onSelect, titles }: { event: TelemetryEvent; theme: PluginTheme; time: string; selected: boolean; fresh: boolean; onSelect: (agentId: string) => void; titles: ReadonlyMap<string, string> }) {
  // Events stored before 2.13 carry English labels; the type names them (gemini-F9).
  const label = eventLabel(event);
  return <Enter active={fresh}><Row theme={theme} title={label} titleLines={1} selected={selected} onPress={() => onSelect(event.agentId)} accessibilityLabel={t("coreActivityFeed.view", { value1: eventAgentTitle(event, titles) || t("coreActivityFeed.untitledAgent"), value2: label })}
    leading={<EventGlyph theme={theme} type={event.type} />}
    trailing={<Text style={{ color: theme.colors.foregroundMuted, fontSize: fontSize.meta, fontVariant: ["tabular-nums"] }}>{time}</Text>}
    subtitle={<MetaLine theme={theme} parts={[eventAgentTitle(event, titles) || event.agentId, event.durationMs !== undefined ? t("coreActivityFeed.took", { value1: shortDuration(event.durationMs) }) : null]} />} /></Enter>;
});

/** On phones the swimlane scrolls with the feed; wide layouts show it above the split view instead (`swimlane` false). */
export function ActivityFeed({ events, theme, telemetry, onSelect, now, selectedId, agents, swimlane }: { events: TelemetryEvent[]; theme: PluginTheme; telemetry?: TelemetrySnapshot; onSelect: (id: string) => void; now: number; selectedId: string | null; agents: readonly AgentRecord[]; swimlane: boolean }) {
  // Everything present when the feed first has events is history; later ids are news.
  const known = useRef<Set<string> | null>(null);
  if (known.current === null && events.length) known.current = new Set(events.map(event => event.id));
  useEffect(() => { if (known.current) for (const event of events) known.current.add(event.id); }, [events]);
  const titles = useMemo(() => new Map(agents.map(agent => [agent.id, agent.title] as const)), [agents]);
  return <FlatList style={{ flex: 1, minHeight: 0 }} data={events} keyExtractor={event => event.id} contentContainerStyle={{ paddingHorizontal: space.xs, paddingBottom: space.xl }}
    initialNumToRender={20} windowSize={7} extraData={`${now}:${selectedId}`}
    ListHeaderComponent={<View style={{ marginHorizontal: -space.xs }}>
      {swimlane && events.length ? <Swimlane theme={theme} events={events} agents={agents} now={now} compact onSelect={onSelect} /> : null}
      <Pulse theme={theme} events={events} now={now} telemetry={telemetry} />
    </View>}
    ListEmptyComponent={<EmptyState theme={theme} icon="Activity" title={t("coreActivityFeed.noExecutionEventsYet")} message={t("coreActivityFeed.taskStartsCompletionsFailuresAndApprovalsAppear")} />}
    renderItem={({ item }) => <EventRow event={item} theme={theme} time={relativeTime(item.at, now)} selected={item.agentId === selectedId} fresh={!!known.current && !known.current.has(item.id)} onSelect={onSelect} titles={titles} />} />;
}
