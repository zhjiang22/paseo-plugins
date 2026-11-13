// Shared by Ferry's live end-to-end scripts. They drive a running daemon (the one in $PASEO_HOME, default ~/.paseo)
// through the plugin's own RPCs and the Paseo client, and spend a little quota on the providers they are given.
// Nothing here runs from `npm test`.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect, move, paseoHome, resolveAgent } from "../../bin/ferry.mjs";

export { connect, move, resolveAgent };
export const PLUGIN_ID = "ferry";
export const LABEL_FROM_AGENT = `${PLUGIN_ID}.from-agent`;
export const LABEL_CHAIN = `${PLUGIN_ID}.chain`;

/** `--name value` options and bare `--flags`. */
export function parseArgs(argv) {
  const options = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(arg, next);
      index += 1;
    } else flags.add(arg);
  }
  return { options, flags, get: (name, fallback) => options.get(name) ?? fallback };
}

export function requireYes(args, what) {
  if (args.flags.has("--yes")) return;
  console.error(`${what}\nAdd --yes to run it.`);
  process.exit(1);
}

export function createReport() {
  const results = [];
  return {
    results,
    check(name, ok, detail = "") {
      results.push({ name, ok: Boolean(ok), detail });
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
      return Boolean(ok);
    },
    note(text) {
      console.log(`      ${text}`);
    },
    finish(suffix = "") {
      const failed = results.filter((result) => !result.ok);
      console.log(`\n${results.length - failed.length}/${results.length} passed${suffix}`);
      return failed.length ? 1 : 0;
    },
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const clip = (text, size = 160) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, size);
export const code = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.floor(10 + Math.random() * 89)}`;

export async function waitFor(get, predicate, timeoutMs, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await get();
    if (predicate(value)) return value;
    if (Date.now() > deadline) return value;
    await sleep(stepMs);
  }
}

export const readAgent = async (api, agentId) => (await api.agents.ref(agentId).refresh().catch(() => null))?.agent ?? null;

/** The agents a move from `sourceId` created or brought back, newest first. */
export async function movedFrom(api, sourceId) {
  const result = await api.agents.list({ filter: { labels: { [LABEL_FROM_AGENT]: sourceId }, includeBackground: true } });
  return result.entries.map((entry) => entry.agent).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/**
 * Waits for the agent's turn to end and returns its last reply. With `approve`, permission requests on the way are
 * allowed (the scripts' agents work in scratch directories) and named in `approved`.
 */
export async function finished(api, agentId, timeoutMs = 300_000, options = {}) {
  await sleep(1500);
  const approved = [];
  const agent = await waitFor(
    async () => {
      const value = await readAgent(api, agentId);
      if (options.approve) {
        for (const request of value?.pendingPermissions ?? []) {
          approved.push(String(request.name ?? request.toolName ?? request.id));
          await api.agents.ref(agentId).respondToPermission({ requestId: request.id, response: { behavior: "allow" } }).catch(() => {});
        }
      }
      return value;
    },
    (value) => value && value.status !== "running" && value.status !== "initializing" && !(value.pendingPermissions?.length && options.approve),
    timeoutMs,
    1000,
  );
  const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 30 }).catch(() => ({ entries: [] }));
  const reply = [...(page.entries ?? [])].reverse().find((entry) => entry.item?.type === "assistant_message")?.item?.text ?? "";
  return { status: agent?.status ?? "missing", error: agent?.lastError ?? null, reply, approved };
}

/** Processes serving a provider session: Paseo starts Claude Code with --resume=<session>. */
export async function sessionProcesses(sessionId) {
  const found = [];
  for (const pid of await readdir("/proc").catch(() => [])) {
    if (!/^\d+$/.test(pid)) continue;
    let args;
    try {
      args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    } catch {
      continue;
    }
    const line = args.join(" ");
    if (line.includes(`--resume=${sessionId}`) || line.includes(`--resume ${sessionId}`)) found.push({ pid: Number(pid), args });
  }
  return found;
}

/** pgrep's matches; none (exit 1) is an empty list. */
function pgrep(args) {
  try {
    return execFileSync("pgrep", args, { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Kills the processes running a session and their children, the way a crashed provider looks to Paseo. */
export function killSession(sessionId) {
  const killed = [];
  for (const pid of pgrep(["-f", "--", sessionId])) {
    if (Number(pid) === process.pid) continue;
    for (const child of pgrep(["-P", pid])) {
      try {
        process.kill(Number(child), "SIGKILL");
        killed.push(child);
      } catch {}
    }
    try {
      process.kill(Number(pid), "SIGKILL");
      killed.push(pid);
    } catch {}
  }
  return killed;
}

/** Ferry's settings document, read and written the way its settings screen does. */
export async function readSettings(client) {
  return client.invokePluginRpc(PLUGIN_ID, "settings.general.read", {});
}

export async function patchSettings(client, patch) {
  const state = await readSettings(client);
  if (state.status !== "ready") throw new Error(`Ferry's settings cannot be read: ${state.error ?? state.status}`);
  const result = await client.invokePluginRpc(PLUGIN_ID, "settings.general.write", { revision: state.revision, values: { ...state.values, ...patch } });
  if (result.status !== "saved") throw new Error(`Ferry's settings were not saved: ${result.error ?? result.status}`);
  return state.values;
}

export async function restoreSettings(client, values) {
  const state = await readSettings(client);
  if (state.status === "ready") await client.invokePluginRpc(PLUGIN_ID, "settings.general.write", { revision: state.revision, values });
}

/**
 * A headless Chromium from Playwright: --playwright <dir> (or FERRY_PLAYWRIGHT) is a directory whose node_modules has
 * playwright; --chrome <file> (or FERRY_CHROME) the browser. The server-browser plugin's runtime works as both.
 */
export async function launchBrowser(args) {
  const runtime = args.get("--playwright", process.env.FERRY_PLAYWRIGHT ?? join(homedir(), ".local/share/paseo-server-browser"));
  const require = createRequire(join(runtime, "package.json"));
  const { chromium } = require("playwright");
  let chrome = args.get("--chrome", process.env.FERRY_CHROME ?? null);
  if (!chrome) {
    const cache = join(homedir(), ".cache/ms-playwright");
    const shells = (await readdir(cache).catch(() => [])).filter((name) => name.startsWith("chromium_headless_shell-")).sort().reverse();
    for (const shell of shells) {
      const candidate = join(cache, shell, "chrome-headless-shell-linux64/chrome-headless-shell");
      if (existsSync(candidate)) {
        chrome = candidate;
        break;
      }
    }
  }
  const env = { ...process.env };
  if (existsSync(join(runtime, "lib"))) env.LD_LIBRARY_PATH = join(runtime, "lib");
  if (existsSync(join(runtime, "fonts.conf"))) env.FONTCONFIG_FILE = join(runtime, "fonts.conf");
  return chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}), env });
}

/** The daemon the scripts talk to, and its web app. */
export async function daemonInfo() {
  const home = paseoHome();
  const { listen, serverId } = JSON.parse(await readFile(join(home, "paseo.pid"), "utf8"));
  return { home, listen, serverId, base: `http://${listen}` };
}

/** Removes what a test made: its agents, workspace, project entry and chains. */
export async function cleanUp({ client, api }, { agents = [], workspaceIds = [], dir = null, chains = [] }) {
  for (const chainId of new Set(chains)) await client.invokePluginRpc(PLUGIN_ID, `${PLUGIN_ID}.forget`, { chainId }).catch(() => {});
  for (const agentId of new Set(agents)) await client.deleteAgent(agentId).catch(() => {});
  for (const workspaceId of new Set(workspaceIds)) if (workspaceId) await api.workspaces.archive(workspaceId).catch(() => {});
  if (dir) {
    const projects = (await api.projects.list().catch(() => ({ projects: [] }))).projects ?? [];
    for (const project of projects) if (project.projectRootPath === dir) await client.removeProject(project.projectId).catch(() => {});
  }
}

/** The English catalog, for finding the plugin's words on screen. */
export async function catalog() {
  const words = JSON.parse(await readFile(new URL("../../shared/locales/en.json", import.meta.url), "utf8"));
  return (id, params = {}) => {
    const [section, name] = id.split(".");
    let text = words[section]?.[name];
    if (text && typeof text === "object") text = (params.count === 1 ? text.one : null) ?? text.other;
    return String(text ?? id).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? `{${key}}`));
  };
}
