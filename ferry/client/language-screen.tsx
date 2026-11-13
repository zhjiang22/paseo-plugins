import { Text, View } from "react-native";
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { t } from "../shared/text";
import { LanguageSettings } from "./language-settings";

/** The Language settings screen: kit's section, introduced like the other public plugins do it. */
export function LanguageScreen({ theme }: PluginSurfaceProps) {
  return (
    <View style={{ gap: 20 }}>
      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>{t("boot.name")}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{t("settings.languageDescription")}</Text>
      </View>
      <LanguageSettings />
    </View>
  );
}
