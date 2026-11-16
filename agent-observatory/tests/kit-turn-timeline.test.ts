import assert from "node:assert/strict";
import test from "node:test";
import { hasUserMessage, hookTimeline, turnTimeline, type TurnTimelinePaseo } from "../server/turn-timeline";

type Item = { type: string; text?: string };
type Request = { direction: "tail" | "before"; cursor?: { epoch: string; seq: number }; limit: number; projection: "projected" };

/** A projected timeline as Paseo 0.13 pages it: rows numbered from 1, `before` a cursor returns the rows under its seq. */
function fakePaseo(items: Item[], options: { epochs?: string[]; fail?: number; hang?: number } = {}) {
  const requests: Request[] = [];
  const paseo: TurnTimelinePaseo = { agents: { ref: () => ({ timeline: { refetch: async (request: Request) => {
    requests.push(request);
    const call = requests.length;
    if (options.fail === call) throw new Error("socket closed");
    if (options.hang === call) return new Promise<never>(() => {});
    const epoch = options.epochs?.[call - 1] ?? "e1";
    const rows = items.map((item, index) => ({ seqStart: index + 1, seqEnd: index + 1, item, timestamp: "2026-10-25T00:00:00.000Z" }));
    const end = request.direction === "tail" ? rows.length : request.cursor!.seq - 1;
    const page = rows.slice(Math.max(0, end - request.limit), end);
    return { epoch, entries: page, startCursor: page.length ? { epoch, seq: page[0]!.seqStart } : null, hasOlder: (page[0]?.seqStart ?? 1) > 1, reset: false, staleCursor: false };
  } } }) } };
  return { paseo, requests };
}

const user = (text: string): Item => ({ type: "user_message", text });
const reply = (text: string): Item => ({ type: "assistant_message", text });
const tool = (index: number): Item => ({ type: "tool_call", text: `t${index}` });

test("the hook's own timeline (Paseo 0.12) is used as it is, without a read", async () => {
  const { paseo, requests } = fakePaseo([user("x")]);
  const hook = [user("whole"), reply("conversation")];
  const read = await turnTimeline(paseo, "a", hook);
  assert.deepEqual(read, { items: hook, positions: [0, 1], complete: true, source: "hook" });
  assert.equal(requests.length, 0);
});

test("a hook without `timeline` (the field leaves the 0.16 SDK type; the daemon stops sending it after 2027-05-31) reads like an empty one", async () => {
  assert.deepEqual(hookTimeline({ agent: { id: "a" }, turnId: "t", outcome: { kind: "completed" } }), []);
  assert.deepEqual(hookTimeline({ timeline: "not an array" }), []);
  assert.deepEqual(hookTimeline(null), []);
  const hook = [user("whole")];
  assert.equal(hookTimeline({ timeline: hook }), hook);
  const items = [user("ask"), tool(1), reply("done")];
  const { paseo, requests } = fakePaseo(items);
  const read = await turnTimeline<Item>(paseo, "a", hookTimeline<Item>({ agent: { id: "a" } }));
  assert.equal(read.source, "read");
  assert.deepEqual(read.items, items);
  assert.equal(requests.length, 1);
  const missing = await turnTimeline<Item>(paseo, "a", undefined);
  assert.deepEqual(missing.items, items, "undefined hook items read too");
});

test("an empty hook timeline (0.13) reads the projected tail back to the latest user message", async () => {
  const items = [user("old"), reply("old answer"), ...Array.from({ length: 60 }, (_, index) => tool(index)), user("new"),
    ...Array.from({ length: 150 }, (_, index) => tool(100 + index)), reply("done")];
  const { paseo, requests } = fakePaseo(items);
  const read = await turnTimeline<Item>(paseo, "a", []);
  assert.equal(read.source, "read");
  assert.equal(read.complete, false, "the window stops at the user message, short of the start");
  assert.deepEqual(requests.map(request => [request.direction, request.cursor?.seq ?? null, request.limit, request.projection]),
    [["tail", null, 100, "projected"], ["before", 115, 100, "projected"]]);
  assert.deepEqual(read.items, items.slice(14), "oldest first, nothing repeated");
  assert.deepEqual(read.positions, items.slice(14).map((_, index) => index + 15), "row sequence numbers");
  assert.ok(hasUserMessage(read.items));
});

test("a short conversation is read whole and marked complete", async () => {
  const items = [user("hi"), reply("hello")];
  const read = await turnTimeline<Item>(fakePaseo(items).paseo, "a", []);
  assert.deepEqual(read.items, items);
  assert.equal(read.complete, true);
});

test("enough, maxRows and an autonomous turn without a user message bound the read", async () => {
  const items = Array.from({ length: 450 }, (_, index) => tool(index));
  const capped = fakePaseo(items);
  const read = await turnTimeline<Item>(capped.paseo, "a", [], { maxRows: 250 });
  assert.equal(read.items.length, 250);
  assert.deepEqual(capped.requests.map(request => request.limit), [100, 100, 50]);
  assert.equal(read.complete, false);
  const stop = fakePaseo(items);
  const early = await turnTimeline<Item>(stop.paseo, "a", [], { enough: got => got.length >= 100 });
  assert.equal(early.items.length, 100);
  assert.equal(stop.requests.length, 1);
});

test("a failed or slow page keeps the newer pages; a new epoch drops the older history", async () => {
  const items = [user("a"), ...Array.from({ length: 120 }, (_, index) => tool(index))];
  const failed = await turnTimeline<Item>(fakePaseo(items, { fail: 2 }).paseo, "a", []);
  assert.deepEqual(failed.items, items.slice(21));
  assert.equal(failed.complete, false);
  const hung = await turnTimeline<Item>(fakePaseo(items, { hang: 2 }).paseo, "a", [], { timeoutMs: 50 });
  assert.deepEqual(hung.items, items.slice(21), "the read gives up at its deadline");
  const rebuilt = await turnTimeline<Item>(fakePaseo(items, { epochs: ["e1", "e2"] }).paseo, "a", []);
  assert.deepEqual(rebuilt.items, items.slice(21));
  assert.equal(rebuilt.complete, false);
  const none = await turnTimeline<Item>(null, "a", []);
  assert.deepEqual(none, { items: [], positions: [], complete: false, source: "read" });
});
