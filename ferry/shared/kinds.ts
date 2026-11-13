import { z } from "zod";

// The data of Ferry's timeline rows. Rows hold message codes and names, never worded text: each device words them in
// its own language. The resident client registers the renderers with a lenient schema; the views check these.

export const routeKind = z.enum(["native", "switch-back", "native-switch-back", "handoff"]);
export type RouteKind = z.infer<typeof routeKind>;

export const deliveryStatus = z.enum(["pending", "accepted", "read", "failed", "canceled"]);

const endpoint = z.object({ agentId: z.string().nullable(), provider: z.string(), label: z.string() });

/** On the agent a conversation arrived at (or came back to). */
export const handoffRow = z.object({
  route: routeKind,
  chainId: z.string(),
  deliveryId: z.string().nullable(),
  from: endpoint,
  to: endpoint.extend({ model: z.string().nullable() }),
  mode: z.enum(["full", "delta"]).nullable(),
  selected: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  status: deliveryStatus.nullable(),
  error: z.string().nullable().optional(),
  at: z.string(),
});
export type HandoffRow = z.infer<typeof handoffRow>;

/** On the agent a conversation left, when it is kept open. */
export const movedRow = z.object({ chainId: z.string(), to: endpoint, at: z.string() });
export type MovedRow = z.infer<typeof movedRow>;

/** After a turn that ended on the provider's limit (or a full context) without failing. */
export const alertRow = z.object({
  kind: z.enum(["limit", "context", "connection", "error"]),
  resetAt: z.string().nullable(),
  resetGuessed: z.boolean().optional(),
  partner: z.string().nullable(),
  at: z.string(),
});
export type AlertRow = z.infer<typeof alertRow>;
