import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { alertOnTrouble } from "./server/alerts";
import { createChainStore } from "./server/chain-store";
import type { FerryContext } from "./server/context";
import { connectDaemon, installAnchors, paseoHome, readDaemonAddress, resolveHostClient } from "./server/daemon-link";
import { trackTurn } from "./server/delivery";
import { registerHistoryTool } from "./server/history-tool";
import { createLocaleService } from "./server/i18n-server";
import { BUILTIN_CATALOGS } from "./server/locales";
import { createOperations } from "./server/operations";
import { chainOf, describe, forget, preview, retry, sentText, start, wait } from "./server/service";
import { findSessionFile } from "./server/session-files";
import { readStoredAgent } from "./server/stored-agent";
import type { PaseoLike } from "./server/types";
import { registerClientChunks } from "./server/ui-chunk";
import { PLUGIN_ID } from "./shared/plugin-id";
import { chainRpc, deliveryRpc, forgetRpc, planRpc, providersRpc, retryRpc, startRpc, waitRpc } from "./shared/rpc";
import { DEFAULT_SETTINGS, ferrySettings, settingsSchema, type FerrySettings } from "./shared/settings";

/**
 * Ferry's daemon side: the chains (files under `$PASEO_HOME/plugin-data/<id>/`), the moves, the history tool and the
 * turn-end watch for deliveries and limit notices. No network requests of its own and no subprocesses; native
 * continuation opens a second local connection to this daemon (see server/daemon-link.ts).
 */
export default function contribute(server: PluginServerContext) {
  const home = paseoHome();
  const locales = createLocaleService(server, { pluginId: PLUGIN_ID, builtins: BUILTIN_CATALOGS });
  const settingsHandle = server.registerSettings(ferrySettings);
  let settings: FerrySettings = DEFAULT_SETTINGS;
  let settingsRead = false;
  const take = (state: { status: string; values?: unknown }) => {
    if (state.status !== "ready") return;
    settings = settingsSchema.parse(state.values ?? {});
    settingsRead = true;
  };
  const stopSettings = settingsHandle.subscribe(take);
  void settingsHandle.read().then(take, () => undefined);

  const ctx: FerryContext = {
    store: createChainStore(join(home, "plugin-data", PLUGIN_ID)),
    async settings() {
      const state = await settingsHandle.read().catch(() => null);
      if (state) take(state);
      return settings;
    },
    daemonEnv: process.env,
    userHome: homedir(),
    connect: () => connectDaemon({ home }),
    async canConnect() {
      await readDaemonAddress(home);
      await resolveHostClient(await installAnchors());
      return true;
    },
    findSessionFile,
    readStoredAgent: (agentId) => readStoredAgent(agentId, home),
    now: () => new Date(),
    newId: () => randomUUID(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    log: (message, details) => console.error(`[${PLUGIN_ID}] ${message}`, details ?? ""),
    pending: new Map(),
  };
  const operations = createOperations(() => randomUUID());
  const api = (paseo: unknown) => paseo as PaseoLike;

  registerClientChunks(server);
  server.handle(providersRpc, ({ agentId }, { paseo }) => describe(api(paseo), ctx, agentId));
  server.handle(planRpc, (input, { paseo }) => preview(api(paseo), ctx, input));
  server.handle(startRpc, (input, { paseo }) => start(api(paseo), ctx, operations, input));
  server.handle(waitRpc, (input) => wait(operations, input));
  server.handle(retryRpc, (input, { paseo }) => retry(api(paseo), ctx, input));
  server.handle(chainRpc, ({ agentId }, { paseo }) => chainOf(api(paseo), ctx, agentId));
  server.handle(deliveryRpc, (input) => sentText(ctx, input));
  server.handle(forgetRpc, (input) => forget(ctx, input));

  const stopTool = registerHistoryTool(server, ctx, () => settings);
  const stopTurns = server.on("agent.turn_ended", (event, { paseo }) => {
    // Never hold the daemon's hook: the work runs on its own.
    void trackTurn(api(paseo), ctx, event).catch((error: unknown) => ctx.log("delivery tracking failed", { error: String(error) }));
    void alertOnTrouble(api(paseo), ctx, event).catch((error: unknown) => ctx.log("reply check failed", { error: String(error) }));
  });

  // Chains untouched for longer than the retention setting go, a minute after start and then daily; never while the
  // settings cannot be read (the default could be shorter than what the user chose).
  const sweep = () => {
    if (!settingsRead) return;
    void ctx.store.withLock("sweep", () => ctx.store.sweep(settings.retentionDays)).catch((error: unknown) => ctx.log("sweep failed", { error: String(error) }));
  };
  const first = setTimeout(sweep, 60_000);
  const daily = setInterval(sweep, 86_400_000);
  void ctx.store.ready();

  return () => {
    clearTimeout(first);
    clearInterval(daily);
    stopTurns();
    stopTool();
    void stopSettings();
    locales.dispose();
  };
}
