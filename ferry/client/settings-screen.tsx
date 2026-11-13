import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { PluginClientContext, PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { STORE_ENV, type Family } from "../shared/families";
import { forgetRpc, providersRpc, type ProviderSummary } from "../shared/rpc";
import { ferrySettings, type FerrySettings } from "../shared/settings";
import { t } from "../shared/text";
import { Button, Muted } from "./ui";

const BUDGETS = [4000, 8000, 16_000, 32_000, 64_000];
const OUTPUTS = [2000, 6000, 12_000, 16_000];
const RETENTION = [7, 30, 90, 365];
/** Text fields save once typing pauses: a save per keystroke would race the one before it (each needs the revision). */
const TYPING_PAUSE_MS = 700;

/** Ferry's settings, kept on the host: every device sees the same. */
export function SettingsScreen({ theme, client }: PluginSurfaceProps & { client: PluginClientContext }) {
  const settings = useSettings(ferrySettings);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [both, setBoth] = useState(true);
  const [forgot, setForgot] = useState<string | null>(null);
  const [confirmForget, setConfirmForget] = useState(false);
  const typed = useRef<{ patch: Partial<FerrySettings>; timer: ReturnType<typeof setTimeout> | null }>({ patch: {}, timer: null });
  const latest = useRef<{ values: FerrySettings; revision: string; save: typeof settings.save } | null>(null);
  const takeTyped = (): Partial<FerrySettings> => {
    const { patch, timer } = typed.current;
    if (timer) clearTimeout(timer);
    typed.current = { patch: {}, timer: null };
    return patch;
  };
  const flushTyped = () => {
    const patch = takeTyped();
    if (Object.keys(patch).length && latest.current) void latest.current.save({ ...latest.current.values, ...patch }, latest.current.revision);
  };
  // Leaving the screen saves what was typed last.
  useEffect(() => () => flushTyped(), []);

  useEffect(() => {
    let live = true;
    client.rpc(providersRpc, {}).then(
      (info) => {
        if (live) setProviders(info.providers);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  if (settings.status === "loading") return <Muted theme={theme}>{t("settings.loading")}</Muted>;
  if (settings.status === "error" || settings.status === "invalid") return <Muted theme={theme}>{t("settings.loadFailed", { error: settings.error })}</Muted>;
  const values = settings.values;
  const revision = settings.revision;
  latest.current = { values, revision, save: settings.save };
  const save = (patch: Partial<FerrySettings>) => void settings.save({ ...values, ...takeTyped(), ...patch }, revision);
  const saveTyped = (patch: Partial<FerrySettings>) => {
    const { timer } = typed.current;
    if (timer) clearTimeout(timer);
    typed.current = { patch: { ...typed.current.patch, ...patch }, timer: setTimeout(flushTyped, TYPING_PAUSE_MS) };
  };
  const labelOf = (id: string) => providers.find((provider) => provider.id === id)?.label ?? id;
  const providerOptions = providers.map((provider) => ({ value: provider.id, label: `${provider.label} (${provider.id})` }));
  const shareable = providers.filter((provider) => STORE_ENV[provider.family as Family] !== undefined);

  const addPartner = () => {
    if (!from || !to || from === to.split("/")[0]) return;
    const next = values.partners.filter((entry) => !(entry.from === from && entry.to === to));
    next.push({ from, to });
    if (both && !values.partners.some((entry) => entry.from === to.split("/")[0])) next.push({ from: to.split("/")[0]!, to: from });
    save({ partners: next });
  };
  const forget = async () => {
    setConfirmForget(false);
    try {
      const result = await client.rpc(forgetRpc, { chainId: "all" });
      setForgot(t("settings.forgotten", { count: result.removed }));
    } catch (error) {
      setForgot(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <View style={{ gap: 20 }} testID="ferry-settings">
      <View style={{ gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "600" }}>{t("boot.name")}</Text>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{t("settings.intro")}</Text>
      </View>

      <SettingsSection title={t("settings.partnersTitle")} info={<Muted theme={theme}>{t("settings.partnersInfo")}</Muted>}>
        <SettingsCard>
          {values.partners.length === 0 ? <SettingsRow label={t("settings.partnersNone")} /> : null}
          {values.partners.map((entry, index) => (
            <SettingsAction
              key={`${entry.from}>${entry.to}`}
              label={t("settings.partnerLine", { from: labelOf(entry.from), to: entry.to.includes("/") ? `${labelOf(entry.to.split("/")[0]!)} · ${entry.to.slice(entry.to.indexOf("/") + 1)}` : labelOf(entry.to) })}
              actionLabel={t("settings.remove")}
              onPress={() => save({ partners: values.partners.filter((_, position) => position !== index) })}
              testID={`ferry-partner-${index}`}
            />
          ))}
          <SettingsSelect label={t("settings.partnerFrom")} value={from} options={[{ value: "", label: "—" }, ...providerOptions]} onValueChange={setFrom} testID="ferry-partner-from" />
          <SettingsSelect label={t("settings.partnerTo")} value={to} options={[{ value: "", label: "—" }, ...providerOptions]} onValueChange={setTo} testID="ferry-partner-to" />
          <SettingsSwitch label={t("settings.partnerBoth")} value={both} onValueChange={setBoth} />
          <SettingsAction label={t("settings.partnerAdd")} actionLabel={t("settings.add")} onPress={addPartner} disabled={!from || !to || from === to} testID="ferry-partner-add" />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.handoffTitle")}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.budget")}
            hint={t("settings.budgetHint")}
            value={String(values.budgetTokens)}
            options={[...new Set([...BUDGETS, values.budgetTokens])].sort((a, b) => a - b).map((value) => ({ value: String(value), label: t("settings.tokens", { count: Math.round(value / 1000) }) }))}
            onValueChange={(value) => save({ budgetTokens: Number(value) })}
            testID="ferry-budget"
          />
          <SettingsSwitch label={t("settings.toolOutput")} hint={t("settings.toolOutputHint")} value={values.includeToolOutput} onValueChange={(value) => save({ includeToolOutput: value })} />
          <SettingsSelect
            label={t("settings.toolOutputBytes")}
            value={String(values.toolOutputBytes)}
            options={[...new Set([...OUTPUTS, values.toolOutputBytes])].sort((a, b) => a - b).map((value) => ({ value: String(value), label: `${Math.round(value / 100) / 10} KB` }))}
            onValueChange={(value) => save({ toolOutputBytes: Number(value) })}
            disabled={!values.includeToolOutput}
          />
          <SettingsInput label={t("settings.defaultMessage")} hint={t("settings.defaultMessageHint")} initialValue={values.defaultMessage} placeholder={t("message.default")} onChangeText={(text) => saveTyped({ defaultMessage: text.slice(0, 2000) })} />
          <SettingsSelect
            label={t("settings.afterHandoff")}
            hint={t("settings.afterHandoffHint")}
            value={values.afterHandoff}
            options={[
              { value: "archive", label: t("settings.afterArchive") },
              { value: "keep", label: t("settings.afterKeep") },
            ]}
            onValueChange={(value) => save({ afterHandoff: value })}
          />
          <SettingsSwitch label={t("settings.historyTool")} hint={t("settings.historyToolHint")} value={values.historyTool} onValueChange={(value) => save({ historyTool: value })} />
          <SettingsSwitch label={t("settings.transcriptFile")} hint={t("settings.transcriptFileHint")} value={values.transcriptFile} onValueChange={(value) => save({ transcriptFile: value })} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.nativeTitle")} info={<Muted theme={theme}>{t("settings.nativeInfo")}</Muted>}>
        <SettingsCard>
          <SettingsSwitch label={t("settings.native")} value={values.native} onValueChange={(value) => save({ native: value })} testID="ferry-native" />
          {shareable.map((provider) => (
            <SettingsSelect
              key={provider.id}
              label={provider.label}
              hint={provider.storePath ? t("settings.storeDetected", { store: provider.storePath }) : undefined}
              value={values.stores[provider.id] === "isolated" ? "isolated" : "auto"}
              options={[
                { value: "auto", label: t("settings.storeAuto") },
                { value: "isolated", label: t("settings.storeIsolated") },
              ]}
              onValueChange={(value) => save({ stores: { ...values.stores, [provider.id]: value } })}
              disabled={!values.native}
            />
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.watchTitle")}>
        <SettingsCard>
          <SettingsSwitch label={t("settings.composerButton")} hint={t("settings.composerButtonHint")} value={values.composerButton} onValueChange={(value) => save({ composerButton: value })} testID="ferry-composer-button" />
          <SettingsSwitch label={t("settings.failurePill")} hint={t("settings.failurePillHint")} value={values.failurePill} onValueChange={(value) => save({ failurePill: value })} />
          <SettingsSwitch label={t("settings.alertRows")} hint={t("settings.alertRowsHint")} value={values.alertRows} onValueChange={(value) => save({ alertRows: value })} />
          <SettingsInput label={t("settings.slashAlias")} hint={t("settings.slashAliasHint")} initialValue={values.slashAlias} placeholder="switch" onChangeText={(text) => {
            const alias = text.trim().toLowerCase();
            if (/^(?:|[a-z][a-z0-9-]{0,30})$/.test(alias)) saveTyped({ slashAlias: alias });
          }} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.deliveryTitle")} info={<Muted theme={theme}>{t("settings.deliveryInfo")}</Muted>}>
        <SettingsCard>
          {providers
            .filter((provider) => provider.enabled)
            .map((provider) => (
              <SettingsSelect
                key={provider.id}
                label={provider.label}
                value={values.delivery[provider.id] ?? "auto"}
                options={[
                  { value: "auto", label: t("settings.deliveryAuto") },
                  { value: "attachment", label: t("settings.deliveryAttachment") },
                  { value: "inline", label: t("settings.deliveryInline") },
                ]}
                onValueChange={(value) => {
                  const next = { ...values.delivery };
                  if (value === "auto") delete next[provider.id];
                  else next[provider.id] = value as "attachment" | "inline";
                  save({ delivery: next });
                }}
              />
            ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title={t("settings.dataTitle")} info={<Muted theme={theme}>{t("settings.dataInfo")}</Muted>}>
        <SettingsCard>
          <SettingsSelect
            label={t("settings.retention")}
            value={String(values.retentionDays)}
            options={[...new Set([...RETENTION, values.retentionDays])].sort((a, b) => a - b).map((value) => ({ value: String(value), label: t("settings.days", { count: value }) }))}
            onValueChange={(value) => save({ retentionDays: Number(value) })}
          />
          <SettingsAction label={t("settings.forgetAll")} hint={forgot ?? t("settings.forgetAllHint")} actionLabel={confirmForget ? t("settings.forgetConfirm") : t("settings.forget")} onPress={() => (confirmForget ? void forget() : setConfirmForget(true))} testID="ferry-forget" />
        </SettingsCard>
      </SettingsSection>
      {settings.saveError ? <Muted theme={theme}>{t("settings.saveFailed", { error: settings.saveError })}</Muted> : null}
      <Button theme={theme} kind="link" label={t("settings.reload")} onPress={() => void settings.reload()} />
    </View>
  );
}
