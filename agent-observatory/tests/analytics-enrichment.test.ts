import assert from "node:assert/strict";
import test from "node:test";
import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { createAnalyticsEnrichment } from "../server/analytics-enrichment";
import type { TelemetryStore } from "../server/telemetry";
import type { TelemetryEvent } from "../shared/telemetry";

const at = new Date().toISOString();
// Paseo 0.16 adds `background` and `metadata` to the hook agent; older SDK types do not know them, so the fixture asserts.
const hookAgent = { id: "agent", workspaceId: "workspace", parentAgentId: null, provider: "codex", cwd: "/repo/checkout", title: "Worker", background: false, metadata: {} } as PluginHookAgent;
const ended: TelemetryEvent = { id: "end-event", agentId: "agent", agentTitle: "Worker", at, type: "turn_completed", label: "Turn completed" };
const tick = () => new Promise(resolve => setImmediate(resolve));
const placement = { projectKey: "repository", projectName: "Repository project", workspaceName: "Feature checkout",
  checkout: { cwd: "/repo/checkout", mainRepoRoot: "/repo/main", worktreeRoot: "/repo/checkout" } };
function setup(api: unknown) {
  const calls: unknown[][] = [];
  const store = { recordUsage: async (...args: unknown[]) => { calls.push(args); } } as unknown as TelemetryStore;
  return { calls, sampler: createAnalyticsEnrichment(store), api: api as PaseoApi };
}

test("end enrichment uses exact project placement and a primitive usage allowlist", async () => {
  const f = setup({ agents: { ref: () => ({ refresh: async () => ({ agent: { id: "agent", provider: "codex", workspaceId: "workspace",
    activeTurn: null, lastUserMessageAt: null, lastUsage: { inputTokens: 100, outputTokens: 20, contextWindowUsedTokens: 999, raw: "not copied" } }, project: placement }) }) } });
  f.sampler.captureEnd(ended, hookAgent, f.api);
  await tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0][1], { id: "agent", provider: "codex", workspaceId: "workspace", projectId: "repository", projectName: "Repository project", projectRootPath: "/repo/main" });
  assert.deepEqual(f.calls[0][3], { inputTokens: 100, outputTokens: 20, cachedInputTokens: undefined, totalCostUsd: undefined });
  f.sampler.close();
});

test("a subsequent active turn cannot have its usage attached to the previous end", async () => {
  const f = setup({ agents: { ref: () => ({ refresh: async () => ({ agent: { id: "agent", provider: "codex", workspaceId: "workspace",
    activeTurn: { turnId: "newer" }, lastUserMessageAt: null, lastUsage: { inputTokens: 800 } }, project: placement }) }) } });
  f.sampler.captureEnd(ended, hookAgent, f.api);
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][3], null);
  f.sampler.close();
});

test("enrichment bounds concurrent metadata reads and cleanup discards pending work", async () => {
  const resolvers: Array<(value: unknown) => void> = [];
  const f = setup({ agents: { ref: () => ({ refresh: () => new Promise(resolve => resolvers.push(resolve)) }) } });
  for (let index = 0; index < 100; index++) f.sampler.captureEnd({ ...ended, id: `end-${index}` }, hookAgent, f.api);
  assert.equal(resolvers.length, 4);
  f.sampler.close();
  for (const resolve of resolvers) resolve({ agent: { id: "agent", lastUsage: { inputTokens: 500 } }, project: null });
  await tick();
  assert.equal(resolvers.length, 4);
  assert.equal(f.calls.length, 0);
});

test("recent sampling is one bounded metadata page and repeated reads are throttled", async () => {
  const requests: unknown[] = [];
  const f = setup({ agents: { list: async (options: unknown) => { requests.push(options); return { entries: [{ agent: { id: "agent", provider: "codex", workspaceId: "workspace", lastUsage: { inputTokens: 200 } }, project: placement }], pageInfo: { hasMore: true } }; } } });
  f.sampler.refreshRecent(f.api);
  f.sampler.refreshRecent(f.api);
  await tick();
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { filter: { includeArchived: false }, sort: [{ key: "updated_at", direction: "desc" }], page: { limit: 200 }, timeout: 12_000 });
  assert.equal(f.calls.length, 1);
  assert.match(String(f.calls[0][0]), /^sample:[a-f0-9]{64}$/);
  f.sampler.close();
});

test("synchronous SDK failures do not reject or disable persisted analytics reads", async () => {
  const f = setup({ agents: { list() { throw new Error("Disconnected"); } } });
  assert.doesNotThrow(() => f.sampler.refreshRecent(f.api));
  await tick();
  assert.equal(f.calls.length, 0);
  f.sampler.close();
});
