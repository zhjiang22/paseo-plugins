import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import { deliveryRpc } from "../shared/rpc";
import { t } from "../shared/text";
import { Button, Muted } from "./ui";

/** Exactly what a handoff sent to an agent, for the curious and for checking nothing private went along. */
export function SentScreen({ theme, layout, params, client }: PluginScreenProps & { client: PluginClientContext }) {
  const [state, setState] = useState<{ text: string | null; truncated: boolean; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    if (!params.chainId || !params.deliveryId) {
      setState({ text: null, truncated: false });
      return;
    }
    client.rpc(deliveryRpc, { chainId: params.chainId, deliveryId: params.deliveryId }).then(
      (result) => {
        if (live) setState(result);
      },
      (error: unknown) => {
        if (live) setState({ text: null, truncated: false, error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [params.chainId, params.deliveryId]);
  const colors = theme.colors;
  const padding = layout.compact ? 16 : 24;
  return (
    <ScrollView testID="ferry-sent" style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding, gap: 12 }}>
      {!state ? <Muted theme={theme}>{t("sent.loading")}</Muted> : null}
      {state && !state.text ? <Muted theme={theme}>{state.error ? t("sent.failed", { error: state.error }) : t("sent.gone")}</Muted> : null}
      {state?.text ? (
        <View style={{ gap: 8 }}>
          <Muted theme={theme}>{t("sent.intro")}</Muted>
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <Button theme={theme} kind="link" label={t("picker.copy")} onPress={() => void copyText(state.text!)} />
            {state.truncated ? <Muted theme={theme}>{t("picker.previewTruncated")}</Muted> : null}
          </View>
          <Text selectable testID="ferry-sent-text" style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17 }}>
            {state.text}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  );
}
