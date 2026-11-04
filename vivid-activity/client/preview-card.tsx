import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { Text, View, type TextStyle, type ViewStyle } from "react-native";
import { STRENGTH_OPACITY, activitySettings, type PaletteMode } from "../shared/settings";
import { densityMetrics, type DensityMetrics } from "../shared/density";
import { DiffBlock } from "./activity-details";
import type { ActivityPalette } from "../shared/presentation";
import type { useActivityStyles } from "./activity";
import { t } from "../shared/text";

/**
 * 0.11.0：设置页顶部的实时预览卡。样本不重复生产样式：diff 用真实 DiffBlock（无副作用），强度/配色从
 * 与活动行相同的计算函数取值（paletteFor/metrics/STRENGTH_OPACITY，由常驻入口经 props 传入——ui chunk
 * 不可引用 resident 的调色板解析）。设置即改即存，useSettings 订阅让样本随存随变，不需要草稿覆盖机制。
 * 命令着色的预览不做（其组件在 fx 懒加载块）。
 */

/** 与 useActivityStyles 的 diff 系样式逐值对齐（native-rows.test 有防漂移断言）；只含 DiffBlock 触到的键。 */
export function previewDiffStyles(
  theme: PluginTheme,
  palette: ActivityPalette,
): Record<string, TextStyle | ViewStyle> {
  return {
    section: { gap: 3 },
    detailLabel: { color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600", lineHeight: 15 },
    diffSurface: { backgroundColor: theme.colors.surface0, borderColor: theme.colors.border, borderRadius: 8, borderWidth: 1, minWidth: "100%", overflow: "hidden", paddingVertical: 2 },
    diffLine: { flexDirection: "row", minHeight: 16, paddingHorizontal: 5 },
    diffMarker: { fontFamily: "monospace", fontSize: 11, lineHeight: 16, width: 12 },
    diffText: { flexShrink: 0, fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
    diffAdded: { backgroundColor: palette.statusBackgrounds.completed },
    diffRemoved: { backgroundColor: palette.statusBackgrounds.failed },
    diffMeta: { backgroundColor: palette.categoryBackgrounds.search },
    codeLine: { color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11, lineHeight: 16, minHeight: 16 },
    empty: { color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
    codeScroll: { maxWidth: "100%" },
    showMoreButton: { alignSelf: "flex-start", paddingHorizontal: 6, paddingVertical: 3, borderRadius: 2, marginTop: 3 },
    showMoreText: { color: palette.categoryColors.agent, fontSize: 11, fontWeight: "600", lineHeight: 15 },
  };
}

const STRENGTH_LABELS: Array<{ value: "dim" | "faded" | "soft" | "full" }> = [
  { value: "dim" },
  { value: "faded" },
  { value: "soft" },
  { value: "full" },
];

function PanelLabel({ theme, children }: { theme: PluginTheme; children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.5 }}>{children.toUpperCase()}</Text>;
}

/** 强度面板：四个档位各一条迷你行头（opacity 取 STRENGTH_OPACITY），当前档位加粗标注。 */
function StrengthPanel({ theme, palette, metrics, current }: { theme: PluginTheme; palette: ActivityPalette; metrics: DensityMetrics; current: string }) {
  const shell = palette.categoryColors.shell;
  return (
    <View style={{ gap: 4 }}>
      <PanelLabel theme={theme}>{t("settings.previewStrength")}</PanelLabel>
      {STRENGTH_LABELS.map(({ value }) => {
        const active = value === current;
        return (
          <View key={value} style={{ flexDirection: "row", alignItems: "center", gap: metrics.gap, minHeight: metrics.rowMinHeight, opacity: STRENGTH_OPACITY[value] }}>
            <View style={{ width: metrics.tile, height: metrics.tile, borderRadius: 6, backgroundColor: shell }} />
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: active ? "800" : "700", flexShrink: 0 }}>Bash</Text>
            <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1, minWidth: 0 }}>npm ci --omit=dev</Text>
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: "auto", fontWeight: active ? "800" : "400" }}>{Math.round(STRENGTH_OPACITY[value] * 100)}%{active ? ` · ${t("settings.previewCurrent")}` : ""}</Text>
          </View>
        );
      })}
    </View>
  );
}

/** 配色面板：类别色点 + 状态色块，随调色板档位实时取值。 */
function PalettePanel({ theme, palette }: { theme: PluginTheme; palette: ActivityPalette }) {
  const dot = (color: string, key: string) => (
    <View key={key} accessibilityLabel={key} style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: color }} />
  );
  return (
    <View style={{ gap: 4 }}>
      <PanelLabel theme={theme}>{t("settings.previewPalette")}</PanelLabel>
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        {Object.entries(palette.categoryColors).map(([category, color]) => dot(color, `cat-${category}`))}
        {Object.entries(palette.statusColors).map(([status, color]) => dot(color, `status-${status}`))}
      </View>
    </View>
  );
}

export interface PreviewCardProps {
  theme: PluginTheme;
  /** 调色板解析（常驻入口的 paletteFor 经 props 传入；ui chunk 不引用 resident 模块）。 */
  paletteFor: (theme: PluginTheme, mode: PaletteMode) => ActivityPalette;
}

export function PreviewCard({ theme, paletteFor }: PreviewCardProps) {
  const settings = useSettings(activitySettings);
  if (settings.status !== "ready") return null;
  const values = settings.values;
  const palette = paletteFor(theme, values.palette);
  const metrics = densityMetrics(values.density, false, false);
  const detail = { type: "edit", filePath: "/demo/src/app.ts", oldString: `const a = ${"lorem-ipsum-dolor.".repeat(16)}\nconst b = 1;`, newString: "const a = 1;\nconst b = 2;" } as const;
  // DiffBlock 的 styles 形如 useActivityStyles；预览用对齐过的子集（防漂移断言在 native-rows.test）。
  const diffStyles = previewDiffStyles(theme, palette) as unknown as ReturnType<typeof useActivityStyles>;
  return (
    <View style={{ gap: 14 }}>
      <StrengthPanel theme={theme} palette={palette} metrics={metrics} current={values.strength} />
      <View style={{ gap: 4 }}>
        <PanelLabel theme={theme}>{t("settings.previewDiff")}</PanelLabel>
        <DiffBlock detail={detail} palette={palette} styles={diffStyles} />
      </View>
      <PalettePanel theme={theme} palette={palette} />
    </View>
  );
}
