import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ChunkExtras } from "./client/lazy-chunk";
import { LanguageScreen } from "./client/language-screen";
import { AlertRowView, HandoffRowView, MovedRowView } from "./client/rows";
import { FerryScreen } from "./client/screen";
import { SentScreen } from "./client/sent";
import { SettingsScreen } from "./client/settings-screen";
import { followText } from "./shared/i18n";

// Paseo freezes exports before the module body runs; keep this declaration hoisted.
export default function chunk() {
  return { api: 1, createSurfaces };
}

/** Ferry's views, loaded the first time one shows. They get the client to call Ferry's RPCs and open its screens. */
function createSurfaces(client: PluginClientContext, extras?: ChunkExtras) {
  followText(extras?.text);
  return {
    screen: (props: any) => <FerryScreen {...props} client={client} />,
    sent: (props: any) => <SentScreen {...props} client={client} />,
    settings: (props: any) => <SettingsScreen {...props} client={client} />,
    language: LanguageScreen,
    "row-handoff": (props: any) => <HandoffRowView {...props} client={client} />,
    "row-moved": (props: any) => <MovedRowView {...props} client={client} />,
    "row-alert": (props: any) => <AlertRowView {...props} client={client} />,
  };
}
