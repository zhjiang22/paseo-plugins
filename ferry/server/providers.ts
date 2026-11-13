// The daemon's providers as Ferry sees them: config (extends, env, Paseo tools) and the live snapshot (status, models,
// modes). Right after a reload or a restart the daemon is still probing providers, so the snapshot is read after
// waiting a moment for that to finish.

import { readProviders, type ProviderInfo } from "../shared/families";
import { TOOL_NAME } from "../shared/plugin-id";
import type { FerrySettings } from "../shared/settings";
import type { PaseoLike } from "./types";

const PROVIDERS_READY_MS = 8000;

export interface ProviderContext {
  daemonEnv: Readonly<Record<string, string | undefined>>;
  userHome: string;
}

export interface Providers {
  list: ProviderInfo[];
  /** Whether the daemon gives agents Paseo's MCP tools (and so plugin tools such as Ferry's history tool). */
  toolsInjected: boolean;
  get(id: string): ProviderInfo | undefined;
}

async function readSnapshot(paseo: PaseoLike) {
  if (paseo.providers.waitForReady) {
    try {
      return await paseo.providers.waitForReady({ timeoutMs: PROVIDERS_READY_MS });
    } catch {
      // Still probing after the wait: take what the daemon has.
    }
  }
  return paseo.providers.snapshot();
}

export async function loadProviders(paseo: PaseoLike, settings: Pick<FerrySettings, "stores">, context: ProviderContext): Promise<Providers> {
  const [{ config }, snapshot] = await Promise.all([paseo.config.get(), readSnapshot(paseo)]);
  const list = readProviders(config.providers ?? {}, snapshot.entries ?? [], {
    daemonEnv: context.daemonEnv,
    home: context.userHome,
    stores: settings.stores,
    toolName: TOOL_NAME,
  });
  const mcp = config.mcp ?? null;
  return {
    list,
    toolsInjected: mcp?.enabled !== false && mcp?.injectIntoAgents !== false,
    get: (id) => list.find((provider) => provider.id === id),
  };
}
