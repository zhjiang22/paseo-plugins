import type { PluginServerContext } from "@getpaseo/plugin/server";
import { hookTimeline, turnTimeline, type TurnTimeline, type TurnTimelinePaseo } from "./turn-timeline";

type On = PluginServerContext["on"];
type Name = Parameters<On>[0];
type Handler = (input: unknown, context: unknown) => unknown;
type Item = { type: string };

/** How the hub filled in an `agent.turn_ended` input that came without the conversation (Paseo 0.13). */
export type TurnRead = Pick<TurnTimeline<Item>, "positions" | "complete">;
const reads = new WeakMap<object, TurnRead>();
/** Null when the hook brought its own timeline (Paseo 0.12 and older: the whole conversation). */
export function turnRead(input: object): TurnRead | null { return reads.get(input) ?? null; }

/**
 * One host registration per lifecycle event (opus-F15). The host structuredClones a hook's input once for every handler
 * it calls, and on Paseo 0.12 `agent.turn_ended` carries the Agent's whole projected timeline: six handlers meant six deep
 * copies of it on every turn of every Agent. Modules keep calling `server.on` on the wrapped context; the hub registers a
 * single host handler per event and runs theirs in registration order on that one copy, one after another, each failure
 * on its own, as the host does. The input is shared, so handlers treat it as read-only (the timeline is typed readonly).
 *
 * Paseo 0.13 sends `agent.turn_ended` with `timeline: []` (getpaseo/paseo#7477), and 0.16 drops the field from the SDK
 * type (sent as `[]` until 2027-05-31, then omitted). The hub then reads the end of the conversation once, back to the
 * latest user message (`turnTimeline`), and hands every handler that window as `timeline` (read it with `hookTimeline`);
 * `turnRead(input)` tells how far it reaches. While such a turn end is being read and handled, the Agent's later events
 * wait in order behind it, so a turn that starts right away (a queued message) is never handled before the end of the
 * turn before it. Without a read (0.12, or no Agent) events run at once, as before.
 */
export function lifecycleHub(server: PluginServerContext): { server: PluginServerContext; registered(): string[]; close(): void } {
  const handlers = new Map<Name, Set<Handler>>();
  const hosts = new Map<Name, () => void>();
  /** Per Agent, the last event queued behind a turn-end read. */
  const queues = new Map<string, Promise<void>>();
  const dispatch = (name: Name) => (input: unknown, context: unknown): Promise<void> => {
    const agentId = agentOf(input);
    const needsRead = name === "agent.turn_ended" && agentId !== null && emptyTimeline(input);
    const run = async () => {
      const shared = needsRead ? await fill(input as Record<string, unknown>, agentId!, context) : input;
      for (const handler of [...(handlers.get(name) ?? [])]) {
        try { await handler(shared, context); } catch (error) { console.error(`agent-observatory: ${name} handler failed`, error); }
      }
    };
    const previous = agentId === null ? undefined : queues.get(agentId);
    if (agentId === null || (!previous && !needsRead)) return run();
    const current = previous ? previous.then(run) : run();
    const settled = current.then(() => undefined, () => undefined);
    queues.set(agentId, settled);
    void settled.then(() => { if (queues.get(agentId) === settled) queues.delete(agentId); });
    return current;
  };
  const on = ((name: Name, handler: Handler) => {
    let set = handlers.get(name);
    if (!set) { set = new Set(); handlers.set(name, set); }
    set.add(handler);
    if (!hosts.has(name)) hosts.set(name, server.on(name, dispatch(name) as never));
    return () => {
      const current = handlers.get(name);
      if (!current?.delete(handler) || current.size) return;
      handlers.delete(name);
      const remove = hosts.get(name); hosts.delete(name); remove?.();
    };
  }) as unknown as On;
  // Everything else (handle, registerSettings …) goes to the host context unchanged, called on the context itself.
  const wrapped = new Proxy(server, { get: (target, property) => {
    if (property === "on") return on;
    const value = Reflect.get(target, property, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  return {
    server: wrapped,
    registered: () => [...hosts.keys()],
    close() { for (const remove of hosts.values()) remove(); hosts.clear(); handlers.clear(); },
  };
}

function agentOf(input: unknown): string | null {
  const agent = (input as { agent?: { id?: unknown } } | null)?.agent;
  return typeof agent?.id === "string" && agent.id ? agent.id : null;
}

/** `[]` (Paseo 0.13–0.16) or no field at all (the 0.16 SDK type; the daemon stops sending `[]` after 2027-05-31). */
function emptyTimeline(input: unknown): boolean {
  return hookTimeline(input).length === 0;
}

/** Short enough that a few turn ends queued behind each other stay inside the host's 30 s hook timeout. */
const READ_MS = 6_000;

async function fill(input: Record<string, unknown>, agentId: string, context: unknown): Promise<Record<string, unknown>> {
  const paseo = (context as { paseo?: TurnTimelinePaseo } | null)?.paseo;
  const read = await turnTimeline<Item>(paseo, agentId, [], { timeoutMs: READ_MS });
  const filled = { ...input, timeline: read.items };
  reads.set(filled, { positions: read.positions, complete: read.complete });
  return filled;
}
