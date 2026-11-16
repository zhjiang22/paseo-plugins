import { t } from "../shared/text";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { DeferredSend, type DeferredAgentSnapshot, type DeferredGuard } from "./deferred-send";
import { resolvePaseoHome } from "./paseo-home";
import { readSendCapabilities } from "./steerable-providers";
import { telemetryDirectory } from "./telemetry";
import { observatoryDeferred } from "../shared/steer";
import type { PaseoApi } from "./paseo-types";

type LedgerOptions = ConstructorParameters<typeof DeferredSend>[0];
/**
 * Every message the plugin sends to an Agent (快捷回复, 发给这个 Agent) goes through one ledger (the shared kit's
 * `DeferredSend`): sent now, planned again here at the last moment from the Agent as it is, or queued for 「等这一轮结束再发」.
 * One file beside the plugin's other data, so it survives reloads; the per-agent send locks are shared with the other
 * plugins' ledgers. `guard`: the check of a quick reply's turn (`answeringGuard`); `file` and `capabilities` are for tests.
 */
export function createSendLedger(options: { file?: string; capabilities?: LedgerOptions["capabilities"]; guard?: LedgerOptions["guard"] } = {}): DeferredSend {
  return new DeferredSend({ file: options.file ?? join(telemetryDirectory(), "deferred-send.json"),
    capabilities: options.capabilities ?? (() => readSendCapabilities({ PASEO_HOME: resolvePaseoHome() })), guard: options.guard });
}

/**
 * What the plugin observed of each Agent's latest turn (server/telemetry.ts `TelemetryStore`). `persistenceError`: the store's
 * own, set while its record may be incomplete (a history it could not read and restarted, an event it could not record).
 */
interface ObservedTurns { snapshot(agentId: string): Promise<{ persistenceError?: string | null; agents: ReadonlyArray<{ agentId: string; turnStartedAt?: string | null }> }> }
const instant = (value: string | null | undefined) => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
/**
 * The ledger's check of a quick reply (codex-obs-attn-R3), the server's own `answering` and `sameRound`
 * (client/send-check.ts), asked under the Agent's send lock right before the reply goes out, and before a queued one is
 * delivered. Its guard names the turn it answers: `prompt`, that turn's lastUserMessageAt, and `round`, when the plugin saw
 * it start. The reply fits only while the Agent still rests after that very turn: idle or not loaded, no turn open, no
 * message since, and no turn seen starting after `round` (a heartbeat's rounds start without a message). Without a round
 * (none was observed) the Agent's state decides alone, as on the client. With one, only the plugin's own record of this
 * Agent's latest turn can tell, so a round that record cannot vouch for throws (codex-obs-attn-R3-remaining): the store
 * reports an error, holds no valid round for this Agent (a history restored empty from a damaged file) or only one older than
 * the reply's; so does a read that fails. The ledger answers that busy when sent now and holds a queued reply: it never goes
 * out on a guess, and is never dropped for one either.
 */
export function answeringGuard(turns: ObservedTurns) {
  return async ({ agentId, guard, agent }: { agentId: string; guard: DeferredGuard; agent: DeferredAgentSnapshot }): Promise<string | null> => {
    const title = (agent as { title?: string | null }).title?.trim().slice(0, 60) || t("serverSendLedger.m001");
    if (instant(agent.lastUserMessageAt) !== instant(guard.prompt) || !!agent.activeTurn || agent.status === "running") return t("serverSendLedger.m002", { title: title });
    if (agent.status !== "idle" && agent.status !== "closed") return t("serverSendLedger.m003", { title: title });
    const round = instant(guard.round);
    if (round === null) return null;
    const observed = await turns.snapshot(agentId);
    if (observed.persistenceError) throw new Error(t("serverSendLedger.m004", { title: title }));
    const seen = instant(observed.agents.find(item => item.agentId === agentId)?.turnStartedAt);
    if (seen === null || seen < round) throw new Error(t("serverSendLedger.m005", { title: title }));
    return seen > round ? t("serverSendLedger.m006", { title: title }) : null;
  };
}

/**
 * The host context with every RPC handing the ledger the daemon API first: after a reload the ledger has none until a call
 * or a hook brings one, so the first call of any kind (the sidebar badge polls) lets queued messages go out again.
 */
export function handingOver(host: PluginServerContext, ledger: { use(paseo: PaseoApi | null | undefined): void }): PluginServerContext {
  // Paseo 0.16 overloads `handle` (RPCs and subscriptions); this wrapper only ever registers RPCs, typed as the RPC overload.
  type Handle = PluginServerContext["handle"];
  const handle = ((contract: Parameters<Handle>[0], handler: Parameters<Handle>[1]) => host.handle(contract, (input, call) => { ledger.use(call?.paseo); return handler(input, call); })) as Handle;
  return new Proxy(host, { get: (target, property) => {
    if (property === "handle") return handle;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** `observatory.deferred.send / enqueue / list / cancel / resume`, answered by the ledger. */
export function registerSendLedger(server: Pick<PluginServerContext, "handle">, ledger: DeferredSend): void {
  server.handle(observatoryDeferred.send, (input, { paseo }) => ledger.send(input, paseo));
  server.handle(observatoryDeferred.enqueue, (input, { paseo }) => ledger.enqueue(input, paseo));
  server.handle(observatoryDeferred.list, input => ledger.list(input));
  server.handle(observatoryDeferred.cancel, ({ messageId }) => ledger.cancel(messageId));
  // 立即发送 a scheduled message (`now`), or 仍然发送 a held one (its time, if any, kept).
  server.handle(observatoryDeferred.resume, ({ messageId, now }, { paseo }) => ledger.resume(messageId, paseo, { now }));
}
