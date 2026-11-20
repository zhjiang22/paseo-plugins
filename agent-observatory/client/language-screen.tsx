import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { LanguageSettings } from "./language-settings";
import { AlertSettingsSections } from "./alert-settings";
import { DisplaySettingsSection } from "./display-settings";
import { t } from "../shared/text";

export function LanguageScreen({ theme }: PluginSurfaceProps) {
  return <View style={{ gap: 16 }}>
    <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "600" }}>{t("boot.screenTitle")}</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>{t("language.description")}</Text>
    <LanguageSettings />
    <DisplaySettingsSection />
    <AlertSettingsSections theme={theme} />
  </View>;
}
