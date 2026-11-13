// A second connection to this daemon, for what the plugin API does not offer yet: importing a provider session into a
// given workspace (native continuation), and setting an imported agent's mode, model, thinking and name, or stopping a
// running turn. Paseo's `paseo agent import` CLI cannot name the workspace, and the daemon then picks the oldest
// workspace of that directory, which is often another one.
//
// It loads the daemon's own @getpaseo/client (never a bundled copy, so it always speaks the daemon's protocol) and signs
// in with the local credential (`$PASEO_HOME/local-credential`), exactly like the paseo CLI on this machine. These are
// Paseo internals: when any of it is missing, native continuation is unavailable and Ferry hands over instead.

import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PLUGIN_ID } from "../shared/plugin-id";
import { paseoHome } from "./i18n-server";
import type { AgentLike } from "./types";

export interface ImportAgentRequest {
  providerId: string;
  providerHandleId: string;
  cwd: string;
  workspaceId?: string;
  labels?: Record<string, string>;
}

/** The part of the daemon client this plugin uses. */
export interface DaemonLink {
  importAgent(input: ImportAgentRequest): Promise<AgentLike>;
  setAgentMode(agentId: string, modeId: string): Promise<unknown>;
  setAgentModel(agentId: string, modelId: string | null): Promise<unknown>;
  setAgentThinkingOption(agentId: string, thinkingOptionId: string | null): Promise<unknown>;
  updateAgent(agentId: string, updates: { name?: string; labels?: Record<string, string> }): Promise<unknown>;
  cancelAgent(agentId: string): Promise<unknown>;
  close(): Promise<unknown>;
}

interface HostClientModule {
  createHostClient(
    connection: string,
    config: {
      clientId: string;
      clientType: string;
      appVersion: string;
      localCredential: () => string | undefined;
      connectTimeoutMs: number;
      reconnect: { enabled: boolean };
    },
  ): DaemonLink & { connect(): Promise<void> };
}

/** Not `plugin:…`: the daemon keeps that prefix for plugin sessions. */
export const LINK_CLIENT_ID = `${PLUGIN_ID}-link`;

/** The daemon's home, resolved the way Paseo does (and the same one the language folder uses). */
export { paseoHome };

/** Files of the running Paseo to resolve the client from: this process (run by @getpaseo/server), then `paseo` on PATH. */
export async function installAnchors(env: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): Promise<string[]> {
  const anchors: string[] = [];
  if (argv[1]) anchors.push(argv[1]);
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "paseo");
    try {
      await access(candidate);
      anchors.push(await realpath(candidate));
      break;
    } catch {
      // Not here.
    }
  }
  return anchors;
}

/** The daemon's @getpaseo/client/node entry and its version. */
export async function resolveHostClient(anchors: readonly string[]): Promise<{ entry: string; version: string | null }> {
  for (const anchor of anchors) {
    let entry: string;
    try {
      entry = createRequire(anchor).resolve("@getpaseo/client/node");
    } catch {
      continue;
    }
    return { entry, version: await packageVersion(entry, "@getpaseo/client") };
  }
  throw new Error("Paseo's own @getpaseo/client was not found (the plugin runs inside the Paseo daemon, or `paseo` is on PATH).");
}

async function packageVersion(file: string, name: string): Promise<string | null> {
  let directory = dirname(file);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8")) as { name?: string; version?: string };
      if (manifest.name === name) return manifest.version ?? null;
    } catch {
      // Keep walking up.
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

export async function readDaemonAddress(home: string): Promise<{ listen: string; token: string }> {
  let listen: unknown;
  try {
    listen = (JSON.parse(await readFile(join(home, "paseo.pid"), "utf8")) as { listen?: unknown }).listen;
  } catch {
    throw new Error(`Cannot read the daemon's address (${join(home, "paseo.pid")}). Is the daemon running?`);
  }
  if (typeof listen !== "string" || !listen) throw new Error(`${join(home, "paseo.pid")} has no listen address.`);
  let token: string;
  try {
    token = (await readFile(join(home, "local-credential"), "utf8")).trim();
  } catch {
    throw new Error(`Cannot read the local credential (${join(home, "local-credential")}).`);
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("The local credential has an unexpected format.");
  return { listen, token };
}

export async function connectDaemon(options: { home?: string; timeoutMs?: number; anchors?: readonly string[] } = {}): Promise<DaemonLink> {
  const home = options.home ?? paseoHome();
  const { listen, token } = await readDaemonAddress(home);
  const { entry, version } = await resolveHostClient(options.anchors ?? (await installAnchors()));
  // A runtime path: the bundler leaves it alone and Node loads the daemon's own copy with its own dependencies.
  const module = (await import(pathToFileURL(entry).href)) as HostClientModule;
  const client = module.createHostClient(listen, {
    clientId: LINK_CLIENT_ID,
    clientType: "cli",
    appVersion: version ?? "0.0.0",
    localCredential: () => token,
    connectTimeoutMs: options.timeoutMs ?? 15_000,
    reconnect: { enabled: false },
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`Cannot connect to the daemon (${listen}): ${error instanceof Error ? error.message : String(error)}`);
  }
  return client;
}
