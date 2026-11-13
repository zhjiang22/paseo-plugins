// Whether a handoff reached the agent: "accepted" when the send went through, "read" once the agent's turn on it
// completes. A turn that fails because the route is down is retried once, five seconds later, with a new message id
// (the daemon's receipt for a failed send stays pending forever, so the old id cannot be reused). Anything else marks
// the delivery failed, and its row offers a retry or another agent.

import { failureKind } from "../shared/failure";
import type { Delivery } from "../shared/model";
import { ROW_HANDOFF } from "../shared/plugin-id";
import type { StartOutput } from "../shared/rpc";
import type { FerryContext } from "./context";
import { appendRow, handoffRowId, sendDelivery } from "./move";
import type { PaseoLike } from "./types";

const RETRY_DELAY_MS = 5000;
const MAX_AUTO_ATTEMPTS = 2;
const DAY_MS = 86_400_000;

export interface TurnEnded {
  agent: { id: string };
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
}

/** Shows the delivery's new status on its row (same id: the row is replaced). */
async function refreshRow(paseo: PaseoLike, delivery: Delivery): Promise<void> {
  if (!delivery.row) return;
  delivery.row = { ...delivery.row, status: delivery.status, error: delivery.error ?? null };
  await appendRow(paseo, delivery.targetAgentId, handoffRowId(delivery.id), ROW_HANDOFF, delivery.row);
}

/** Sends a delivery again from what it sent before; the RPC behind the row's Retry, and the automatic retry. */
export async function retryDelivery(paseo: PaseoLike, ctx: FerryContext, chainId: string, deliveryId: string): Promise<StartOutput> {
  return ctx.store.withLock(chainId, async () => {
    const chain = await ctx.store.read(chainId);
    const delivery = chain?.deliveries.find((entry) => entry.id === deliveryId);
    if (!chain || !delivery) return { status: "refused", reason: { code: "errors.deliveryMissing" } };
    if (delivery.status === "read") return { status: "refused", reason: { code: "errors.alreadyRead" } };
    // The conversation went on elsewhere since (another move, perhaps from this very agent): sending now would wake an
    // agent that is no longer the one carrying it.
    if (chain.visits.some((visit) => visit.n > delivery.visitN)) return { status: "refused", reason: { code: "errors.movedOn" } };
    const envelope = await ctx.store.readSent(chainId, deliveryId);
    if (!envelope) return { status: "refused", reason: { code: "errors.deliveryMissing" } };
    try {
      await sendDelivery(paseo, ctx, delivery.targetAgentId, delivery, envelope);
    } catch {
      // The delivery records the failure.
    }
    chain.updatedAt = ctx.now().toISOString();
    await ctx.store.write(chain);
    await refreshRow(paseo, delivery);
    if (delivery.status !== "accepted") return { status: "refused", reason: { code: "errors.retryFailed", params: { error: delivery.error ?? "" } } };
    const visit = chain.visits.find((entry) => entry.n === delivery.visitN);
    return {
      status: "done",
      result: {
        agentId: delivery.targetAgentId,
        route: delivery.mode === "delta" ? "switch-back" : "handoff",
        from: { agentId: delivery.row?.from.agentId ?? "", provider: delivery.row?.from.provider ?? "", label: delivery.row?.from.label ?? "" },
        to: { provider: visit?.provider ?? "", label: delivery.row?.to.label ?? visit?.provider ?? "", model: visit?.model ?? null },
        chainId,
        deliveryId,
        selected: delivery.selected,
        total: delivery.total,
        restored: false,
        reused: true,
        archivedSource: false,
        notes: [{ code: "notes.retried" }],
        warnings: [],
      },
    };
  });
}

/** Records what a turn on a delivery's target means for the delivery. */
export async function trackTurn(paseo: PaseoLike, ctx: FerryContext, event: TurnEnded, schedule: (task: () => void, ms: number) => void = (task, ms) => void setTimeout(task, ms)): Promise<void> {
  await ctx.store.ready();
  const chainId = ctx.store.chainOf(event.agent.id);
  if (!chainId) return;
  let retry: string | null = null;
  await ctx.store.withLock(chainId, async () => {
    const chain = await ctx.store.read(chainId);
    if (!chain) return;
    const delivery = [...chain.deliveries].reverse().find((entry) => entry.targetAgentId === event.agent.id && (entry.status === "accepted" || entry.status === "pending"));
    if (!delivery) {
      // A conversation still in use is not untouched: the retention sweep counts from here too (one write a day at most).
      if (ctx.now().getTime() - Date.parse(chain.updatedAt) > DAY_MS) {
        chain.updatedAt = ctx.now().toISOString();
        await ctx.store.write(chain);
      }
      return;
    }
    if (event.outcome.kind === "completed") {
      delivery.status = "read";
      delete delivery.error;
    } else if (event.outcome.kind === "canceled") {
      delivery.status = "canceled";
    } else {
      const reason = event.outcome.error.message;
      if (failureKind("error", null, reason) === "connection" && delivery.attempts.length < MAX_AUTO_ATTEMPTS) retry = delivery.id;
      delivery.status = "failed";
      delivery.error = reason;
    }
    chain.updatedAt = ctx.now().toISOString();
    await ctx.store.write(chain);
    await refreshRow(paseo, delivery);
  });
  if (retry) {
    const deliveryId: string = retry;
    schedule(() => {
      void retryDelivery(paseo, ctx, chainId, deliveryId).catch((error: unknown) => ctx.log("retry failed", { error: String(error) }));
    }, RETRY_DELAY_MS);
  }
}
