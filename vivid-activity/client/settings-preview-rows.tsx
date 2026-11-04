import type { PluginTheme } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ReactNode } from "react";
import { Text, View, type TextStyle, type ViewStyle } from "react-native";
import { STRENGTH_OPACITY, activitySettings, type LoaderKind, type PaletteMode } from "../shared/settings";
import { densityMetrics, type DensityMetrics } from "../shared/density";
import { createReasoningData } from "../shared/timeline";
import { looks, type LookKey } from "../shared/vivid-model";
import type { ActivityPalette } from "../shared/presentation";
import { buildActivityStyles, type ActivityStyles } from "./activity-styles";
import { DiffBlock, ReasoningMarkdown } from "./activity-details";
import { hue, isDarkTheme, withAlpha } from "./kit";
import type { SettingsActions } from "./settings";
import { useTypography } from "./typography";
import { t } from "../shared/text";

/**
 * 0.11.0：设置页右侧的全量实时预览——一段模拟回合的高保真静态副本（展示态固定并标注，不可交互）。
 * 结构镜像真实行头（tile/动词/计数/状态丸/时长/勾叉/chevron），样式全部来自 buildActivityStyles
 * （与真实行同一构建器，零漂移由构造保证）；淡出豁免谓词与真实行同构（运行中不淡；展开不淡；
 * failures 档豁免失败行；折叠摘要跟随档位、含失败自动展开为全强度）。样本结构是行组件的轻量副本，
 * 不引用常驻行组件（fold-runtime/prompt-pin/attention 的状态不得被假 agent 污染）。
 * 命令着色（Prism，fx chunk）与 fx 改动清单不在预览内：命令以纯文本呈现。
 */

type Typography = ReturnType<typeof useTypography>;

export interface PreviewPanelProps {
  theme: PluginTheme;
  paletteFor: (theme: PluginTheme, mode: PaletteMode) => ActivityPalette;
  actions: SettingsActions;
  compact: boolean;
}

const SAMPLE_COMMAND = "npm ci --omit=dev && npm test";
const SAMPLE_QUESTION = () => t("settings.previewQuestion");
const reasoningSample = () => t("settings.previewReasoning").split("\n");

interface PreviewValues {
  strength: "dim" | "faded" | "soft" | "full";
  thoughtExpansion?: "always" | "latest" | "never" | "failures";
  tailFollow?: boolean;
  tailLines?: number;
  shellExpansion?: "always" | "latest" | "never" | "failures";
  fold?: boolean;
}

function Dot({ color, size = 12 }: { color: string; size?: number }) {
  return <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }} />;
}

/** 类别 tile：淡色调底 + lucide 图标（镜像真实行的 CategoryTile）。 */
function Tile({ theme, look, size }: { theme: PluginTheme; look: LookKey; size: number }) {
  const meta = looks[look];
  const color = meta.hue === "gray" ? theme.colors.foregroundMuted : hue(theme, meta.hue);
  return (
    <View style={{ width: size, height: size, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(color.startsWith("#") ? color : "#888888", isDarkTheme(theme) ? 0.2 : 0.13) }}>
      <Icon name={meta.icon} size={Math.round(size * 0.62)} color={color} />
    </View>
  );
}

/** 软色状态丸（镜像真实行的 StatusPill）。 */
function Pill({ color, soft, text }: { color: string; soft: string; text: string }) {
  return (
    <View style={{ height: 18, paddingHorizontal: 6, borderRadius: 9, justifyContent: "center", backgroundColor: soft, flexShrink: 0 }}>
      <Text numberOfLines={1} style={{ color, fontSize: 11, fontWeight: "700" }}>{text}</Text>
    </View>
  );
}

function RowText({ style, children }: { style: TextStyle; children: string }) {
  return <Text numberOfLines={1} style={style}>{children}</Text>;
}

/** 淡出豁免谓词的预览版：与 client/activity.tsx、fold-row.tsx 的真实规则同构。运行中不淡；展开不淡；失败档豁免失败行。 */
function idleOpacity(values: PreviewValues, opts: { expanded?: boolean; failed?: boolean } = {}): number | null {
  if (values.strength === "full") return null;
  if (opts.expanded) return null;
  if (values.shellExpansion === "failures" && opts.failed) return null;
  return STRENGTH_OPACITY[values.strength];
}

function card(children: ReactNode, opacity: number | null, styles: ActivityStyles): ReactNode {
  return <View style={[styles.card, opacity != null ? { opacity } : null]}>{children}</View>;
}

/** 思考行副本：always/latest 展开正文（跟随模式取尾窗 N 行，否则头 20 行）；failures/never 收起并淡出（与真实行为一致）。 */
function ReasoningReplica({ theme, styles, values, palette, metrics }: { theme: PluginTheme; styles: ActivityStyles; values: PreviewValues; palette: ActivityPalette; metrics: DensityMetrics }) {
  const mode = values.thoughtExpansion ?? "latest";
  const expanded = mode === "always" || mode === "latest";
  const opacity = values.strength === "full" || expanded ? null : STRENGTH_OPACITY[values.strength];
  const lines = reasoningSample();
  const body = values.tailFollow
    ? lines.slice(Math.max(0, lines.length - (values.tailLines ?? 20))).join("\n")
    : lines.slice(0, 20).join("\n");
  const tag = values.tailFollow ? `${t("settings.previewWindow")} ${values.tailLines ?? 20}` : t("settings.previewHead20");
  return card(
    <>
      <View style={styles.headerButton}>
        <Tile theme={theme} look="think" size={metrics.tile} />
        <RowText style={{ ...styles.title, color: hue(theme, "violet", "text") }}>{t("modelLook.think")}</RowText>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, marginLeft: "auto", flexShrink: 0 }}>{expanded ? tag : "…"}</Text>
      </View>
      {expanded ? (
        <View style={styles.details}>
          <ReasoningMarkdown text={body} theme={theme} styles={styles} />
        </View>
      ) : null}
    </>,
    opacity,
    styles,
  );
}

/** 工具行副本：state/expanded 驱动（failures 档 = 失败行展开全强度红态，完成行收起淡出）。 */
function ToolReplica({ theme, styles, palette, values, metrics, look, label, command, state, expanded, diff, errorLine }: {
  theme: PluginTheme;
  styles: ActivityStyles;
  palette: ActivityPalette;
  values: PreviewValues;
  metrics: DensityMetrics;
  look: LookKey;
  label: string;
  command: string;
  state: "completed" | "failed" | "running";
  expanded?: boolean;
  diff?: ReactNode;
  errorLine?: ReactNode;
}) {
  const running = state === "running";
  const open = expanded === true;
  const opacity = running ? null : idleOpacity(values, { expanded: open, failed: state === "failed" });
  const meta = looks[look];
  const color = meta.hue === "gray" ? theme.colors.foregroundMuted : hue(theme, meta.hue);
  return card(
    <>
      <View style={styles.headerButton}>
        <Tile theme={theme} look={look} size={metrics.tile} />
        <RowText style={{ ...styles.title, color }}>{label}</RowText>
        <RowText style={styles.summary}>{command}</RowText>
        {state === "failed" ? <Pill color={hue(theme, "red", "text")} soft={hue(theme, "red", "soft")} text={t("ui.failed2", { count: 1 })} /> : null}
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 0 }}>{running ? "…" : "›"}</Text>
      </View>
      {open && errorLine ? <View style={styles.details}>{errorLine}</View> : null}
      {open && diff ? <View style={styles.details}>{diff}</View> : null}
    </>,
    opacity,
    styles,
  );
}

/** 折叠摘要副本：done 段（绿 tile/勾/时长），跟随淡出档位；含失败 → 自动展开明细（全强度）。 */
function FoldReplica({ theme, styles, values, palette, metrics, failed }: { theme: PluginTheme; styles: ActivityStyles; values: PreviewValues; palette: ActivityPalette; metrics: DensityMetrics; failed: boolean }) {
  if (!values.fold) return null;
  const expanded = failed;
  const opacity = values.strength === "full" || expanded ? null : STRENGTH_OPACITY[values.strength];
  const green = hue(theme, "green");
  return card(
    <>
      <View style={styles.headerButton}>
        <View style={{ width: metrics.tile, height: metrics.tile, borderRadius: 6, alignItems: "center", justifyContent: "center", backgroundColor: withAlpha(green, isDarkTheme(theme) ? 0.2 : 0.13) }}>
          <Icon name="Check" size={Math.round(metrics.tile * 0.62)} color={hue(theme, "green", "text")} />
        </View>
        <RowText style={{ ...styles.title, color: theme.colors.foreground }}>{t("settings.previewFoldTitle")}</RowText>
        <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 16, flexShrink: 1, minWidth: 0 }}>{t("settings.previewFoldCounts")}</Text>
        <Pill color={hue(theme, "red", "text")} soft={hue(theme, "red", "soft")} text={t("ui.failed2", { count: 1 })} />
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"], flexShrink: 0 }}>38 s</Text>
        <Text style={{ color: hue(theme, "green", "text"), fontSize: 12, flexShrink: 0 }}>✓</Text>
      </View>
      {expanded ? (
        <View style={styles.details}>
          <Text style={{ color: theme.colors.foregroundMuted, fontFamily: "monospace", fontSize: 11, lineHeight: 16 }}>{t("settings.previewFoldAuto")}</Text>
          <Text style={{ color: hue(theme, "red", "text"), fontFamily: "monospace", fontSize: 11, lineHeight: 16 }}>npm test — Exit code 1</Text>
        </View>
      ) : null}
    </>,
    opacity,
    styles,
  );
}

function LoaderMarkNode(mark: SettingsActions["LoaderMark"], loader: LoaderKind, color: string, theme: PluginTheme): ReactNode {
  if (!mark) {
    return (
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingLeft: 5 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>…</Text>
      </View>
    );
  }
  const Mark = mark;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 28, paddingLeft: 5 }}>
      <Mark kind={loader} size={16} color={color} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>npm ci --omit=dev</Text>
    </View>
  );
}

function TokensReplica({ theme, indent }: { theme: PluginTheme; indent: number }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, paddingLeft: indent, paddingRight: 6, paddingBottom: 2, minWidth: 0 }}>
      <Dot color={hue(theme, "amber")} size={10} />
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 11, lineHeight: 15, flexShrink: 1, minWidth: 0 }}>
        {t("settings.previewTokens")}
      </Text>
    </View>
  );
}

function PanelLabel({ theme, children }: { theme: PluginTheme; children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, letterSpacing: 0.5 }}>{children.toUpperCase()}</Text>;
}

export function PreviewPanel({ theme, paletteFor, actions, compact }: PreviewPanelProps) {
  const settings = useSettings(activitySettings);
  const type = useTypography();
  const ready = settings.status === "ready";
  const values = ready ? settings.values : null;
  const metrics = densityMetrics(values?.density ?? "compact", compact, false);
  if (!ready || !values) {
    return (
      <View style={{ gap: 6 }}>
        <PanelLabel theme={theme}>{t("settings.preview")}</PanelLabel>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t("settings.readingSettings")}</Text>
      </View>
    );
  }
  if (values.takeover === "off") {
    return (
      <View style={{ gap: 6 }}>
        <PanelLabel theme={theme}>{t("settings.preview")}</PanelLabel>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>{t("settings.previewTakeoverOff")}</Text>
      </View>
    );
  }
  const palette = paletteFor(theme, values.palette);
  const styles = buildActivityStyles(theme, palette, metrics, type);
  // buildActivityStyles 的 card 外边距是负值（真实聊天里抵消 Paseo 列表的 16px 行距）；预览容器没有
  // 这份行距可抵消，负值会让样本行互相叠压——钳为固定正间距。
  styles.card = { ...styles.card, marginTop: 6, marginBottom: 6 };
  const failuresMode = values.expansion.shell === "failures";
  const shellAlways = values.expansion.shell === "always";
  const indent = (compact ? 6 : 8) + metrics.tile + metrics.gap;
  const toolValues = { strength: values.strength, shellExpansion: values.expansion.shell };
  const diffDetail = { type: "edit", filePath: "/demo/src/app.ts", oldString: `const a = ${"lorem-ipsum-dolor.".repeat(16)}\nconst b = 1;`, newString: "const a = 1;\nconst b = 2;" } as const;
  return (
    <View>
      {values.pinPrompt ? (
        <View style={[styles.section, { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 6, backgroundColor: theme.colors.surface1, marginBottom: metrics.marginTop + 4 }]}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "600" }}>{t("settings.previewPinned")}</Text>
          <Text numberOfLines={2} style={{ color: theme.colors.foreground, fontSize: 12, lineHeight: 17, marginTop: 2 }}>{SAMPLE_QUESTION()}</Text>
        </View>
      ) : null}
      <ReasoningReplica theme={theme} styles={styles} values={{ strength: values.strength, thoughtExpansion: values.expansion.thinking, tailFollow: values.thoughtTailFollow, tailLines: values.thoughtTailLines, shellExpansion: values.expansion.shell, fold: values.fold }} palette={palette} metrics={metrics} />
      {values.takeover === "reasoning" ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{t("settings.previewThinkingOnly")}</Text>
      ) : (
        <View>
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="read" label={t("modelLook.read")} command="/demo/src/app.ts" state="completed" />
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="edit" label={t("modelLook.edit")} command="/demo/src/app.ts" state="completed" expanded diff={<DiffBlock detail={diffDetail} palette={palette} styles={styles} />} />
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="search" label={t("modelLook.search")} command="vivid preview coverage" state="completed" />
          {failuresMode ? (
            <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="shell" label={t("modelLook.shell")} command={SAMPLE_COMMAND} state="failed" expanded errorLine={<Text style={{ color: hue(theme, "red", "text"), fontFamily: "monospace", fontSize: 11, lineHeight: 16 }}>{t("ui.error")}: Exit code 1</Text>} />
          ) : (
            <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="shell" label={t("modelLook.shell")} command={SAMPLE_COMMAND} state="completed" />
          )}
          <ToolReplica theme={theme} styles={styles} palette={palette} values={toolValues} metrics={metrics} look="shell" label={t("modelLook.shell")} command={SAMPLE_COMMAND} state="running" />
          {actions.LoaderMark ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: metrics.gap, minHeight: metrics.rowMinHeight, paddingLeft: 5 }}>
              {(() => { const Mark = actions.LoaderMark; return Mark ? <Mark kind={values.loader} size={16} color={palette.statusColors.running} /> : null; })()}
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t("modelLook.shell")} · {SAMPLE_COMMAND}</Text>
            </View>
          ) : null}
          <FoldReplica theme={theme} styles={styles} values={{ strength: values.strength, fold: values.fold }} palette={palette} metrics={metrics} failed={failuresMode} />
          <TokensReplica theme={theme} indent={indent} />
          <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap", alignItems: "center", paddingLeft: indent, paddingTop: 6 }}>
            {Object.entries(palette.categoryColors).map(([category, color]) => <Dot key={category} color={color} size={12} />)}
          </View>
        </View>
      )}
    </View>
  );
}
