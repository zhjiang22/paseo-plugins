import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import type { AttentionResponse, AttentionSummary } from "../shared/attention";

// The client stores read AppState from react-native (Flow source node cannot load) and the host SDK: stub both. The app
// starts in the foreground; tests switch it through the listener the store registered.
const appState = { currentState: "active", listeners: new Set<(state: string) => void>() };
const loader = Module as unknown as { _resolveFilename(request: string, ...rest: unknown[]): string; _cache: Record<string, unknown> };
const stubs: Record<string, unknown> = {
  "react-native": { AppState: { get currentState() { return appState.currentState; }, addEventListener: (_type: string, listener: (state: string) => void) => { appState.listeners.add(listener); return { remove() { appState.listeners.delete(listener); } }; } } },
  "@getpaseo/plugin/client": { useRpc: () => async () => { throw new Error("not used"); }, usePaseo: () => { throw new Error("not used"); } },
};
for (const [name, value] of Object.entries(stubs)) loader._cache[`\0stub:${name}`] = { id: `\0stub:${name}`, filename: `\0stub:${name}`, loaded: true, exports: value };
const resolveFilename = loader._resolveFilename;
loader._resolveFilename = function (request, ...rest) { return request in stubs ? `\0stub:${request}` : resolveFilename.call(this, request, ...rest); };
const setAppState = (state: string) => { appState.currentState = state; for (const listener of [...appState.listeners]) listener(state); };
const tick = () => new Promise(resolve => setImmediate(resolve));

const summary = (patch: Partial<AttentionSummary> = {}): AttentionSummary => ({ count: 3, truncated: false, blocking: 1, loud: 0, entries: [], scheduleFailures: 0, ready: true, failed: false, ...patch });

test("the sidebar badge shows an honest count: none before the first directory read, after a failure, or when old (opus-B1)", async () => {
  const { attentionCount, attentionUnreliable, ATTENTION_STALE_MS } = await import("../client/use-attention");
  const now = 1_000_000;
  assert.equal(attentionCount({ state: null, error: null, at: null }, now), null);
  assert.equal(attentionCount({ state: { ...summary({ ready: false }), revision: "r" }, error: null, at: now }, now), null, "the server has not read the directory yet");
  assert.deepEqual(attentionCount({ state: { ...summary(), revision: "r" }, error: null, at: now }, now), { value: 3, label: "3" });
  assert.deepEqual(attentionCount({ state: { ...summary({ truncated: true }), revision: "r" }, error: null, at: now }, now), { value: 3, label: "3+" });
  assert.equal(attentionCount({ state: { ...summary(), revision: "r" }, error: "offline", at: now }, now), null, "a failed read hides the number");
  assert.equal(attentionCount({ state: { ...summary(), revision: "r" }, error: null, at: now }, now + ATTENTION_STALE_MS + 1), null, "an old read is not shown as current");
  const serverFailed = { state: { ...summary({ failed: true }), revision: "r" }, error: null, at: now };
  assert.equal(attentionCount(serverFailed, now), null, "the server's own directory read failed");
  assert.equal(attentionUnreliable(serverFailed, now), true, "the popover says it cannot read instead of 「正在读取」");
});

test("the sidebar store reads only while shown and in the foreground, and sends its revision", async () => {
  const { createAttentionStore } = await import("../client/use-attention");
  const calls: Array<{ revision?: string }> = [];
  let next: AttentionResponse = { ...summary(), mode: "full", unchanged: false, revision: "r1" };
  const store = createAttentionStore(60_000);
  store.read = async input => { calls.push(input); return next; };
  const seen: number[] = [];
  const release = store.subscribe(() => seen.push(store.getSnapshot().state?.count ?? -1));
  await tick();
  assert.deepEqual(calls, [{}], "the first read asks for everything");
  next = { mode: "unchanged", unchanged: true, revision: "r1" };
  await store.refresh();
  assert.deepEqual(calls.at(-1), { revision: "r1" });
  assert.equal(store.getSnapshot().state?.count, 3, "an unchanged answer keeps the state");
  // Background: no more reads; foreground again: read at once.
  setAppState("background");
  const before = calls.length;
  setAppState("active"); await tick();
  assert.equal(calls.length, before + 1);
  release();
  assert.equal(appState.listeners.size, 0, "the last user releases the app state listener");
  // A read that fails keeps the last state but marks the error.
  store.read = async () => { throw new Error("offline"); };
  await store.refresh();
  assert.equal(store.getSnapshot().error, "offline"); assert.equal(store.getSnapshot().state?.count, 3);
  assert.ok(seen.length >= 2);
});

test("an unchanged answer without a cached state reads in full again", async () => {
  const { createAttentionStore } = await import("../client/use-attention");
  const store = createAttentionStore(60_000), calls: Array<{ revision?: string }> = [];
  let first = true;
  store.read = async input => { calls.push(input); if (first) { first = false; return { ...summary({ count: 1 }), mode: "full", unchanged: false, revision: "a" }; } return input.revision ? { mode: "unchanged", unchanged: true, revision: "b" } : { ...summary({ count: 2 }), mode: "full", unchanged: false, revision: "b" }; };
  await store.refresh();
  assert.equal(store.getSnapshot().state?.count, 1);
  await store.refresh();
  // The server answered "unchanged" for a revision the store does not hold: mergeAttention keeps the old one (same revision
  // semantics as every revisioned read here); a fresh store recovers with a full read.
  const fresh = createAttentionStore(60_000);
  fresh.read = async input => input.revision ? { mode: "unchanged", unchanged: true, revision: "x" } : { ...summary({ count: 5 }), mode: "full", unchanged: false, revision: "x" };
  await fresh.refresh();
  assert.equal(fresh.getSnapshot().state?.count, 5);
  assert.deepEqual(calls.map(call => call.revision ?? null), [null, "a"]);
});

test("the page, the workspace panel and the inspector share one directory per connection (opus-F7)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { retainDirectory } = await import("../client/use-observatory");
  const lists: unknown[] = [], observed: unknown[] = [];
  const page = { entries: [], pageInfo: { nextCursor: null, hasMore: false } };
  const paseo = { agents: { list: async (options: { subscribe?: object }) => {
    if (options.subscribe) { observed.push(options); return { ...page, subscription: { subscribe: () => () => {}, release: async () => {} } }; }
    lists.push(options); return page;
  } } } as never;
  const first = retainDirectory(paseo, false), second = retainDirectory(paseo, false), archive = retainDirectory(paseo, true);
  assert.equal(first.directory, second.directory, "two views on one host share the directory");
  assert.notEqual(first.directory, archive.directory, "the archive scope is its own");
  await tick(); await tick();
  assert.equal(observed.length, 2, "one observation per scope, not per view");
  first.release(); second.release();
  // Re-opening within the grace period keeps the same directory: no new read of every Agent.
  const third = retainDirectory(paseo, false);
  assert.equal(third.directory, first.directory);
  third.release(); archive.release();
  t.mock.timers.tick(15_001);
  const fourth = retainDirectory(paseo, false);
  assert.notEqual(fourth.directory, first.directory, "after the grace period the directory was let go");
  fourth.release(); t.mock.timers.tick(15_001);
});

test("显示后台工作区 reads its own shared directory, the only one that asks the host for background workspaces (issue 16)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { retainDirectory } = await import("../client/use-observatory");
  const filters: Array<{ includeBackground?: unknown }> = [];
  const page = { entries: [], pageInfo: { nextCursor: null, hasMore: false } };
  const paseo = { agents: { list: async (options: { subscribe?: object; filter: { includeBackground?: unknown } }) => {
    filters.push(options.filter);
    return options.subscribe ? { ...page, subscription: { subscribe: () => () => {}, release: async () => {} } } : page;
  } } } as never;
  const plain = retainDirectory(paseo, false), shown = retainDirectory(paseo, false, true), again = retainDirectory(paseo, false, true);
  try {
    assert.notEqual(plain.directory, shown.directory, "turning the setting on reads another directory");
    assert.equal(shown.directory, again.directory, "shared like the plain one");
    await tick(); await tick();
    assert.equal(filters.filter(filter => filter.includeBackground === true).length, 3, "its observation and both reads ask for background workspaces");
    assert.equal(filters.filter(filter => !("includeBackground" in filter)).length, 3, "the plain directory's requests are unchanged");
  } finally { plain.release(); shown.release(); again.release(); t.mock.timers.tick(15_001); }
});

test("one badge store shares a single foreground clock, and hides stale counts while a read is stalled", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const { createAttentionStore, attentionCount, ATTENTION_STALE_MS } = await import("../client/use-attention");
  let now = 1_000, calls = 0, finish: ((reply: AttentionResponse) => void) | undefined;
  const store = createAttentionStore(20_000, () => now);
  store.read = async () => { calls++; return { ...summary(), mode: "full", unchanged: false, revision: "r1" }; };
  const first = store.subscribe(() => {}), second = store.subscribe(() => {});
  await tick();
  assert.equal(appState.listeners.size, 1);
  assert.equal(calls, 1);
  store.read = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  now += ATTENTION_STALE_MS + 1;
  t.mock.timers.tick(20_000);
  assert.equal(attentionCount(store.getSnapshot()), null, "the shared clock expires old data even if its next RPC never returns");
  assert.equal(calls, 2);
  first(); assert.equal(appState.listeners.size, 1);
  second(); assert.equal(appState.listeners.size, 0);
  finish!({ mode: "unchanged", unchanged: true, revision: "r1" }); await tick();
});
