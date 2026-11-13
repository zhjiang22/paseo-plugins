// A turn that "completed" with the provider's limit notice, or one of its errors, as the reply leaves the agent idle,
// with no error and so no failure button. When that happens Ferry adds a row under the turn: what went wrong, when a
// limit resets if the notice said, and the way to the partner or another agent. One row per turn; a failed turn is the
// failure button's job.

import { findProvider } from "../shared/families";
import type { AlertRow } from "../shared/kinds";
import { PLUGIN_ID, ROW_ALERT } from "../shared/plugin-id";
import { partnerFor } from "../shared/settings";
import type { FerryContext } from "./context";
import { turnTrouble } from "./limit-notice";
import { appendRow } from "./move";
import { loadProviders } from "./providers";
import { readRows } from "./timeline-reader";
import { isTurnStart } from "../shared/turn-start";
import type { PaseoLike } from "./types";

export interface TurnEndedEvent {
  agent: { id: string; provider: string };
  turnId: string | null;
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled"; reason: string };
}

export async function alertOnTrouble(paseo: PaseoLike, ctx: FerryContext, event: TurnEndedEvent): Promise<AlertRow | null> {
  if (event.outcome.kind !== "completed") return null;
  const settings = await ctx.settings();
  if (!settings.alertRows) return null;
  const read = await readRows(paseo, event.agent.id, { pageSize: 40, maxRows: 120, timeoutMs: 8000, enough: (rows) => rows.some((row) => isTurnStart(row.item)) });
  const now = ctx.now().getTime();
  const limit = turnTrouble({ items: read.rows.map((row) => row.item), now, zone: ctx.zone });
  if (!limit) return null;
  let partner: string | null = null;
  try {
    const providers = await loadProviders(paseo, settings, ctx);
    partner = partnerFor(settings, event.agent.provider, (target) => {
      const match = findProvider(providers.list, target);
      return !!match && match.provider.ready && match.provider.id !== event.agent.provider;
    });
  } catch {
    // The row still says what happened.
  }
  const row: AlertRow = { kind: limit.kind, resetAt: limit.resetAt, ...(limit.resetGuessed ? { resetGuessed: true } : {}), partner, at: new Date(now).toISOString() };
  const turn = event.turnId ?? String(read.lastSeq ?? now);
  await appendRow(paseo, event.agent.id, `${PLUGIN_ID}-alert-${turn}`, ROW_ALERT, row);
  return row;
}
