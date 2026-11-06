import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo } from "react";
import { Text, View } from "react-native";
import type { TurnTimeData } from "../shared/turn-time";
import { formatTurnTime } from "../shared/turn-time";
import { densityMetrics, useDensity } from "./density";

/**
 * 本地补丁：每一轮结束时，在这一轮末尾显示一行常显的时刻。
 *
 * 用插件自己的行距（与折叠摘要行同一套密度参数），是一行独立的、右对齐的淡色小字：不做重叠、不用负边距，所以在任何
 * 平台、任何版式下位置都是确定的，也不会遮住文字或别的插件的行。
 *
 * 位置由服务端决定（见 server/turn-time.ts）：整轮结束时才写，因此时间总落在这一轮所有内容之后。
 */
export function TurnTimeRow({ item, theme, layout }: PluginTimelineItemProps<TurnTimeData>) {
  const metrics = densityMetrics(useDensity(), layout.compact, layout.platform !== "web");
  const at = item.data.at;
  const label = useMemo(() => formatTurnTime(at), [at]);
  if (!label) return null;
  const color = item.data.outcome === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 5,
        minHeight: metrics.rowMinHeight,
        marginTop: metrics.marginTop,
        marginBottom: metrics.marginBottom,
        paddingVertical: metrics.rowPaddingVertical,
      }}
    >
      <Icon name="Clock" size={metrics.dense ? 11 : 12} color={color} />
      <Text
        style={{
          color,
          fontSize: metrics.dense ? 11 : 12,
          lineHeight: metrics.lineHeight,
          fontVariant: ["tabular-nums"],
        }}
      >
        {label}
      </Text>
    </View>
  );
}
