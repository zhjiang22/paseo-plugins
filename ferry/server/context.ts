// What Ferry's server parts share: its files, its settings, the way to the daemon's internals, and the clock. Tests
// build one with fakes.

import type { FerrySettings } from "../shared/settings";
import type { ChainStore } from "./chain-store";
import type { DaemonLink } from "./daemon-link";
import type { AgentLike } from "./types";

export interface FerryContext {
  store: ChainStore;
  settings(): Promise<FerrySettings>;
  daemonEnv: Readonly<Record<string, string | undefined>>;
  userHome: string;
  /** The second connection (native continuation, stopping a turn); throws when Paseo's internals are not there. */
  connect(): Promise<DaemonLink>;
  /** Whether `connect` can work at all, without connecting (files present, client found). Cached by the caller. */
  canConnect(): Promise<boolean>;
  findSessionFile(storeKey: string, sessionId: string): Promise<string | null | undefined>;
  readStoredAgent(agentId: string): Promise<AgentLike | null>;
  now(): Date;
  newId(): string;
  sleep(ms: number): Promise<void>;
  /** The time zone a reset time without one is read in. */
  zone?: string;
  log(message: string, details?: Record<string, unknown>): void;
  /** Agents being created for a chain right now: the session-open hook must know them before the chain file says so. */
  pending: Map<string, string>;
}
