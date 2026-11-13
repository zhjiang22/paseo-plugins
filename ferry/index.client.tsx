import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { ActivityIndicator } from "react-native";
import { z } from "zod";
import { createDrafts } from "./client/drafts";
import { createClientI18n } from "./client/i18n-client";
import { lazySurfaces } from "./client/lazy-chunk";
import { registerPills } from "./client/pills";
import { readStubSettings } from "./client/settings-read";
import { UI_CHUNK } from "./shared/generated/ui-chunk-manifest";
import { boot as bootEn } from "./shared/locales/en.json";
import { boot as bootZh } from "./shared/locales/zh-CN.json";
import { PLUGIN_ID, ROW_ALERT, ROW_HANDOFF, ROW_MOVED, ROW_VERSION } from "./shared/plugin-id";
import { t } from "./shared/text";
import { getClientChunk } from "./shared/ui-chunk";

/** Rows are registered with a lenient schema; the views check the data themselves. */
const lenient = z.object({}).passthrough();

/**
 * The resident part: registrations only. The picker, the settings and the timeline cards load on first use
 * (`ui-chunk.client.tsx`). Connecting costs the boot text and one settings read (for a slash alias); the failure
 * button watches failed agents only.
 */
export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void | Promise<void>> = [];
  const i18n = createClientI18n(client, { pluginId: PLUGIN_ID, boot: { "zh-CN": { boot: bootZh }, en: { boot: bootEn } }, load: "lazy" });
  // Until the views' code is there: rows show nothing, screens a spinner.
  const fallback = (id: string, props: PluginTimelineItemProps) => (id.startsWith("row-") ? null : <ActivityIndicator color={props.theme?.colors.foregroundMuted} />);
  const lazy = lazySurfaces(client, { rpc: getClientChunk, manifest: UI_CHUNK, label: () => t("boot.name"), text: i18n, fallback });
  const drafts = createDrafts();

  const Screen = lazy("screen");
  const FerryScreen = (props: object) => <Screen {...props} drafts={drafts} />;
  cleanups.push(client.addScreen({ id: "ferry", title: () => t("boot.screenTitle"), Component: FerryScreen }));
  cleanups.push(client.addScreen({ id: "sent", title: () => t("boot.sentTitle"), Component: lazy("sent") }));
  cleanups.push(client.addSettingsScreen({ id: "settings", title: t("boot.settingsTitle"), icon: "ArrowLeftRight", Component: lazy("settings") }));
  cleanups.push(client.addSettingsScreen({ id: "language", title: t("boot.languageTitle"), icon: "Languages", Component: lazy("language") }));

  cleanups.push(client.addTimelineRenderer({ kind: ROW_HANDOFF, version: ROW_VERSION, schema: lenient, Component: lazy("row-handoff") }));
  cleanups.push(client.addTimelineRenderer({ kind: ROW_MOVED, version: ROW_VERSION, schema: lenient, Component: lazy("row-moved") }));
  cleanups.push(client.addTimelineRenderer({ kind: ROW_ALERT, version: ROW_VERSION, schema: lenient, Component: lazy("row-alert") }));

  // `/ferry [provider[/model]] [message]`, and the same under the alias the settings name.
  let alias = "";
  const slash = (name: string) =>
    client.addSlashCommand({
      name,
      description: t("boot.slashDescription"),
      argumentHint: t("boot.slashHint"),
      context: "agent",
      onSubmit({ args, agent, openScreen }) {
        const draft = drafts.put({ args, auto: true });
        openScreen({ screenId: "ferry", params: { agentId: agent.id, draft } });
      },
    });
  const registerCommands = () =>
    i18n.localized(() => {
      const entries = [
        client.addCommandCenterItem({
          id: "continue",
          title: t("boot.commandTitle"),
          icon: "ArrowLeftRight",
          context: "agent",
          keywords: t("boot.keywords").split("|"),
          onSelect: ({ agent, openScreen }) => openScreen({ screenId: "ferry", params: { agentId: agent.id } }),
        }),
        slash(PLUGIN_ID),
      ];
      if (alias && alias !== PLUGIN_ID) entries.push(slash(alias));
      return entries;
    });
  let commands = registerCommands();
  let disposed = false;
  void readStubSettings(client).then(
    (values) => {
      const next = values.slashAlias;
      if (disposed || next === alias) return;
      alias = next;
      commands();
      commands = registerCommands();
    },
    () => undefined,
  );

  cleanups.push(
    registerPills(
      client,
      (agentId, target) => client.openScreen({ screenId: "ferry", params: target ? { agentId, target, auto: "1" } : { agentId } }),
      (listener) => i18n.subscribe(listener),
    ),
  );

  return () => {
    disposed = true;
    commands();
    for (const cleanup of cleanups.splice(0).reverse()) void cleanup();
    i18n.dispose();
  };
}
