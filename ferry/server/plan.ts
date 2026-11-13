// Everything a move needs, worked out before anything changes: the source, the target and its model, mode and thinking,
// the chain brought up to date, the route, and the history to send. The picker's preview runs the same plan on a
// chain store that keeps its writes in memory.

import { byteLength } from "../shared/bytes";
import { chooseMode, chooseModel, chooseThinking, findProvider, tierOf, type ProviderInfo } from "../shared/families";
import type { RouteKind } from "../shared/kinds";
import type { Chain, NumberedItem } from "../shared/model";
import { LABEL_CHAIN, TOOL_NAME } from "../shared/plugin-id";
import { buildEnvelope, handoffBudget, MIN_DELTA_BYTES, type Budget, type BuiltEnvelope } from "../shared/select";
import { partnerFor, type FerrySettings } from "../shared/settings";
import { decideRoute, type RouteDecision } from "../shared/strategy";
import { t } from "../shared/text";
import type { ChainStore } from "./chain-store";
import type { FerryContext } from "./context";
import { deltaItems, lineageOf, settle } from "./history";
import { overlayStore } from "./overlay";
import { loadProviders, type Providers } from "./providers";
import type { AgentLike, Note, PaseoLike } from "./types";

export interface PlanInput {
  agentId: string;
  /** `provider` or `provider/model`; omitted: the configured partner. */
  target?: string;
  message?: string;
  fresh?: boolean;
  stopRunning?: boolean;
}

export interface Plan {
  store: ChainStore;
  settings: FerrySettings;
  providers: Providers;
  source: AgentLike;
  sourceProvider: ProviderInfo | null;
  target: ProviderInfo;
  modelId: string | null;
  thinkingId: string | null;
  modeId: string | null;
  route: RouteDecision;
  chain: Chain;
  history: NumberedItem[];
  /** The history to send, for every route that sends one. */
  envelope: BuiltEnvelope | null;
  budget: Budget | null;
  mode: "full" | "delta" | null;
  deliveryId: string;
  /** What the user wrote, or the default wording. */
  message: string;
  /** The user wrote nothing (a native move then sends nothing). */
  messageGiven: boolean;
  notes: Note[];
  warnings: Note[];
  nativeAvailable: boolean;
  /** What a new agent on the target would run with, and what to say about it: a switch-back that has to fall back to a
   *  handoff uses these, never the returning agent's own settings (they may be more permissive than the source's). */
  fresh: { modelId: string | null; thinkingId: string | null; modeId: string | null; notes: Note[]; warnings: Note[] };
}

export type PlanOutcome =
  | { status: "ok"; plan: Plan }
  | { status: "refused"; reason: Note }
  | { status: "choose"; reason: Note }
  | { status: "running"; reason: Note };

const refused = (code: string, params?: Note["params"]): PlanOutcome => ({ status: "refused", reason: { code, ...(params ? { params } : {}) } });
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The agent as the daemon has it, else its stored record (an agent on a provider switched off cannot be loaded). */
export async function readSource(paseo: PaseoLike, ctx: Pick<FerryContext, "readStoredAgent">, agentId: string): Promise<AgentLike | null> {
  let failure: unknown = null;
  try {
    const agent = (await paseo.agents.ref(agentId).refresh())?.agent ?? null;
    if (agent) return agent;
  } catch (error) {
    failure = error;
  }
  const stored = await ctx.readStoredAgent(agentId).catch(() => null);
  if (stored) return stored;
  if (failure) throw failure;
  return null;
}

/** Whether the daemon can still find an agent (an archived one counts; a deleted one does not). */
async function agentExists(paseo: PaseoLike, agentId: string): Promise<boolean> {
  try {
    return !!(await paseo.agents.ref(agentId).refresh())?.agent;
  } catch {
    return false;
  }
}

const nativeChecks = new WeakMap<object, { at: number; ok: boolean }>();
/** Whether the second connection can work; cached for a minute per context. */
export async function nativeAvailable(ctx: Pick<FerryContext, "canConnect" | "now">): Promise<boolean> {
  const now = ctx.now().getTime();
  const cached = nativeChecks.get(ctx);
  if (cached && now - cached.at < 60_000) return cached.ok;
  const ok = await ctx.canConnect().catch(() => false);
  nativeChecks.set(ctx, { at: now, ok });
  return ok;
}

export function defaultMessage(settings: Pick<FerrySettings, "defaultMessage">): string {
  return settings.defaultMessage.trim() || t("message.default");
}

export interface EnvelopeShape {
  settings: FerrySettings;
  providers: Providers;
  target: ProviderInfo;
  modelWindow: number | null;
  chain: Chain;
  store: ChainStore;
  deliveryId: string;
  message: string;
}

/** The history envelope for a target: everything ("full") or what a returning agent missed ("delta"). */
export function envelopeFor(shape: EnvelopeShape, kind: "full" | "delta", items: NumberedItem[], usedTokens: number | null): { built: BuiltEnvelope; spent: Budget } {
  const { settings, providers, target, chain, store, deliveryId } = shape;
  const spent = handoffBudget({ capTokens: settings.budgetTokens, windowTokens: shape.modelWindow, usedTokens, messageBytes: byteLength(shape.message) });
  const tool = settings.historyTool && providers.toolsInjected && !target.toolDisabled ? TOOL_NAME : null;
  const built = buildEnvelope({
    id: deliveryId,
    chainId: chain.id,
    mode: kind,
    cwd: chain.cwd,
    visits: chain.visits.filter((visit) => visit.itemCount > 0).map((visit) => ({ n: visit.n, provider: visit.provider, model: visit.model })),
    items,
    budgetBytes: spent.effective,
    includeToolOutput: settings.includeToolOutput,
    toolOutputBytes: settings.toolOutputBytes,
    recordPath: settings.transcriptFile ? store.recordPath(chain.id, deliveryId) : null,
    tool,
  });
  return { built, spent };
}

export async function makePlan(paseo: PaseoLike, ctx: FerryContext, input: PlanInput, options: { dry: boolean }): Promise<PlanOutcome> {
  const settings = await ctx.settings();
  const store = options.dry ? overlayStore(ctx.store) : ctx.store;
  const providers = await loadProviders(paseo, settings, ctx);
  let source: AgentLike | null;
  try {
    source = await readSource(paseo, ctx, input.agentId);
  } catch (error) {
    return refused("errors.agentUnreadable", { error: message(error) });
  }
  if (!source) return refused("errors.agentMissing");
  const sessionId = source.persistence?.sessionId ?? null;
  if (!sessionId && !source.labels?.[LABEL_CHAIN]) return refused("errors.nothingToMove");
  const sourceProvider = providers.get(source.provider) ?? null;

  // The target: named, or the partner configured for the source's provider.
  let wanted = input.target?.trim() || null;
  if (!wanted) {
    wanted = partnerFor(settings, source.provider, (target) => {
      const match = findProvider(providers.list, target);
      return !!match && match.provider.ready && match.provider.id !== source!.provider;
    });
    if (!wanted) return { status: "choose", reason: { code: "errors.chooseTarget" } };
  }
  const match = findProvider(providers.list, wanted);
  if (!match) return refused("errors.unknownTarget", { target: wanted });
  const target = match.provider;
  // The same provider only with another model, as a new agent. The model picker by the composer changes the model in
  // place; a session that keeps failing on its model (a gateway without it) needs a new agent instead.
  const sameProvider = target.id === source.provider;
  if (sameProvider && (!match.model || match.model.id === source.model)) return refused("errors.sameProvider", { label: target.label });
  if (!target.enabled) return refused("errors.targetDisabled", { label: target.label });
  if (!target.ready) return refused("errors.targetNotReady", { label: target.label, status: target.status });
  if (!target.models.length) return refused("errors.targetNoModels", { label: target.label });

  const running = source.status === "running";
  if (running && !options.dry && !input.stopRunning) {
    return { status: "running", reason: { code: "errors.running", params: { title: source.title?.trim() || source.id.slice(0, 8), label: target.label } } };
  }

  const notes: Note[] = [];
  const warnings: Note[] = [];
  if (running && options.dry) warnings.push({ code: "warnings.running" });

  // The chain, brought up to date (in memory for a preview).
  await store.ready();
  const chainId = store.chainOf(source.id) ?? source.labels?.[LABEL_CHAIN] ?? null;
  const existing = chainId ? await store.read(chainId) : null;
  const meta = { family: sourceProvider?.family ?? "other", storeKey: sourceProvider?.storeKey ?? null };
  const settled = await settle({ paseo, store, now: () => ctx.now() }, existing, source, meta, (agentId) => readSource(paseo, ctx, agentId));
  notes.push(...settled.notes);
  const chain = settled.chain;

  // The route.
  const nativeOk = settings.native && (await nativeAvailable(ctx));
  const sessionFile = nativeOk && sessionId && sourceProvider?.storeKey ? await ctx.findSessionFile(sourceProvider.storeKey, sessionId).then((file) => (file === undefined ? undefined : !!file)) : false;
  // Earlier agents on the target that still exist (one may have been deleted since).
  const alive = new Set<string>();
  for (const agentId of new Set(chain.visits.filter((visit) => visit.provider === target.id).map((visit) => visit.agentId))) {
    if (await agentExists(paseo, agentId)) alive.add(agentId);
  }
  let route = decideRoute({
    source: { agentId: source.id, provider: sourceProvider, sessionId, sessionFile },
    target,
    chain,
    native: nativeOk,
    fresh: input.fresh === true || sameProvider,
    exists: (agentId) => alive.has(agentId),
  });
  if (sameProvider) notes.push({ code: "notes.sameProviderNew", params: { label: target.label, model: match.model!.id } });
  // A switch-back returns to an agent that keeps its own model; a different model named explicitly needs a new agent.
  let back: AgentLike | null = null;
  if (route.kind === "switch-back") {
    back = await readSource(paseo, ctx, route.agentId!).catch(() => null);
    if (match.model && back?.model && back.model !== match.model.id) {
      notes.push({ code: "notes.backOtherModel", params: { label: target.label, model: back.model } });
      route = { kind: "handoff", agentId: null, lineage: null };
      back = null;
    }
  }

  // The target's settings, for a new or imported agent.
  const modelChoice = chooseModel(target, { named: match.model?.id ?? null, sourceModel: source.model });
  const model = target.models.find((candidate) => candidate.id === modelChoice.modelId) ?? null;
  // An agent created without a thinking level runs at its model's default: that is the level to keep, not the target's
  // default (which may be far more expensive).
  const sourceThinking = source.thinkingOptionId ?? sourceProvider?.models.find((candidate) => candidate.id === source!.model)?.defaultThinking ?? null;
  const thinking = chooseThinking(model, sourceThinking);
  // The tier the source provider reports for the conversation's mode; when its snapshot has none (still loading,
  // failed, removed), the mode's name decides, and a name Ferry cannot place counts as careful.
  const sourceMode = source.currentModeId ?? null;
  const sourceTier = sourceMode ? (sourceProvider?.modes.find((mode) => mode.id === sourceMode)?.tier ?? tierOf({ id: sourceMode }, "safe")) : null;
  const modeChoice = chooseMode({ modeId: sourceMode, tier: sourceTier }, target);

  const text = input.message?.trim() ?? "";
  const userMessage = text || defaultMessage(settings);
  const deliveryId = ctx.newId();

  // The history to send.
  let envelope: BuiltEnvelope | null = null;
  let budget: Budget | null = null;
  let mode: "full" | "delta" | null = null;
  const history: NumberedItem[] = await store.history(chain);
  const shape = { settings, providers, target, modelWindow: model?.window ?? null, chain, store, deliveryId, message: userMessage };
  const build = (kind: "full" | "delta", items: NumberedItem[], used: number | null) => envelopeFor(shape, kind, items, used);
  if (route.kind === "switch-back" || route.kind === "native-switch-back") {
    const lineage = lineageOf(route.lineage!);
    const items = deltaItems(chain, history, lineage);
    const used = back?.lastUsage?.contextWindowUsedTokens ?? null;
    const delta = build("delta", items, used);
    if (delta.spent.effective < MIN_DELTA_BYTES) {
      notes.push({ code: "notes.deltaTooSmall", params: { label: target.label } });
      route = { kind: "handoff", agentId: null, lineage: null };
      back = null;
    } else {
      envelope = delta.built;
      budget = delta.spent;
      mode = "delta";
      if (!items.length) notes.push({ code: "notes.nothingMissed" });
    }
  }
  if (route.kind === "handoff") {
    const full = build("full", history, null);
    envelope = full.built;
    budget = full.spent;
    mode = "full";
    if (full.built.selected < full.built.total) notes.push({ code: "notes.partial", params: { selected: full.built.selected, total: full.built.total } });
  }
  // What the agent that carries on will run with: a returning agent its own settings, any other the ones chosen above.
  const fresh: Plan["fresh"] = { modelId: model?.id ?? null, thinkingId: thinking.thinkingId, modeId: modeChoice.modeId, notes: [], warnings: [] };
  if (!modelChoice.equivalent && source.model && !sameProvider) fresh.notes.push({ code: "notes.modelFallback", params: { source: source.model, model: model?.id ?? "-" } });
  if (!thinking.kept && sourceThinking) fresh.notes.push({ code: "notes.thinkingFallback", params: { thinking: sourceThinking } });
  if (modeChoice.escalated) fresh.warnings.push({ code: "warnings.modeEscalated", params: { mode: modeChoice.modeId ?? "-" } });
  if (modeChoice.none) fresh.notes.push({ code: "notes.noModes", params: { label: target.label } });
  const chosen = back
    ? { modelId: back.model ?? null, thinkingId: back.thinkingOptionId ?? null, modeId: back.currentModeId ?? null }
    : { modelId: fresh.modelId, thinkingId: fresh.thinkingId, modeId: fresh.modeId };
  if (!back) {
    notes.push(...fresh.notes);
    warnings.push(...fresh.warnings);
  }
  return {
    status: "ok",
    plan: {
      store,
      settings,
      providers,
      source,
      sourceProvider,
      target,
      ...chosen,
      route,
      chain,
      history,
      envelope,
      budget,
      mode,
      deliveryId,
      message: userMessage,
      messageGiven: !!text,
      notes,
      warnings,
      nativeAvailable: nativeOk,
      fresh,
    },
  };
}

export type { RouteKind };
