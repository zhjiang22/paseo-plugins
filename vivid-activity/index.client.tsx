import { createClientI18n } from "./client/i18n-client";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { t } from "./shared/text";
import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { z } from "zod";
import { createChunkLoader, lazySurfaces } from "./client/lazy-chunk";
import { ActivityDetailsContext, PlainDetail } from "./client/activity-lazy";
import { getClientChunk } from "./shared/ui-chunk";
import { FX_CHUNK } from "./shared/generated/fx-chunk-manifest";
import { PI_CHUNK } from "./shared/generated/pi-chunk-manifest";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { ActivityIndicator } from "react-native";
import { ColorfulReasoning, ColorfulToolCall } from "./client/activity";
import { TurnTimeRow } from "./client/turn-time";
import { TURN_TIME_RENDERER_KIND, TURN_TIME_RENDERER_VERSION, turnTimeDataSchema } from "./shared/turn-time";
import { FoldRow } from "./client/fold-row";
import { configureFx } from "./client/fx";
import { LoaderMark } from "./client/vivid";
import { foldRuntime } from "./client/fold-runtime";
import { BOUNDARY_ITEM_TYPES, configurePiNotices, observeBoundary, transformReasoning, transformToolCall } from "./client/transform";
import { applyTakeover, isSettingsChange, setLiveTakeover, startTakeover, type TakeoverPart } from "./client/takeover";
import { installColorfulFonts } from "./client/web";
import { foldIndexRpc } from "./shared/fold-index";
import { activitySettings, DEFAULT_TAKEOVER, foldFromValues } from "./shared/settings";
import {
  FOLD_RENDERER_KIND,
  FOLD_RENDERER_VERSION,
  foldItemDataSchema,
  REASONING_RENDERER_KIND,
  REASONING_RENDERER_VERSION,
  TOOL_CALL_RENDERER_KIND,
  TOOL_CALL_RENDERER_VERSION,
  reasoningItemDataSchema,
  setPiNoticeReader,
  toolCallItemDataSchema,
  type PiNoticeReader,
} from "./shared/timeline";

type EventObserver = (
  events: ["status.plugin_settings_changed"],
  options: { signal: AbortSignal },
) => {
  subscribe(observer: { snapshot(): void; update(message: unknown): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
};

/** Follows settings changes made on any device; also fires after (re)connecting. */
function watchSettings(client: PluginClientContext, changed: () => void): () => void {
  const observe = (client.paseo as { observeEvents?: unknown }).observeEvents;
  if (typeof observe !== "function") return () => undefined;
  const lifetime = new AbortController();
  try {
    const observation = (observe as EventObserver).call(client.paseo, ["status.plugin_settings_changed"], {
      signal: lifetime.signal,
    });
    const unsubscribe = observation.subscribe({
      snapshot: changed,
      update: (message) => {
        if (isSettingsChange(message, activitySettings.id)) changed();
      },
      error: () => undefined,
    });
    return () => {
      unsubscribe();
      lifetime.abort();
      void observation.release().catch(() => undefined);
    };
  } catch {
    lifetime.abort();
    return () => undefined;
  }
}

const NudgeRow = () => null;

export default function contribute(client: PluginClientContext) {
  const i18n = createClientI18n(client, { pluginId: "vivid-activity", boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } } });
  const surface = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.name"), text: i18n, fallback: (id, props) => id === "settings" ? <ActivityIndicator color={props.theme?.colors.foregroundMuted} /> : <PlainDetail {...props} /> });
  const details = { DetailBody: surface("detail"), ReasoningText: surface("reasoning") };
  const LazySettings = surface("settings");
  const actions = { onFoldSettings: foldRuntime.setSettings, onTakeover: applyTakeover, LoaderMark };
  const ActivitySettings = (props: any) => <LazySettings {...props} actions={actions} />;
  const ReasoningRow = (props: any) => <ActivityDetailsContext.Provider value={details}><ColorfulReasoning {...props} /></ActivityDetailsContext.Provider>;
  const ToolRow = (props: any) => <ActivityDetailsContext.Provider value={details}><ColorfulToolCall {...props} /></ActivityDetailsContext.Provider>;
  const removeFonts = installColorfulFonts();
  client.addSettingsScreen({
    id: "display",
    title: t("boot.name"),
    icon: "Palette",
    Component: ActivitySettings,
  });
  // 计划（ExitPlanMode / plan_approval）和任务清单（TodoWrite）不注册转换器，始终由 Paseo 显示。
  client.addTimelineRenderer({
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    schema: reasoningItemDataSchema,
    Component: ReasoningRow,
  });
  client.addTimelineRenderer({
    kind: TOOL_CALL_RENDERER_KIND,
    version: TOOL_CALL_RENDERER_VERSION,
    schema: toolCallItemDataSchema,
    Component: ToolRow,
  });
  client.addTimelineRenderer({ kind: TURN_TIME_RENDERER_KIND, version: TURN_TIME_RENDERER_VERSION, schema: turnTimeDataSchema, Component: TurnTimeRow });
  // 本地补丁：折叠摘要行。
  client.addTimelineRenderer({
    kind: FOLD_RENDERER_KIND,
    version: FOLD_RENDERER_VERSION,
    schema: foldItemDataSchema,
    Component: FoldRow,
  });

  // 本地补丁：折叠需要 Paseo 重新投影时，增删一个空渲染器——Paseo 会换一个新的组合转换函数，投影缓存随之失效
  // （与切换接管范围用的是同一个机制）。
  let nudgeRegistration: (() => void) | null = null;
  const nudge = () => {
    if (nudgeRegistration) {
      nudgeRegistration();
      nudgeRegistration = null;
    } else {
      nudgeRegistration = client.addTimelineRenderer({ kind: "vivid-nudge", version: 1, schema: z.null(), Component: NudgeRow });
    }
  };
  const stopText = i18n.subscribe(nudge);
  foldRuntime.configure({ rpc: (input) => client.rpc(foldIndexRpc, input), nudge });
  // 0.6.0-local.5: the Pi notice reader comes in its own small chunk, the first time a Pi notice row is drawn.
  const piChunk = createChunkLoader(client, { rpc: getClientChunk, manifest: PI_CHUNK, label: () => t("boot.piNotice"), text: i18n });
  configurePiNotices({ load: () => piChunk.load().then((surfaces) => surfaces.readPiNotice as unknown as PiNoticeReader), redraw: nudge });
  // 0.8.0: running animations other than the spinner and the change list of an expanded summary (client/fx.ts).
  configureFx(createChunkLoader(client, { rpc: getClientChunk, manifest: FX_CHUNK, label: () => t("boot.name"), text: i18n }));

  const readSettings = settingsRpc(activitySettings.id).read;
  const register = (part: TakeoverPart) => {
    if (part === "tool-calls") {
      return client.addTimelineTransformer({ id: "tool-calls", query: { itemType: "tool_call" }, transform: transformToolCall });
    }
    // Reasoning is drawn in every scope but 「关闭」, so the boundary observers live with it.
    const removals = [
      client.addTimelineTransformer({ id: "reasoning", query: { itemType: "reasoning" }, transform: transformReasoning }),
      ...BOUNDARY_ITEM_TYPES.map((itemType) =>
        client.addTimelineTransformer({ id: `fold-${itemType.replace(/_/g, "-")}`, query: { itemType }, transform: observeBoundary } as Parameters<typeof client.addTimelineTransformer>[0]),
      ),
    ];
    // Paseo 0.13 lets a transformer watch notifications too (getpaseo/paseo#7582), so a segment folds as soon as one
    // arrives. Paseo 0.12 rejects the item type before registering anything, which tells the two apart.
    try {
      removals.push(client.addTimelineTransformer({ id: "fold-notification", query: { itemType: "notification" }, transform: observeBoundary } as Parameters<typeof client.addTimelineTransformer>[0]));
    } catch {
      // Older host: the fold index still splits segments at notifications, just later.
    }
    return () => {
      for (const remove of removals) remove();
    };
  };
  const takeover = startTakeover({
    register,
    read: async () => {
      const [result] = await Promise.all([client.rpc(readSettings, {}), i18n.ready()]);
      if (result.status !== "ready") return null;
      const fold = foldFromValues(result.values);
      if (fold) foldRuntime.setSettings(fold);
      return fold?.scope ?? null;
    },
    watch: (changed) => watchSettings(client, changed),
    // Rows need their text: with a catalog already kept (reconnect, web reload) take over at once as before; otherwise
    // the first read waits for both settings and text, and the host's own rows show until then.
  }, i18n.isReady() ? DEFAULT_TAKEOVER : "off");
  setLiveTakeover(takeover);
  return () => {
    stopText();
    i18n.dispose();
    setLiveTakeover(null);
    takeover.stop();
    configurePiNotices(null);
    configureFx(null);
    setPiNoticeReader(null);
    foldRuntime.configure(null);
    nudgeRegistration = null;
    removeFonts();
  };
}
