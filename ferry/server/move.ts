// Carrying out a plan. The order keeps the conversation safe: the target gets the conversation first (created and sent
// to, imported, or sent the part it missed); only then is the source archived. A failure before that leaves the source
// untouched. Every route that fails part-way falls back to a plain handoff to a new agent, and says so.

import type { RouteKind } from "../shared/kinds";
import type { Chain, Delivery, Visit } from "../shared/model";
import { ENVELOPE_TITLE, LABEL_CHAIN, LABEL_FROM_AGENT, LABEL_VISIT, MESSAGE_PREFIX, OWN_LABELS, PLUGIN_ID, ROW_HANDOFF, ROW_MOVED, ROW_VERSION } from "../shared/plugin-id";
import type { HandoffRow, MovedRow } from "../shared/kinds";
import type { MoveResult } from "../shared/rpc";
import type { FerryContext } from "./context";
import type { DaemonLink } from "./daemon-link";
import { addVisit, deltaItems, lineageOf } from "./history";
import { envelopeFor, readSource, type Plan } from "./plan";
import { renderRecord } from "./record";
import type { AgentLike, Note, PaseoLike, TextAttachment } from "./types";

const STOP_WAIT_MS = 20_000;
/** Imports finish in seconds; an agent created earlier than this before the move is one that came back. */
const RESTORED_SLACK_MS = 2000;

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type Phase = "stopping" | "creating" | "importing" | "sending" | "archiving" | "done";

export type MoveOutcome = { status: "done"; result: MoveResult } | { status: "refused"; reason: Note };

interface Run {
  paseo: PaseoLike;
  ctx: FerryContext;
  plan: Plan;
  notes: Note[];
  warnings: Note[];
  phase(phase: Phase): void;
  startedAt: number;
}

/** The source's labels go with the conversation (a subagent stays under its parent); Ferry's own are rewritten. */
export function carriedLabels(source: Pick<AgentLike, "labels">): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [name, value] of Object.entries(source.labels ?? {})) if (!OWN_LABELS.includes(name)) labels[name] = value;
  return labels;
}

function chainLabels(chain: Chain, visit: Pick<Visit, "n">, source: AgentLike): Record<string, string> {
  return { [LABEL_CHAIN]: chain.id, [LABEL_VISIT]: String(visit.n), [LABEL_FROM_AGENT]: source.id };
}

const label = (run: Run, provider: string) => run.plan.providers.get(provider)?.label ?? provider;

function handoffRow(run: Run, route: RouteKind, to: { agentId: string; model: string | null }, delivery: Delivery | null): HandoffRow {
  const { plan } = run;
  const row: HandoffRow = {
    route,
    chainId: plan.chain.id,
    deliveryId: delivery?.id ?? null,
    from: { agentId: plan.source.id, provider: plan.source.provider, label: label(run, plan.source.provider) },
    to: { agentId: to.agentId, provider: plan.target.id, label: plan.target.label, model: to.model },
    mode: delivery?.mode ?? null,
    selected: delivery?.selected ?? 0,
    total: delivery?.total ?? 0,
    bytes: delivery?.bytes ?? 0,
    status: delivery?.status ?? null,
    error: delivery?.error ?? null,
    at: delivery?.row?.at ?? run.ctx.now().toISOString(),
  };
  if (delivery) delivery.row = row;
  return row;
}

/** Appends (or, with the same id, replaces) a row; a row that cannot be added is not worth failing a move for. */
export async function appendRow(paseo: PaseoLike, agentId: string, id: string, kind: string, data: unknown): Promise<boolean> {
  try {
    await paseo.agents.ref(agentId).timeline.append({ type: "plugin", id, kind, version: ROW_VERSION, data });
    return true;
  } catch {
    return false;
  }
}

export const handoffRowId = (deliveryOrVisit: string) => `${PLUGIN_ID}-handoff-${deliveryOrVisit}`;

async function save(run: Run): Promise<void> {
  run.plan.chain.updatedAt = run.ctx.now().toISOString();
  await run.plan.store.write(run.plan.chain);
}

/**
 * Stops an agent's running turn, waiting up to 20 s for it to end. It runs before the move is planned, so the history
 * includes everything the turn did; nothing has been written when it refuses.
 */
export async function stopTurn(paseo: PaseoLike, ctx: FerryContext, agentId: string, onPhase: (phase: Phase) => void): Promise<{ stopped: boolean } | { refused: Note }> {
  const source = await readSource(paseo, ctx, agentId).catch(() => null);
  if (source?.status !== "running") return { stopped: false };
  onPhase("stopping");
  let link: DaemonLink;
  try {
    link = await ctx.connect();
  } catch (error) {
    return { refused: { code: "errors.cannotStop", params: { error: errorText(error) } } };
  }
  try {
    await link.cancelAgent(agentId);
    let current: AgentLike | null = source;
    for (let waited = 0; current?.status === "running" && waited < STOP_WAIT_MS; waited += 500) {
      await ctx.sleep(500);
      current = await readSource(paseo, ctx, agentId).catch(() => current);
    }
    return current?.status === "running" ? { refused: { code: "errors.stillRunning" } } : { stopped: true };
  } catch (error) {
    return { refused: { code: "errors.cannotStop", params: { error: errorText(error) } } };
  } finally {
    await link.close().catch(() => undefined);
  }
}

function newDelivery(run: Run, visit: Visit, targetAgentId: string, mode: "full" | "delta", since: number | null, built: { selected: number; total: number; bytes: number }): Delivery {
  const { plan } = run;
  return {
    id: plan.deliveryId,
    visitN: visit.n,
    targetAgentId,
    mode,
    since,
    via: plan.settings.delivery[plan.target.id] ?? (plan.target.family === "plugin" ? "inline" : "attachment"),
    selected: built.selected,
    total: built.total,
    bytes: built.bytes,
    attempts: [],
    status: "pending",
    message: plan.message,
  };
}

/** Sends the user's words with the history, as an attachment the app does not show (or inline). */
export async function sendDelivery(paseo: PaseoLike, ctx: Pick<FerryContext, "newId" | "now">, agentId: string, delivery: Delivery, envelope: string): Promise<void> {
  const messageId = `${MESSAGE_PREFIX}${ctx.newId()}`;
  const attempt = { messageId, at: ctx.now().toISOString(), status: "sent" as "sent" | "rejected", error: undefined as string | undefined };
  delivery.attempts.push(attempt);
  const attachments: TextAttachment[] = [{ type: "text", mimeType: "text/plain", contextKind: "chat_history", title: ENVELOPE_TITLE, text: envelope }];
  try {
    if (delivery.via === "inline") await paseo.agents.ref(agentId).send(`${envelope}\n\n${delivery.message}`, { messageId });
    else await paseo.agents.ref(agentId).send(delivery.message, { messageId, attachments });
    delivery.status = "accepted";
    delete delivery.error;
  } catch (error) {
    attempt.status = "rejected";
    attempt.error = errorText(error);
    delivery.status = "failed";
    delivery.error = attempt.error;
    throw error;
  }
}

/** Archives the source, or (when the setting keeps it) leaves a row pointing at where the conversation went. */
async function leaveSource(run: Run, to: { agentId: string }, force = false): Promise<boolean> {
  const { plan, paseo } = run;
  if (plan.settings.afterHandoff === "keep" && !force) {
    const row: MovedRow = { chainId: plan.chain.id, to: { agentId: to.agentId, provider: plan.target.id, label: plan.target.label }, at: run.ctx.now().toISOString() };
    await appendRow(paseo, plan.source.id, `${PLUGIN_ID}-moved-${plan.deliveryId}`, ROW_MOVED, row);
    return false;
  }
  if (plan.source.archivedAt) return true;
  run.phase("archiving");
  try {
    await paseo.agents.ref(plan.source.id).archive();
    return true;
  } catch (error) {
    run.warnings.push({ code: "warnings.archiveFailed", params: { error: errorText(error) } });
    return false;
  }
}

function result(run: Run, route: RouteKind, agentId: string, model: string | null, delivery: Delivery | null, extra: { restored?: boolean; reused?: boolean; archivedSource: boolean }): MoveOutcome {
  const { plan } = run;
  run.phase("done");
  return {
    status: "done",
    result: {
      agentId,
      route,
      from: { agentId: plan.source.id, provider: plan.source.provider, label: label(run, plan.source.provider) },
      to: { provider: plan.target.id, label: plan.target.label, model },
      chainId: plan.chain.id,
      deliveryId: delivery?.id ?? null,
      selected: delivery?.selected ?? 0,
      total: delivery?.total ?? 0,
      restored: extra.restored ?? false,
      reused: extra.reused ?? false,
      archivedSource: extra.archivedSource,
      notes: run.notes,
      warnings: run.warnings,
    },
  };
}

// --- handoff: a new agent with the history ---------------------------------------------------------------------------

async function handoff(run: Run): Promise<MoveOutcome> {
  const { plan, ctx, paseo } = run;
  let envelope = plan.envelope;
  if (!envelope || plan.mode !== "full") {
    // Falling back from another route: the whole history this time.
    envelope = envelopeFor({ ...plan, modelWindow: plan.target.models.find((model) => model.id === plan.modelId)?.window ?? null }, "full", plan.history, null).built;
  }
  let agentId = ctx.newId();
  const visit = addVisit(plan.chain, {
    agentId,
    provider: plan.target.id,
    model: plan.modelId,
    sessionId: null,
    storeKey: plan.target.storeKey,
    family: plan.target.family,
    openedBy: "handoff",
    deliveryId: plan.deliveryId,
    start: null,
    openedAt: ctx.now().toISOString(),
  });
  const delivery = newDelivery(run, visit, agentId, "full", null, envelope);
  plan.chain.deliveries.push(delivery);
  if (plan.settings.transcriptFile) await plan.store.writeRecord(plan.chain.id, delivery.id, renderRecord(plan.chain, plan.history, ctx.now()));
  await plan.store.writeSent(plan.chain.id, delivery.id, envelope.text);
  // Known to the session-open hook before the agent exists, so its first session gets the history tool.
  ctx.pending.set(agentId, plan.chain.id);
  await save(run);

  run.phase("creating");
  const config = {
    provider: plan.modelId ? `${plan.target.id}/${plan.modelId}` : plan.target.id,
    ...(plan.modeId ? { modeId: plan.modeId } : {}),
    ...(plan.thinkingId ? { thinkingOptionId: plan.thinkingId } : {}),
  };
  const labels = { ...carriedLabels(plan.source), ...chainLabels(plan.chain, visit, plan.source) };
  const create = async (settings: typeof config, attempt: number) => {
    const options = { agentId, idempotencyKey: `${PLUGIN_ID}-${delivery.id}-${attempt}`, config: settings, title: plan.source.title ?? null, labels };
    if (plan.source.workspaceId) await paseo.workspaces.ref(plan.source.workspaceId).agents.create(options);
    else await paseo.agents.create({ ...options, cwd: plan.source.cwd });
  };
  try {
    try {
      await create(config, 1);
    } catch (error) {
      // Some providers take a thinking level only in some modes (Cursor's "ask" has none, at times): once more without
      // it. The mode stays; without it the agent could run more permissively. The daemon keeps a failed creation under
      // its id, so the second try has a new one.
      if (!config.thinkingOptionId) throw error;
      const { thinkingOptionId: _dropped, ...rest } = config;
      ctx.pending.delete(agentId);
      agentId = ctx.newId();
      visit.agentId = agentId;
      delivery.targetAgentId = agentId;
      ctx.pending.set(agentId, plan.chain.id);
      await create(rest, 2).catch((second: unknown) => Promise.reject(new Error(`${errorText(error)}; without the thinking level: ${errorText(second)}`)));
      run.notes.push({ code: "notes.thinkingRefused", params: { label: plan.target.label, thinking: config.thinkingOptionId } });
    }
  } catch (error) {
    ctx.pending.delete(agentId);
    plan.chain.visits = plan.chain.visits.filter((entry) => entry !== visit);
    plan.chain.deliveries = plan.chain.deliveries.filter((entry) => entry !== delivery);
    await save(run);
    return { status: "refused", reason: { code: "errors.createFailed", params: { label: plan.target.label, error: errorText(error) } } };
  }

  await appendRow(paseo, agentId, handoffRowId(delivery.id), ROW_HANDOFF, handoffRow(run, "handoff", { agentId, model: plan.modelId }, delivery));
  run.phase("sending");
  try {
    await sendDelivery(paseo, ctx, agentId, delivery, envelope.text);
  } catch {
    run.warnings.push({ code: "warnings.sendFailed", params: { error: delivery.error ?? "" } });
  }
  await appendRow(paseo, agentId, handoffRowId(delivery.id), ROW_HANDOFF, handoffRow(run, "handoff", { agentId, model: plan.modelId }, delivery));
  ctx.pending.delete(agentId);
  await save(run);
  // Without the history the new agent cannot carry on: keep the source until a retry gets through.
  const archivedSource = delivery.status === "accepted" ? await leaveSource(run, { agentId }) : false;
  return result(run, "handoff", agentId, plan.modelId, delivery, { archivedSource });
}

// --- switch-back: an earlier agent gets what it missed -------------------------------------------------------------------

async function switchBack(run: Run): Promise<MoveOutcome> {
  const { plan, ctx, paseo } = run;
  const agentId = plan.route.agentId!;
  const back = await readSource(paseo, ctx, agentId).catch(() => null);
  const lineage = lineageOf(plan.route.lineage!);
  const items = deltaItems(plan.chain, plan.history, lineage);
  const seen = plan.history.filter((item) => !items.includes(item)).reduce((max, item) => Math.max(max, item.n), 0);
  const visit = addVisit(plan.chain, {
    agentId,
    provider: plan.target.id,
    model: back?.model ?? plan.route.lineage!.model,
    sessionId: back?.persistence?.sessionId ?? plan.route.lineage!.sessionId,
    storeKey: plan.target.storeKey,
    family: plan.target.family,
    openedBy: "delta",
    deliveryId: plan.deliveryId,
    start: null,
    openedAt: ctx.now().toISOString(),
  });
  const delivery = newDelivery(run, visit, agentId, "delta", seen || null, plan.envelope!);
  plan.chain.deliveries.push(delivery);
  if (plan.settings.transcriptFile) await plan.store.writeRecord(plan.chain.id, delivery.id, renderRecord(plan.chain, plan.history, ctx.now()));
  await plan.store.writeSent(plan.chain.id, delivery.id, plan.envelope!.text);
  await save(run);
  // The row goes above the message where it can; an archived agent takes rows only once the send has brought it back.
  const rowFirst = !back?.archivedAt && (await appendRow(paseo, agentId, handoffRowId(delivery.id), ROW_HANDOFF, handoffRow(run, "switch-back", { agentId, model: back?.model ?? null }, delivery)));
  run.phase("sending");
  try {
    await sendDelivery(paseo, ctx, agentId, delivery, plan.envelope!.text);
  } catch (error) {
    plan.chain.visits = plan.chain.visits.filter((entry) => entry !== visit);
    plan.chain.deliveries = plan.chain.deliveries.filter((entry) => entry !== delivery);
    run.notes.push({ code: "notes.switchBackFailed", params: { error: errorText(error) } });
    // Rows cannot be removed: the one already shown says the return did not happen (nothing to retry there).
    if (rowFirst) await appendRow(paseo, agentId, handoffRowId(delivery.id), ROW_HANDOFF, { ...handoffRow(run, "switch-back", { agentId, model: back?.model ?? null }, delivery), status: "canceled", deliveryId: null });
    plan.route = { kind: "handoff", agentId: null, lineage: null };
    plan.deliveryId = ctx.newId();
    // A new agent runs with the settings chosen for one, never the returning agent's own: those may be more permissive.
    plan.modelId = plan.fresh.modelId;
    plan.thinkingId = plan.fresh.thinkingId;
    plan.modeId = plan.fresh.modeId;
    run.notes.push(...plan.fresh.notes);
    run.warnings.push(...plan.fresh.warnings);
    return handoff(run);
  }
  await appendRow(paseo, agentId, handoffRowId(delivery.id), ROW_HANDOFF, handoffRow(run, "switch-back", { agentId, model: back?.model ?? null }, delivery));
  await save(run);
  await archiveLineage(run, lineage, agentId);
  const archivedSource = await leaveSource(run, { agentId });
  return result(run, "switch-back", agentId, back?.model ?? null, delivery, { archivedSource });
}

// --- native: the target provider continues the same session --------------------------------------------------------------

/** An active agent on `provider` that already holds `sessionId` (an earlier move that could not archive its source). */
async function findHolder(paseo: PaseoLike, provider: string, sessionId: string): Promise<AgentLike | null> {
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const result = await paseo.agents.list({ filter: { includeBackground: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    const found = result.entries.map((entry) => entry.agent).find((agent) => agent.provider === provider && agent.persistence?.sessionId === sessionId && !agent.archivedAt);
    if (found) return found;
    if (!result.pageInfo?.hasMore || !result.pageInfo.nextCursor) return null;
    cursor = result.pageInfo.nextCursor;
  }
  return null;
}

/** Model (always: an imported agent has none of its own), thinking, mode and name, where the target offers them. */
async function carrySettings(run: Run, link: DaemonLink, agentId: string): Promise<void> {
  const { plan } = run;
  const attempt = async (what: string, action: () => Promise<unknown>) => {
    try {
      await action();
    } catch (error) {
      run.warnings.push({ code: "warnings.settingFailed", params: { what, error: errorText(error) } });
    }
  };
  if (plan.modelId) await attempt("model", () => link.setAgentModel(agentId, plan.modelId));
  if (plan.thinkingId) await attempt("thinking", () => link.setAgentThinkingOption(agentId, plan.thinkingId));
  if (plan.modeId) await attempt("mode", () => link.setAgentMode(agentId, plan.modeId!));
  const title = plan.source.title?.trim();
  if (title) await attempt("name", () => link.updateAgent(agentId, { name: title }));
}

/** Imports `sessionId` on the target into the source's workspace; reuses an agent that already holds it. */
async function importSession(run: Run, link: DaemonLink, sessionId: string, visit: Visit): Promise<{ agent: AgentLike; restored: boolean; reused: boolean }> {
  const { plan, paseo } = run;
  const holder = await findHolder(paseo, plan.target.id, sessionId);
  const labels = { ...carriedLabels(plan.source), ...chainLabels(plan.chain, visit, plan.source) };
  if (holder) {
    run.notes.push({ code: "notes.reused", params: { label: plan.target.label } });
    await link.updateAgent(holder.id, { labels }).catch(() => undefined);
    return { agent: holder, restored: false, reused: true };
  }
  run.phase("importing");
  const agent = await link.importAgent({
    providerId: plan.target.id,
    providerHandleId: sessionId,
    cwd: plan.source.cwd,
    ...(plan.source.workspaceId ? { workspaceId: plan.source.workspaceId } : {}),
    labels,
  });
  const restored = Date.parse(agent.createdAt ?? "") < run.startedAt - RESTORED_SLACK_MS;
  if (restored) run.notes.push({ code: "notes.restored", params: { label: plan.target.label } });
  else await carrySettings(run, link, agent.id);
  await link.updateAgent(agent.id, { labels }).catch(() => undefined);
  if (agent.provider !== plan.target.id) run.warnings.push({ code: "warnings.wrongProvider", params: { provider: agent.provider } });
  if (plan.source.workspaceId && agent.workspaceId && agent.workspaceId !== plan.source.workspaceId) run.warnings.push({ code: "warnings.otherWorkspace" });
  return { agent, restored, reused: false };
}

async function native(run: Run): Promise<MoveOutcome> {
  const { plan, ctx, paseo } = run;
  const sessionId = plan.source.persistence!.sessionId!;
  const sourceVisit = [...plan.chain.visits].reverse().find((visit) => visit.agentId === plan.source.id) ?? null;
  const visit = addVisit(plan.chain, {
    agentId: "pending",
    provider: plan.target.id,
    model: plan.modelId,
    sessionId,
    storeKey: plan.target.storeKey,
    family: plan.target.family,
    openedBy: "native",
    deliveryId: null,
    start: sourceVisit?.end ?? null,
    openedAt: ctx.now().toISOString(),
  });
  let link: DaemonLink;
  let moved: { agent: AgentLike; restored: boolean; reused: boolean };
  try {
    link = await ctx.connect();
  } catch (error) {
    return fallBack(run, visit, "notes.nativeUnavailable", error);
  }
  try {
    moved = await importSession(run, link, sessionId, visit);
  } catch (error) {
    await link.close().catch(() => undefined);
    return fallBack(run, visit, "notes.nativeFailed", error);
  }
  await link.close().catch(() => undefined);
  visit.agentId = moved.agent.id;
  await save(run);
  // Two agents must not write one session file: the source goes, whatever the setting says.
  const archivedSource = await leaveSource(run, { agentId: moved.agent.id }, true);
  if (plan.settings.afterHandoff === "keep") run.notes.push({ code: "notes.nativeArchives" });
  await appendRow(paseo, moved.agent.id, handoffRowId(`native-${visit.n}-${plan.deliveryId}`), ROW_HANDOFF, handoffRow(run, "native", { agentId: moved.agent.id, model: plan.modelId }, null));
  if (plan.messageGiven) {
    run.phase("sending");
    try {
      await paseo.agents.ref(moved.agent.id).send(plan.message, { messageId: `${MESSAGE_PREFIX}${ctx.newId()}` });
    } catch (error) {
      run.warnings.push({ code: "warnings.sendFailed", params: { error: errorText(error) } });
    }
  }
  return result(run, "native", moved.agent.id, plan.modelId, null, { restored: moved.restored, reused: moved.reused, archivedSource });
}

async function nativeSwitchBack(run: Run): Promise<MoveOutcome> {
  const { plan, ctx, paseo } = run;
  const lineageVisit = plan.route.lineage!;
  const sessionId = lineageVisit.sessionId!;
  const lineage = lineageOf(lineageVisit);
  const items = deltaItems(plan.chain, plan.history, lineage);
  const seen = plan.history.filter((item) => !items.includes(item)).reduce((max, item) => Math.max(max, item.n), 0);
  const visit = addVisit(plan.chain, {
    agentId: "pending",
    provider: plan.target.id,
    model: plan.modelId,
    sessionId,
    storeKey: plan.target.storeKey,
    family: plan.target.family,
    openedBy: "delta",
    deliveryId: plan.deliveryId,
    start: null,
    openedAt: ctx.now().toISOString(),
  });
  let link: DaemonLink;
  let moved: { agent: AgentLike; restored: boolean; reused: boolean };
  try {
    link = await ctx.connect();
  } catch (error) {
    return fallBack(run, visit, "notes.nativeUnavailable", error);
  }
  try {
    moved = await importSession(run, link, sessionId, visit);
  } catch (error) {
    await link.close().catch(() => undefined);
    return fallBack(run, visit, "notes.nativeFailed", error);
  }
  await link.close().catch(() => undefined);
  visit.agentId = moved.agent.id;
  await archiveLineage(run, lineage, moved.agent.id);
  const delivery = newDelivery(run, visit, moved.agent.id, "delta", seen || null, plan.envelope!);
  plan.chain.deliveries.push(delivery);
  if (plan.settings.transcriptFile) await plan.store.writeRecord(plan.chain.id, delivery.id, renderRecord(plan.chain, plan.history, ctx.now()));
  await plan.store.writeSent(plan.chain.id, delivery.id, plan.envelope!.text);
  await save(run);
  await appendRow(paseo, moved.agent.id, handoffRowId(delivery.id), ROW_HANDOFF, handoffRow(run, "native-switch-back", { agentId: moved.agent.id, model: plan.modelId }, delivery));
  run.phase("sending");
  try {
    await sendDelivery(paseo, ctx, moved.agent.id, delivery, plan.envelope!.text);
  } catch {
    run.warnings.push({ code: "warnings.sendFailed", params: { error: delivery.error ?? "" } });
  }
  await appendRow(paseo, moved.agent.id, handoffRowId(delivery.id), ROW_HANDOFF, handoffRow(run, "native-switch-back", { agentId: moved.agent.id, model: plan.modelId }, delivery));
  await save(run);
  const archivedSource = delivery.status === "accepted" ? await leaveSource(run, { agentId: moved.agent.id }) : false;
  return result(run, "native-switch-back", moved.agent.id, plan.modelId, delivery, { restored: moved.restored, reused: moved.reused, archivedSource });
}

/** Other agents of a lineage still open would write the same session file as the one carrying on: archive them. */
async function archiveLineage(run: Run, lineage: string, keep: string): Promise<void> {
  const { plan, paseo, ctx } = run;
  for (const agentId of new Set(plan.chain.visits.filter((visit) => lineageOf(visit) === lineage).map((visit) => visit.agentId))) {
    if (agentId === keep || agentId === plan.source.id) continue;
    const agent = await readSource(paseo, ctx, agentId).catch(() => null);
    if (agent && !agent.archivedAt) await paseo.agents.ref(agentId).archive().catch(() => undefined);
  }
}

/** A native route that could not run: forget its visit and hand off instead. */
async function fallBack(run: Run, visit: Visit, code: string, error: unknown): Promise<MoveOutcome> {
  const { plan, ctx } = run;
  plan.chain.visits = plan.chain.visits.filter((entry) => entry !== visit);
  run.notes.push({ code, params: { error: errorText(error) } });
  plan.route = { kind: "handoff", agentId: null, lineage: null };
  plan.deliveryId = ctx.newId();
  return handoff(run);
}

export async function executeMove(paseo: PaseoLike, ctx: FerryContext, plan: Plan, onPhase: (phase: Phase) => void = () => undefined): Promise<MoveOutcome> {
  const run: Run = { paseo, ctx, plan, notes: [...plan.notes], warnings: [...plan.warnings], phase: onPhase, startedAt: ctx.now().getTime() };
  switch (plan.route.kind) {
    case "native":
      return native(run);
    case "native-switch-back":
      return nativeSwitchBack(run);
    case "switch-back":
      return switchBack(run);
    default:
      return handoff(run);
  }
}
