#!/usr/bin/env node
// ferry: move a Paseo conversation to another provider from a terminal, through the plugin's own RPCs (the same path
// as /ferry in the app). Needs the Ferry plugin running on the daemon.
//
//   ferry <agent> [provider[/model]] [message…] [--stop] [--fresh] [--json]
//   ferry providers [<agent>] [--json]       providers, and how this agent would go to each
//   ferry plan <agent> <provider[/model]> [--preview] [--json]
//   ferry chain <agent> [--json]             the conversation's stretches and handoffs
//   ferry sent <chain> <delivery>            exactly what a handoff sent
//   ferry retry <chain> <delivery>           send a handoff that did not get through again
//
// <agent> is an agent id, a unique id prefix, or an exact title. The daemon is found the way the paseo CLI finds it:
// $PASEO_HOME (default ~/.paseo), its paseo.pid and local-credential.

import { randomUUID } from "node:crypto";
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ID = "ferry";
const rpc = (name) => `${PLUGIN_ID}.${name}`;
const here = dirname(fileURLToPath(import.meta.url));

function usage(code = 0) {
  console.log(`Usage:
  ferry <agent> [provider[/model]] [message…] [--stop] [--fresh] [--json]
  ferry providers [<agent>] [--json]
  ferry plan <agent> <provider[/model]> [--preview] [--json]
  ferry chain <agent> [--json]
  ferry sent <chain> <delivery>
  ferry retry <chain> <delivery>
Without a provider, the partner configured in Ferry's settings is used. --stop stops a running turn first;
--fresh starts a new agent even where an earlier one could be switched back to.`);
  process.exit(code);
}

async function clientEntry() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    try {
      await access(join(directory, "paseo"));
      const require = createRequire(await realpath(join(directory, "paseo")));
      return { node: require.resolve("@getpaseo/client/node"), root: require.resolve("@getpaseo/client") };
    } catch {}
  }
  throw new Error("Paseo's own @getpaseo/client was not found: the paseo command must be on PATH.");
}

async function version(file) {
  let directory = dirname(file);
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === "@getpaseo/client") return manifest.version;
    } catch {}
    directory = dirname(directory);
  }
  return "0.0.0";
}

/** `$PASEO_HOME` (a leading `~` expands), else `~/.paseo`: the daemon this machine's paseo CLI talks to. */
export function paseoHome(env = process.env) {
  const home = env.PASEO_HOME?.trim() || join(homedir(), ".paseo");
  return resolve(home === "~" ? homedir() : home.startsWith("~/") ? join(homedir(), home.slice(2)) : home);
}

export async function connect() {
  const home = paseoHome();
  const { listen } = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"));
  const token = (await readFile(join(home, "local-credential"), "utf8")).trim();
  const entry = await clientEntry();
  const { createHostClient } = await import(pathToFileURL(entry.node).href);
  const { createPaseoApi } = await import(pathToFileURL(entry.root).href);
  const client = createHostClient(listen, {
    clientId: `${PLUGIN_ID}-cli`,
    clientType: "cli",
    appVersion: await version(entry.node),
    localCredential: () => token,
    connectTimeoutMs: 15_000,
    reconnect: { enabled: false },
  });
  await client.connect();
  return { client, api: createPaseoApi(client) };
}

/** Full id, unique id prefix, or exact title among active agents. */
export async function resolveAgent(api, query) {
  const agents = [];
  let cursor;
  for (let page = 0; page < 50; page += 1) {
    const result = await api.agents.list({ filter: { includeBackground: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    agents.push(...result.entries.map((entry) => entry.agent));
    if (!result.pageInfo?.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  const exact = agents.find((agent) => agent.id === query);
  if (exact) return exact.id;
  const prefix = agents.filter((agent) => agent.id.startsWith(query));
  if (prefix.length === 1) return prefix[0].id;
  const titled = agents.filter((agent) => agent.title === query);
  if (titled.length === 1) return titled[0].id;
  if (prefix.length > 1) throw new Error(`"${query}" matches ${prefix.length} agents; give more of the id.`);
  // An archived agent is not listed; pass the id through and let the plugin answer.
  return query;
}

let catalog = null;
/** Ferry's notes are message codes; the CLI words them with the plugin's English catalog. */
export async function word(note) {
  catalog ??= JSON.parse(await readFile(join(here, "..", "shared", "locales", "en.json"), "utf8"));
  const [section, name] = note.code.split(".");
  let message = catalog[section]?.[name];
  if (message && typeof message === "object") message = (note.params?.count === 1 ? message.one : null) ?? message.other;
  if (typeof message !== "string") return `${note.code}${note.params ? ` ${JSON.stringify(note.params)}` : ""}`;
  return message.replace(/\{(\w+)\}/g, (_, key) => String(note.params?.[key] ?? `{${key}}`));
}

/** Starts a move and follows it to the end. */
export async function move(client, input) {
  let output = await client.invokePluginRpc(PLUGIN_ID, rpc("start"), { requestId: randomUUID(), ...input });
  while (output.status === "pending") output = await client.invokePluginRpc(PLUGIN_ID, rpc("wait"), { opId: output.opId });
  return output;
}

const FLAGS = new Set(["--stop", "--fresh", "--json", "--preview", "--help", "-h"]);

export async function main(argv) {
  // Only these are flags: anything else, "--verbose" in a message included, stays a word.
  const flags = new Set(argv.filter((arg) => FLAGS.has(arg)));
  const args = argv.filter((arg) => !FLAGS.has(arg));
  if (flags.has("--help") || flags.has("-h")) usage(0);
  if (args.length === 0) usage(1);
  const json = flags.has("--json");
  const { client, api } = await connect();
  const print = async (value, text) => console.log(json ? JSON.stringify(value, null, 2) : await text(value));
  try {
    if (args[0] === "providers") {
      const agentId = args[1] ? await resolveAgent(api, args[1]) : undefined;
      const info = await client.invokePluginRpc(PLUGIN_ID, rpc("providers"), agentId ? { agentId } : {});
      return print(info, async () => {
        const lines = [];
        for (const provider of info.providers) {
          const route = info.routes.find((entry) => entry.provider === provider.id);
          const reason = route?.reason ? ` (${await word(route.reason)})` : "";
          lines.push(`${provider.ready ? "✓" : "✗"} ${provider.id.padEnd(16)} ${provider.label}${route ? `  → ${route.kind}${reason}` : ""}`);
        }
        if (info.agent) lines.push("", `${info.agent.title ?? info.agent.id} is on ${info.agent.provider}${info.agent.failure ? `; last turn: ${info.agent.failure}` : ""}${info.partner ? `; partner: ${info.partner}` : ""}`);
        if (!info.native.available && info.native.reason) lines.push(await word(info.native.reason));
        return lines.join("\n");
      });
    }
    if (args[0] === "plan") {
      if (args.length < 3) usage(1);
      const agentId = await resolveAgent(api, args[1]);
      const plan = await client.invokePluginRpc(PLUGIN_ID, rpc("plan"), { agentId, target: args[2], preview: flags.has("--preview"), fresh: flags.has("--fresh") });
      return print(plan, async () => {
        if (plan.status !== "ok") return await word(plan.reason);
        const lines = [`${plan.route} → ${plan.target.provider}/${plan.target.model ?? "default"}  mode ${plan.target.modeId ?? "-"}  thinking ${plan.target.thinkingId ?? "-"}`];
        if (plan.selection) lines.push(`${plan.selection.mode}: ${plan.selection.selected} of ${plan.selection.total} items, ${plan.selection.bytes} bytes of ${plan.budget?.effective} allowed`);
        for (const note of plan.notes) lines.push(`  · ${await word(note)}`);
        for (const warning of plan.warnings) lines.push(`  ! ${await word(warning)}`);
        if (plan.preview) lines.push("", plan.preview);
        return lines.join("\n");
      });
    }
    if (args[0] === "chain") {
      const agentId = await resolveAgent(api, args[1] ?? "");
      const result = await client.invokePluginRpc(PLUGIN_ID, rpc("chain"), { agentId });
      return print(result, async () => {
        if (!result.chain) return "This agent is in no chain.";
        const lines = [`chain ${result.chain.id}`];
        for (const visit of result.chain.visits) lines.push(`  ${visit.n}. ${visit.openedBy.padEnd(7)} ${visit.provider.padEnd(14)} ${visit.agentId}  ${visit.itemCount} items${visit.closedAt ? "" : " (open)"}`);
        for (const delivery of result.chain.deliveries) lines.push(`  → ${delivery.mode} to visit ${delivery.visitN}: ${delivery.selected}/${delivery.total} items, ${delivery.status}  (${delivery.id})`);
        return lines.join("\n");
      });
    }
    if (args[0] === "sent") {
      const result = await client.invokePluginRpc(PLUGIN_ID, rpc("delivery"), { chainId: args[1] ?? "", deliveryId: args[2] ?? "" });
      return print(result, async () => result.text ?? "Not kept (any more).");
    }
    if (args[0] === "retry") {
      const result = await client.invokePluginRpc(PLUGIN_ID, rpc("retry"), { chainId: args[1] ?? "", deliveryId: args[2] ?? "" });
      return print(result, async () => (result.status === "done" ? "Sent again." : await word(result.reason)));
    }
    const agentId = await resolveAgent(api, args[0]);
    const output = await move(client, {
      agentId,
      ...(args[1] ? { target: args[1] } : {}),
      ...(args.length > 2 ? { message: args.slice(2).join(" ") } : {}),
      ...(flags.has("--stop") ? { stopRunning: true } : {}),
      ...(flags.has("--fresh") ? { fresh: true } : {}),
    });
    await print(output, async () => {
      if (output.status !== "done") return (await word(output.reason)) + (output.status === "running" ? "\nAdd --stop to stop the turn first." : "");
      const result = output.result;
      const lines = [`${result.route}: ${result.from.label} → ${result.to.label}${result.to.model ? ` (${result.to.model})` : ""}  agent ${result.agentId}`];
      if (result.deliveryId) lines.push(`  ${result.selected} of ${result.total} items sent  (chain ${result.chainId}, delivery ${result.deliveryId})`);
      for (const note of result.notes) lines.push(`  · ${await word(note)}`);
      for (const warning of result.warnings) lines.push(`  ! ${await word(warning)}`);
      return lines.join("\n");
    });
    if (output.status !== "done") process.exitCode = 2;
  } finally {
    await client.close().catch(() => {});
  }
}

const invoked = process.argv[1] ? await realpath(process.argv[1]).catch(() => process.argv[1]) : null;
if (invoked && import.meta.url === pathToFileURL(invoked).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`ferry: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
