import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { PLUGIN_ID } from "./plugin-id";
import { deliveryStatus, routeKind } from "./kinds";

// Ferry's RPCs. Messages for the screens travel as `{ code, params }` (catalog ids), so each device words them itself.

const rpc = (name: string) => `${PLUGIN_ID}.${name}`;

/** Ids and targets from the app: bounded, so nothing unexpected reaches the server's checks. */
const id = z.string().max(200);
export const note = z.object({ code: z.string(), params: z.record(z.string(), z.union([z.string(), z.number()])).optional() });
export type NoteData = z.infer<typeof note>;

const tier = z.enum(["planning", "safe", "moderate", "dangerous"]);

export const providerSummary = z.object({
  id: z.string(),
  label: z.string(),
  family: z.string(),
  source: z.enum(["builtin", "custom"]),
  enabled: z.boolean(),
  ready: z.boolean(),
  status: z.string(),
  models: z.array(z.object({ id: z.string(), label: z.string(), isDefault: z.boolean(), window: z.number().nullable(), thinking: z.array(z.string()), defaultThinking: z.string().nullable() })),
  modes: z.array(z.object({ id: z.string(), label: z.string(), tier })),
  defaultModeId: z.string().nullable(),
  storeKey: z.string().nullable(),
  /** The store's directory for display, `~` for the home directory. */
  storePath: z.string().nullable(),
  toolDisabled: z.boolean(),
});
export type ProviderSummary = z.infer<typeof providerSummary>;

export const routeChoice = z.object({
  provider: z.string(),
  kind: z.union([routeKind, z.enum(["unavailable", "same"])]),
  reason: note.nullable(),
  /** The agent a switch-back returns to. */
  targetAgentId: z.string().nullable(),
});
export type RouteChoice = z.infer<typeof routeChoice>;

export const agentSummary = z.object({
  id: z.string(),
  title: z.string().nullable(),
  provider: z.string(),
  model: z.string().nullable(),
  status: z.string(),
  failure: z.enum(["limit", "connection", "context", "error"]).nullable(),
  lastError: z.string().nullable(),
  archived: z.boolean(),
  chainId: z.string().nullable(),
  visits: z.number().int(),
  /** Why this agent cannot be moved at all (no conversation yet). */
  blocked: note.nullable(),
});

export const providersRpc = defineRpc({
  name: rpc("providers"),
  input: z.object({ agentId: id.optional() }),
  output: z.object({
    providers: z.array(providerSummary),
    agent: agentSummary.nullable(),
    routes: z.array(routeChoice),
    /** The partner configured for the agent's provider, when it can be used now. */
    partner: z.string().nullable(),
    native: z.object({ available: z.boolean(), reason: note.nullable() }),
  }),
});
export type ProvidersInfo = z.infer<(typeof providersRpc)["output"]>;

const targetSummary = z.object({
  provider: z.string(),
  label: z.string(),
  model: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingId: z.string().nullable(),
});

const budgetSummary = z.object({ cap: z.number(), window: z.number(), used: z.number(), message: z.number(), headroom: z.number(), effective: z.number() });
const selectionSummary = z.object({
  mode: z.enum(["full", "delta"]),
  selected: z.number().int(),
  total: z.number().int(),
  bytes: z.number().int(),
  omitted: z.array(z.tuple([z.number(), z.number()])),
});

export const planRpc = defineRpc({
  name: rpc("plan"),
  input: z.object({ agentId: id, target: id, message: z.string().max(20_000).optional(), fresh: z.boolean().optional(), preview: z.boolean().optional() }),
  output: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      route: routeKind,
      target: targetSummary,
      budget: budgetSummary.nullable(),
      selection: selectionSummary.nullable(),
      notes: z.array(note),
      warnings: z.array(note),
      preview: z.string().nullable(),
      previewTruncated: z.boolean(),
    }),
    z.object({ status: z.literal("refused"), reason: note }),
  ]),
});
export type PlanResult = z.infer<(typeof planRpc)["output"]>;

export const moveResult = z.object({
  agentId: z.string(),
  route: routeKind,
  from: z.object({ agentId: z.string(), provider: z.string(), label: z.string() }),
  to: z.object({ provider: z.string(), label: z.string(), model: z.string().nullable() }),
  chainId: z.string(),
  deliveryId: z.string().nullable(),
  selected: z.number().int(),
  total: z.number().int(),
  /** Native: the target provider's own earlier agent came back. */
  restored: z.boolean(),
  /** An agent that already held this conversation was used. */
  reused: z.boolean(),
  archivedSource: z.boolean(),
  notes: z.array(note),
  warnings: z.array(note),
});
export type MoveResult = z.infer<typeof moveResult>;

export const startOutput = z.discriminatedUnion("status", [
  z.object({ status: z.literal("done"), result: moveResult }),
  z.object({ status: z.literal("pending"), opId: z.string(), phase: z.string() }),
  z.object({ status: z.literal("running"), reason: note }),
  z.object({ status: z.literal("choose"), reason: note }),
  z.object({ status: z.literal("refused"), reason: note }),
]);
export type StartOutput = z.infer<typeof startOutput>;

export const startRpc = defineRpc({
  name: rpc("start"),
  input: z.object({
    requestId: z.string().min(8).max(80),
    agentId: id,
    /** `provider` or `provider/model`; omitted: the configured partner. */
    target: id.optional(),
    message: z.string().max(20_000).optional(),
    stopRunning: z.boolean().optional(),
    fresh: z.boolean().optional(),
  }),
  output: startOutput,
});

export const waitRpc = defineRpc({
  name: rpc("wait"),
  input: z.object({ opId: id, timeoutMs: z.number().int().min(0).max(25_000).optional() }),
  output: startOutput,
});

export const retryRpc = defineRpc({
  name: rpc("retry"),
  input: z.object({ chainId: id, deliveryId: id }),
  output: startOutput,
});

export const chainRpc = defineRpc({
  name: rpc("chain"),
  input: z.object({ agentId: id }),
  output: z.object({
    chain: z
      .object({
        id: z.string(),
        visits: z.array(
          z.object({
            n: z.number(),
            agentId: z.string(),
            provider: z.string(),
            model: z.string().nullable(),
            openedBy: z.string(),
            openedAt: z.string(),
            closedAt: z.string().nullable(),
            itemCount: z.number(),
          }),
        ),
        deliveries: z.array(
          z.object({ id: z.string(), visitN: z.number(), targetAgentId: z.string(), mode: z.enum(["full", "delta"]), selected: z.number(), total: z.number(), status: deliveryStatus, at: z.string().nullable() }),
        ),
      })
      .nullable(),
  }),
});

export const deliveryRpc = defineRpc({
  name: rpc("delivery"),
  input: z.object({ chainId: id, deliveryId: id }),
  output: z.object({ text: z.string().nullable(), truncated: z.boolean() }),
});

export const forgetRpc = defineRpc({
  name: rpc("forget"),
  input: z.object({ chainId: id }),
  output: z.object({ removed: z.number().int() }),
});
