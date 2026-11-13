// The history tool agents in a chain get: the conversation's earlier items, numbered as in the handoff they received,
// a page at a time, one item in full, or a search. Read-only, from Ferry's snapshots; it never opens another agent.
//
// It is attached when an agent's session opens (`agent.session_open`), only for interactive sessions of agents in a
// chain. The hook looks in memory only: reading the opening agent's timeline there would wait on itself.

import { defineAgentTool, type AgentToolDefinition, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { clipHead } from "../shared/bytes";
import type { Chain, NumberedItem } from "../shared/model";
import { LABEL_CHAIN, TOOL_NAME } from "../shared/plugin-id";
import type { FerrySettings } from "../shared/settings";
import type { FerryContext } from "./context";

const PAGE_DEFAULT = 20;
const PAGE_ITEM_BYTES = 8 * 1024;
const FULL_ITEM_BYTES = 32 * 1024;
const MAX_HITS = 20;

export const historyInput = z.object({
  from: z.number().int().min(1).optional().describe("First item number of the page (default 1)."),
  limit: z.number().int().min(1).max(50).optional().describe("Items per page, 1-50 (default 20)."),
  item: z.number().int().min(1).optional().describe("Read this one item in full."),
  query: z.string().min(1).max(200).optional().describe("Find items containing this text (case-insensitive)."),
});
export type HistoryInput = z.infer<typeof historyInput>;

function header(item: NumberedItem): string {
  const parts = [`[${item.n}] ${item.role} · ${item.kind}`, `agent ${item.visit} (${item.provider})`];
  if (item.status && item.status !== "completed") parts.push(item.status);
  if (typeof item.exitCode === "number") parts.push(`exit ${item.exitCode}`);
  if (item.from) parts.push(`from ${item.from}`);
  return parts.join(" · ");
}

function overview(chain: Chain, total: number): string {
  const agents = chain.visits
    .filter((visit) => visit.itemCount > 0)
    .map((visit) => `${visit.n}) ${visit.provider}${visit.model ? ` (${visit.model})` : ""}`)
    .join(", ");
  return `Conversation history: ${total} items. Agents: ${agents || "none"}.`;
}

/** The tool's answer for `input` over `items` (the whole history, in number order). */
export function answerHistory(chain: Chain, items: readonly NumberedItem[], input: HistoryInput): { text: string; structuredContent: unknown } {
  const total = items.length;
  const last = items.length ? items[items.length - 1]!.n : 0;
  if (input.item !== undefined) {
    const item = items.find((entry) => entry.n === input.item);
    if (!item) return { text: `${overview(chain, total)}\nThere is no item ${input.item}; items run from ${items[0]?.n ?? 0} to ${last}.`, structuredContent: { total, items: [] } };
    return { text: `${overview(chain, total)}\n${header(item)}\n${clipHead(item.text, FULL_ITEM_BYTES)}`, structuredContent: { total, items: [item] } };
  }
  if (input.query !== undefined) {
    const needle = input.query.toLowerCase();
    const hits = items.filter((item) => item.text.toLowerCase().includes(needle));
    const shown = hits.slice(-MAX_HITS);
    const lines = shown.map((item) => {
      const at = item.text.toLowerCase().indexOf(needle);
      const start = Math.max(0, at - 120);
      const excerpt = `${start > 0 ? "…" : ""}${item.text.slice(start, at + needle.length + 180)}${at + needle.length + 180 < item.text.length ? "…" : ""}`;
      return `${header(item)}\n${excerpt}`;
    });
    const more = hits.length > shown.length ? `\n${hits.length - shown.length} earlier matches not shown; search more precisely.` : "";
    return {
      text: `${overview(chain, total)}\n${hits.length ? `Items containing ${JSON.stringify(input.query)} (latest ${shown.length}):` : `No item contains ${JSON.stringify(input.query)}.`}\n${lines.join("\n\n")}${more}\nRead one in full with {"item": <number>}.`,
      structuredContent: { total, items: shown.map((item) => ({ ...item, text: clipHead(item.text, 600) })) },
    };
  }
  const from = input.from ?? items[0]?.n ?? 1;
  const limit = input.limit ?? PAGE_DEFAULT;
  const page = items.filter((item) => item.n >= from).slice(0, limit);
  const next = page.length && page[page.length - 1]!.n < last ? page[page.length - 1]!.n + 1 : null;
  const body = page.map((item) => `${header(item)}\n${clipHead(item.text, PAGE_ITEM_BYTES)}`).join("\n\n");
  const range = page.length ? `Items ${page[0]!.n}-${page[page.length - 1]!.n}:` : `No items from ${from}.`;
  return {
    text: `${overview(chain, total)}\n${range}\n${body}${next ? `\nMore: {"from": ${next}}.` : "\nThat is the latest item."}`,
    structuredContent: { total, next, items: page.map((item) => ({ ...item, text: clipHead(item.text, PAGE_ITEM_BYTES) })) },
  };
}

export function historyTool(ctx: FerryContext): AgentToolDefinition {
  return defineAgentTool({
    name: TOOL_NAME,
    title: "Conversation history",
    description:
      "Read the earlier history of this conversation: what the user and other coding agents said and did before you took over, as numbered items. Use it for items your handoff left out or shortened. Page with {\"from\": n}, read one item with {\"item\": n}, or search with {\"query\": \"text\"}.",
    input: historyInput,
    async execute(input, { agent }) {
      await ctx.store.ready();
      const chainId = ctx.store.chainOf(agent.id) ?? ctx.pending.get(agent.id) ?? null;
      const chain = chainId ? await ctx.store.read(chainId) : null;
      if (!chain) return { text: "This agent has no earlier history from other agents.", isError: true };
      const items = await ctx.store.history(chain);
      return answerHistory(chain, items, input);
    },
  });
}

/** Gives the tool to interactive sessions of agents in a chain, while the setting allows it. */
export function registerHistoryTool(server: PluginServerContext, ctx: FerryContext, settings: () => FerrySettings): () => void {
  const tool = historyTool(ctx);
  return server.before("agent.session_open", async ({ request }) => {
    if (request.purpose !== "interactive" || !settings().historyTool) return;
    await ctx.store.ready();
    const member = ctx.pending.has(request.agentId) || ctx.store.chainOf(request.agentId) !== null || !!request.labels[LABEL_CHAIN];
    if (!member || request.tools.some((existing) => existing.name === TOOL_NAME)) return;
    request.tools.push(tool);
    return request;
  });
}
