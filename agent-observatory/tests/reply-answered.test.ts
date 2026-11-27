import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelemetryStore } from "../server/telemetry";
import { applyTelemetry, classifyAgentStatus, normalizeAgent, replyMarkedAnswered, replyStillAsks, type AgentSource, type LifecycleOutcome } from "../shared/model";
import { setReplyAnswered } from "../shared/telemetry";

// 已答复 / 待回复: an Agent awaiting a reply can be marked answered without sending it anything, and put back.

const at = (minutes: number) => new Date(Date.parse("2026-11-26T10:00:00Z") + minutes * 60_000).toISOString();
const asking = (patch: Partial<LifecycleOutcome> = {}): LifecycleOutcome =>
  ({ outcome: "completed", turnStartedAt: at(1), turnEndedAt: at(5), replyAt: at(5), replyAsks: true, ...patch });
const source = { status: "idle", createdAt: at(0), updatedAt: at(5), lastUserMessageAt: at(1) };

test("a reply marked answered no longer counts as awaiting a reply; a newer reply asks again", () => {
  assert.equal(replyStillAsks(asking()), true);
  assert.equal(classifyAgentStatus(source as Omit<AgentSource, "id">, asking()), "idle");
  // Marked after the reply was written: answered, so the turn reads as completed.
  const answered = asking({ replyAnsweredAt: at(6) });
  assert.equal(replyStillAsks(answered), false); assert.equal(replyMarkedAnswered(answered), true);
  assert.equal(classifyAgentStatus(source as Omit<AgentSource, "id">, answered), "completed");
  // A newer reply than the mark asks again.
  const newer = asking({ turnStartedAt: at(7), turnEndedAt: at(9), replyAt: at(9), replyAnsweredAt: at(6) });
  assert.equal(replyStillAsks(newer), true); assert.equal(replyMarkedAnswered(newer), false);
  // A reply that asks nothing is never "marked answered".
  assert.equal(replyMarkedAnswered(asking({ replyAsks: false, replyAnsweredAt: at(6) })), false);
});

test("the agent record names the reply the actions apply to and whether it is marked answered", () => {
  const agent = normalizeAgent({ id: "a", ...source } as AgentSource);
  const waiting = applyTelemetry(agent, asking());
  assert.deepEqual([waiting.status, waiting.replyAskedAt, waiting.replyAnswered], ["idle", at(5), false]);
  const answered = applyTelemetry(agent, asking({ replyAnsweredAt: at(6) }));
  assert.deepEqual([answered.status, answered.replyAskedAt, answered.replyAnswered], ["completed", at(5), true]);
  // Quick replies are not offered for a reply marked answered.
  assert.equal(applyTelemetry(agent, asking({ replyAnsweredAt: at(6), replyNudge: "go-ahead" })).replyNudge ?? null, null);
  // After the user wrote again, the old reply names nothing.
  const wrote = applyTelemetry(normalizeAgent({ id: "a", ...source, lastUserMessageAt: at(8) } as AgentSource), asking({ replyAnsweredAt: at(6) }));
  assert.deepEqual([wrote.replyAskedAt ?? null, !!wrote.replyAnswered], [null, false]);
});

test("the store marks the current asking reply answered, persists it, refuses a stale reply and can undo", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-answered-"));
  let clock = Date.parse(at(6));
  let store = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
  const agents = [{ id: "a", status: "idle", lastUserMessageAt: at(1), archivedAt: null, activeTurn: false }];
  try {
    await store.record({ type: "created", agent: { id: "a", title: "a" } });
    await store.recordReply("a", at(1), { at: at(5), asks: true });
    assert.deepEqual([...store.awaitingAgents(agents)], ["a"]);
    // A reply the user did not see (another timestamp) is stale: nothing changes.
    assert.deepEqual(await store.setReplyAnswered("a", at(4), true), { status: "stale", replyAnsweredAt: null });
    assert.deepEqual(await store.setReplyAnswered("missing", at(5), true), { status: "stale", replyAnsweredAt: null });
    const marked = await store.setReplyAnswered("a", at(5), true);
    assert.deepEqual(marked, { status: "ok", replyAnsweredAt: at(6) });
    assert.deepEqual([...store.awaitingAgents(agents)], []);
    // Marking again changes nothing.
    clock = Date.parse(at(7)); assert.deepEqual(await store.setReplyAnswered("a", at(5), true), { status: "ok", replyAnsweredAt: at(6) });
    // Written out before answering: a restart keeps it.
    await store.close();
    store = new TelemetryStore({ directory, now: () => clock, writeDelayMs: 60_000 });
    assert.equal((await store.snapshot("a")).agents[0]?.replyAnsweredAt, at(6));
    assert.deepEqual([...store.awaitingAgents(agents)], []);
    // Undo: awaiting a reply again.
    assert.deepEqual(await store.setReplyAnswered("a", at(5), false), { status: "ok", replyAnsweredAt: null });
    assert.deepEqual([...store.awaitingAgents(agents)], ["a"]);
    // Marked answered, then the user prompts again and the Agent asks again: awaiting again; the old reply is stale.
    await store.setReplyAnswered("a", at(5), true);
    await store.recordReply("a", at(10), { at: at(15), asks: true });
    const later = [{ ...agents[0]!, lastUserMessageAt: at(10) }];
    assert.deepEqual([...store.awaitingAgents(later)], ["a"]);
    assert.equal((await store.setReplyAnswered("a", at(5), true)).status, "stale");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("the RPC contract takes the agent, the reply it names and the direction", () => {
  assert.equal(setReplyAnswered.name, "observatory.reply.answered");
  assert.ok(setReplyAnswered.input.safeParse({ agentId: "a", replyAt: at(5), answered: true }).success);
  assert.equal(setReplyAnswered.input.safeParse({ agentId: "a", replyAt: "yesterday", answered: true }).success, false);
  assert.ok(setReplyAnswered.output.safeParse({ status: "stale", replyAnsweredAt: null, message: "x" }).success);
});
