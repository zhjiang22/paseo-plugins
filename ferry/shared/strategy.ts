// Which way a conversation goes to a provider:
//
// - native: the target reads the same session store (same CLI, same directory): import the very session;
// - switch-back: an agent on the target already had this conversation earlier: send it only what it missed;
// - native-switch-back: an earlier stretch ran on a provider that shares the target's store: import that session on
//   the target and send it what it missed;
// - handoff: a new agent on the target, given the history as text.
//
// The most recent earlier stretch wins. Everything here is decided from data the server gathered; running a route
// may still fail (an import refused, a send rejected), and then the server falls back to a handoff.

import { sharesStore, type ProviderInfo } from "./families";
import type { Chain, Visit } from "./model";
import type { RouteKind } from "./kinds";

export interface RouteSource {
  agentId: string;
  provider: ProviderInfo | null;
  sessionId: string | null;
  /** The session file was found in the store (undefined: the store cannot be searched, try the import). */
  sessionFile: boolean | undefined;
}

export interface RouteDecision {
  kind: RouteKind;
  /** switch-back: the agent to send to. */
  agentId: string | null;
  /** native-switch-back: the earlier stretch whose session is imported. */
  lineage: Visit | null;
}

/** Visits that share a provider session natively, keyed the same way history.ts keys lineages. */
function lineageKey(visit: Pick<Visit, "storeKey" | "sessionId" | "agentId">): string {
  return visit.storeKey && visit.sessionId ? `${visit.storeKey}|${visit.sessionId}` : `agent:${visit.agentId}`;
}

export function decideRoute(input: {
  source: RouteSource;
  target: ProviderInfo;
  chain: Chain | null;
  /** Native continuation allowed: the setting is on and the second connection works. */
  native: boolean;
  /** Start a new agent whatever else is possible. */
  fresh: boolean;
  /** Agents that still exist (an earlier agent may have been deleted). */
  exists: (agentId: string) => boolean;
}): RouteDecision {
  const { source, target, chain } = input;
  const none: RouteDecision = { kind: "handoff", agentId: null, lineage: null };
  if (input.fresh) return none;
  if (input.native && source.provider && source.sessionId && source.sessionFile !== false && sharesStore(source.provider, target)) {
    return { kind: "native", agentId: null, lineage: null };
  }
  if (!chain) return none;
  const sourceVisit = [...chain.visits].reverse().find((visit) => visit.agentId === source.agentId);
  const sourceLineage = sourceVisit ? lineageKey(sourceVisit) : `agent:${source.agentId}`;
  const seen = new Set<string>([sourceLineage]);
  for (const visit of [...chain.visits].sort((a, b) => b.n - a.n)) {
    const key = lineageKey(visit);
    if (seen.has(key)) continue;
    seen.add(key);
    const members = chain.visits.filter((entry) => lineageKey(entry) === key).sort((a, b) => b.n - a.n);
    const onTarget = members.find((entry) => entry.provider === target.id && input.exists(entry.agentId));
    if (onTarget) return { kind: "switch-back", agentId: onTarget.agentId, lineage: onTarget };
    if (input.native && visit.sessionId && visit.storeKey && sharesStore({ id: visit.provider, family: visit.family as ProviderInfo["family"], storeKey: visit.storeKey }, target)) {
      return { kind: "native-switch-back", agentId: null, lineage: visit };
    }
  }
  return none;
}
