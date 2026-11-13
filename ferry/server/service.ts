// Ferry's RPC handlers: what the picker shows, the plan and its preview, starting and following a move, a chain's
// record, what a delivery sent, and forgetting.

import { findProvider, storeLabel, type ProviderInfo } from "../shared/families";
import { failureKind } from "../shared/failure";
import { LABEL_CHAIN } from "../shared/plugin-id";
import type { PlanResult, ProvidersInfo, RouteChoice, StartOutput } from "../shared/rpc";
import { partnerFor } from "../shared/settings";
import { decideRoute } from "../shared/strategy";
import type { FerryContext } from "./context";
import { retryDelivery } from "./delivery";
import { executeMove, stopTurn } from "./move";
import type { Operations } from "./operations";
import { makePlan, nativeAvailable, readSource } from "./plan";
import { loadProviders } from "./providers";
import type { PaseoLike } from "./types";

const PREVIEW_BYTES = 48 * 1024;
const START_ANSWER_MS = 20_000;

const summary = (provider: ProviderInfo, home: string) => ({
  id: provider.id,
  label: provider.label,
  family: provider.family,
  source: provider.source,
  enabled: provider.enabled,
  ready: provider.ready,
  status: provider.status,
  models: provider.models,
  modes: provider.modes,
  defaultModeId: provider.defaultModeId,
  storeKey: provider.storeKey,
  storePath: storeLabel(provider.storeKey, home),
  toolDisabled: provider.toolDisabled,
});

/** What the picker lists: every provider, how a move from this agent to each would go, and the agent itself. */
export async function describe(paseo: PaseoLike, ctx: FerryContext, agentId?: string): Promise<ProvidersInfo> {
  const settings = await ctx.settings();
  const providers = await loadProviders(paseo, settings, ctx);
  const nativeOk = settings.native && (await nativeAvailable(ctx));
  const native = { available: nativeOk, reason: nativeOk ? null : { code: settings.native ? "notes.nativeUnavailableHere" : "notes.nativeOff" } };
  const base = { providers: providers.list.map((provider) => summary(provider, ctx.userHome)), native };
  if (!agentId) return { ...base, agent: null, routes: [], partner: null };
  const agent = await readSource(paseo, ctx, agentId).catch(() => null);
  if (!agent) return { ...base, agent: null, routes: [], partner: null };
  await ctx.store.ready();
  const chainId = ctx.store.chainOf(agent.id) ?? agent.labels?.[LABEL_CHAIN] ?? null;
  const chain = chainId ? await ctx.store.read(chainId).catch(() => null) : null;
  const sessionId = agent.persistence?.sessionId ?? null;
  const sourceProvider = providers.get(agent.provider) ?? null;
  const failure = failureKind(agent.status, agent.attentionReason, agent.lastError);
  const routes: RouteChoice[] = providers.list.map((target) => {
    // After a failure the current provider is offered too: a new agent there with another model.
    if (target.id === agent.provider) {
      return failure && target.ready && target.models.length > 1
        ? { provider: target.id, kind: "handoff", reason: { code: "reasons.sameProviderNew" }, targetAgentId: null }
        : { provider: target.id, kind: "same", reason: null, targetAgentId: null };
    }
    if (!target.enabled) return { provider: target.id, kind: "unavailable", reason: { code: "reasons.disabled" }, targetAgentId: null };
    if (!target.ready) return { provider: target.id, kind: "unavailable", reason: { code: "reasons.notReady", params: { status: target.status } }, targetAgentId: null };
    if (!target.models.length) return { provider: target.id, kind: "unavailable", reason: { code: "reasons.noModels" }, targetAgentId: null };
    const decision = decideRoute({
      source: { agentId: agent.id, provider: sourceProvider, sessionId, sessionFile: undefined },
      target,
      chain,
      native: nativeOk,
      fresh: false,
      exists: () => true,
    });
    return { provider: target.id, kind: decision.kind, reason: null, targetAgentId: decision.agentId };
  });
  const partner = partnerFor(settings, agent.provider, (target) => {
    const match = findProvider(providers.list, target);
    return !!match && match.provider.ready && match.provider.id !== agent.provider;
  });
  const visits = chain?.visits.length ?? 0;
  return {
    ...base,
    agent: {
      id: agent.id,
      title: agent.title ?? null,
      provider: agent.provider,
      model: agent.model ?? null,
      status: agent.status,
      failure,
      lastError: agent.lastError ?? null,
      archived: !!agent.archivedAt,
      chainId: chain?.id ?? null,
      visits,
      blocked: !sessionId && !chain ? { code: "errors.nothingToMove" } : null,
    },
    routes,
    partner,
  };
}

/** The plan for a move, worked out on a copy: nothing is written, nothing is sent. */
export async function preview(paseo: PaseoLike, ctx: FerryContext, input: { agentId: string; target: string; message?: string; fresh?: boolean; preview?: boolean }): Promise<PlanResult> {
  const outcome = await makePlan(paseo, ctx, { agentId: input.agentId, target: input.target, message: input.message, fresh: input.fresh }, { dry: true });
  if (outcome.status !== "ok") return { status: "refused", reason: outcome.reason };
  const { plan } = outcome;
  const text = plan.envelope?.text ?? null;
  const truncated = !!text && text.length > PREVIEW_BYTES;
  return {
    status: "ok",
    route: plan.route.kind,
    target: { provider: plan.target.id, label: plan.target.label, model: plan.modelId, modeId: plan.modeId, thinkingId: plan.thinkingId },
    budget: plan.budget,
    selection: plan.envelope && plan.mode ? { mode: plan.mode, selected: plan.envelope.selected, total: plan.envelope.total, bytes: plan.envelope.bytes, omitted: plan.envelope.omitted } : null,
    notes: plan.notes,
    warnings: plan.warnings,
    preview: input.preview && text ? (truncated ? text.slice(0, PREVIEW_BYTES) : text) : null,
    previewTruncated: !!input.preview && truncated,
  };
}

export interface StartInput {
  requestId: string;
  agentId: string;
  target?: string;
  message?: string;
  stopRunning?: boolean;
  fresh?: boolean;
}

export async function start(paseo: PaseoLike, ctx: FerryContext, operations: Operations, input: StartInput): Promise<StartOutput> {
  const operation = operations.start({ requestId: input.requestId, agentId: input.agentId }, (phase) =>
    // From the stop to the end of the move nothing else writes a chain: a delivery retry or a turn's bookkeeping waits,
    // and a second move plans on what this one leaves.
    ctx.store.withLock(input.agentId, async (): Promise<StartOutput> => {
      const stop = input.stopRunning ? await stopTurn(paseo, ctx, input.agentId, phase) : { stopped: false };
      if ("refused" in stop) return { status: "refused", reason: stop.refused };
      const outcome = await makePlan(paseo, ctx, input, { dry: false });
      if (outcome.status !== "ok") return outcome;
      if (stop.stopped) outcome.plan.notes.push({ code: "notes.stopped" });
      return executeMove(paseo, ctx, outcome.plan, phase);
    }),
  );
  if (operation === "busy") return { status: "refused", reason: { code: "errors.busy" } };
  return operations.answer(operation, START_ANSWER_MS);
}

export async function wait(operations: Operations, input: { opId: string; timeoutMs?: number }): Promise<StartOutput> {
  const operation = operations.get(input.opId);
  if (!operation) return { status: "refused", reason: { code: "errors.operationGone" } };
  return operations.answer(operation, input.timeoutMs ?? 25_000);
}

export async function retry(paseo: PaseoLike, ctx: FerryContext, input: { chainId: string; deliveryId: string }): Promise<StartOutput> {
  return retryDelivery(paseo, ctx, input.chainId, input.deliveryId);
}

export async function chainOf(paseo: PaseoLike, ctx: FerryContext, agentId: string) {
  await ctx.store.ready();
  const agent = await readSource(paseo, ctx, agentId).catch(() => null);
  const chainId = ctx.store.chainOf(agentId) ?? agent?.labels?.[LABEL_CHAIN] ?? null;
  const chain = chainId ? await ctx.store.read(chainId).catch(() => null) : null;
  if (!chain) return { chain: null };
  return {
    chain: {
      id: chain.id,
      visits: chain.visits.map((visit) => ({ n: visit.n, agentId: visit.agentId, provider: visit.provider, model: visit.model, openedBy: visit.openedBy, openedAt: visit.openedAt, closedAt: visit.closedAt, itemCount: visit.itemCount })),
      deliveries: chain.deliveries.map((delivery) => ({
        id: delivery.id,
        visitN: delivery.visitN,
        targetAgentId: delivery.targetAgentId,
        mode: delivery.mode,
        selected: delivery.selected,
        total: delivery.total,
        status: delivery.status,
        at: delivery.attempts[0]?.at ?? null,
      })),
    },
  };
}

export async function sentText(ctx: FerryContext, input: { chainId: string; deliveryId: string }) {
  const text = await ctx.store.readSent(input.chainId, input.deliveryId).catch(() => null);
  if (!text) return { text: null, truncated: false };
  return text.length > PREVIEW_BYTES ? { text: text.slice(0, PREVIEW_BYTES), truncated: true } : { text, truncated: false };
}

export async function forget(ctx: FerryContext, input: { chainId: string }) {
  return { removed: await ctx.store.withLock("forget", () => ctx.store.forget(input.chainId === "all" ? "all" : input.chainId)) };
}

