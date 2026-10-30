import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addCall, emptyData } from "../server/tokens/data";
import { TokenIngester } from "../server/tokens/ingester";
import { buildTokenSnapshot } from "../server/tokens/snapshot";
import { StatsDirectory } from "../server/stats-directory";
import { tokenSnapshotSchema, tokenSourceNames, type TokenSnapshot } from "../shared/tokens";
import { type LedgerCall, type LogRoot } from "../server/tokens/types";
// Fictional logs in the shapes CodeBuddy Code writes (field names checked against real logs; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const coverage: TokenSnapshot["coverage"] = { earliestAt: null, latestAt: null, backfill: { done: true, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 }, roots: [] };
const SESSION = "01a10000-0000-7000-8000-00000000000a", SUB = "01a20000-0000-7000-8000-00000000000b";
const metaRow = (sessionId: string) => ({ type: "session-meta", id: sessionId + "-meta", sessionId, timestamp: NOW - 3_600_000, meta: { "codebuddy.ai/hostKind": "unopted" } });
/** The usage summary a `function_call` row carries, cache-inclusive input like the OpenAI-compatible gateways report it. */
const usageRow = (input: number, cached: number, output: number, reasoning: number) => ({
  requests: 1, inputTokens: input, outputTokens: output, totalTokens: input + output,
  inputTokensDetails: [{ cached_tokens: cached }], outputTokensDetails: [{ reasoning_tokens: reasoning }] });
const rawUsageRow = (prompt: number, cached: number, completion: number, reasoning: number) => ({
  prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion,
  completion_tokens_details: { reasoning_tokens: reasoning }, prompt_tokens_details: { cached_tokens: cached },
  prompt_cache_hit_tokens: cached, prompt_cache_miss_tokens: prompt - cached, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
const functionCall = (id: string, sessionId: string, parts: { cwd?: string; model?: string; usage?: unknown; raw?: unknown; messageId?: string; step?: number; name?: string }) => ({
  id, parentId: id + "p", timestamp: NOW - 30_000, type: "function_call", callId: "call_" + id, name: parts.name ?? "read_file",
  ...(parts.cwd ? { cwd: parts.cwd } : {}), sessionId,
  providerData: { model: parts.model ?? "cb-test-model", requestModelId: parts.model ?? "cb-test-model", requestModelName: "CB Test", messageId: parts.messageId ?? id + "m", stepSeq: parts.step ?? 1,
    ...(parts.usage ? { usage: parts.usage } : {}), ...(parts.raw ? { rawUsage: parts.raw } : {}) } });
async function codebuddySession(root: string, files: Record<string, unknown[]>): Promise<void> {
  for (const [name, rows] of Object.entries(files)) {
    const path = join(root, "home-me-app", name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, rows.map(line).join(""));
  }
}
async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-codebuddy-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("CodeBuddy: a function_call row is one call, cache split out of its inclusive input; aggregates and chatter are not calls", () => ingest(root => [{ source: "codebuddy", path: root }], async (root, ingester, calls) => {
  await codebuddySession(root, {
    [`${SESSION}.jsonl`]: [
      metaRow(SESSION),
      { type: "message", id: SESSION + "u", timestamp: NOW - 50_000, role: "user", content: [{ type: "input_text", text: "PRIVATE_PROMPT" }] },
      functionCall("fc1", SESSION, { cwd: "/home/me/app", usage: usageRow(60_156, 28_160, 493, 286), messageId: "resp1", step: 1 }),
      // Two rows of one step (parallel tool calls) share the response's usage: counted once.
      functionCall("fc2", SESSION, { usage: usageRow(60_156, 28_160, 493, 286), messageId: "resp1", step: 1 }),
      functionCall("fc3", SESSION, { usage: usageRow(1_000, 200, 60, 10), messageId: "resp2", step: 2 }),
      // A row whose summary is missing falls back to the provider's raw usage.
      functionCall("fc4", SESSION, { raw: rawUsageRow(5_000, 1_000, 400, 40), messageId: "resp3", step: 1 }),
      // Newer versions put the usage on the assistant message row itself (providerData beside it).
      { type: "message", id: SESSION + "am", timestamp: NOW - 25_000, role: "assistant", cwd: "/home/me/app", sessionId: SESSION,
        providerData: { requestModelId: "cb-test-model", messageId: "resp4", usage: usageRow(2_000, 500, 100, 20) },
        message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } },
      // An assistant message row, the session-level aggregates and the reasoning drafts are never calls.
      { type: "message", id: SESSION + "a", timestamp: NOW - 20_000, role: "assistant", message: { role: "assistant", content: [{ type: "text", text: "PRIVATE_OUTPUT" }] } },
      { type: "credit-usage", id: SESSION + "c", timestamp: NOW - 10_000, credits: 999_999 },
      { type: "model-usage", id: SESSION + "m", timestamp: NOW - 10_000, usage: { inputTokens: 99_999_999, outputTokens: 99_999 } },
      { type: "reasoning", id: SESSION + "r", timestamp: NOW - 15_000, text: "PRIVATE_THOUGHTS" },
    ],
  });
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at || a.model!.localeCompare(b.model!));
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.reasoning, call.at, call.start, call.subagent]), [
    ["codebuddy", SESSION, "/home/me/app", "cb-test-model", 31_996, 28_160, 0, 493, 286, NOW - 30_000, null, false],
    ["codebuddy", SESSION, "/home/me/app", "cb-test-model", 800, 200, 0, 60, 10, NOW - 30_000, null, false],
    ["codebuddy", SESSION, "/home/me/app", "cb-test-model", 4_000, 1_000, 0, 400, 40, NOW - 30_000, null, false],
    ["codebuddy", SESSION, "/home/me/app", "cb-test-model", 1_500, 500, 0, 100, 20, NOW - 25_000, null, false],
  ], "the cache comes out of the inclusive input; a shared step usage counts once; raw usage is the fallback; a message row's providerData counts too");
  assert.equal(tokenSourceNames.codebuddy, "CodeBuddy");
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
  // A whole-step record counts in the totals, but has no response time: nothing in the live speed or the fastest records.
  const data = emptyData(); for (const call of rows) addCall(data, call, null, NOW);
  const snapshot = tokenSnapshotSchema.parse(buildTokenSnapshot(data, { range: "7d", utcOffsetMinutes: 0 }, NOW, new StatsDirectory(), coverage));
  assert.equal(snapshot.totals.calls, 4); assert.equal(snapshot.totals.genMs, 0); assert.equal(snapshot.speed.p50, null);
}));

test("CodeBuddy: a sub-agent transcript under its session counts for that session", () => ingest(root => [{ source: "codebuddy", path: root }], async (root, ingester, calls) => {
  await codebuddySession(root, {
    [`${SESSION}.jsonl`]: [metaRow(SESSION), functionCall("fc1", SESSION, { cwd: "/home/me/app", usage: usageRow(1_000, 0, 100, 0) })],
  });
  const sub = join(root, "home-me-app", SESSION, "subagents", "agent-777.jsonl");
  await mkdir(join(sub, ".."), { recursive: true });
  await writeFile(sub, [metaRow(SUB), functionCall("sfc1", SUB, { cwd: "/home/me/app", usage: usageRow(2_000, 500, 200, 20), messageId: "subresp" })].map(line).join(""));
  await ingester.backfillAll();
  const subCall = [...calls.values()].find(call => call.subagent);
  assert.ok(subCall, "the sub-agent's call is counted");
  assert.equal(subCall.sessionId, SESSION, "the sub-agent's usage belongs to the session it served");
  assert.equal(subCall.cwd, "/home/me/app");
}));

test("CodeBuddy: CODEBUDDY_CONFIG_DIR moves the project root", () => ingest(root => [{ source: "codebuddy", path: join(root, "cb") }], async (root, ingester, calls) => {
  await codebuddySession(root, {});
  await mkdir(join(root, "cb", "projects", "home-me-app"), { recursive: true });
  await writeFile(join(root, "cb", "projects", "home-me-app", `${SESSION}.jsonl`), [metaRow(SESSION), functionCall("fc9", SESSION, { cwd: "/home/me/app", usage: usageRow(500, 0, 50, 5) })].map(line).join(""));
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  assert.equal([...calls.values()][0]!.sessionId, SESSION);
}));
