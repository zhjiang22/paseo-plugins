import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { PluginClientContext, PluginScreenProps } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/ui";
import { findProvider, parseCommand, type ProviderInfo } from "../shared/families";
import type { RouteKind } from "../shared/kinds";
import { planRpc, providersRpc, startRpc, waitRpc, type MoveResult, type NoteData, type PlanResult, type ProvidersInfo, type ProviderSummary, type RouteChoice, type StartOutput } from "../shared/rpc";
import { t } from "../shared/text";
import type { Drafts } from "./drafts";
import { Badge, Body, Button, Card, Heading, Muted, Notes, type Tone } from "./ui";
import { familyName, kilobytes, noteText, tokens } from "./words";

export interface FerryScreenProps extends PluginScreenProps {
  client: PluginClientContext;
  drafts: Drafts;
}

type Phase =
  | { kind: "pick" }
  | { kind: "stop"; reason: NoteData }
  | { kind: "working"; step: string }
  | { kind: "done"; result: MoveResult }
  | { kind: "refused"; reason: NoteData };

const ROUTE_ORDER: Record<string, number> = { native: 0, "switch-back": 1, "native-switch-back": 1, handoff: 2, unavailable: 3, same: 4 };
const MAX_MODELS_SHOWN = 30;

const newRequestId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function routeTone(kind: RouteChoice["kind"]): Tone {
  return kind === "native" ? "success" : kind === "switch-back" || kind === "native-switch-back" ? "accent" : kind === "handoff" ? "muted" : "danger";
}

function routeBadge(kind: RouteChoice["kind"]): string {
  switch (kind) {
    case "native":
      return t("picker.badgeNative");
    case "switch-back":
    case "native-switch-back":
      return t("picker.badgeBack");
    case "handoff":
      return t("picker.badgeHandoff");
    case "same":
      return t("picker.badgeCurrent");
    default:
      return t("picker.badgeUnavailable");
  }
}

function routeExplanation(kind: RouteKind, label: string, plan: Extract<PlanResult, { status: "ok" }> | null): string {
  const selection = plan?.selection;
  switch (kind) {
    case "native":
      return t("picker.explainNative", { label });
    case "switch-back":
      return t("picker.explainBack", { label, count: selection?.total ?? 0 });
    case "native-switch-back":
      return t("picker.explainNativeBack", { label, count: selection?.total ?? 0 });
    default:
      return t("picker.explainHandoff", { label });
  }
}

function failureText(failure: "limit" | "connection" | "context" | "error"): string {
  switch (failure) {
    case "limit":
      return t("picker.failureLimit");
    case "connection":
      return t("picker.failureConnection");
    case "context":
      return t("picker.failureContext");
    default:
      return t("picker.failureError");
  }
}

function doneText(result: MoveResult): string {
  const params = { from: result.from.label, to: result.to.label, selected: result.selected, total: result.total, count: result.total };
  switch (result.route) {
    case "native":
      return t(result.restored ? "result.doneNativeRestored" : "result.doneNative", params);
    case "switch-back":
      return t("result.doneBack", params);
    case "native-switch-back":
      return t("result.doneNativeBack", params);
    default:
      return t("result.doneHandoff", params);
  }
}

function phaseText(step: string): string {
  switch (step) {
    case "stopping":
      return t("progress.stopping");
    case "creating":
      return t("progress.creating");
    case "importing":
      return t("progress.importing");
    case "sending":
      return t("progress.sending");
    case "archiving":
      return t("progress.archiving");
    default:
      return t("progress.planning");
  }
}

/** The picker, its progress and its result: one screen, opened from `/ferry`, the Command Center or a button. */
export function FerryScreen({ theme, layout, params, navigation, client, drafts }: FerryScreenProps) {
  const colors = theme.colors;
  const agentId = params.agentId ?? "";
  const [info, setInfo] = useState<ProvidersInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [fresh, setFresh] = useState(false);
  const [plan, setPlan] = useState<PlanResult | null>(null);
  /** What the plan above was made for: a plan for an earlier choice never starts a move or shows its preview. */
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [planning, setPlanning] = useState(false);
  const [preview, setPreview] = useState<{ text: string; truncated: boolean } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [modelFilter, setModelFilter] = useState("");
  const [modelsOpen, setModelsOpen] = useState(false);
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "pick" });
  const [auto, setAuto] = useState(false);
  const live = useRef(true);
  useEffect(() => () => void (live.current = false), []);
  // A row's link to another agent comes through here: rows cannot navigate, screens can.
  useEffect(() => {
    if (params.open && navigation) navigation.openAgent({ agentId: params.open });
  }, [params.open]);

  useEffect(() => {
    let current = true;
    setInfo(null);
    setLoadError(null);
    client.rpc(providersRpc, { agentId }).then(
      (data) => {
        if (!current) return;
        setInfo(data);
        // What to start with: the draft from `/ferry`, a target from a button, else the partner.
        const draft = params.draft ? drafts.take(params.draft) : null;
        const providers = data.providers as unknown as ProviderInfo[];
        const routeOf = (provider: string) => data.routes.find((route) => route.provider === provider);
        const usable = (provider: string) => {
          const kind = routeOf(provider)?.kind;
          return kind !== undefined && kind !== "unavailable" && kind !== "same";
        };
        if (draft) {
          const parsed = parseCommand(draft.args, providers);
          setMessage(parsed.message);
          const chosen = parsed.match ?? (data.partner ? findProvider(providers, data.partner) : null);
          if (chosen) {
            setSelected(chosen.provider.id);
            setModel(chosen.model?.id ?? null);
            const exact = parsed.match ? parsed.match.exact : !parsed.message && !!data.partner;
            if (draft.auto && exact && usable(chosen.provider.id)) setAuto(true);
          }
        } else if (params.target) {
          const chosen = findProvider(providers, params.target);
          if (chosen) {
            setSelected(chosen.provider.id);
            setModel(chosen.model?.id ?? null);
            if (params.auto === "1" && usable(chosen.provider.id)) setAuto(true);
          }
        } else if (data.partner) {
          const chosen = findProvider(providers, data.partner);
          if (chosen) {
            setSelected(chosen.provider.id);
            setModel(chosen.model?.id ?? null);
          }
        }
      },
      (error: unknown) => {
        if (current) setLoadError(errorText(error));
      },
    );
    return () => {
      current = false;
    };
  }, [agentId, params.draft, params.target]);

  const target = selected ? (info?.providers.find((provider) => provider.id === selected) ?? null) : null;
  const route = selected ? (info?.routes.find((entry) => entry.provider === selected) ?? null) : null;
  const targetText = selected ? (model ? `${selected}/${model}` : selected) : null;
  const planKey = targetText ? `${targetText}${fresh ? " fresh" : ""}` : null;
  const currentKey = useRef(planKey);
  currentKey.current = planKey;

  // The plan for the current choice: route, model, mode, what would be sent. Nothing changes until "Continue".
  useEffect(() => {
    if (!targetText || !agentId) {
      setPlan(null);
      setPlanFor(null);
      return;
    }
    let current = true;
    const key = planKey;
    setPlanning(true);
    setPreview(null);
    client.rpc(planRpc, { agentId, target: targetText, fresh }).then(
      (result) => {
        if (!current) return;
        setPlan(result);
        setPlanFor(key);
        setPlanning(false);
        if (result.status === "ok" && !model && result.target.model) setModel(result.target.model);
      },
      (error: unknown) => {
        if (!current) return;
        setPlan({ status: "refused", reason: { code: "errors.unexpected", params: { error: errorText(error) } } });
        setPlanFor(key);
        setPlanning(false);
      },
    );
    return () => {
      current = false;
    };
  }, [targetText, fresh, agentId]);

  const run = async (stopRunning = false) => {
    if (!targetText) return;
    setPhase({ kind: "working", step: "planning" });
    try {
      let output: StartOutput = await client.rpc(startRpc, { requestId: newRequestId(), agentId, target: targetText, ...(message.trim() ? { message: message.trim() } : {}), stopRunning, fresh });
      while (output.status === "pending") {
        if (!live.current) return;
        setPhase({ kind: "working", step: output.phase });
        output = await client.rpc(waitRpc, { opId: output.opId });
      }
      if (!live.current) return;
      if (output.status === "done") {
        setPhase({ kind: "done", result: output.result });
        if (!output.result.warnings.length && navigation) navigation.openAgent({ agentId: output.result.agentId });
      } else if (output.status === "running") setPhase({ kind: "stop", reason: output.reason });
      else setPhase({ kind: "refused", reason: output.reason });
    } catch (error) {
      if (live.current) setPhase({ kind: "refused", reason: { code: "errors.unexpected", params: { error: errorText(error) } } });
    }
  };

  // Started from a button or an exact `/ferry provider`: go once the plan for that choice is there and fine. A plan
  // that refuses or warns (a more permissive mode, a running turn) stays on screen for the user to read and decide.
  useEffect(() => {
    if (!auto || phase.kind !== "pick" || !plan || planning || planFor !== planKey) return;
    setAuto(false);
    if (plan.status === "ok" && !plan.warnings.length) void run();
  }, [auto, plan, planFor, planKey, planning, phase.kind]);

  const showPreview = async () => {
    if (!targetText) return;
    if (preview) {
      setPreview(null);
      return;
    }
    setPreviewing(true);
    const key = planKey;
    try {
      const result = await client.rpc(planRpc, { agentId, target: targetText, fresh, preview: true, ...(message.trim() ? { message: message.trim() } : {}) });
      if (!live.current || currentKey.current !== key) return;
      if (result.status === "ok") setPreview({ text: result.preview ?? t("picker.previewNothing"), truncated: result.previewTruncated });
      else setPreview({ text: noteText(result.reason), truncated: false });
    } catch (error) {
      if (live.current && currentKey.current === key) setPreview({ text: errorText(error), truncated: false });
    } finally {
      setPreviewing(false);
    }
  };

  const groups = useMemo(() => {
    if (!info) return [];
    const byProvider = new Map(info.providers.map((provider) => [provider.id, provider]));
    const entries = info.routes
      .filter((entry) => byProvider.has(entry.provider))
      .map((entry) => ({ route: entry, provider: byProvider.get(entry.provider)! }))
      .sort((a, b) => (ROUTE_ORDER[a.route.kind] ?? 9) - (ROUTE_ORDER[b.route.kind] ?? 9));
    const result: { title: string; key: string; entries: typeof entries; collapsed?: boolean }[] = [];
    const native = entries.filter((entry) => entry.route.kind === "native");
    if (native.length) result.push({ title: t("picker.groupNative"), key: "native", entries: native });
    const back = entries.filter((entry) => entry.route.kind === "switch-back" || entry.route.kind === "native-switch-back");
    if (back.length) result.push({ title: t("picker.groupBack"), key: "back", entries: back });
    const handoff = entries.filter((entry) => entry.route.kind === "handoff");
    const families = [...new Set(handoff.map((entry) => familyName(entry.provider.family)))];
    for (const family of families) result.push({ title: t("picker.groupNew", { family }), key: `new-${family}`, entries: handoff.filter((entry) => familyName(entry.provider.family) === family) });
    const unavailable = entries.filter((entry) => entry.route.kind === "unavailable");
    if (unavailable.length) result.push({ title: t("picker.groupUnavailable", { count: unavailable.length }), key: "unavailable", entries: unavailable, collapsed: true });
    return result;
  }, [info]);

  const page = { flex: 1, backgroundColor: colors.surface0 };
  const padding = layout.compact ? 16 : 24;

  if (params.open) {
    return (
      <View style={[page, { padding }]}>
        <Muted theme={theme}>{navigation ? t("picker.opening") : t("picker.cannotOpen")}</Muted>
      </View>
    );
  }
  if (!agentId) {
    return (
      <View style={[page, { padding }]}>
        <Body theme={theme}>{t("picker.noAgent")}</Body>
      </View>
    );
  }
  if (loadError) {
    return (
      <View style={[page, { padding, gap: 12 }]}>
        <Card theme={theme} tone="danger">
          <Body theme={theme}>{t("picker.loadFailed", { error: loadError })}</Body>
        </Card>
      </View>
    );
  }
  if (!info) {
    return (
      <View style={[page, { padding }]}>
        <Muted theme={theme}>{t("picker.loading")}</Muted>
      </View>
    );
  }

  const agent = info.agent;
  const header = (
    <View style={{ gap: 6 }}>
      <Heading theme={theme} size="large" text={agent?.title?.trim() || t("picker.untitled")} />
      {agent ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
          <Muted theme={theme}>{t("picker.currentOn", { label: info.providers.find((provider) => provider.id === agent.provider)?.label ?? agent.provider })}</Muted>
          {agent.failure ? <Badge theme={theme} tone="danger" text={failureText(agent.failure)} testID="ferry-failure" /> : null}
          {agent.visits > 1 ? <Badge theme={theme} text={t("picker.chainLength", { count: agent.visits })} /> : null}
        </View>
      ) : null}
      {agent?.blocked ? (
        <Card theme={theme} tone="warning">
          <Body theme={theme}>{noteText(agent.blocked)}</Body>
        </Card>
      ) : null}
    </View>
  );

  if (phase.kind === "working") {
    return (
      <View testID="ferry-progress" style={[page, { padding, gap: 16 }]}>
        {header}
        <Card theme={theme}>
          <Button theme={theme} label={phaseText(phase.step)} busy onPress={() => undefined} />
        </Card>
      </View>
    );
  }
  if (phase.kind === "stop") {
    return (
      <View testID="ferry-stop" style={[page, { padding, gap: 16 }]}>
        {header}
        <Card theme={theme} tone="warning">
          <Body theme={theme}>{noteText(phase.reason)}</Body>
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
            <Button theme={theme} kind="primary" label={t("picker.stopAndContinue")} onPress={() => void run(true)} testID="ferry-stop-confirm" />
            <Button theme={theme} label={t("picker.back")} onPress={() => setPhase({ kind: "pick" })} testID="ferry-back" />
          </View>
        </Card>
      </View>
    );
  }
  if (phase.kind === "done") {
    const result = phase.result;
    return (
      <ScrollView testID="ferry-result" style={page} contentContainerStyle={{ padding, gap: 16 }}>
        {header}
        <Card theme={theme} tone={result.warnings.length ? "warning" : "success"}>
          <Body theme={theme}>{doneText(result)}</Body>
          <Notes theme={theme} lines={result.notes.map(noteText)} />
          <Notes theme={theme} tone="warning" lines={result.warnings.map(noteText)} testID="ferry-warnings" />
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
            {navigation ? <Button theme={theme} kind="primary" label={t("result.open", { label: result.to.label })} onPress={() => navigation.openAgent({ agentId: result.agentId })} testID="ferry-open" /> : null}
            <Button theme={theme} label={t("picker.back")} onPress={() => setPhase({ kind: "pick" })} />
          </View>
        </Card>
      </ScrollView>
    );
  }

  const okPlan = plan?.status === "ok" ? plan : null;
  const refused = plan?.status === "refused" ? plan : null;
  const kind = okPlan?.route ?? (route && route.kind !== "unavailable" && route.kind !== "same" ? route.kind : null);
  const canStart = !!okPlan && !planning && !agent?.blocked;
  const filteredModels = (target?.models ?? []).filter((entry) => !modelFilter || `${entry.id} ${entry.label}`.toLowerCase().includes(modelFilter.toLowerCase()));

  const detail = target ? (
    <View testID="ferry-detail" style={{ gap: 12, flex: layout.compact ? undefined : 1.2 }}>
      <Heading theme={theme} text={t("picker.continueOn", { label: target.label })} />
      {kind ? <Body theme={theme}>{routeExplanation(kind, target.label, okPlan)}</Body> : null}
      {refused ? (
        <Card theme={theme} tone="danger">
          <Body theme={theme}>{noteText(refused.reason)}</Body>
        </Card>
      ) : null}
      {okPlan?.selection ? (
        <Muted theme={theme} testID="ferry-selection">
          {t("picker.selection", { selected: okPlan.selection.selected, total: okPlan.selection.total, size: kilobytes(okPlan.selection.bytes), tokens: tokens(okPlan.selection.bytes) })}
        </Muted>
      ) : null}
      {okPlan ? <Notes theme={theme} lines={okPlan.notes.map(noteText)} testID="ferry-notes" /> : null}
      {okPlan ? <Notes theme={theme} tone="warning" lines={okPlan.warnings.map(noteText)} /> : null}

      <View style={{ gap: 6 }}>
        <Muted theme={theme}>{t("picker.model")}</Muted>
        <Pressable accessibilityRole="button" testID="ferry-model" onPress={() => setModelsOpen(!modelsOpen)} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, backgroundColor: colors.surface1 }}>
          <Text style={{ color: colors.foreground }}>{model ?? okPlan?.target.model ?? t("picker.modelDefault")}</Text>
        </Pressable>
        {modelsOpen ? (
          <View style={{ gap: 4 }}>
            {target.models.length > 8 ? (
              <TextInput
                value={modelFilter}
                onChangeText={setModelFilter}
                placeholder={t("picker.modelFilter")}
                placeholderTextColor={colors.foregroundMuted}
                style={{ color: colors.foreground, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 8 }}
                testID="ferry-model-filter"
              />
            ) : null}
            {filteredModels.slice(0, MAX_MODELS_SHOWN).map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                testID={`ferry-model-${entry.id}`}
                onPress={() => {
                  setModel(entry.id);
                  setModelsOpen(false);
                }}
                style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 6, backgroundColor: entry.id === (model ?? okPlan?.target.model) ? colors.surface2 : "transparent" }}
              >
                <Text style={{ color: colors.foreground }}>
                  {entry.label}
                  {entry.label !== entry.id ? <Text style={{ color: colors.foregroundMuted }}> · {entry.id}</Text> : null}
                  {entry.isDefault ? <Text style={{ color: colors.foregroundMuted }}> · {t("picker.modelIsDefault")}</Text> : null}
                </Text>
              </Pressable>
            ))}
            {filteredModels.length > MAX_MODELS_SHOWN ? <Muted theme={theme}>{t("picker.modelsMore", { count: filteredModels.length - MAX_MODELS_SHOWN })}</Muted> : null}
          </View>
        ) : null}
      </View>

      {route && route.kind !== "handoff" && route.kind !== "unavailable" && route.kind !== "same" ? (
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: fresh }} testID="ferry-fresh" onPress={() => setFresh(!fresh)} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <View style={{ width: 18, height: 18, borderRadius: 4, borderWidth: 1, borderColor: colors.border, backgroundColor: fresh ? colors.accent : "transparent" }} />
          <Text style={{ color: colors.foreground, flexShrink: 1 }}>{t("picker.fresh")}</Text>
        </Pressable>
      ) : null}

      <View style={{ gap: 6 }}>
        <Muted theme={theme}>{t("picker.message")}</Muted>
        <TextInput
          value={message}
          onChangeText={setMessage}
          multiline
          placeholder={kind === "native" ? t("picker.messagePlaceholderNative") : t("picker.messagePlaceholder")}
          placeholderTextColor={colors.foregroundMuted}
          style={{ color: colors.foreground, minHeight: 72, borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, textAlignVertical: "top" }}
          testID="ferry-message"
        />
      </View>

      <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <Button theme={theme} kind="primary" label={t("picker.start", { label: target.label })} disabled={!canStart} busy={planning} onPress={() => void run()} testID="ferry-start" />
        {kind && kind !== "native" ? <Button theme={theme} label={preview ? t("picker.previewHide") : t("picker.preview")} busy={previewing} onPress={() => void showPreview()} testID="ferry-preview-toggle" /> : null}
      </View>
      {preview ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
            <Button theme={theme} kind="link" label={t("picker.copy")} onPress={() => void copyText(preview.text)} />
            {preview.truncated ? <Muted theme={theme}>{t("picker.previewTruncated")}</Muted> : null}
          </View>
          <ScrollView style={{ maxHeight: 360, borderWidth: 1, borderColor: colors.border, borderRadius: 8, backgroundColor: colors.surface1 }} contentContainerStyle={{ padding: 10 }} nestedScrollEnabled>
            <Text selectable testID="ferry-preview" style={{ color: colors.foreground, fontFamily: "monospace", fontSize: 12, lineHeight: 17 }}>
              {preview.text}
            </Text>
          </ScrollView>
        </View>
      ) : null}
    </View>
  ) : (
    <View style={{ flex: layout.compact ? undefined : 1.2 }}>
      <Muted theme={theme}>{t("picker.chooseHint")}</Muted>
    </View>
  );

  const list = (
    <View style={{ gap: 14, flex: layout.compact ? undefined : 1 }}>
      {groups.map((group) => {
        const hidden = group.collapsed && !showUnavailable;
        return (
          <View key={group.key} style={{ gap: 6 }}>
            {group.collapsed ? (
              <Pressable accessibilityRole="button" onPress={() => setShowUnavailable(!showUnavailable)} testID="ferry-unavailable-toggle">
                <Heading theme={theme} text={`${group.title} ${showUnavailable ? "▾" : "▸"}`} />
              </Pressable>
            ) : (
              <Heading theme={theme} text={group.title} />
            )}
            {hidden
              ? null
              : group.entries.map(({ route: entry, provider }) => (
                  <ProviderRow key={provider.id} theme={theme} provider={provider} route={entry} selected={selected === provider.id} onPress={() => {
                    if (entry.kind === "same") return;
                    setSelected(provider.id);
                    setModel(null);
                    setModelFilter("");
                    // On the agent's own provider the point is another model: show them straight away.
                    setModelsOpen(provider.id === agent?.provider);
                    setFresh(false);
                    setPhase({ kind: "pick" });
                  }} />
                ))}
          </View>
        );
      })}
    </View>
  );

  return (
    <ScrollView testID="ferry-screen" style={page} contentContainerStyle={{ padding, gap: 16 }} keyboardShouldPersistTaps="handled">
      {header}
      {phase.kind === "refused" ? (
        <Card theme={theme} tone="danger" testID="ferry-refused">
          <Body theme={theme}>{noteText(phase.reason)}</Body>
          <Button theme={theme} kind="link" label={t("picker.dismiss")} onPress={() => setPhase({ kind: "pick" })} />
        </Card>
      ) : null}
      {!info.native.available && info.native.reason ? <Muted theme={theme}>{noteText(info.native.reason)}</Muted> : null}
      {layout.compact ? (
        <>
          {detail}
          {list}
        </>
      ) : (
        <View style={{ flexDirection: "row", gap: 24, alignItems: "flex-start" }}>
          {list}
          {detail}
        </View>
      )}
    </ScrollView>
  );
}

function ProviderRow(props: { theme: FerryScreenProps["theme"]; provider: ProviderSummary; route: RouteChoice; selected: boolean; onPress(): void }) {
  const { theme, provider, route } = props;
  const colors = theme.colors;
  const dot = provider.ready ? colors.statusSuccess : provider.enabled ? colors.statusWarning : colors.foregroundMuted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: props.selected, disabled: route.kind === "same" }}
      testID={`ferry-provider-${provider.id}`}
      onPress={props.onPress}
      style={({ pressed }) => ({
        borderWidth: 1,
        borderColor: props.selected ? colors.accent : colors.border,
        borderRadius: 10,
        padding: 10,
        gap: 4,
        backgroundColor: props.selected ? colors.surface2 : colors.surface1,
        opacity: pressed ? 0.8 : route.kind === "same" ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
        <Text style={{ color: colors.foreground, fontSize: 15, fontWeight: "600", flexShrink: 1 }} numberOfLines={1}>
          {provider.label}
        </Text>
        <View style={{ flex: 1 }} />
        <Badge theme={theme} tone={routeTone(route.kind)} text={routeBadge(route.kind)} />
      </View>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }} numberOfLines={1}>
        {provider.id}
        {route.reason ? ` · ${noteText(route.reason)}` : ""}
      </Text>
    </Pressable>
  );
}

