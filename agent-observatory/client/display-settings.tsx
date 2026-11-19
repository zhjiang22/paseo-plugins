import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsSection, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { DISPLAY_DEFAULTS, displaySettings, type DisplaySettings } from "../shared/display-settings";
import { t } from "../shared/text";

/**
 * Display switches of the observatory, in the board's 观测设置 and the plugin's settings screen: saved as the host setting
 * `display`, so every device shows the same thing. The running bar is the only one today.
 */
export function DisplaySettingsSection() {
  const settings = useSettings(displaySettings);
  const values: DisplaySettings = settings.status === "ready" ? settings.values : DISPLAY_DEFAULTS;
  const ready = settings.status === "ready" && !settings.saving;
  const save = (patch: Partial<DisplaySettings>) => { if (settings.status === "ready") void settings.save({ ...settings.values, ...patch }, settings.revision); };
  return <SettingsSection title={t("displaySettings.title")}>
    <SettingsCard>
      <SettingsSwitch label={t("displaySettings.runningBar")} hint={t("displaySettings.runningBarHint")} value={values.runningBar} disabled={!ready}
        error={settings.saveError ?? (settings.status === "error" || settings.status === "invalid" ? settings.error : null)}
        onValueChange={runningBar => save({ runningBar })} />
    </SettingsCard>
  </SettingsSection>;
}
