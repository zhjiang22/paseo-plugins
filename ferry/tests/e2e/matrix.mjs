#!/usr/bin/env node
// Live relay through Ferry on a running daemon: one conversation hops across the providers given, in order. Each hop
// adds a code word and asks the agent that takes over to list every code word so far, so a hop passes only when the
// whole history came along. Ferry picks the route itself (native, switch-back, handoff); the script reports it and
// checks what each route promises:
//
// - every hop: all code words recalled; the message bubble shows only the typed words; the chain has the new stretch;
// - handoff and switch-back: the delivery ends up "read";
// - native: the very same session id, served by the target (Paseo names its Claude settings file after the provider).
//
//   node tests/e2e/matrix.mjs --yes --hops <provider/model>,<provider[/model]>,… [--budget-test <provider[/model]>]
//        [--dir /tmp/ferry-matrix] [--keep] [--report /tmp/ferry-matrix.json]
//
// A provider may appear more than once: coming back to it is a switch-back (or a native one). --budget-test ends with
// a handoff under a 1,000-token budget, so most code words are left out of the envelope and the agent has to find
// them with Ferry's history tool or in the full record file. Ferry's settings are restored at the end.

import { mkdir, writeFile } from "node:fs/promises";
import {
  PLUGIN_ID,
  clip,
  code,
  cleanUp,
  connect,
  createReport,
  finished,
  move,
  parseArgs,
  patchSettings,
  readAgent,
  readSettings,
  requireYes,
  restoreSettings,
  sessionProcesses,
  waitFor,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
requireYes(args, "This test sends one or two short messages per hop to every provider you name (a little quota each).");
const hops = (args.get("--hops", "") || "").split(",").map((hop) => hop.trim()).filter(Boolean);
if (hops.length < 2) {
  console.error("Give at least two hops: --hops <provider/model>,<provider[/model]>,…");
  process.exit(1);
}
const BUDGET_TARGET = args.get("--budget-test", null);
const DIR = args.get("--dir", "/tmp/ferry-matrix");
const report = createReport();
const { check, note } = report;
const link = await connect();
const { client, api } = link;
const made = { agents: [], workspaceIds: [], dir: DIR, chains: [] };
const saved = await readSettings(client);
const rows = [];

const rpc = (name, input) => client.invokePluginRpc(PLUGIN_ID, `${PLUGIN_ID}.${name}`, input);
const provider = (hop) => hop.split("/")[0];
const ask = (word) => `Remember the code word ${word} as well. Then list every code word from this conversation so far, in the order they were given, separated by spaces, and nothing else. Do not call any tools.`;

/** The user message Ferry sent for this hop, as the live timeline has it. */
async function sentBubble(agentId, text) {
  const page = await api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 60 });
  return [...(page.entries ?? [])].reverse().find((entry) => entry.item?.type === "user_message" && String(entry.item.clientMessageId ?? "").startsWith(`${PLUGIN_ID}-`) && entry.item.text?.includes(text.slice(0, 40)))?.item ?? null;
}

try {
  await mkdir(DIR, { recursive: true });
  const words = [code("FERRY")];
  console.log(`Hops: ${hops.join(" → ")}${BUDGET_TARGET ? ` → (budget test) ${BUDGET_TARGET}` : ""}\nDirectory: ${DIR}\n`);
  const origin = await api.agents.create({
    config: { provider: hops[0] },
    cwd: DIR,
    title: `Ferry matrix ${words[0]}`,
    prompt: `This is an automated test of a conversation-handoff plugin. Remember the code word ${words[0]}. Do not call any tools; reply with one word: noted.`,
  });
  made.agents.push(origin.id);
  const start = await finished(api, origin.id, 300_000, { approve: true });
  check(`hop 1: ${hops[0]} answers`, start.status === "idle", `${start.status} · ${clip(start.reply)}${start.error ? ` · ${start.error}` : ""}`);
  made.workspaceIds.push((await readAgent(api, origin.id))?.workspaceId);
  let current = origin.id;

  const hop = async (index, target, message, expected) => {
    const startedAt = Date.now();
    // A hop that never finished (a provider retrying on its quota) is stopped by the next move.
    const output = await move(client, { agentId: current, target, message, stopRunning: true });
    if (output.status !== "done") {
      check(`hop ${index}: ${target}`, false, `${output.status}: ${output.reason?.code ?? ""} ${JSON.stringify(output.reason?.params ?? {})}`);
      return null;
    }
    const result = output.result;
    made.agents.push(result.agentId);
    made.chains.push(result.chainId);
    const answer = await finished(api, result.agentId, 300_000, { approve: true });
    const missing = expected.filter((word) => !answer.reply.includes(word));
    const row = { hop: index, target, route: result.route, agentId: result.agentId, selected: result.selected, total: result.total, ms: Date.now() - startedAt, missing, reply: clip(answer.reply, 300), notes: result.notes.map((entry) => entry.code), warnings: result.warnings.map((entry) => entry.code) };
    rows.push(row);
    check(`hop ${index}: ${target} by ${result.route} recalls all ${expected.length} code words`, answer.status === "idle" && missing.length === 0, `${answer.status}${answer.error ? ` · ${answer.error}` : ""} · ${missing.length ? `missing ${missing.join(" ")} · ` : ""}${clip(answer.reply, 120)}`);
    if (row.notes.length || row.warnings.length) note(`notes: ${row.notes.join(", ") || "-"} · warnings: ${row.warnings.join(", ") || "-"}`);
    const bubble = await sentBubble(result.agentId, message);
    check(`hop ${index}: the bubble shows only the typed words`, !!bubble && bubble.text.trim() === message.trim(), bubble ? clip(bubble.text, 80) : "not found");
    const chain = (await rpc("chain", { agentId: result.agentId })).chain;
    const visit = chain?.visits.at(-1);
    check(`hop ${index}: the chain records the stretch`, visit?.agentId === result.agentId && visit.provider === provider(target), visit ? `${visit.n}. ${visit.openedBy} ${visit.provider}` : "no chain");
    if (result.deliveryId) {
      const read = await waitFor(async () => (await rpc("chain", { agentId: result.agentId })).chain?.deliveries.find((entry) => entry.id === result.deliveryId)?.status, (status) => status === "read" || status === "failed", 15_000, 1000);
      check(`hop ${index}: the delivery is read`, read === "read", read ?? "unknown");
    }
    if (result.route === "native" || result.route === "native-switch-back") {
      const agent = await readAgent(api, result.agentId);
      const sessionId = agent?.persistence?.sessionId;
      const before = await readAgent(api, current);
      if (result.route === "native") check(`hop ${index}: the same session continues`, !!sessionId && sessionId === before?.persistence?.sessionId, `${sessionId}`);
      const processes = sessionId ? await sessionProcesses(sessionId) : [];
      const served = processes.some((entry) => entry.args.some((arg) => arg.includes(`claude-settings/${provider(target)}-`)));
      check(`hop ${index}: ${provider(target)} serves the session`, served || processes.length === 0, processes.length ? processes.map((entry) => entry.args.find((arg) => arg.includes("claude-settings/")) ?? entry.args[0]).join(" | ") : "no session process alive any more (not checked)");
    }
    current = result.agentId;
    return row;
  };

  for (let index = 1; index < hops.length; index += 1) {
    words.push(code("FERRY"));
    // A move that did not happen sent its code word to nobody; one that happened carries it on in the history.
    if (!(await hop(index + 1, hops[index], ask(words.at(-1)), words))) words.pop();
  }

  if (BUDGET_TARGET) {
    // Most of the history cannot fit: the agent has to look the code words up.
    await patchSettings(client, { budgetTokens: 1000 });
    const before = words.length;
    const message = `This conversation was handed to you with most of its history left out. Find every code word given in it (there are ${before}), using the tool ferry_read_history if you have it (it may be listed as mcp__paseo__ferry_read_history), or else by reading the full record file named at the top of the history. List them in the order they were given, separated by spaces, and nothing else.`;
    const output = await move(client, { agentId: current, target: BUDGET_TARGET, message, fresh: true, stopRunning: true });
    if (output.status === "done") {
      const result = output.result;
      made.agents.push(result.agentId);
      const answer = await finished(api, result.agentId, 600_000, { approve: true });
      const missing = words.filter((word) => !answer.reply.includes(word));
      const page = await api.agents.ref(result.agentId).timeline.refetch({ direction: "tail", limit: 80 });
      const tools = (page.entries ?? []).filter((entry) => entry.item?.type === "tool_call").map((entry) => String(entry.item.name ?? "")).filter(Boolean);
      const usedTool = tools.some((name) => name.includes("ferry_read_history"));
      const readFile = tools.some((name) => /read|cat|shell|bash|view/i.test(name));
      check(`budget test: ${BUDGET_TARGET} got ${result.selected} of ${result.total} items and still recalls all ${before} code words`, missing.length === 0, `${missing.length ? `missing ${missing.join(" ")} · ` : ""}history tool: ${usedTool ? "used" : "not used"} · other tools: ${tools.filter((name) => !name.includes("ferry_read_history")).join(", ") || "none"} · ${clip(answer.reply, 120)}`);
      rows.push({ hop: "budget", target: BUDGET_TARGET, route: result.route, selected: result.selected, total: result.total, missing, usedTool, readFile, tools, reply: clip(answer.reply, 300) });
    } else check(`budget test: ${BUDGET_TARGET}`, false, `${output.status}: ${output.reason?.code ?? ""}`);
  }
} catch (error) {
  check("the relay ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  if (saved.status === "ready") await restoreSettings(client, saved.values).catch(() => {});
  const file = args.get("--report", null);
  if (file) await writeFile(file, `${JSON.stringify({ hops, rows, results: report.results }, null, 2)}\n`);
  if (!args.flags.has("--keep")) await cleanUp(link, made);
  await client.close().catch(() => {});
}

console.log("\nRoutes:");
for (const row of rows) console.log(`  ${String(row.hop).padEnd(6)} ${String(row.target).padEnd(28)} ${String(row.route).padEnd(18)} ${row.selected}/${row.total}${row.missing?.length ? `  missing ${row.missing.join(" ")}` : ""}`);
process.exit(report.finish());
