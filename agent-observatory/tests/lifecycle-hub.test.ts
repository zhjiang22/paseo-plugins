import assert from "node:assert/strict";
import test from "node:test";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { lifecycleHub, turnRead } from "../server/lifecycle-hub";

/** The host side of `server.on`, as plugin-process.js / PluginHookHandlers.invoke run it: a structuredClone per handler. */
function fakeHost() {
  const handlers = new Map<string, Set<(input: unknown, context: unknown) => unknown>>();
  let clones = 0;
  const server = {
    on: (name: string, handler: (input: unknown, context: unknown) => unknown) => {
      let set = handlers.get(name); if (!set) { set = new Set(); handlers.set(name, set); }
      set.add(handler);
      return () => { set!.delete(handler); if (!set!.size) handlers.delete(name); };
    },
    handle: function (this: unknown) { return this; },
    before: () => () => {},
  } as unknown as PluginServerContext;
  const invoke = async (name: string, input: unknown) => {
    for (const handler of handlers.get(name) ?? []) { clones++; try { await handler(structuredClone(input), { paseo: {} }); } catch { /* the host logs and goes on */ } }
  };
  return { server, handlers, invoke, clones: () => clones };
}

test("every module's turn_ended handler runs on one host clone, in registration order (opus-F15)", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server), seen: string[] = [];
  const timeline = Array.from({ length: 50 }, (_, index) => ({ type: "assistant_message", text: `part ${index}` }));
  const inputs = new Set<unknown>();
  for (const name of ["telemetry", "stats", "results", "read-state", "quota", "insights"]) {
    hub.server.on("agent.turn_ended", async (input: unknown) => { inputs.add(input); seen.push(name); await Promise.resolve(); });
  }
  assert.equal(host.handlers.get("agent.turn_ended")?.size, 1, "a single host registration");
  await host.invoke("agent.turn_ended", { agent: { id: "a" }, turnId: "t", outcome: { kind: "completed" }, timeline });
  assert.equal(host.clones(), 1, "the host cloned the whole timeline once, not six times");
  assert.deepEqual(seen, ["telemetry", "stats", "results", "read-state", "quota", "insights"]);
  assert.equal(inputs.size, 1, "all handlers read the same copy");
  assert.deepEqual(hub.registered(), ["agent.turn_ended"]);
});

test("a failing handler does not stop the others; removal drops the host registration with the last handler", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server), seen: string[] = [];
  const removeA = hub.server.on("agent.turn_started", () => { seen.push("a"); throw new Error("boom"); });
  const removeB = hub.server.on("agent.turn_started", () => { seen.push("b"); });
  const originalError = console.error; console.error = () => {};
  try { await host.invoke("agent.turn_started", { agent: { id: "x" }, turnId: null }); } finally { console.error = originalError; }
  assert.deepEqual(seen, ["a", "b"]);
  removeA();
  assert.equal(host.handlers.get("agent.turn_started")?.size, 1, "still registered while a handler is left");
  removeB(); removeB();
  assert.equal(host.handlers.has("agent.turn_started"), false);
  assert.deepEqual(hub.registered(), []);
  // A handler registered after everything was removed registers again.
  hub.server.on("agent.turn_started", () => { seen.push("c"); });
  await host.invoke("agent.turn_started", { agent: { id: "x" }, turnId: null });
  assert.deepEqual(seen, ["a", "b", "c"]);
});

test("close removes every host registration; other context methods are the host's, called on the host", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server);
  hub.server.on("agent.created", () => {}); hub.server.on("agent.closed", () => {});
  assert.equal(host.handlers.size, 2);
  assert.equal((hub.server.handle as unknown as () => unknown)(), host.server, "bound to the host context");
  hub.close();
  assert.equal(host.handlers.size, 0);
});

/** Paseo 0.13: `agent.turn_ended` arrives with `timeline: []` and the hub reads the end of the conversation itself. */
function pagedPaseo(items: { type: string; text?: string }[], gate?: Promise<void>) {
  const calls: unknown[] = [];
  const paseo = { agents: { ref: (id: string) => ({ timeline: { refetch: async (request: { direction: string; cursor?: { seq: number }; limit: number }) => {
    calls.push({ id, ...request });
    await gate;
    const rows = items.map((item, index) => ({ seqStart: index + 1, seqEnd: index + 1, item }));
    const end = request.direction === "tail" ? rows.length : request.cursor!.seq - 1;
    const page = rows.slice(Math.max(0, end - request.limit), end);
    return { epoch: "e", entries: page, startCursor: page.length ? { epoch: "e", seq: page[0]!.seqStart } : null, hasOlder: (page[0]?.seqStart ?? 1) > 1 };
  } } }) } };
  return { paseo, calls };
}

test("Paseo 0.13: an empty turn_ended timeline is read once and every handler gets the window", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server);
  const conversation = [{ type: "user_message", text: "old" }, { type: "assistant_message", text: "old reply" }, { type: "user_message", text: "go" }, { type: "assistant_message", text: "done" }];
  const { paseo, calls } = pagedPaseo(conversation);
  const seen: unknown[] = [], reads: unknown[] = [];
  for (let index = 0; index < 3; index++) hub.server.on("agent.turn_ended", (input: object) => { seen.push((input as { timeline?: unknown }).timeline); reads.push(turnRead(input)); });
  const handler = [...host.handlers.get("agent.turn_ended")!][0]!;
  await handler({ agent: { id: "a" }, turnId: "t", outcome: { kind: "completed" }, timeline: [] }, { paseo });
  assert.equal(calls.length, 1, "one read for all handlers");
  assert.deepEqual(seen, [conversation, conversation, conversation]);
  assert.deepEqual(reads[0], { positions: [1, 2, 3, 4], complete: true });
  // 0.12 still brings the whole conversation: no read, nothing recorded.
  seen.length = 0; reads.length = 0;
  await handler({ agent: { id: "a" }, turnId: "t2", outcome: { kind: "completed" }, timeline: conversation }, { paseo });
  assert.equal(calls.length, 1);
  assert.deepEqual(reads, [null, null, null]);
});

test("Paseo 0.16+: a turn_ended without a timeline field (gone from the SDK type; sent as [] until 2027-05-31) is read like an empty one", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server);
  const conversation = [{ type: "user_message", text: "go" }, { type: "assistant_message", text: "done" }];
  const { paseo, calls } = pagedPaseo(conversation);
  const seen: unknown[] = [];
  hub.server.on("agent.turn_ended", (input: object) => { seen.push((input as { timeline?: unknown }).timeline); });
  const handler = [...host.handlers.get("agent.turn_ended")!][0]!;
  await handler({ agent: { id: "a" }, turnId: "t", outcome: { kind: "completed" } }, { paseo });
  assert.equal(calls.length, 1, "the hub read the turn");
  assert.deepEqual(seen, [conversation]);
});

test("Paseo 0.13: the Agent's later events wait for its turn-end read; other Agents do not", async () => {
  const host = fakeHost(), hub = lifecycleHub(host.server);
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const { paseo } = pagedPaseo([{ type: "user_message", text: "go" }], gate);
  const order: string[] = [];
  hub.server.on("agent.turn_ended", ({ agent }: { agent: { id: string } }) => { order.push(`ended ${agent.id}`); });
  hub.server.on("agent.turn_started", ({ agent }: { agent: { id: string } }) => { order.push(`started ${agent.id}`); });
  const ended = [...host.handlers.get("agent.turn_ended")!][0]!, started = [...host.handlers.get("agent.turn_started")!][0]!;
  const first = ended({ agent: { id: "a" }, turnId: "1", outcome: { kind: "completed" }, timeline: [] }, { paseo });
  const next = started({ agent: { id: "a" }, turnId: "2" }, { paseo });
  await started({ agent: { id: "b" }, turnId: "9" }, { paseo });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(order, ["started b"], "a's next turn waits; b runs at once");
  open();
  await Promise.all([first, next]);
  assert.deepEqual(order, ["started b", "ended a", "started a"]);
});
