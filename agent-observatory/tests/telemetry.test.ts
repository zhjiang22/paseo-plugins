import { t, type MessageId } from "../shared/text";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TelemetryStore, type TelemetryObservation } from "../server/telemetry";
import { eventLabel, hiddenEventCount, mergeTelemetry, telemetryResponseSchema, telemetrySnapshotSchema, type TelemetryEvent } from "../shared/telemetry";

const epoch = Date.parse("2026-09-16T12:00:00.000Z");
const agent = { id: "agent-1", title: "Ship dashboard" };
/** Storage messages are shown as they are (a banner, 明细 → 观测): a whole Chinese sentence, only a safe code in Latin. */
function chineseNotice(message: string | null, code?: string) {
  assert.ok(message, "a notice is set");
  assert.match(message, /[\u3400-\u9fff]/);
  assert.match(message, /。$/, "a whole sentence");
  assert.doesNotMatch(message.replace(/[A-Z0-9_]{2,32}/g, ""), /[A-Za-z]{2,}/, "no English words besides the code");
  if (code) assert.ok(message.includes(`（${code}）`), `the code ${code} is named`);
}

async function fixture(options: { maxAgents?: number; maxEvents?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "observatory-telemetry-"));
  let currentTime = epoch;
  const store = new TelemetryStore({ directory, now: () => currentTime, writeDelayMs: 60_000, ...options });
  return {
    directory,
    store,
    advance(ms: number) { currentTime += ms; },
    async dispose() { await store.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test("counts only observed outcomes and durations with paired starts", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "created", agent });
    await f.store.record({ type: "turn_started", agent, turnId: "turn-1" });
    f.advance(1_500);
    await f.store.record({ type: "turn_ended", agent, turnId: "turn-1", outcome: "completed" });
    f.advance(100);
    await f.store.record({ type: "turn_ended", agent, turnId: "unobserved-start", outcome: "failed" });
    const snapshot = telemetrySnapshotSchema.parse(await f.store.snapshot());
    assert.equal(snapshot.agents[0].completedTurns, 1);
    assert.equal(snapshot.agents[0].failedTurns, 1);
    assert.equal(snapshot.agents[0].totalRunMs, 1_500);
    assert.equal(snapshot.agents[0].turnStartedAt, null);
    assert.equal(snapshot.agents[0].outcome, "failed");
    assert.equal(snapshot.events[0].durationMs, undefined);
    assert.equal(snapshot.events[1].durationMs, 1_500);
    assert.equal(snapshot.startedAt, new Date(epoch).toISOString());
  } finally { await f.dispose(); }
});

test("serializes overlapping handlers before asynchronous loading completes", async () => {
  const f = await fixture();
  try {
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < 40; i += 1) {
      const member = { id: `agent-${i}`, title: `Worker ${i}` };
      tasks.push(f.store.record({ type: "turn_started", agent: member, turnId: `turn-${i}` }));
      f.advance(10);
      tasks.push(f.store.record({ type: "turn_ended", agent: member, turnId: `turn-${i}`, outcome: "completed" }));
    }
    await Promise.all(tasks);
    await Promise.all([f.store.flush(), f.store.flush(), f.store.flush()]);
    const snapshot = await f.store.snapshot();
    assert.equal(snapshot.agents.length, 40);
    assert.ok(snapshot.agents.every((item) => item.completedTurns === 1 && item.totalRunMs === 10));
    const saved = JSON.parse(await readFile(join(f.directory, "telemetry.json"), "utf8"));
    assert.equal(saved.events.length, 80);
    assert.deepEqual(await readdir(f.directory), ["telemetry.json"]);
  } finally { await f.dispose(); }
});

test("deduplicates keyed endings across reload and ignores a late matching start", async () => {
  const f = await fixture();
  let restored: TelemetryStore | undefined;
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "turn-1" });
    f.advance(500);
    await f.store.record({ type: "turn_ended", agent, turnId: "turn-1", outcome: "completed" });
    await f.store.record({ type: "turn_ended", agent, turnId: "turn-1", outcome: "completed" });
    await f.store.record({ type: "turn_started", agent, turnId: "turn-1" });
    await f.store.close();
    restored = new TelemetryStore({ directory: f.directory, now: () => epoch + 10_000, writeDelayMs: 60_000 });
    await restored.record({ type: "turn_ended", agent, turnId: "turn-1", outcome: "completed" });
    const snapshot = await restored.snapshot();
    assert.equal(snapshot.agents[0].completedTurns, 1);
    assert.equal(snapshot.agents[0].totalRunMs, 500);
    assert.equal(snapshot.agents[0].outcome, "completed");
    assert.equal(snapshot.events.length, 2);
    assert.equal(snapshot.startedAt, new Date(epoch).toISOString());
  } finally { await restored?.close(); await f.dispose(); }
});

test("anonymous turn IDs deduplicate until another observed start", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: null });
    await f.store.record({ type: "turn_started", agent, turnId: null });
    f.advance(100);
    await f.store.record({ type: "turn_ended", agent, turnId: null, outcome: "canceled" });
    await f.store.record({ type: "turn_ended", agent, turnId: null, outcome: "canceled" });
    await f.store.record({ type: "turn_started", agent, turnId: null });
    f.advance(200);
    await f.store.record({ type: "turn_ended", agent, turnId: null, outcome: "completed" });
    const snapshot = await f.store.snapshot();
    assert.equal(snapshot.agents[0].completedTurns, 1);
    assert.equal(snapshot.agents[0].canceledTurns, 1);
    assert.equal(snapshot.agents[0].totalRunMs, 300);
    assert.equal(snapshot.events.length, 4);
  } finally { await f.dispose(); }
});

test("delayed endings never replace the newer turn, active or already ended", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "older" });
    f.advance(100);
    await f.store.record({ type: "turn_started", agent, turnId: "newer" });
    f.advance(100);
    await f.store.record({ type: "turn_ended", agent, turnId: "newer", outcome: "failed" });
    f.advance(100);
    await f.store.record({ type: "turn_ended", agent, turnId: "older", outcome: "completed" });
    let summary = (await f.store.snapshot()).agents[0];
    assert.equal(summary.outcome, "failed");
    assert.equal(summary.turnEndedAt, new Date(epoch + 200).toISOString());
    await f.store.record({ type: "turn_started", agent, turnId: "current" });
    await f.store.record({ type: "turn_ended", agent, turnId: "missing-start", outcome: "failed" });
    summary = (await f.store.snapshot()).agents[0];
    assert.equal(summary.outcome, null);
    assert.equal(summary.turnEndedAt, null);
  } finally { await f.dispose(); }
});

test("turn ends record whether the final reply asks the user; a new turn clears it", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    f.advance(1_000);
    await f.store.record({ type: "turn_ended", agent, turnId: "t1", outcome: "completed", asks: true });
    let summary = (await f.store.snapshot()).agents[0];
    assert.equal(summary.replyAsks, true); assert.equal(summary.replyAt, new Date(epoch + 1_000).toISOString());
    const saved = await readFile(join(f.directory, "telemetry.json"), "utf8").catch(() => "");
    assert.equal(saved.includes("要不要"), false);
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    summary = (await f.store.snapshot()).agents[0];
    assert.equal(summary.replyAsks, null); assert.equal(summary.replyAt, null);
    f.advance(1_000);
    await f.store.record({ type: "turn_ended", agent, turnId: "t2", outcome: "canceled", asks: true });
    assert.equal((await f.store.snapshot()).agents[0].replyAsks, null, "only a completed turn has a final reply");
  } finally { await f.dispose(); }
});

test("an end whose start was never delivered still updates the summary once older starts are stale", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "lost-end" });
    f.advance(60_000);
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    f.advance(60_000);
    await f.store.record({ type: "turn_ended", agent, turnId: "t2", outcome: "completed" });
    f.advance(60_000);
    // A queued follow-up ran without a start hook; "lost-end" is still listed as active from long before.
    await f.store.record({ type: "turn_ended", agent, turnId: "queued", outcome: "completed", asks: false });
    const summary = (await f.store.snapshot()).agents[0];
    assert.equal(summary.turnEndedAt, new Date(epoch + 180_000).toISOString());
    assert.equal(summary.replyAsks, false);
  } finally { await f.dispose(); }
});

test("backfilled replies complete missed turns once per user message and feed 待回复", async () => {
  const f = await fixture();
  try {
    const userAt = new Date(epoch + 5_000).toISOString(), replyAt = new Date(epoch + 9_000).toISOString();
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    f.advance(1_000);
    await f.store.record({ type: "turn_ended", agent, turnId: "t1", outcome: "completed", asks: false });
    assert.equal(await f.store.needsReplyCheck(agent.id, new Date(epoch).toISOString()), false, "the observed end already answers this message");
    assert.equal(await f.store.needsReplyCheck(agent.id, userAt), true);
    await f.store.recordReply(agent.id, userAt, { at: replyAt, asks: true });
    const summary = (await f.store.snapshot()).agents[0];
    assert.deepEqual({ outcome: summary.outcome, turnStartedAt: summary.turnStartedAt, turnEndedAt: summary.turnEndedAt, replyAsks: summary.replyAsks },
      { outcome: "completed", turnStartedAt: userAt, turnEndedAt: replyAt, replyAsks: true });
    assert.equal(summary.completedTurns, 1, "a backfill is not an observed turn");
    assert.equal(await f.store.needsReplyCheck(agent.id, userAt), false);
    assert.deepEqual([...f.store.awaitingAgents([{ id: agent.id, status: "idle", lastUserMessageAt: userAt }])], [agent.id]);
    assert.deepEqual([...f.store.awaitingAgents([{ id: agent.id, status: "idle", lastUserMessageAt: new Date(epoch + 10_000).toISOString() }])], []);
    assert.deepEqual([...f.store.awaitingAgents([{ id: agent.id, status: "idle", lastUserMessageAt: userAt, archivedAt: userAt }])], []);
    const next = new Date(epoch + 20_000).toISOString();
    await f.store.recordReply(agent.id, next, null);
    assert.equal(await f.store.needsReplyCheck(agent.id, next), false, "a turn without a final reply is read once");
    assert.equal((await f.store.snapshot()).agents[0].replyAsks, null);
    await f.store.recordReply("never-observed", userAt, { at: replyAt, asks: false });
    assert.equal((await f.store.snapshot("never-observed")).agents[0].outcome, "completed");
  } finally { await f.dispose(); }
});

test("overlapping approvals count waiting wall time once and tolerate reverse delivery", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "permission_requested", agent, requestId: "first" });
    await f.store.record({ type: "permission_requested", agent, requestId: "first" });
    f.advance(100);
    await f.store.record({ type: "permission_requested", agent, requestId: "second" });
    f.advance(100);
    await f.store.record({ type: "permission_resolved", agent, requestId: "first", allowed: true });
    f.advance(100);
    await f.store.record({ type: "permission_resolved", agent, requestId: "second", allowed: false });
    await f.store.record({ type: "permission_resolved", agent, requestId: "second", allowed: false });
    await f.store.record({ type: "permission_resolved", agent, requestId: "reverse", allowed: true });
    await f.store.record({ type: "permission_requested", agent, requestId: "reverse" });
    const snapshot = await f.store.snapshot();
    assert.equal(snapshot.agents[0].permissionWaitMs, 300);
    assert.equal(snapshot.events.length, 5);
    assert.equal(snapshot.events[1].durationMs, 200);
  } finally { await f.dispose(); }
});

test("ending a turn closes its approval wait without inventing a resolution event", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "turn" });
    await f.store.record({ type: "permission_requested", agent, requestId: "permission" });
    f.advance(400);
    await f.store.record({ type: "turn_ended", agent, turnId: "turn", outcome: "canceled" });
    f.advance(100);
    await f.store.record({ type: "permission_resolved", agent, requestId: "permission", allowed: false });
    assert.equal((await f.store.snapshot()).agents[0].permissionWaitMs, 400);
    assert.equal((await f.store.snapshot()).events.filter((event) => event.type === "permission_resolved").length, 1);
  } finally { await f.dispose(); }
});

test("bounds records and the event ledger and scopes snapshot copies to one agent", async () => {
  const f = await fixture({ maxAgents: 2, maxEvents: 3 });
  try {
    for (let i = 0; i < 5; i += 1) {
      await f.store.record({ type: "created", agent: { id: `agent-${i}`, title: "Title" } });
      f.advance(10);
    }
    const snapshot = await f.store.snapshot();
    assert.equal(snapshot.agents.length, 2);
    assert.equal(snapshot.events.length, 3);
    assert.deepEqual(snapshot.agents.map((item) => item.agentId), ["agent-4", "agent-3"]);
    const scoped = await f.store.snapshot("agent-4");
    assert.equal(scoped.agents.length, 1);
    assert.equal(scoped.events.length, 1);
    scoped.agents[0].completedTurns = 999;
    scoped.events[0].label = "modified";
    assert.equal((await f.store.snapshot("agent-4")).agents[0].completedTurns, 0);
    assert.equal((await f.store.snapshot("agent-4")).events[0].label, "新建 Agent");
    assert.equal((await f.store.snapshot("missing")).agents.length, 0);
  } finally { await f.dispose(); }
});

test("persists only lifecycle metadata and bounded labels", async () => {
  const f = await fixture();
  try {
    const observation = {
      type: "turn_ended", agent: { ...agent, title: "A".repeat(400), cwd: "PRIVATE_PATH" },
      turnId: "PRIVATE_TURN_ID", outcome: "failed", timeline: [{ text: "PRIVATE_PROMPT" }],
      error: { message: "PRIVATE_ERROR" }, request: { arguments: "PRIVATE_ARGUMENTS" },
    } as unknown as TelemetryObservation;
    await f.store.record(observation);
    await f.store.close();
    const persisted = await readFile(join(f.directory, "telemetry.json"), "utf8");
    assert.ok(!persisted.includes("PRIVATE_"));
    assert.equal((await f.store.snapshot()).events[0].agentTitle.length, 160);
    assert.equal((await f.store.snapshot()).persistenceError, null);
  } finally { await f.dispose(); }
});

test("recovers corrupt persistence and preserves one bounded quarantine file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-corrupt-"));
  await writeFile(join(directory, "telemetry.json"), "{not-json", "utf8");
  const store = new TelemetryStore({ directory, now: () => epoch, writeDelayMs: 60_000 });
  try {
    const initial = await store.snapshot();
    chineseNotice(initial.persistenceError);
    assert.match(initial.persistenceError ?? "", /无法读取，已重新开始记录/, "a restore notice, not a save failure");
    assert.equal(initial.agents.length, 0);
    await store.record({ type: "created", agent });
    await store.flush();
    assert.equal((await store.snapshot()).persistenceError, null);
    assert.equal(JSON.parse(await readFile(join(directory, "telemetry.json"), "utf8")).agents.length, 1);
    assert.equal(await readFile(join(directory, "telemetry.json.corrupt"), "utf8"), "{not-json");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("persistence failures keep live collection available and a later flush recovers", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-unwritable-"));
  const directory = join(root, "blocked");
  await writeFile(directory, "not a directory", "utf8");
  const store = new TelemetryStore({ directory, now: () => epoch, writeDelayMs: 60_000 });
  try {
    await store.record({ type: "created", agent });
    await store.flush();
    assert.equal((await store.snapshot()).agents.length, 1);
    const notice = (await store.snapshot()).persistenceError;
    chineseNotice(notice);
    assert.match(notice ?? "", /^事件暂时无法写入磁盘（[A-Z0-9_]+），仍在内存里继续记录。$/);
    await rm(directory);
    await store.flush();
    assert.equal((await store.snapshot()).persistenceError, null);
    assert.equal(JSON.parse(await readFile(join(directory, "telemetry.json"), "utf8")).events.length, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects oversized persistence before parsing and does not retain an oversized backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-oversized-"));
  const file = join(directory, "telemetry.json");
  await writeFile(file, "{}", "utf8");
  await truncate(file, 64 * 1024 * 1024 + 1);
  const store = new TelemetryStore({ directory, now: () => epoch, writeDelayMs: 60_000 });
  try {
    chineseNotice((await store.snapshot()).persistenceError);
    assert.match((await store.snapshot()).persistenceError ?? "", /超过 64 MB/);
    await store.record({ type: "created", agent });
    await store.flush();
    assert.deepEqual(await readdir(directory), ["telemetry.json"]);
    assert.ok((await readFile(file, "utf8")).length < 10_000, "recovered state stays small including coverage and attributed buckets");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("cleanup drains pending handlers and rejects new observations after closing", async () => {
  const f = await fixture();
  try {
    const pending = f.store.record({ type: "created", agent });
    await f.store.close();
    await pending;
    await f.store.record({ type: "created", agent: { id: "too-late", title: "Late" } });
    assert.equal((await f.store.snapshot()).agents.length, 1);
    assert.equal(JSON.parse(await readFile(join(f.directory, "telemetry.json"), "utf8")).agents.length, 1);
  } finally { await f.dispose(); }
});

const sortedSnapshot = (value: { startedAt: string; persistenceError: string | null; agents: Array<{ agentId: string }>; events: unknown[] }) =>
  ({ startedAt: value.startedAt, persistenceError: value.persistenceError, agents: [...value.agents].sort((a, b) => a.agentId.localeCompare(b.agentId)), events: value.events });

test("revisioned reads return unchanged, then only new summaries and events; reloads and evictions resend everything", async () => {
  const f = await fixture({ maxAgents: 2 });
  let restored: TelemetryStore | undefined;
  try {
    await f.store.record({ type: "created", agent: { id: "a", title: "A" } });
    const full = telemetryResponseSchema.parse(await f.store.read());
    assert.equal(full.mode, "full");
    const same = telemetryResponseSchema.parse(await f.store.read({ revision: full.revision }));
    assert.equal(same.mode, "unchanged"); assert.ok(JSON.stringify(same).length < 90);
    f.advance(10); await f.store.record({ type: "turn_started", agent: { id: "a", title: "A" }, turnId: "turn" });
    const delta = telemetryResponseSchema.parse(await f.store.read({ revision: full.revision }));
    assert.equal(delta.mode, "delta");
    if (delta.mode !== "delta") return;
    assert.deepEqual(delta.agents.map(item => item.agentId), ["a"]); assert.deepEqual(delta.events.map(event => event.type), ["turn_started"]);
    const merged = mergeTelemetry(mergeTelemetry(undefined, full), delta);
    assert.deepEqual(sortedSnapshot(merged), sortedSnapshot(await f.store.snapshot()));
    assert.equal(merged.revision, delta.revision);
    await f.store.record({ type: "created", agent: { id: "b", title: "B" } });
    await f.store.record({ type: "created", agent: { id: "c", title: "C" } });
    assert.equal((await f.store.read({ revision: delta.revision })).mode, "full", "an evicted summary cannot linger in a client cache");
    const scoped = await f.store.read({ agentId: "c" });
    assert.ok(scoped.mode === "full" && scoped.agents.length === 1 && scoped.events.every(event => event.agentId === "c"));
    await f.store.close();
    restored = new TelemetryStore({ directory: f.directory, now: () => epoch + 60_000, writeDelayMs: 60_000 });
    assert.equal((await restored.read({ revision: delta.revision })).mode, "full", "a reload starts a new revision generation");
    assert.equal((await restored.read({ revision: "not-a-revision" })).mode, "full");
  } finally { await restored?.close(); await f.dispose(); }
});

test("client-merged deltas always equal a fresh snapshot across random lifecycle sequences", async () => {
  for (let seed of [7, 11, 2026]) {
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const f = await fixture({ maxAgents: 6, maxEvents: 25 });
  try {
    let client = mergeTelemetry(undefined, await f.store.read());
    for (let step = 0; step < 400; step++) {
      const member = { id: `agent-${Math.floor(random() * 8)}`, title: `Worker ${step}` };
      const turnId = `turn-${Math.floor(random() * 5)}`, requestId = `request-${Math.floor(random() * 4)}`;
      const kind = Math.floor(random() * 7);
      f.advance(Math.floor(random() * 5_000));
      if (kind === 0) await f.store.record({ type: "created", agent: member });
      else if (kind === 1 || kind === 2) await f.store.record({ type: "turn_started", agent: member, turnId });
      else if (kind === 3) await f.store.record({ type: "turn_ended", agent: member, turnId, outcome: random() < 0.7 ? "completed" : "failed" });
      else if (kind === 4) await f.store.record({ type: "permission_requested", agent: member, requestId });
      else if (kind === 5) await f.store.record({ type: "permission_resolved", agent: member, requestId, allowed: random() < 0.5 });
      else await f.store.record({ type: "archived", agent: member });
      if (random() < 0.6) {
        client = mergeTelemetry(client, await f.store.read({ revision: client.revision }));
        assert.deepEqual(sortedSnapshot(client), sortedSnapshot(await f.store.snapshot()), `step ${step}`);
      }
    }
  } finally { await f.dispose(); }
  }
});

test("idle heartbeats never rewrite the ledger; coverage is saved lazily and identical payloads are skipped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-writes-"));
  const file = join(directory, "telemetry.json");
  let now = epoch;
  const store = new TelemetryStore({ directory, now: () => now, writeDelayMs: 0, coverageWriteMs: 60_000 });
  try {
    await store.record({ type: "created", agent });
    await store.flush();
    const lifecycle = (await stat(file)).ino;
    for (let beat = 0; beat < 5; beat++) { now += 30_000; await store.analyticsSnapshot(); }
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal((await stat(file)).ino, lifecycle, "heartbeats alone never trigger the prompt lifecycle write");
    await store.flush();
    const coverage = (await stat(file)).ino;
    assert.notEqual(coverage, lifecycle, "an explicit flush still saves pending coverage");
    await store.analyticsSnapshot(); await store.flush();
    assert.equal((await stat(file)).ino, coverage, "a byte-identical state is not rewritten");
    await store.recordUsage("sample", { id: agent.id, projectId: "project" }, new Date(now).toISOString(), { inputTokens: 5 });
    await store.flush();
    const usage = (await stat(file)).ino;
    assert.notEqual(usage, coverage);
    await store.recordUsage("sample", { id: agent.id, projectId: "project" }, new Date(now).toISOString(), { inputTokens: 5 });
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal((await stat(file)).ino, usage, "a repeated usage sample does not dirty storage");
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("lazy coverage writes run on their own timer and survive a reload", async () => {
  const directory = await mkdtemp(join(tmpdir(), "observatory-lazy-coverage-"));
  let now = epoch;
  const store = new TelemetryStore({ directory, now: () => now, writeDelayMs: 60_000, coverageWriteMs: 5 });
  let restored: TelemetryStore | undefined;
  try {
    await store.analyticsSnapshot();
    now += 30_000; await store.analyticsSnapshot();
    await new Promise(resolve => setTimeout(resolve, 40));
    const saved = JSON.parse(await readFile(join(directory, "telemetry.json"), "utf8"));
    assert.equal(saved.analytics.coverageIntervals.at(-1).end, new Date(now).toISOString());
    await store.close();
    restored = new TelemetryStore({ directory, now: () => now + 1000, writeDelayMs: 60_000 });
    assert.equal((await restored.analyticsSnapshot()).coverageIntervals?.[0].end, new Date(now).toISOString());
  } finally { await restored?.close(); await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a turn's stop reason is kept (never text), cleared by the next turn, and a close mid-turn marks it unfinished", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    f.advance(1_000);
    const resetAt = new Date(epoch + 5 * 3_600_000).toISOString();
    await f.store.record({ type: "turn_ended", agent, turnId: "t1", outcome: "completed", asks: null, stop: { kind: "quota", resetAt, at: "1999-01-01T00:00:00.000Z" } });
    let summary = (await f.store.snapshot("agent-1")).agents[0]!;
    assert.deepEqual(summary.stop, { kind: "quota", resetAt, at: new Date(epoch + 1_000).toISOString() }, "stamped with the observed end");
    assert.equal((await f.store.snapshot("agent-1")).events[0]!.label, "完成一轮");
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    summary = (await f.store.snapshot("agent-1")).agents[0]!;
    assert.equal(summary.stop, null);
    f.advance(1_000);
    await f.store.record({ type: "closed", agent });
    summary = (await f.store.snapshot("agent-1")).agents[0]!;
    assert.equal(summary.stop?.kind, "unfinished", "closed while the turn was open");
    assert.equal((await f.store.snapshot("agent-1")).events[0]!.type, "turn_started", "closing adds no event");
    // A close after a finished turn changes nothing.
    await f.store.record({ type: "turn_started", agent, turnId: "t3" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t3", outcome: "completed", asks: false, stop: null });
    await f.store.record({ type: "closed", agent });
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.stop, null);
  } finally { await f.dispose(); }
});

test("a backfilled missed end can carry a stop reason", async () => {
  const f = await fixture();
  try {
    const userAt = new Date(epoch - 60_000).toISOString();
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    await f.store.recordReply("agent-1", new Date(epoch + 1).toISOString(), null, { kind: "unfinished", resetAt: null, at: new Date(epoch + 5_000).toISOString() });
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.stop?.kind, "unfinished");
    await f.store.recordReply("agent-1", userAt, { at: new Date(epoch + 10_000).toISOString(), asks: false });
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.stop?.kind, "unfinished", "an older prompt's reply does not clear a newer stop");
  } finally { await f.dispose(); }
});

test("a reply's merge or pull request link is kept (only the link), survives later replies without one and is replaced by a new one (opus-B16)", async () => {
  const f = await fixture();
  try {
    const mr = { url: "https://git.example.com/team/app/-/merge_requests/42", label: "!42", kind: "mr" as const };
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t1", outcome: "completed", asks: false, link: mr });
    assert.deepEqual((await f.store.snapshot("agent-1")).agents[0]!.link, mr);
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t2", outcome: "completed", asks: false, link: null });
    assert.deepEqual((await f.store.snapshot("agent-1")).agents[0]!.link, mr, "a later reply without a link does not unmake the request");
    const pr = { url: "https://forge.example.org/team/app/pull/7", label: "#7", kind: "pr" as const };
    await f.store.recordReply("agent-1", new Date(epoch + 1).toISOString(), { at: new Date(epoch + 2_000).toISOString(), asks: false, link: pr });
    assert.deepEqual((await f.store.snapshot("agent-1")).agents[0]!.link, pr);
    await f.store.record({ type: "turn_started", agent, turnId: "t3" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t3", outcome: "completed", asks: false, link: { url: "javascript:alert(1)", label: "!1", kind: "mr" } });
    assert.deepEqual((await f.store.snapshot("agent-1")).agents[0]!.link, pr, "a malformed link is never stored");
    // A link with credentials before the host (a push URL) is stored and shown without them.
    await f.store.record({ type: "turn_started", agent, turnId: "t4" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t4", outcome: "completed", asks: false, link: { url: "https://oauth2:QX7-token-0123@git.example.test/team/app/-/merge_requests/43", label: "!43", kind: "mr" } });
    assert.deepEqual((await f.store.snapshot("agent-1")).agents[0]!.link, { url: "https://git.example.test/team/app/-/merge_requests/43", label: "!43", kind: "mr" });
  } finally { await f.dispose(); }
});

test("events stored by 2.12 and earlier read in Chinese; Chinese labels stay as they are (gemini-F9)", () => {
  assert.equal(eventLabel({ type: "created", label: "Agent created" }), "新建 Agent");
  assert.equal(eventLabel({ type: "turn_started", label: "Turn started" }), "开始一轮");
  assert.equal(eventLabel({ type: "turn_failed", label: "Turn failed" }), "一轮失败");
  assert.equal(eventLabel({ type: "permission_requested", label: "Waiting for approval or input" }), "等你审批或回答");
  assert.equal(eventLabel({ type: "permission_resolved", label: "Request declined or cleared" }), "请求被拒绝或撤销");
  assert.equal(eventLabel({ type: "permission_resolved", label: "Request approved" }), "请求已批准");
  assert.equal(eventLabel({ type: "turn_completed", label: "完成重复请求验证" }), "完成重复请求验证");
});

test("a turn's 快捷回复 category is kept with its final reply only, cleared by the next turn, and backfilled like 待回复 (opus-B26)", async () => {
  const f = await fixture();
  const summary = async () => (await f.store.snapshot("agent-1")).agents[0]!;
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t1", outcome: "completed", asks: true, nudge: "go-ahead" });
    assert.equal((await summary()).replyNudge, "go-ahead");
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    assert.equal((await summary()).replyNudge, null, "a new turn clears it with 待回复");
    await f.store.record({ type: "turn_ended", agent, turnId: "t2", outcome: "completed", asks: false, nudge: "made-up" as never });
    assert.equal((await summary()).replyNudge, null, "only a known category is stored");
    await f.store.record({ type: "turn_started", agent, turnId: "t3" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t3", outcome: "completed", asks: null, nudge: "keep-going" });
    assert.equal((await summary()).replyNudge, null, "no final reply, nothing it invites");
    f.advance(1_000);
    const userAt = new Date(epoch + 2_000).toISOString();
    await f.store.recordReply("agent-1", userAt, { at: new Date(epoch + 3_000).toISOString(), asks: false, nudge: "keep-going" });
    assert.equal((await summary()).replyNudge, "keep-going", "a backfilled reply carries its category");
    await f.store.recordReply("agent-1", new Date(epoch + 9_000).toISOString(), null);
    assert.equal((await summary()).replyNudge, null, "a newer prompt without a reply clears it");
    await f.store.close();
    assert.equal((await readFile(join(f.directory, "telemetry.json"), "utf8")).includes("继续"), false, "never any text");
  } finally { await f.dispose(); }
});

test("a guessed reset is kept on both paths; a stop as stored never carries an acknowledgement from a turn's end (grok-F2)", async () => {
  const f = await fixture();
  try {
    const resetAt = new Date(epoch + 4 * 3_600_000).toISOString();
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t1", outcome: "completed", asks: null,
      stop: { kind: "quota", resetAt, resetGuessed: true, at: "1999-01-01T00:00:00.000Z", seenAt: "1999-01-01T00:00:00.000Z" } });
    assert.deepEqual((await f.store.snapshot("agent-1")).agents[0]!.stop, { kind: "quota", resetAt, resetGuessed: true, at: new Date(epoch).toISOString() });
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t2", outcome: "completed", asks: null, stop: { kind: "quota", resetAt, resetGuessed: false, at: new Date(epoch).toISOString() } });
    assert.equal("resetGuessed" in (await f.store.snapshot("agent-1")).agents[0]!.stop!, false, "only a guess is marked");
    f.advance(5_000);
    await f.store.recordReply("agent-1", new Date(epoch + 1_000).toISOString(), { at: new Date(epoch + 2_000).toISOString(), asks: false },
      { kind: "quota", resetAt, resetGuessed: true, at: new Date(epoch + 2_000).toISOString() });
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.stop?.resetGuessed, true, "the backfill keeps it too");
  } finally { await f.dispose(); }
});

test("a close after an hour idle (Paseo 0.14) ends a turn whose end the hook missed, by the host's own record of it", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    f.advance(60 * 60_000);
    const endedAt = new Date(epoch + 20_000).toISOString();
    await f.store.record({ type: "closed", agent, ended: { at: endedAt, outcome: "completed" } });
    const row = (await f.store.snapshot("agent-1")).agents[0]!;
    assert.equal(row.stop, null, "no 可能未收尾 an hour later");
    assert.equal(row.turnEndedAt, endedAt);
    assert.equal(row.outcome, "completed");
    assert.equal(row.completedTurns, 1);
    // A record older than the open turn proves nothing about it: the close still marks it.
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    f.advance(1_000);
    await f.store.record({ type: "closed", agent, ended: { at: endedAt, outcome: "completed" } });
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.stop?.closedMidTurn, true);
  } finally { await f.dispose(); }
});

test("a close recorded after the Agent ran again leaves the new turn alone", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    await f.store.record({ type: "turn_ended", agent, turnId: "t1", outcome: "completed", asks: null });
    const closedAt = epoch;
    f.advance(1_000);
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    await f.store.record({ type: "closed", agent, closedAt, ended: null });
    const row = (await f.store.snapshot("agent-1")).agents[0]!;
    assert.equal(row.stop, null);
    assert.equal(row.turnEndedAt, null, "t2 is still running");
    await f.store.record({ type: "turn_ended", agent, turnId: "t2", outcome: "completed", asks: null });
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.completedTurns, 2);
  } finally { await f.dispose(); }
});

test("a close mid-turn is marked as such and 知道了 on exactly that stop is saved; a new turn replaces it (opus-F34)", async () => {
  const f = await fixture();
  try {
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    f.advance(30_000);
    await f.store.record({ type: "closed", agent });
    const stop = (await f.store.snapshot("agent-1")).agents[0]!.stop!;
    assert.deepEqual(stop, { kind: "unfinished", resetAt: null, at: new Date(epoch + 30_000).toISOString(), closedMidTurn: true });
    const { revision } = await f.store.read();
    assert.equal(await f.store.ackStop("agent-1", new Date(epoch + 29_999).toISOString()), false, "another stop");
    assert.equal(await f.store.ackStop("unknown", stop.at), false);
    assert.equal((await f.store.read({ revision })).mode, "unchanged");
    f.advance(60_000);
    assert.equal(await f.store.ackStop("agent-1", stop.at), true);
    const seen = (await f.store.snapshot("agent-1")).agents[0]!.stop!;
    assert.equal(seen.seenAt, new Date(epoch + 90_000).toISOString());
    assert.equal(stop.seenAt, undefined, "a snapshot handed out earlier is not changed under its reader");
    assert.equal((await f.store.read({ revision })).mode, "delta", "polling clients see it");
    f.advance(60_000);
    assert.equal(await f.store.ackStop("agent-1", stop.at), true, "again: already seen");
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.stop?.seenAt, seen.seenAt, "the first acknowledgement stands");
    // Written out before answering: a restart right after keeps it.
    const reloaded = new TelemetryStore({ directory: f.directory, now: () => epoch, writeDelayMs: 60_000 });
    assert.equal((await reloaded.snapshot("agent-1")).agents[0]!.stop?.seenAt, seen.seenAt);
    await reloaded.close();
    await f.store.record({ type: "turn_started", agent, turnId: "t2" });
    assert.equal((await f.store.snapshot("agent-1")).agents[0]!.stop, null);
    assert.equal(await f.store.ackStop("agent-1", stop.at), false, "nothing to acknowledge after a new turn");
  } finally { await f.dispose(); }
});

test("a backfilled stop of the open turn survives the close, and a tail read cannot undo a first-hand close (opus-F34)", async () => {
  const f = await fixture();
  try {
    const userAt = new Date(epoch - 1_000).toISOString();
    // The end was missed (a plugin reload): the backfill read the turn's tail, so that turn did end; a later close changes nothing.
    await f.store.record({ type: "turn_started", agent, turnId: "t1" });
    await f.store.recordReply("agent-1", userAt, null, { kind: "silent", resetAt: null, at: new Date(epoch + 5_000).toISOString() });
    f.advance(10_000);
    await f.store.record({ type: "closed", agent });
    assert.deepEqual((await f.store.snapshot("agent-1")).agents[0]!.stop, { kind: "silent", resetAt: null, at: new Date(epoch + 5_000).toISOString() });
    // A close of an open turn, then (the session loaded again) the tail read of that same prompt: the close stands.
    const other = { id: "agent-2", title: "Index" };
    await f.store.record({ type: "turn_started", agent: other, turnId: "o1" });
    const prompt = new Date(epoch + 9_000).toISOString();
    await f.store.record({ type: "closed", agent: other });
    const closed = (await f.store.snapshot("agent-2")).agents[0]!.stop!;
    await f.store.ackStop("agent-2", closed.at);
    await f.store.recordReply("agent-2", prompt, null, { kind: "unfinished", resetAt: null, at: new Date(epoch + 40_000).toISOString() });
    const kept = (await f.store.snapshot("agent-2")).agents[0]!.stop!;
    assert.deepEqual([kept.at, kept.closedMidTurn, typeof kept.seenAt], [closed.at, true, "string"]);
    // A limit notice as the reply proves that turn ended after all (only its hook was missed): it replaces the close.
    await f.store.recordReply("agent-2", prompt, { at: new Date(epoch + 41_000).toISOString(), asks: false }, { kind: "quota", resetAt: null, at: new Date(epoch + 41_000).toISOString() });
    assert.deepEqual((await f.store.snapshot("agent-2")).agents[0]!.stop, { kind: "quota", resetAt: null, at: new Date(epoch + 41_000).toISOString() });
    // So does an ordinary closing reply: that turn was done, nothing stopped it.
    const third = { id: "agent-3", title: "Docs" };
    await f.store.record({ type: "turn_started", agent: third, turnId: "d1" });
    await f.store.record({ type: "closed", agent: third });
    assert.equal((await f.store.snapshot("agent-3")).agents[0]!.stop?.closedMidTurn, true);
    await f.store.recordReply("agent-3", prompt, { at: new Date(epoch + 42_000).toISOString(), asks: false });
    const done = (await f.store.snapshot("agent-3")).agents[0]!;
    assert.deepEqual([done.stop, done.outcome, done.turnEndedAt], [null, "completed", new Date(epoch + 42_000).toISOString()]);
  } finally { await f.dispose(); }
});

test("storage notices are whole Chinese sentences: saving failed, or what was saved could not be read (opus-F74)", async () => {
  // Every notice the store can set, resolving catalog IDs from its source: none is English.
  const source = await readFile(new URL("../server/telemetry.ts", import.meta.url), "utf8");
  const notices = [...source.matchAll(/(?:setError\(|persistenceError = )(?:quarantine \? )?(["`])((?:(?!\1).)+)\1(?: : (["`])((?:(?!\3).)+)\3)?/g)]
    .flatMap(match => [match[2], match[4]]).filter((text): text is string => !!text);
  for (const line of source.split("\n").filter(line => /setError\(|persistenceError =/.test(line))) {
    for (const match of line.matchAll(/\bt\("([^"\n]+)"/g)) notices.push(t(match[1] as MessageId, { value1: "EACCES", error: "EACCES" }));
  }
  assert.ok(notices.length >= 8, `found ${notices.length}`);
  for (const notice of notices) chineseNotice(notice.replace(/\$\{errorCode\(error\)\}/g, "EACCES"));
  // Saved analytics that cannot be restored: a notice of its own, the lifecycle history stays.
  const directory = await mkdtemp(join(tmpdir(), "observatory-analytics-notice-"));
  const first = new TelemetryStore({ directory, now: () => epoch, writeDelayMs: 60_000 });
  await first.record({ type: "created", agent });
  await first.close();
  const saved = JSON.parse(await readFile(join(directory, "telemetry.json"), "utf8"));
  await writeFile(join(directory, "telemetry.json"), JSON.stringify({ ...saved, analytics: { version: "broken" } }), "utf8");
  const store = new TelemetryStore({ directory, now: () => epoch, writeDelayMs: 60_000 });
  try {
    const snapshot = await store.snapshot();
    chineseNotice(snapshot.persistenceError);
    assert.match(snapshot.persistenceError ?? "", /统计数据无法读取.*会话事件历史保留不变/);
    assert.equal(snapshot.agents.length, 1);
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("hiddenEventCount only counts events inside the window and never goes negative", () => {
  const event = (id: string, at: string): TelemetryEvent =>
    ({ id, agentId: "a", agentTitle: "x", at, type: "turn_started", label: "开始一轮", localized: true });
  const since = Date.parse("2026-09-16T10:00:00.000Z");
  const available = new Set(["a"]);
  const retained = [
    event("in-1", "2026-09-16T10:30:00.000Z"), event("in-2", "2026-09-16T11:00:00.000Z"),
    event("out-1", "2026-09-16T08:00:00.000Z"),
  ];
  // Nothing shown: both in-window events count; the out-of-window one does not.
  assert.equal(hiddenEventCount(retained, [], since, available), 2);
  // Shown events subtract only within the window.
  assert.equal(hiddenEventCount(retained, [retained[0]!], since, available), 1);
  assert.equal(hiddenEventCount(retained, [retained[0]!, retained[1]!], since, available), 0);
  // A stray shown event outside the retained set clamps at zero instead of lying.
  assert.equal(hiddenEventCount(retained, [retained[0]!, retained[1]!, event("extra", "2026-09-16T11:30:00.000Z")], since, available), 0);
});

test("hidden event hints exclude records that clearing optional filters cannot reveal", () => {
  const event = (agentId: string, at = "2026-09-16T11:00:00.000Z"): TelemetryEvent =>
    ({ id: agentId, agentId, agentTitle: agentId, at, type: "turn_started", label: "开始一轮" });
  const visible = event("visible"), filteredProject = event("other-project"), filteredProvider = event("other-provider");
  const retained = [visible, filteredProject, filteredProvider, event("archived"), event("deleted"), event("outside-workspace"), event("old", "2026-09-15T11:00:00.000Z")];
  const available = new Set(["visible", "other-project", "other-provider", "old"]);
  const since = Date.parse("2026-09-16T10:00:00.000Z");
  assert.equal(hiddenEventCount(retained, [visible], since, available), 2, "optional project/provider filters can be cleared");
  assert.equal(hiddenEventCount(retained, [visible, filteredProject, filteredProvider], since, available), 0, "no misleading banner remains after clearing");
  assert.equal(hiddenEventCount(retained, [], since, new Set()), 0, "retained events from missing Agents cannot be recovered by clearing filters");
  assert.equal(hiddenEventCount(retained, [event("unrelated")], since, available), 3, "unrelated shown ids do not hide recoverable events");
});
