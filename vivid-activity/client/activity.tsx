import { translator } from "../shared/i18n";
import { useI18n } from "./i18n-client";
import { t } from "../shared/text";
import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useAgent, useSettings } from "@getpaseo/plugin/client";
import { Icon, ScrollView } from "@getpaseo/plugin/client/react-native";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Pressable, Text, View, type TextStyle, type ViewStyle } from "react-native";
import type { z } from "zod";
import { parsePiSubagentCall, piSubagentOperation } from "../shared/pi-subagents";
import { compactText, estimateReasoningTokens, expansionTargetForToolCall, formatReasoningMeta, hasMeaningfulToolCallDetail, isAskTool, isTodoTool, MAX_VISIBLE_SUBAGENT_ACTIONS, parseSubAgentActionLog, relativeToRoot, resolveActivityPalette, resolveSubAgentActionPresentation, splitFileDisplay, splitReasoningSteps, stripAnsi, stripLeadingCwdCd, toolCallHasBody, truncateDirFront, type ActivityPalette, type ActivityThemeColors } from "../shared/presentation";
import { noticeSections } from "../shared/notice";
import type { ExpansionMode, ExpansionTarget, Strength } from "../shared/settings";
import { activitySettings, DEFAULT_EXPANSION, DEFAULT_PALETTE_MODE, DEFAULT_STRENGTH } from "../shared/settings";
import { formatDuration } from "../shared/timing";
import { isLatestTaskUpdate, resolveExpansion, resolveTaskUpdateExpansion, toolCallItemDataSchema, type ReasoningItemData, type TaskUpdateExpansionOverride, type ToolCallItemData, } from "../shared/timeline";
import { useActivityDetails } from "./activity-lazy";
import { usePendingPermissions } from "./attention";
import { densityMetrics, useDensity, useFoldRow, type DensityMetrics } from "./density";
import { typeset, useTypography } from "./typography";
import { foldRuntime } from "./fold-runtime";
import { aria, Button } from "./kit";
import { createLatestRows, forgetWith } from "./latest-rows";
import { PiSubagentLifecycleSummary } from "./pi-subagent-summary";
import { PinnedPrompt, usePromptPin } from "./prompt-pin";
import { timingText, useLiveNow, useOnScreen, useRowTiming } from "./timing";
import { useFx } from "./fx";
import { retryPiNotices } from "./transform";
import { failureText, lookFor, mcpParts, resolveVividPalette, VividHeader, zh, type LookKey, type RowStatus } from "./vivid";
import { cmonoViewEscape, cuiTextEscape, pmonoViewEscape } from "./web";

const MAX_DETAIL_HEIGHT = 420;

// Paseo spaces consecutive activity rows by applying its inter-row gap to the row
// that still has a newer neighbor. On the native inverted timeline the newest live
// row gets none, leaving no gap above it. The plugin supplies the missing gap on the
// row itself whenever it is the live tail.
// 本地补丁：行距按「行密度」取（client/density.ts）：紧凑行间 4px，标准 10px（0.3.0-local.1）。

type Theme = PluginTimelineItemProps["theme"];
type ToolCallData = z.output<typeof toolCallItemDataSchema>;

// 0.5.0：每个 Agent 最新的思考行、工具行、任务更新时间，有上限，折叠运行时忘掉 Agent 时一起丢掉（client/latest-rows.ts）。
const latestReasoning = createLatestRows();
const latestToolCall = createLatestRows();
const latestTaskUpdate = createLatestRows();
forgetWith(foldRuntime, [latestReasoning, latestToolCall, latestTaskUpdate]);
const getEmptyTaskUpdateTimestamp = () => 0;

function useIsLatestReasoning(agentId: string, timestamp: Date, isStreaming: boolean): boolean {
  const itemTime = timestamp.getTime();
  if (isStreaming || itemTime > latestReasoning.get(agentId)) {
    latestReasoning.note(agentId, itemTime);
  }

  const latestTime = useSyncExternalStore(
    latestReasoning.subscribe,
    () => latestReasoning.get(agentId),
    () => 0,
  );
  return isStreaming || (latestTime > 0 && itemTime >= latestTime);
}

function useIsLatestToolCall(agentId: string, timestamp: Date, isRunning: boolean): boolean {
  const itemTime = timestamp.getTime();
  if (isRunning || itemTime > latestToolCall.get(agentId)) {
    latestToolCall.note(agentId, itemTime);
  }

  const latestTime = useSyncExternalStore(
    latestToolCall.subscribe,
    () => latestToolCall.get(agentId),
    () => 0,
  );
  return isRunning || (latestTime > 0 && itemTime >= latestTime);
}

function useLatestTaskUpdateTimestamp(agentId: string, timestamp: Date, isTaskUpdate: boolean): number {
  const itemTime = timestamp.getTime();
  const subscribe = useCallback(
    (listener: () => void) => (isTaskUpdate ? latestTaskUpdate.subscribe(listener) : () => {}),
    [isTaskUpdate],
  );
  const getSnapshot = useCallback(
    () => (isTaskUpdate ? latestTaskUpdate.get(agentId) : 0),
    [agentId, isTaskUpdate],
  );
  const latestTimestamp = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getEmptyTaskUpdateTimestamp,
  );
  useLayoutEffect(() => {
    if (isTaskUpdate) latestTaskUpdate.note(agentId, itemTime);
  }, [agentId, isTaskUpdate, itemTime]);
  return isTaskUpdate ? Math.max(latestTimestamp, itemTime) : latestTimestamp;
}

/**
 * Whether a row is the live tail: the newest activity row, still being produced, on
 * the native inverted timeline. Paseo's inverted stream skips the inter-row gap on
 * that row (the gap lands above the row before it), so only it needs the plugin to
 * supply its own top spacing. Comparing against both activity stores keeps parallel
 * (or background) rows from claiming the tail while a newer row exists; the web
 * timeline is not inverted and already receives the host's gap.
 */
function useIsLiveTail(
  agentId: string,
  timestamp: Date,
  active: boolean,
  platform: PluginTimelineItemProps["layout"]["platform"],
): boolean {
  const reasoningLatest = useSyncExternalStore(
    latestReasoning.subscribe,
    () => latestReasoning.get(agentId),
    () => 0,
  );
  const toolCallLatest = useSyncExternalStore(
    latestToolCall.subscribe,
    () => latestToolCall.get(agentId),
    () => 0,
  );
  return (
    active &&
    platform !== "web" &&
    timestamp.getTime() >= Math.max(reasoningLatest, toolCallLatest)
  );
}

function useExpansionMode(target: ExpansionTarget): ExpansionMode {
  const settings = useSettings(activitySettings);
  if (settings.status === "ready") return settings.values.expansion[target] ?? DEFAULT_EXPANSION[target];
  return DEFAULT_EXPANSION[target];
}

export function usePalette(theme: Theme): ActivityPalette {
  const settings = useSettings(activitySettings);
  const mode = settings.status === "ready" ? settings.values.palette : DEFAULT_PALETTE_MODE;
  return useMemo(
    () => (mode === "vivid" ? resolveVividPalette(theme) : resolveActivityPalette(mode === "theme" ? "vivid" : mode, theme.colors as ActivityThemeColors)),
    [mode, theme],
  );
}

/** 「淡出强度」的档位 → 行的不透明度（0.11.0）。 */
export const QUIET: Record<Strength, number> = { dim: 0.3, faded: 0.45, soft: 0.65, full: 1 };

export function useStrength(): Strength {
  const settings = useSettings(activitySettings);
  return settings.status === "ready" ? settings.values.strength : DEFAULT_STRENGTH;
}

/** 0.11.0:「命令着色」档位（着色组件在 fx 懒加载块 client/command-tokens.tsx，常驻包不带 Prism）。 */
function useCommandColors(): "expanded" | "always" {
  const settings = useSettings(activitySettings);
  return settings.status === "ready" ? settings.values.commandColors : "expanded";
}

export function useActivityStyles(theme: Theme, palette: ActivityPalette, metrics: DensityMetrics) {
  const type = useTypography();
  return useMemo(
    () => typeset({
      card: {
        marginHorizontal: 0,
        marginTop: metrics.marginTop,
        marginBottom: metrics.marginBottom,
      } satisfies ViewStyle,
      cardTail: {
        marginTop: metrics.tailMarginTop,
      } satisfies ViewStyle,
      headerButton: {
        alignItems: "center",
        borderRadius: 2,
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
        outlineColor: "transparent",
        outlineStyle: "none" as unknown as ViewStyle["outlineStyle"],
        outlineWidth: 0,
        overflow: "hidden",
        paddingHorizontal: 5,
        paddingVertical: metrics.plainPaddingVertical,
      } satisfies ViewStyle,
      iconBadge: {
        alignItems: "center",
        height: 16,
        justifyContent: "center",
        width: 16,
      } satisfies ViewStyle,
      title: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: "600",
        lineHeight: 17,
        maxWidth: "50%",
      } satisfies TextStyle,
      summary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
        minWidth: 0,
      } satisfies TextStyle,
      filePath: {
        alignItems: "center",
        flex: 1,
        flexDirection: "row",
        minWidth: 0,
      } satisfies ViewStyle,
      fileDir: {
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
      } satisfies TextStyle,
      fileName: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: "600",
        lineHeight: 17,
        maxWidth: "100%",
      } satisfies TextStyle,
      status: {
        alignItems: "center",
        flexDirection: "row",
        marginLeft: 2,
      } satisfies ViewStyle,
      stats: {
        alignItems: "center",
        flexDirection: "row",
        gap: 3,
        marginLeft: 2,
      } satisfies ViewStyle,
      // 0.5.0: the palette's state colours (kit hues in 「鲜明」, the theme's own in the other palettes), not the host's dim ones.
      additions: {
        color: palette.statusColors.completed,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 15,
      } satisfies TextStyle,
      deletions: {
        color: palette.statusColors.failed,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 15,
      } satisfies TextStyle,
      // 本地补丁（吸收 beautiful-chat 的层次）：展开后是一张圆角卡片，代码和终端是卡片里更深一层的框。
      // 只用边框和底色分层，不用阴影和毛玻璃：原生端和低端机零额外开销。
      details: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderRadius: 10,
        borderWidth: 1,
        flexShrink: 1,
        marginBottom: 2,
        marginLeft: 2,
        marginTop: 3,
        minWidth: 0,
        overflow: "hidden",
      } satisfies ViewStyle,
      detailsScroll: {
        maxHeight: MAX_DETAIL_HEIGHT,
      } satisfies ViewStyle,
      detailsContent: {
        gap: 8,
        paddingHorizontal: 8,
        paddingVertical: 8,
      } satisfies ViewStyle,
      frame: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        minWidth: 0,
        overflow: "hidden",
      } satisfies ViewStyle,
      frameHeader: {
        alignItems: "center",
        backgroundColor: theme.colors.surface1,
        borderBottomColor: theme.colors.border,
        borderBottomWidth: 1,
        flexDirection: "row",
        gap: 6,
        minHeight: 26,
        paddingHorizontal: 8,
        paddingVertical: 3,
      } satisfies ViewStyle,
      frameTitleRow: {
        alignItems: "center",
        flexDirection: "row",
        flexGrow: 1,
        flexShrink: 1,
        gap: 6,
        minWidth: 0,
      } satisfies ViewStyle,
      frameTitle: {
        color: theme.colors.foreground,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 16,
      } satisfies TextStyle,
      frameBody: {
        flexDirection: "row",
        minWidth: "100%",
        paddingHorizontal: 8,
        paddingVertical: 6,
      } satisfies ViewStyle,
      gutter: {
        alignItems: "flex-end",
        marginRight: 10,
      } satisfies ViewStyle,
      gutterText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        fontVariant: ["tabular-nums"],
        lineHeight: 16,
        opacity: 0.6,
      } satisfies TextStyle,
      termOutput: {
        borderTopColor: theme.colors.border,
        borderTopWidth: 1,
      } satisfies ViewStyle,
      termOutputHeader: {
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "space-between",
        paddingHorizontal: 8,
        paddingTop: 5,
      } satisfies ViewStyle,
      // 本地补丁：小节名改为中文后不用等宽、大写和字距（上游为 10px 等宽大写英文）。
      detailLabel: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 15,
      } satisfies TextStyle,
      detailText: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      mutedText: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      searchLineNumber: {
        color: theme.colors.accent,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      pathRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
      } satisfies ViewStyle,
      pathText: {
        color: theme.colors.foreground,
        flex: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      section: {
        gap: 3,
      } satisfies ViewStyle,
      showMoreButton: {
        alignSelf: "flex-start",
        paddingHorizontal: 6,
        paddingVertical: 3,
        borderRadius: 2,
        marginTop: 3,
      } satisfies ViewStyle,
      showMoreText: {
        color: palette.categoryColors.agent,
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 15,
      } satisfies TextStyle,
      codeHeader: {
        alignItems: "center",
        flexDirection: "row",
        justifyContent: "space-between",
        minWidth: "100%",
      } satisfies ViewStyle,
      copyButton: {
        alignItems: "center",
        borderRadius: 2,
        flexDirection: "row",
        gap: 3,
        paddingHorizontal: 4,
        paddingVertical: 2,
      } satisfies ViewStyle,
      // 本地补丁：中文的按钮、字段名、状态胶囊用 11px 常规字体（上游为 10px 等宽英文）。
      copyText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 15,
      } satisfies TextStyle,
      todoList: {
        gap: 2,
      } satisfies ViewStyle,
      todoRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
      } satisfies ViewStyle,
      todoTitle: {
        color: theme.colors.foreground,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
      } satisfies TextStyle,
      todoDone: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
        textDecorationLine: "line-through",
      } satisfies TextStyle,
      imageSurface: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        minWidth: "100%",
        overflow: "hidden",
      } satisfies ViewStyle,
      imageThumbnail: {
        height: 200,
        width: "100%",
      } satisfies ViewStyle,
      imageExpanded: {
        height: 480,
        width: "100%",
      } satisfies ViewStyle,
      codeSurface: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        minWidth: "100%",
        paddingHorizontal: 6,
        paddingVertical: 4,
      } satisfies ViewStyle,
      codeScroll: {
        maxWidth: "100%",
      } satisfies ViewStyle,
      codeLine: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minHeight: 16,
      } satisfies TextStyle,
      diffSurface: {
        backgroundColor: theme.colors.surface0,
        borderColor: theme.colors.border,
        borderRadius: 8,
        borderWidth: 1,
        minWidth: "100%",
        overflow: "hidden",
        paddingVertical: 2,
      } satisfies ViewStyle,
      diffLine: {
        flexDirection: "row",
        minHeight: 16,
        paddingHorizontal: 5,
      } satisfies ViewStyle,
      diffMarker: {
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        width: 12,
      } satisfies TextStyle,
      diffText: {
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      // 0.5.0: added lines take the "completed" green like their + marker, not the sub-agent tint (upstream's agent was green).
      diffAdded: {
        backgroundColor: palette.statusBackgrounds.completed,
      } satisfies ViewStyle,
      diffRemoved: {
        backgroundColor: palette.statusBackgrounds.failed,
      } satisfies ViewStyle,
      diffMeta: {
        backgroundColor: palette.categoryBackgrounds.search,
      } satisfies ViewStyle,
      reasoningBody: {
        gap: 3,
        paddingHorizontal: 7,
        paddingVertical: 5,
      } satisfies ViewStyle,
      stepList: {
        paddingHorizontal: 8,
        paddingTop: 8,
        paddingBottom: 2,
      } satisfies ViewStyle,
      stepHeader: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
      } satisfies ViewStyle,
      stepBody: {
        gap: 3,
        marginLeft: 16,
      } satisfies ViewStyle,
      // 本地补丁：思考步骤的进度轨（beautiful-chat 的连线步骤），完成的步骤实心勾，进行中的空心并呼吸。
      stepRow: {
        flexDirection: "row",
        gap: 8,
      } satisfies ViewStyle,
      stepRail: {
        alignItems: "center",
        width: 14,
      } satisfies ViewStyle,
      stepDot: {
        alignItems: "center",
        borderRadius: 7,
        borderWidth: 1.5,
        height: 14,
        justifyContent: "center",
        marginTop: 1,
        width: 14,
      } satisfies ViewStyle,
      stepLine: {
        backgroundColor: theme.colors.border,
        borderRadius: 1,
        flexGrow: 1,
        marginBottom: 1,
        marginTop: 2,
        width: 2,
      } satisfies ViewStyle,
      stepContent: {
        flexGrow: 1,
        flexShrink: 1,
        gap: 3,
        minWidth: 0,
        paddingBottom: 10,
      } satisfies ViewStyle,
      stepTitle: {
        color: theme.colors.foreground,
        fontSize: 12,
        fontWeight: "700",
        lineHeight: 16,
      } satisfies TextStyle,
      reasoningLine: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
      } satisfies TextStyle,
      reasoningHeading: {
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 12,
        fontWeight: "600",
        lineHeight: 17,
      } satisfies TextStyle,
      // 0.6.0 (opus-F49): the marker keeps its width but may grow (「10.」 is wider than 14 px in a monospace face on phones);
      // the text next to it shrinks. Native Text defaults to flexShrink 0, so a wrapped list item used to run 18 px past
      // the row and lose about one character at the end of every line (the details card clips it).
      reasoningBullet: {
        color: theme.colors.foregroundMuted,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
        minWidth: 14,
      } satisfies TextStyle,
      reasoningBulletRow: {
        alignItems: "flex-start",
        flexDirection: "row",
        gap: 4,
      } satisfies ViewStyle,
      reasoningBulletText: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
      } satisfies TextStyle,
      reasoningQuote: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 12,
        lineHeight: 17,
        paddingLeft: 6,
      } satisfies TextStyle,
      reasoningInlineCode: {
        backgroundColor: theme.colors.surface2,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        paddingHorizontal: 2,
      } satisfies TextStyle,
      reasoningSpacer: {
        height: 2,
      } satisfies ViewStyle,
      subAgentProgress: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        gap: 1,
        marginLeft: 12,
        paddingBottom: 2,
        paddingLeft: 7,
        paddingTop: 1,
      } satisfies ViewStyle,
      subAgentLine: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
      } satisfies ViewStyle,
      subAgentLineIcon: {
        alignItems: "center",
        justifyContent: "center",
        width: 14,
      } satisfies ViewStyle,
      subAgentLineLabel: {
        color: theme.colors.foreground,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 16,
      } satisfies TextStyle,
      subAgentLineSummary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
      } satisfies TextStyle,
      subAgentMore: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        paddingLeft: 19,
      } satisfies TextStyle,
      subAgentAction: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
        paddingLeft: 19,
      } satisfies ViewStyle,
      subAgentActionIcon: {
        alignItems: "center",
        justifyContent: "center",
        width: 14,
      } satisfies ViewStyle,
      // 0.6.0: an unknown tool shows its raw name here, which can be long: it shrinks (ellipsis) rather than run off the row.
      subAgentActionLabel: {
        color: theme.colors.foreground,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        maxWidth: "60%",
      } satisfies TextStyle,
      subAgentActionSummary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        minWidth: 0,
      } satisfies TextStyle,
      childTimelineSection: {
        gap: 2,
      } satisfies ViewStyle,
      childTimelineHeader: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
      } satisfies ViewStyle,
      childTimelineList: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        gap: 1,
        marginLeft: 7,
        paddingLeft: 7,
      } satisfies ViewStyle,
      childTimelineItem: {
        alignItems: "center",
        flexDirection: "row",
        gap: 5,
        minWidth: 0,
        paddingVertical: 1,
      } satisfies ViewStyle,
      childTimelineItemTitle: {
        color: theme.colors.foreground,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "500",
        lineHeight: 15,
        maxWidth: "60%",
      } satisfies TextStyle,
      childTimelineItemSummary: {
        color: theme.colors.foregroundMuted,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
        minWidth: 0,
      } satisfies TextStyle,
      childTimelineItemMeta: {
        color: theme.colors.foregroundMuted,
        flexShrink: 0,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      empty: {
        color: theme.colors.foregroundMuted,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
      } satisfies TextStyle,
      pendingRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 8,
        paddingVertical: 4,
      } satisfies ViewStyle,
      paseoStack: {
        gap: 6,
      } satisfies ViewStyle,
      paseoHero: {
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 2,
        paddingHorizontal: 6,
        paddingVertical: 2,
      } satisfies ViewStyle,
      paseoHeroRow: {
        alignItems: "center",
        flexDirection: "row",
        gap: 6,
      } satisfies ViewStyle,
      paseoHeroIcon: {
        alignItems: "center",
        height: 16,
        justifyContent: "center",
        width: 16,
      } satisfies ViewStyle,
      paseoHeroTitle: {
        color: theme.colors.foreground,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 16,
      } satisfies TextStyle,
      paseoHeroSubtitle: {
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      paseoRows: {
        gap: 2,
      } satisfies ViewStyle,
      paseoRow: {
        alignItems: "flex-start",
        flexDirection: "row",
        gap: 8,
        minWidth: 0,
      } satisfies ViewStyle,
      // 0.6.0: a long field name wraps inside 45% of the row instead of pushing the value off it.
      paseoKey: {
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontSize: 11,
        lineHeight: 15,
        maxWidth: "45%",
        minWidth: 90,
      } satisfies TextStyle,
      // 0.6.0 (opus-F49): it also sits alone in auto-height columns (nested values, 「—」), where a `flex: 1` basis of 0
      // collapses on the phone apps and lets the next field draw over it; grow from its own size instead.
      paseoValue: {
        color: theme.colors.foreground,
        flexGrow: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 15,
        minWidth: 0,
      } satisfies TextStyle,
      paseoPrompt: {
        backgroundColor: theme.colors.surface0,
        borderLeftColor: theme.colors.border,
        borderLeftWidth: 1,
        color: theme.colors.foreground,
        fontFamily: "monospace",
        fontSize: 11,
        lineHeight: 16,
        paddingHorizontal: 6,
        paddingVertical: 4,
      } satisfies TextStyle,
      paseoList: {
        gap: 0,
      } satisfies ViewStyle,
      paseoListItem: {
        borderTopColor: theme.colors.border,
        borderTopWidth: 1,
        gap: 1,
        paddingHorizontal: 5,
        paddingVertical: 3,
      } satisfies ViewStyle,
      paseoListItemHeader: {
        alignItems: "center",
        flexDirection: "row",
        gap: 7,
        minWidth: 0,
      } satisfies ViewStyle,
      paseoListItemTitle: {
        color: theme.colors.foreground,
        flex: 1,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 11,
        fontWeight: "500",
        lineHeight: 15,
        minWidth: 0,
      } satisfies TextStyle,
      // 0.6.0: also sits next to a title in list headers (a language, a server name): it shrinks there instead of overflowing.
      paseoListItemMeta: {
        color: theme.colors.foregroundMuted,
        flexShrink: 1,
        fontFamily: "monospace",
        fontSize: 10,
        lineHeight: 14,
      } satisfies TextStyle,
      paseoChips: {
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 5,
      } satisfies ViewStyle,
      paseoChip: {
        borderColor: theme.colors.border,
        borderRadius: 2,
        borderWidth: 1,
        paddingHorizontal: 4,
        paddingVertical: 1,
      } satisfies ViewStyle,
      paseoChipText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
        lineHeight: 15,
      } satisfies TextStyle,
      paseoStatus: {
        alignSelf: "flex-start",
      } satisfies ViewStyle,
      paseoStatusText: {
        color: theme.colors.foreground,
        fontSize: 11,
        fontWeight: "600",
        lineHeight: 15,
      } satisfies TextStyle,
    }, type),
    [metrics, palette, theme, type],
  );
}

export type ActivityStyles = ReturnType<typeof useActivityStyles>;

function statusIcon(status: ToolCallData["status"]): string {
  switch (status) {
    case "running":
      return "LoaderCircle";
    case "completed":
      return "CircleCheck";
    case "failed":
      return "CircleX";
    case "canceled":
      return "CircleSlash2";
  }
}

function asToolCallDetail(value: ToolCallData["detail"]): ToolCallDetail | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = Reflect.get(value, "type");
  if (typeof type !== "string") return null;
  return value as unknown as ToolCallDetail;
}

function SubAgentProgress({
  detail,
  styles,
  toolName,
}: {
  detail: Extract<ToolCallDetail, { type: "sub_agent" }>;
  styles: ReturnType<typeof useActivityStyles>;
  toolName: string;
}) {
  const actions = useMemo(() => {
    const explicitActions = [...(detail.actions ?? [])].sort((left, right) => left.index - right.index);
    return explicitActions.length > 0 ? explicitActions : parseSubAgentActionLog(detail.log);
  }, [detail.actions, detail.log]);
  const hiddenActionCount = Math.max(0, actions.length - MAX_VISIBLE_SUBAGENT_ACTIONS);
  const visibleActions = actions.slice(hiddenActionCount);
  const thinking = (actions.length > 0 && !(detail.actions?.length ?? 0)) || (piSubagentOperation(toolName) && parsePiSubagentCall(undefined, detail.log).lifecycle)
    ? null : detail.log?.replace(/\s+/g, " ").trim();

  if (!thinking && actions.length === 0) return null;

  return (
    <View style={styles.subAgentProgress}>
      {thinking ? (
        <View style={styles.subAgentLine}>
          <View style={styles.subAgentLineIcon}>
            <Icon name="Brain" color={styles.subAgentLineSummary.color} size={11} />
          </View>
          <Text numberOfLines={1} style={styles.subAgentLineLabel}>
            {t("ui.thinking")}</Text>
          <Text numberOfLines={1} style={styles.subAgentLineSummary}>
            {thinking}
          </Text>
        </View>
      ) : null}
      {hiddenActionCount > 0 ? <Text style={styles.subAgentMore}>{t("ui.moreSteps", { count: hiddenActionCount })}</Text> : null}
      {visibleActions.map((action) => {
        const presentation = resolveSubAgentActionPresentation(action.toolName, action.summary);
        return (
          <View key={`${action.index}-${action.toolName}`} style={styles.subAgentAction}>
            <View style={styles.subAgentActionIcon}>
              <Icon name={presentation.icon} color={styles.subAgentActionSummary.color} size={11} />
            </View>
            <Text numberOfLines={1} style={styles.subAgentActionLabel}>
              {zh(presentation.label)}
            </Text>
            {presentation.summaryIcon && action.summary ? (
              <Icon name={presentation.summaryIcon} color={styles.subAgentActionSummary.color} size={11} />
            ) : null}
            {action.summary ? (
              <Text numberOfLines={1} style={styles.subAgentActionSummary}>
                {action.summary}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function ActivityHeader({
  icon,
  iconColor,
  title,
  summary,
  summaryNode,
  fileDisplay,
  status,
  statusColor,
  stats,
  expanded,
  onPress,
  onHover,
  expandable = true,
  styles,
  vivid,
}: {
  vivid?: { theme: Theme; compact: boolean; look: LookKey; status?: RowStatus; statusText?: string; meta?: string; live?: boolean; icon?: string; metrics?: DensityMetrics; timing?: string | null };
  icon: string;
  iconColor: string;
  title: string;
  summary?: string;
  summaryNode?: ReactNode;
  fileDisplay?: { dir?: string; base: string };
  status?: ToolCallData["status"];
  statusColor?: string;
  stats?: ToolCallData["presentation"]["diffStats"];
  expanded: boolean;
  onPress: () => void;
  onHover?: (hovering: boolean) => void;
  expandable?: boolean;
  styles: ReturnType<typeof useActivityStyles>;
}) {
  if (vivid) {
    return (
      <VividHeader
        theme={vivid.theme}
        compact={vivid.compact}
        look={vivid.look}
        title={title}
        summary={summary}
        summaryNode={summaryNode}
        fileDisplay={fileDisplay}
        status={vivid.status}
        statusText={vivid.statusText}
        stats={stats}
        meta={vivid.meta}
        live={vivid.live}
        icon={vivid.icon}
        metrics={vivid.metrics}
        timing={vivid.timing}
        expanded={expanded}
        expandable={expandable}
        chevronColor={styles.summary.color}
        onPress={onPress}
        dirText={truncateDirFront}
        Pressable={({ children, style, onPress: press, label, expanded: open, disabled }) => (
          <Pressable
            accessibilityLabel={label}
            accessibilityRole="button"
            {...aria({ expanded: open })}
            disabled={disabled}
            onPress={press}
            onHoverIn={() => onHover?.(true)}
            onHoverOut={() => onHover?.(false)}
            onFocus={() => onHover?.(true)}
            onBlur={() => onHover?.(false)}
            style={[styles.headerButton, style]}
          >
            {children}
          </Pressable>
        )}
      />
    );
  }
  const content = (
    <>
      <View style={styles.iconBadge}>
        <Icon name={icon} color={iconColor} size={12} />
      </View>
      <Text {...cuiTextEscape} numberOfLines={1} style={styles.title}>{title}</Text>
      {summaryNode ? (
        <Text {...cuiTextEscape} numberOfLines={1} style={styles.summary}>{summaryNode}</Text>
      ) : fileDisplay ? (
        <View style={styles.filePath}>
          {fileDisplay.dir ? (
            <Text numberOfLines={1} style={styles.fileDir}>
              {truncateDirFront(fileDisplay.dir)}/
            </Text>
          ) : null}
          <Text numberOfLines={1} style={styles.fileName}>
            {fileDisplay.base}
          </Text>
        </View>
      ) : summary ? (
        <Text numberOfLines={1} style={styles.summary}>
          {summary}
        </Text>
      ) : null}
      {stats ? (
        <View style={styles.stats}>
          <Text style={styles.additions}>+{stats.additions}</Text>
          <Text style={styles.deletions}>-{stats.deletions}</Text>
        </View>
      ) : null}
      {status ? (
        <View style={styles.status}>
          <Icon name={statusIcon(status)} color={statusColor ?? styles.title.color} size={12} />
        </View>
      ) : null}
      {expandable ? (
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} color={styles.summary.color} size={12} />
      ) : (
        <Icon name="ChevronRight" color="transparent" size={12} />
      )}
    </>
  );
  if (!expandable) {
    return <View style={styles.headerButton}>{content}</View>;
  }
  return (
    <Pressable
      accessibilityLabel={expanded ? t("ui.collapseTitle", { title }) : t("ui.expandTitle", { title })}
      accessibilityRole="button"
      {...aria({ expanded })}
      onPress={onPress}
      onHoverIn={() => onHover?.(true)}
      onHoverOut={() => onHover?.(false)}
      onFocus={() => onHover?.(true)}
      onBlur={() => onHover?.(false)}
      style={styles.headerButton}
    >
      {content}
    </Pressable>
  );
}

export function ColorfulReasoning({
  agentId,
  item,
  theme,
  timestamp,
  layout,
}: PluginTimelineItemProps<ReasoningItemData>) {
  useI18n();
  const { ReasoningText } = useActivityDetails();
  const palette = usePalette(theme);
  const metrics = densityMetrics(useDensity(), layout.compact, layout.platform !== "web");
  const styles = useActivityStyles(theme, palette, metrics);
  const isStreaming = item.data.phase === "streaming";
  // 0.5.0: a streaming row's key changes with every chunk; the finished text's key is the one the index will know.
  useFoldRow(agentId, isStreaming ? undefined : item.data.fold, undefined, timestamp);
  // 本地补丁：「思考了 8.4 秒」；思考中实时走表（只在前台、行在屏幕上时）。
  const rootRef = useRef<View>(null);
  const onScreen = useOnScreen(rootRef, isStreaming);
  const timing = useRowTiming(agentId, item.data.fold, isStreaming);
  const liveNow = useLiveNow(isStreaming && onScreen && timing?.start != null);
  const thinkTime = timingText(timing, isStreaming, liveNow);
  const isLatest = useIsLatestReasoning(agentId, timestamp, isStreaming);
  const isLiveTail = useIsLiveTail(agentId, timestamp, isStreaming, layout.platform);
  // 0.6.0 (grok-B2): the question of this turn, when this row opens the newest stretch of activity.
  const pin = usePromptPin(agentId, { key: isStreaming ? undefined : item.data.fold });
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = resolveExpansion(useExpansionMode("thinking"), isLatest, userExpanded);
  const [hovered, setHovered] = useState(false);
  const strength = useStrength();
  // 「淡出强度」：已完成的思考行退后；流式、展开、悬停/聚焦与本轮末行保持原样。
  const quiet = strength !== "full" && !isStreaming && !expanded && !isLiveTail && !hovered;
  const meta = useMemo(
    () =>
      formatReasoningMeta(
        splitReasoningSteps(item.data.text).length,
        estimateReasoningTokens(item.data.text),
      ),
    [item.data.text, translator()],
  );
  const toggle = useCallback(() => {
    setUserExpanded(!expanded);
  }, [expanded]);
  return (
    <View ref={rootRef} {...pmonoViewEscape} style={[styles.card, isLiveTail ? styles.cardTail : null, quiet ? { opacity: QUIET[strength] } : null]}>
      {pin ? <PinnedPrompt agentId={agentId} pin={pin} theme={theme} mode={palette.mode} metrics={metrics} /> : null}
      <ActivityHeader
        icon="Sparkles"
        iconColor={palette.categoryColors.reasoning}
        title={isStreaming ? (thinkTime ? t("ui.thinking3", { time: thinkTime }) : t("ui.thinking2")) : thinkTime ? t("ui.thoughtFor", { time: thinkTime }) : t("ui.thinking")}
        summary={palette.mode === "vivid" ? undefined : meta}
        expanded={expanded}
        onPress={toggle}
        onHover={setHovered}
        styles={styles}
        vivid={palette.mode === "vivid" ? { theme, compact: layout.compact, look: "think", meta, live: isStreaming, metrics } : undefined}
      />
      {expanded ? (
        <View {...cmonoViewEscape} style={styles.details}>
          <ReasoningText text={item.data.text} phase={item.data.phase} theme={theme} palette={palette} styles={styles} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * 0.6.0-local.5 (codex-vivid-merge-F2): under a Pi notice drawn without its reader because the download failed: try again
 * now (it is also retried by itself, client/transform.ts). Resident, so it works whether or not the details chunk loaded.
 */
export function PiReaderRetry({ theme }: { theme: Theme }) {
  useI18n();
  return (
    <View style={{ alignItems: "flex-start", paddingTop: 6 }}>
      <Button theme={theme} size="sm" icon="RefreshCw" label={t("ui.readAgain")} accessibilityLabel={t("ui.readPiNoticesAgain")} onPress={retryPiNotices} />
    </View>
  );
}

export function ColorfulToolCall({
  agentId,
  item,
  theme,
  timestamp,
  layout,
}: PluginTimelineItemProps<ToolCallItemData>) {
  useI18n();
  const { DetailBody } = useActivityDetails();
  const palette = usePalette(theme);
  const metrics = densityMetrics(useDensity(), layout.compact, layout.platform !== "web");
  const styles = useActivityStyles(theme, palette, metrics);
  const isRunning = item.data.status === "running";
  useFoldRow(agentId, item.data.fold, item.data.status, timestamp);
  // 本地补丁：耗时；运行中实时走表（只在前台、行在屏幕上时每秒刷新）。
  const rootRef = useRef<View>(null);
  const onScreen = useOnScreen(rootRef, isRunning);
  const timing = useRowTiming(agentId, item.data.fold, isRunning);
  const liveNow = useLiveNow(isRunning && onScreen && timing?.start != null);
  const durationText = item.data.notice || item.data.pi ? null : timingText(timing, isRunning, liveNow);
  const isLatest = useIsLatestToolCall(agentId, timestamp, isRunning);
  const isLiveTail = useIsLiveTail(agentId, timestamp, isRunning, layout.platform);
  // 0.6.0 (grok-B2): the question of this turn, when this row opens the newest stretch of activity.
  const pin = usePromptPin(agentId, { key: item.data.fold, part: item.data.part });
  const detail = asToolCallDetail(item.data.detail);
  const isTaskUpdate = isTodoTool(item.data.name);
  const itemTimestamp = timestamp.getTime();
  const latestTaskUpdateTimestamp = useLatestTaskUpdateTimestamp(agentId, timestamp, isTaskUpdate);
  const isLatestTaskCard = isLatestTaskUpdate(itemTimestamp, latestTaskUpdateTimestamp);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const [taskUpdateOverride, setTaskUpdateOverride] = useState<TaskUpdateExpansionOverride | null>(null);
  const categoryColor = palette.categoryColors[item.data.presentation.category];
  const statusColor = palette.statusColors[item.data.status];
  const configuredExpansion = useExpansionMode(expansionTargetForToolCall(item.data.name, detail?.type ?? "unknown"));
  // 本地补丁：后台任务通知默认收起（说明已在行头）。0.6.0：Pi 扩展的通知也是。
  const expansionMode = item.data.notice || item.data.pi ? "never" : configuredExpansion;
  const baseExpanded = isTaskUpdate
    ? resolveTaskUpdateExpansion(expansionMode, isLatestTaskCard, latestTaskUpdateTimestamp, taskUpdateOverride)
    : resolveExpansion(expansionMode, isLatest, userExpanded, item.data.status === "failed");
  const hasDetails = detail ? hasMeaningfulToolCallDetail(detail) : true;
  // A notice always has its explanation and state to show.
  const hasBody = Boolean(item.data.notice || item.data.pi) || toolCallHasBody(item.data.name, detail, item.data.presentation.summary);
  const expandable = hasBody || Boolean(item.data.errorText);
  const expanded = expandable ? baseExpanded : false;
  const [hovered, setHovered] = useState(false);
  const strength = useStrength();
  // 「淡出强度」：已完成的工具行退后（失败行同样淡出、保留红色状态）；运行中、等待批准、提问、展开、悬停/聚焦与本轮末行保持原样。
  // 没有正文的行（expandable=false）不淡：disabled Pressable 上 hover/focus 不触发，淡了就没有恢复全强度的途径。
  const quiet = strength !== "full" && expandable && !isRunning && !expanded && !isLiveTail && !hovered;
  const toggle = useCallback(() => {
    if (isTaskUpdate) {
      setTaskUpdateOverride({ expanded: !expanded, latestTimestamp: latestTaskUpdateTimestamp });
    } else {
      setUserExpanded(!expanded);
    }
  }, [expanded, isTaskUpdate, latestTaskUpdateTimestamp]);
  const operation = piSubagentOperation(item.data.name);
  const subAgentDetail = detail?.type === "sub_agent" ? detail : null;
  const cwd = useAgent(agentId, (agent) => agent.cwd);
  const headerFile = useMemo(() => {
    const filePath = item.data.presentation.filePath;
    if (!filePath) return null;
    const relative = cwd ? relativeToRoot(filePath, cwd) : filePath;
    return splitFileDisplay(compactText(relative) ?? relative);
  }, [cwd, item.data.presentation.filePath]);
  const headerSummary =
    detail?.type === "shell" && item.data.presentation.summary
      ? stripLeadingCwdCd(item.data.presentation.summary, cwd)
      : item.data.presentation.summary;
  // 本地补丁：最新一条运行中的工具 + Agent 正在等权限 = 「等你批准」（琥珀）。
  // 0.6.0：提问（Claude 的 AskUserQuestion、Codex 的 request_user_input 等，请求的 kind 是 question）是「等你回答」，问号图标。
  const pending = usePendingPermissions(agentId, isRunning);
  const callId = item.data.callId;
  const waiting = isRunning && (callId ? pending.ids.has(callId) : pending.any && pending.ids.size === 0 && isLatest);
  const asking = waiting && (isAskTool(item.data.name) || (callId ? pending.questions.has(callId) : pending.onlyQuestions));
  const rowStatus: RowStatus = asking ? "question" : waiting ? "waiting" : item.data.status;
  const pi = item.data.pi;
  const look = pi ? pi.look : lookFor(item.data.name, detail, item.data.presentation);
  const mcp = look === "mcp" ? mcpParts(item.data.name) : null;
  const vividTitle = mcp ? t("ui.mcp") : zh(item.data.presentation.label);
  const vividSummary = mcp ? [t("ui.mcpSummary", { server: mcp.server, tool: mcp.tool }), headerSummary].filter(Boolean).join("  ") : headerSummary;
  // 0.6.0: a notice says how it ended in its own words; a reminder or an event (info) carries no state mark.
  const notice = item.data.notice;
  const noticeRaw = notice && detail?.type === "plain_text" ? detail.text : undefined;
  const noticeTime = useMemo(() => {
    const ms = noticeRaw ? noticeSections(noticeRaw).usage?.durationMs : null;
    return ms != null ? formatDuration(ms) : null;
  }, [noticeRaw, translator()]);
  // 0.6.0 (opus-B30): a Pi notice too; one that reports work still going on (仍在运行) gets no spinner, the work is elsewhere.
  const headerStatus: RowStatus | undefined = notice?.state === "info" || pi?.state === "info" || pi?.state === "running" ? undefined : rowStatus;
  const statusText = notice
    ? notice.state === "blocked" ? t("ui.blocked") : notice.state === "stopped" ? t("ui.stopped") : undefined
    : pi
      ? pi.state === "stopped" ? t("ui.stopped") : undefined
      : rowStatus === "failed" ? failureText(detail, item.data.errorText) : undefined;
  const vivid = palette.mode === "vivid";
  // 0.11.0:「命令着色」：shell 行的行头命令按语法色渲染（展开时或始终）。着色组件在 fx 懒加载块，
  // 下载到之前（或失败时）行头保持纯文本摘要——与运行中动画同一降级模式。只有真的需要着色才触发下载：
  // 默认配置（折叠 + 展开时着色）下，fx 不因工具行的存在而被下载。
  const commandColors = useCommandColors();
  const wantsColor = look === "shell" && !mcp && !notice && !pi && (commandColors === "always" || expanded);
  const CommandTokens = useFx(wantsColor)?.CommandTokens;
  const commandNode =
    wantsColor && headerSummary && CommandTokens ? (
      <CommandTokens text={headerSummary} theme={theme} />
    ) : null;
  return (
    <View ref={rootRef} {...pmonoViewEscape} style={[styles.card, isLiveTail ? styles.cardTail : null, quiet ? { opacity: QUIET[strength] } : null]}>
      {pin ? <PinnedPrompt agentId={agentId} pin={pin} theme={theme} mode={palette.mode} metrics={metrics} /> : null}
      <ActivityHeader
        icon={item.data.presentation.icon}
        iconColor={categoryColor}
        title={vividTitle}
        summary={vividSummary}
        summaryNode={commandNode}
        fileDisplay={headerFile ?? undefined}
        // 0.6.0-local.5 (codex-vivid-merge-F2): the other palettes leave out the same state marks as the vivid one.
        status={headerStatus === undefined ? undefined : item.data.status}
        statusColor={statusColor}
        stats={item.data.presentation.diffStats}
        expanded={expanded}
        onPress={toggle}
        onHover={setHovered}
        expandable={expandable}
        styles={styles}
        vivid={vivid ? { theme, compact: layout.compact, look, status: headerStatus, statusText, icon: notice || pi ? item.data.presentation.icon : item.data.presentation.fileIcon, metrics, timing: notice ? noticeTime : durationText } : undefined}
      />
      {operation && detail ? <PiSubagentLifecycleSummary toolName={item.data.name} input={undefined}
        output={detail.type === "sub_agent" ? detail.log : detail.type === "unknown" ? detail.output : undefined}
        theme={theme} palette={palette} styles={styles} /> : null}
      {hasDetails && subAgentDetail ? <SubAgentProgress detail={subAgentDetail} toolName={item.data.name} styles={styles} /> : null}
      {expandable && expanded ? (
        <View {...cmonoViewEscape} style={styles.details}>
          <ScrollView style={styles.detailsScroll} contentContainerStyle={styles.detailsContent} nestedScrollEnabled showsVerticalScrollIndicator>
            {hasBody ? (
              <DetailBody data={item.data} agentId={agentId} theme={theme} palette={palette} styles={styles} />
            ) : null}
            {pi?.reader === "failed" ? <PiReaderRetry theme={theme} /> : null}
            {item.data.errorText && !(detail?.type === "shell" && !detail.output) ? (
              <View style={styles.section}>
                <Text style={styles.detailLabel}>{t("ui.error")}</Text>
                <Text selectable style={{ ...styles.detailText, color: palette.statusColors.failed }}>{stripAnsi(item.data.errorText)}</Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}
