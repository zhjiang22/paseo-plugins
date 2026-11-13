import { useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginClientContext, PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { alertRow, handoffRow, movedRow, type HandoffRow } from "../shared/kinds";
import { retryRpc } from "../shared/rpc";
import { t } from "../shared/text";
import { Badge, Button, type Tone } from "./ui";
import { noteText, tokens } from "./words";

// Ferry's timeline rows. Each checks its data (the resident client registered them with a lenient schema) and shows
// nothing for data it does not understand. Links go through the Ferry screen, which can open agents.

type RowProps = PluginTimelineItemProps<unknown> & { client: PluginClientContext };

function open(client: PluginClientContext, params: Record<string, string>) {
  client.openScreen({ screenId: "ferry", params });
}

function Row(props: { theme: RowProps["theme"]; icon: string; children: ReactNode; testID?: string }) {
  const colors = props.theme.colors;
  return (
    <View testID={props.testID} style={{ borderLeftWidth: 2, borderLeftColor: colors.accent, paddingLeft: 10, paddingVertical: 4, gap: 4, marginVertical: 4 }}>
      <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
        <Text style={{ color: colors.accent, fontSize: 13 }}>{props.icon}</Text>
        <View style={{ flex: 1, gap: 4 }}>{props.children}</View>
      </View>
    </View>
  );
}

function Line(props: { theme: RowProps["theme"]; children: ReactNode; muted?: boolean }) {
  return <Text style={{ color: props.muted ? props.theme.colors.foregroundMuted : props.theme.colors.foreground, fontSize: 13, lineHeight: 18 }}>{props.children}</Text>;
}

function Links(props: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>{props.children}</View>;
}

function statusBadge(status: HandoffRow["status"]): { text: string; tone: Tone } | null {
  switch (status) {
    case "pending":
      return { text: t("rows.statusPending"), tone: "muted" };
    case "accepted":
      return { text: t("rows.statusAccepted"), tone: "accent" };
    case "read":
      return { text: t("rows.statusRead"), tone: "success" };
    case "failed":
      return { text: t("rows.statusFailed"), tone: "danger" };
    case "canceled":
      return { text: t("rows.statusCanceled"), tone: "warning" };
    default:
      return null;
  }
}

export function HandoffRowView(props: RowProps) {
  const parsed = handoffRow.safeParse(props.item.data);
  const [retrying, setRetrying] = useState(false);
  const [retryNote, setRetryNote] = useState<string | null>(null);
  if (!parsed.success) return null;
  const row = parsed.data;
  const { theme, client } = props;
  const badge = statusBadge(row.status);
  const headline =
    row.route === "native"
      ? t("rows.native", { from: row.from.label, to: row.to.label })
      : row.route === "handoff"
        ? t("rows.handoff", { from: row.from.label, to: row.to.label })
        : t("rows.back", { from: row.from.label, count: row.total });
  const retry = async () => {
    if (!row.deliveryId) return;
    setRetrying(true);
    setRetryNote(null);
    try {
      const output = await client.rpc(retryRpc, { chainId: row.chainId, deliveryId: row.deliveryId });
      setRetryNote(output.status === "done" ? t("rows.retried") : output.status === "refused" ? noteText(output.reason) : null);
    } catch (error) {
      setRetryNote(error instanceof Error ? error.message : String(error));
    } finally {
      setRetrying(false);
    }
  };
  return (
    <Row theme={theme} icon={row.route === "handoff" ? "⇄" : row.route === "native" ? "⇋" : "↩"} testID="ferry-row-handoff">
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Line theme={theme}>{headline}</Line>
        {badge ? <Badge theme={theme} tone={badge.tone} text={badge.text} /> : null}
      </View>
      {row.mode ? (
        <Line theme={theme} muted>
          {t("rows.sent", { selected: row.selected, total: row.total, tokens: tokens(row.bytes) })}
        </Line>
      ) : null}
      {row.status === "failed" && row.error ? (
        <Line theme={theme} muted>
          {t("rows.failedBecause", { error: row.error })}
        </Line>
      ) : null}
      {retryNote ? (
        <Line theme={theme} muted>
          {retryNote}
        </Line>
      ) : null}
      <Links>
        {row.status === "failed" && row.deliveryId ? <Button theme={theme} kind="link" label={t("rows.retry")} busy={retrying} onPress={() => void retry()} testID="ferry-row-retry" /> : null}
        {row.status === "failed" ? <Button theme={theme} kind="link" label={t("rows.pickAnother")} onPress={() => open(client, { agentId: props.agentId })} /> : null}
        <Button theme={theme} kind="link" label={t("rows.switchBack", { label: row.from.label })} onPress={() => open(client, { agentId: props.agentId, target: row.from.provider, auto: "1" })} testID="ferry-row-switch-back" />
        {row.deliveryId ? <Button theme={theme} kind="link" label={t("rows.showSent")} onPress={() => client.openScreen({ screenId: "sent", params: { chainId: row.chainId, deliveryId: row.deliveryId! } })} testID="ferry-row-show-sent" /> : null}
      </Links>
    </Row>
  );
}

export function MovedRowView(props: RowProps) {
  const parsed = movedRow.safeParse(props.item.data);
  if (!parsed.success) return null;
  const row = parsed.data;
  const { theme, client } = props;
  return (
    <Row theme={theme} icon="→" testID="ferry-row-moved">
      <Line theme={theme}>{t("rows.moved", { to: row.to.label })}</Line>
      <Links>{row.to.agentId ? <Button theme={theme} kind="link" label={t("rows.openThere")} onPress={() => open(client, { open: row.to.agentId! })} /> : null}</Links>
    </Row>
  );
}

function clock(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  const today = new Date();
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === today.toDateString() ? time : `${at.getMonth() + 1}/${at.getDate()} ${time}`;
}

export function AlertRowView(props: RowProps) {
  const parsed = alertRow.safeParse(props.item.data);
  if (!parsed.success) return null;
  const row = parsed.data;
  const { theme, client } = props;
  const text =
    row.kind === "context"
      ? t("rows.contextFull")
      : row.kind === "connection"
        ? t("rows.replyConnection")
        : row.kind === "error"
          ? t("rows.replyError")
          : row.resetAt
            ? t(row.resetGuessed ? "rows.limitResetGuessed" : "rows.limitReset", { time: clock(row.resetAt) })
            : t("rows.limit");
  const partner = row.partner ? row.partner.split("/")[0]! : null;
  return (
    <Row theme={theme} icon="⚠" testID="ferry-row-alert">
      <Line theme={theme}>{text}</Line>
      <Links>
        {row.partner ? <Button theme={theme} kind="link" label={t("rows.continueOn", { label: partner! })} onPress={() => open(client, { agentId: props.agentId, target: row.partner!, auto: "1" })} testID="ferry-row-alert-partner" /> : null}
        <Button theme={theme} kind="link" label={t("rows.pickAnother")} onPress={() => open(client, { agentId: props.agentId })} />
      </Links>
    </Row>
  );
}
