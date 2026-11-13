import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SETTINGS_ID } from "../shared/settings-id";

/**
 * The few settings the resident client needs, read without the full schema (the views and the server check the
 * whole document): whether every composer has Ferry's button, whether a failed turn changes it, the partners, and the
 * slash alias.
 */
export interface StubSettings {
  composerButton: boolean;
  failurePill: boolean;
  partners: { from: string; to: string }[];
  slashAlias: string;
}

const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function stubSettings(values: unknown): StubSettings {
  const all = record(values);
  const partners = Array.isArray(all.partners)
    ? all.partners.map(record).filter((entry) => typeof entry.from === "string" && typeof entry.to === "string").map((entry) => ({ from: entry.from as string, to: entry.to as string }))
    : [];
  const alias = typeof all.slashAlias === "string" && /^[a-z][a-z0-9-]{0,30}$/.test(all.slashAlias) ? all.slashAlias : "";
  return { composerButton: all.composerButton !== false, failurePill: all.failurePill !== false, partners, slashAlias: alias };
}

export async function readStubSettings(client: PluginClientContext): Promise<StubSettings> {
  const state = await client.rpc(settingsRpc(SETTINGS_ID).read, {});
  return stubSettings(state.status === "ready" ? state.values : {});
}
