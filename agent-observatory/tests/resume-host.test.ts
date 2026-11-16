import assert from "node:assert/strict";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";
import type { PaseoApi } from "../server/paseo-types";
import { LEDGER_MAX_BYTES, ResumeLedger, TIDY_LIMIT, type ResumeLedgerOptions, type SessionLogs } from "../server/resume";
import { RESUME_PROMPT, RESUME_WINDOW_MS, resumeCron } from "../shared/resume";
import { TokenIngester } from "../server/tokens/ingester";
import { LocalTokenCallSource } from "../server/tokens/source";

/**
 * 恢复后续跑 against the installed Paseo's own ScheduleService (schedule/service.js with its cron and file store): its real ticks,
 * its recovery after a daemon restart and its updates, with a runner standing in for the Agent (no provider, no network). The
 * module is found from the `paseo` on PATH; without one these tests are skipped.
 */
function installedScheduleService(): { path: string; version: string } | { skip: string } {
  const bin = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map(directory => join(directory, "paseo")).find(path => existsSync(path));
  if (!bin) return { skip: "no `paseo` on PATH (Paseo is not installed): the host's own ScheduleService cannot be run" };
  // <prefix>/@getpaseo/cli/bin/paseo; the server package is nested under the CLI or next to it.
  const cli = dirname(dirname(realpathSync(bin)));
  const server = [join(cli, "node_modules", "@getpaseo", "server"), join(dirname(cli), "server")].find(path => existsSync(join(path, "dist", "server", "server", "schedule", "service.js")));
  if (!server) return { skip: "the installed Paseo has no @getpaseo/server schedule/service.js next to its CLI: the host's own ScheduleService cannot be run" };
  let version = "unknown";
  try { version = String(JSON.parse(readFileSync(join(server, "package.json"), "utf8")).version); } catch { /* the version only labels the run */ }
  return { path: join(server, "dist", "server", "server", "schedule", "service.js"), version };
}
const installed = installedScheduleService();

const MINUTE = 60_000, base = Date.parse("2026-10-15T00:00:00Z");
const iso = (at: number) => new Date(at).toISOString();
const A = "6f1c2a3b-0000-4000-8000-00000000000a", B = "6f1c2a3b-0000-4000-8000-00000000000b", C = "6f1c2a3b-0000-4000-8000-00000000000c";
const gate = () => { let open!: () => void; const wait = new Promise<void>(resolve => { open = resolve; }); return { open, wait }; };
const until = async (done: () => boolean) => { for (let tries = 0; !done(); tries++) { if (tries > 400) throw new Error("timed out"); await new Promise(resolve => setTimeout(resolve, 5)); } };

interface HostRun { id: string; status: string; startedAt: string; endedAt: string | null; error: string | null }
interface HostSchedule { id: string; name: string | null; prompt: string; status: string; nextRunAt: string | null; maxRuns: number | null; target: { type: string; agentId?: string }; runs: HostRun[] }
/** What these tests use of the host's ScheduleService (0.11.1). */
interface ScheduleServiceLike {
  create(input: unknown): Promise<HostSchedule>; list(): Promise<HostSchedule[]>; inspect(id: string): Promise<HostSchedule>; delete(id: string): Promise<void>;
  update(input: unknown): Promise<HostSchedule>; tick(): Promise<void>; recoverInterruptedRuns(): Promise<void>; runOnce(id: string): Promise<unknown>;
  pause(id: string): Promise<HostSchedule>;
}
type Runner = (schedule: HostSchedule, runId: string) => Promise<{ agentId: string; output: string | null }>;

/**
 * The daemon as far as 恢复后续跑 sees it: the schedule service on a store in a temporary PASEO_HOME, the session requests the ledger
 * sends (schedule/list, inspect, create, delete), and Agents read with fetch_agent. `restart()` is a new daemon on the same
 * schedule files: the old one's runs never finish, and the new one recovers them as the host does at start-up.
 */
class Host {
  now = base;
  runner: Runner = async schedule => ({ agentId: schedule.target.agentId!, output: "done" });
  /** Awaited before a create reaches the host (two creates out at once). */
  beforeCreate: () => Promise<void> = async () => {};
  /** Awaited before an inspect reaches the host (the user changing a schedule in 计划 after the ledger read the list). */
  beforeInspect: (id: string) => Promise<void> = async () => {};
  /** Awaited once the host has read the list, before the ledger gets it (the user changing a schedule in 计划 meanwhile). */
  afterList: (schedules: HostSchedule[]) => Promise<void> = async () => {};
  /** Creates whose answer is lost after the host made the schedule (the plugin session reconnecting), this many more. */
  loseCreate = 0;
  /** Deletes that fail before they reach the host (it cannot be reached for now). */
  failDelete: (id: string) => boolean = () => false;
  /** Deletes whose answer is lost after the host deleted the schedule (the plugin session reconnecting). */
  loseDelete: (id: string) => boolean = () => false;
  sent: Array<Record<string, unknown>> = [];
  /** The daemon's agent manager as the host's own `executeSchedule` uses it (tests fill in what a run needs). */
  // Paseo 0.14+ checks this barrier before every prompt. These test sessions are always current.
  readonly manager: Record<string, unknown> = { reloadStalePluginSession: async () => {} };
  agents = new Map<string, { title: string; archivedAt: string | null; lastUserMessageAt: string | null; attentionTimestamp?: string | null; persistence?: { provider: string; sessionId: string } | null }>();
  service: ScheduleServiceLike;
  constructor(private readonly Service: new (options: unknown) => ScheduleServiceLike, private readonly home: string) { this.service = this.start(); }
  private start(): ScheduleServiceLike {
    const logger = { child() { return logger; }, trace() {}, debug() {}, info() {}, warn() {}, error() {} };
    return new this.Service({ paseoHome: this.home, logger, agentManager: this.manager, agentStorage: { get: async (id: string) => this.agents.has(id) ? { id, archivedAt: null } : null },
      runner: (schedule: HostSchedule, runId: string) => this.runner(schedule, runId), now: () => new Date(this.now) });
  }
  async restart(): Promise<void> { this.service = this.start(); await this.service.recoverInterruptedRuns(); }
  bridge = { request: async (message: Record<string, unknown>) => {
    this.sent.push(structuredClone(message));
    const id = message.scheduleId as string;
    switch (message.type) {
      case "schedule/list": { const schedules = await this.service.list(); await this.afterList(schedules); return { schedules }; }
      case "schedule/inspect": await this.beforeInspect(id); return { schedule: await this.service.inspect(id) };
      case "schedule/delete":
        if (this.failDelete(id)) throw new Error("宿主未响应子任务请求。可重试，或确认 Paseo 宿主支持子任务观察。");
        await this.service.delete(id);
        if (this.loseDelete(id)) throw new Error("宿主未响应：插件会话已重新连接，请重试。");
        return { scheduleId: id };
      case "schedule/create": {
        await this.beforeCreate();
        const schedule = await this.service.create(message);
        if (this.loseCreate > 0) { this.loseCreate--; throw new Error("宿主未响应：插件会话已重新连接，请重试。"); }
        return { schedule };
      }
      default: throw new Error(`unexpected ${String(message.type)}`);
    }
  } };
  paseo = { agents: { ref: (id: string) => ({ refresh: async () => { const agent = this.agents.get(id); return agent ? { agent: { id, ...agent } } : null; } }) } } as unknown as PaseoApi;
  ledger(directory: string, options: ResumeLedgerOptions = {}): ResumeLedger { return new ResumeLedger(this.bridge, { directory, now: () => this.now, timers: false, log: () => {}, ...options }); }
  creates() { return this.sent.filter(message => message.type === "schedule/create").length; }
  deletes(id: string | null | undefined) { return this.sent.filter(message => message.type === "schedule/delete" && message.scheduleId === id).length; }
  /** One of this Agent's own resume heartbeats as an earlier ledger (or 2.13) made it, waking at `at` (past ones too). */
  async ownResume(agentId: string, at: number, name = "恢复后续跑 · 修复登录"): Promise<HostSchedule> {
    const now = this.now; this.now = Math.min(now, at) - MINUTE;
    try { return await this.service.create({ name, prompt: RESUME_PROMPT, cadence: { type: "cron", ...resumeCron(at) }, target: { type: "agent", agentId }, maxRuns: 1 }); }
    finally { this.now = now; }
  }
}
/** The session's own log as the runner leaves it: the prompt of each run it took ("found"), none of any other (absent, read whole). */
const sessionLog = (taken: ReadonlySet<string>): SessionLogs => ({ findMarker: async (_ids, marker, options = {}) =>
  [...taken].some(runId => marker.includes(`run=${runId})`)) ? "found" : options.run ? "absent" : "unknown" });

async function withHost(t: TestContext, run: (host: Host, directory: string) => Promise<void>): Promise<void> {
  if ("skip" in installed) { t.skip(installed.skip); return; }
  t.diagnostic(`Paseo ${installed.version} ScheduleService`);
  const { ScheduleService } = await import(pathToFileURL(installed.path).href) as { ScheduleService: new (options: unknown) => ScheduleServiceLike };
  const root = await mkdtemp(join(tmpdir(), "observatory-resume-host-"));
  const host = new Host(ScheduleService, join(root, "paseo-home"));
  for (const id of [A, B, C]) host.agents.set(id, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  try { await run(host, root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("two Agents asked for the same minute at once get a minute each, so the host's overlapping ticks run each heartbeat once (codex-obs-resume-F1)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  try {
    // Both schedule/list answers are empty and both creates are out before either is answered.
    const both = gate(); let arrived = 0;
    host.beforeCreate = async () => { if (++arrived === 2) both.open(); await both.wait; };
    const [a, b] = await Promise.all([A, B].map(agentId => ledger.schedule(host.paseo, { agentId, at: iso(base + 5 * MINUTE) })));
    assert.deepEqual([a!.status, b!.status], ["scheduled", "scheduled"]);
    // The host's ticks overlap: the first waits out its run's whole turn while the next one runs the other heartbeat; then the
    // first goes on with the list it read before.
    const [early, late] = (await host.service.list()).sort((x, y) => Date.parse(x.nextRunAt!) - Date.parse(y.nextRunAt!));
    const ran: string[] = [], entered = gate(), held = gate();
    host.runner = async schedule => { ran.push(schedule.id); if (schedule.id === early!.id) { entered.open(); await held.wait; } return { agentId: schedule.target.agentId!, output: "done" }; };
    host.now = Date.parse(early!.nextRunAt!); const first = host.service.tick(); await entered.wait;
    host.now = Date.parse(late!.nextRunAt!); await host.service.tick();
    held.open(); await first;
    host.now += MINUTE; await host.service.tick();
    assert.deepEqual(ran.sort(), [early!.id, late!.id].sort(), "each heartbeat ran once");
    assert.deepEqual([a!.runAt, b!.runAt].sort(), [iso(base + 5 * MINUTE), iso(base + 6 * MINUTE)], "a minute each");
    await ledger.check();
    assert.deepEqual((await ledger.list()).map(entry => entry.status), ["delivered", "delivered"]);
    assert.deepEqual(await host.service.list(), [], "both deleted once they went in");
  } finally { await ledger.close(); }
}));

test("a daemon restart that cut the resumed turns short, their turn_started never seen, sends nothing again: 已续跑 only on the prompt in the provider's own log, else 未能确认 (codex-obs-resume-F2, recheck-F1)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), logs = join(root, "claude-projects"), project = join(logs, "-home-me-app");
  await mkdir(project, { recursive: true });
  const session = (id: string) => `1f0c4f8e-0000-4000-8000-0000000000${id.slice(-1)}1`;
  for (const id of [A, B, C]) host.agents.get(id)!.persistence = { provider: "my-claude", sessionId: session(id) };
  const ledger = host.ledger(directory);
  for (const id of [A, B, C]) assert.equal((await ledger.schedule(host.paseo, { agentId: id, at: iso(base + 5 * MINUTE) })).status, "scheduled");
  // At each wake the host sends the prompt and the Agent takes it (B's provider writes it to its session log, as Claude Code
  // does); the plugin is reloading, so no turn_started reaches it; then the daemon goes down mid-turn.
  const accepted: string[] = [], started = new Map<string, string>();
  host.runner = async (schedule, runId) => {
    const agentId = schedule.target.agentId!;
    accepted.push(agentId); started.set(agentId, iso(host.now));
    if (agentId === B) await appendFile(join(project, `${session(B)}.jsonl`), JSON.stringify({ type: "user", sessionId: session(B), cwd: "/home/me/app", timestamp: iso(host.now),
      message: { role: "user", content: `<paseo-system>\nSchedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).\n${schedule.prompt}\n</paseo-system>` } }) + "\n");
    return new Promise(() => {}); // never answered: the daemon goes down first
  };
  for (const minute of [5, 6, 7]) { host.now = base + minute * MINUTE; void host.service.tick(); await until(() => accepted.length === minute - 4); }
  // Attention raised on C after its run began: its turn may have ended, or another turn's, or the user marked it unread. No
  // proof of this run (codex-obs-resume-recheck-F1).
  host.agents.get(C)!.attentionTimestamp = iso(Date.parse(started.get(C)!) + 20_000);
  await ledger.close();
  host.now = base + 9 * MINUTE;
  await host.restart();
  const failures = await Promise.all((await host.service.list()).map(async schedule => (await host.service.inspect(schedule.id)).runs.map(run => [run.status, run.error])));
  assert.deepEqual(failures, [0, 1, 2].map(() => [["failed", "Daemon restarted before the scheduled run completed"]]), "the host's own recovery");
  // The plugin comes back with the daemon: its token module lists the provider logs again, the ledger is read from the same file.
  const ingester = new TokenIngester({ roots: [{ source: "claude", path: logs }], now: () => host.now, onCall: () => {} }), scanned = ingester.scan();
  const reloaded = host.ledger(directory, { logs: new LocalTokenCallSource(ingester, scanned) });
  try {
    await scanned;
    await reloaded.check();
    assert.deepEqual((await reloaded.list()).map(entry => entry.status), ["scheduled", "scheduled", "scheduled"], "nothing decided before a context can read the Agents");
    reloaded.notePaseo(host.paseo);
    await reloaded.check();
    // B's prompt is in its log; A's and C's providers keep none the plugin reads, which the next rescan (since the runs ended) settles.
    assert.deepEqual((await Promise.all([A, B, C].map(async id => (await reloaded.list(id))[0]!))).map(entry => entry.status), ["scheduled", "delivered", "scheduled"]);
    host.now += 30_000; await ingester.scan(); await reloaded.check();
    const entries = await Promise.all([A, B, C].map(async id => (await reloaded.list(id))[0]!));
    assert.deepEqual(entries.map(entry => [entry.status, entry.reason, entry.attempt]), [["failed", "restart-unsure", 1], ["delivered", null, 1], ["failed", "restart-unsure", 1]]);
    assert.equal(entries[1]!.deliveredAt, started.get(B));
    assert.deepEqual(JSON.parse(await readFile(join(directory, "resume-ledger.json"), "utf8")).entries.map((entry: { reason: string | null }) => entry.reason).sort(), [null, "restart-unsure", "restart-unsure"].sort());
    assert.deepEqual(await host.service.list(), [], "the spent heartbeats (moved a month out by the host) are deleted");
    for (host.now = base + 10 * MINUTE; host.now <= base + 60 * MINUTE; host.now += MINUTE) { await host.service.tick(); await reloaded.check(); }
    assert.deepEqual(accepted, [A, B, C], "no prompt is sent twice");
    assert.equal(host.creates(), 3, "no retry heartbeat");
  } finally { await reloaded.close(); await ingester.close(); }
}));

test("a turn the user's own message opened while the host was still loading the Agent is 你已接着做, never 已续跑, and nothing is sent again (codex-obs-resume-F3, recheck-F1)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  try {
    const scheduled = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 5 * MINUTE), stopAt: iso(base - MINUTE) });
    // The run is recorded first, then the host loads the Agent; it finds the user's turn going and fails before any prompt.
    const loading = gate(), loaded = gate();
    host.runner = async schedule => { loading.open(); await loaded.wait; throw new Error(`Agent ${schedule.target.agentId} already has an active run`); };
    host.now = base + 5 * MINUTE; const tick = host.service.tick(); await loading.wait;
    host.now += 1000; host.agents.get(A)!.lastUserMessageAt = iso(host.now);
    await ledger.noteTurn(A, host.now, "turn-of-the-user");
    await ledger.check();
    // A turn proves nothing either way: still waking, the heartbeat kept while its run goes.
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await ledger.list(A))[0]!.deliveredAt], ["waking", null]);
    assert.deepEqual((await host.service.inspect(scheduled.scheduleId!)).runs.map(run => run.status), ["running"], "kept while its run goes");
    loaded.open(); await tick;
    host.now += MINUTE; await ledger.check();
    const entry = (await ledger.list(A))[0]!;
    assert.deepEqual([entry.status, entry.reason, entry.deliveredAt], ["canceled", "resumed", null], "the run failed busy, and the user had carried on");
    assert.equal(await host.service.inspect(scheduled.scheduleId!).catch(() => null), null, "deleted once its run ended");
    assert.equal(host.creates(), 1, "nothing tried again");
  } finally { await ledger.close(); }
}));

test("a tracked heartbeat the user changed with the host's update is theirs: its run is never 已续跑 and it is never deleted, in the deferred clean-up either (codex-obs-resume-F4)", async t => withHost(t, async (host, root) => {
  // B's provider writes its prompts to its session log (as Claude Code does): the proof that lets B's resume count while its run goes.
  host.agents.get(B)!.persistence = { provider: "my-claude", sessionId: "1f0c4f8e-0000-4000-8000-0000000000b1" };
  const fired: string[] = [];
  const ledger = host.ledger(join(root, "plugin"), { logs: { findMarker: async (ids, marker) => !ids.includes("1f0c4f8e-0000-4000-8000-0000000000b1") ? "unknown" : fired.some(line => line.includes(marker)) ? "found" : "absent" } });
  try {
    const a = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 5 * MINUTE) });
    // Made into the user's nightly report: its own prompt, 20 runs, every day; the name kept.
    await host.service.update({ id: a.scheduleId, prompt: "Write the nightly report", maxRuns: 20, cadence: { type: "cron", expression: "5 0 * * *", timezone: "UTC" } });
    const prompts: string[] = [];
    host.runner = async schedule => { prompts.push(schedule.prompt); return { agentId: schedule.target.agentId!, output: "done" }; };
    host.now = base + 5 * MINUTE; await host.service.tick(); await ledger.check();
    const edited = (await ledger.list(A))[0]!;
    assert.deepEqual([edited.status, edited.reason, edited.deliveredAt], ["canceled", "edited", null], "the run was the user's report, not a resume");
    const kept = await host.service.inspect(a.scheduleId!);
    assert.deepEqual([kept.prompt, kept.maxRuns, kept.status, kept.runs.map(run => run.status)], ["Write the nightly report", 20, "active", ["succeeded"]]);
    // B: delivered while its run still went (its heartbeat left for the clean-up); the user changes it before the run ends.
    const b = await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 10 * MINUTE) });
    const noted = gate(), ending = gate();
    host.runner = async (schedule, runId) => {
      fired.push(`Schedule "${schedule.name}" fired (id=${schedule.id}, run=${runId}).`);
      await ledger.noteTurn(B, host.now, "turn-of-the-resume"); noted.open(); await ending.wait; return { agentId: schedule.target.agentId!, output: "done" };
    };
    host.now = base + 10 * MINUTE; const tick = host.service.tick();
    await noted.wait;
    await ledger.check();
    assert.equal((await ledger.list(B))[0]!.status, "delivered");
    await host.service.update({ id: b.scheduleId, prompt: "Report the progress every day" });
    ending.open(); await tick;
    host.now += MINUTE; await ledger.check(); await ledger.check();
    assert.equal((await host.service.inspect(b.scheduleId!)).prompt, "Report the progress every day");
    assert.deepEqual(host.sent.filter(message => message.type === "schedule/delete"), [], "neither is deleted");
    assert.deepEqual(prompts, ["Write the nightly report"]);
  } finally { await ledger.close(); }
}));

test("a turn a system notification opened while the host loads the Agent, or one whose source cannot be read, is never 已续跑 (codex-obs-resume-recheck-F1)", async t => withHost(t, async (host, root) => {
  // A's provider keeps a log the plugin reads (as Claude Code does): read whole, it shows whether a run's prompt went in.
  host.agents.get(A)!.persistence = { provider: "my-claude", sessionId: "1f0c4f8e-0000-4000-8000-0000000000a1" };
  const ledger = host.ledger(join(root, "plugin"), { logs: { findMarker: async ids => ids.includes("1f0c4f8e-0000-4000-8000-0000000000a1") ? "absent" : "unknown" } });
  try {
    const scheduled = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 5 * MINUTE), stopAt: iso(base - MINUTE) });
    // The run is recorded, the host is loading the Agent: a subagent finishing notifies it meanwhile (a turn, no message time),
    // and the host then finds it busy and fails the run before its prompt.
    const loading = gate(), loaded = gate(), accepted: string[] = [];
    host.runner = async schedule => { loading.open(); await loaded.wait; throw new Error(`Agent ${schedule.target.agentId} already has an active run`); };
    host.now = base + 5 * MINUTE; const tick = host.service.tick(); await loading.wait;
    host.now += 1000; await ledger.noteTurn(A, host.now, "turn-from-subagent-notification");
    await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await ledger.list(A))[0]!.deliveredAt], ["waking", null], "a turn is no proof");
    loaded.open(); await tick;
    host.now += 30_000; await ledger.check();
    const retry = (await ledger.list(A))[0]!;
    assert.deepEqual([retry.status, retry.reason, retry.attempt], ["retrying", "busy", 2], "busy, its log shows no prompt, and the user wrote nothing: tried again");
    host.runner = async schedule => { accepted.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
    host.now = Date.parse(retry.wakeAt); await host.service.tick(); await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, accepted], ["delivered", [A]], "the retry's own run went through: the host's record proves it");
    assert.equal(await host.service.inspect(scheduled.scheduleId!).catch(() => null), null);
    // B: its snapshot cannot be read at all while its run goes and then fails with text that may come after the prompt.
    const other = host.ledger(join(root, "plugin-b"), { logs: { findMarker: async () => "found" } });
    try {
      await other.schedule(host.paseo, { agentId: B, at: iso(host.now + 10 * MINUTE), stopAt: iso(base - MINUTE) });
      other.notePaseo({ agents: { ref: () => ({ refresh: async () => { throw new Error("snapshot unavailable"); } }) } } as unknown as PaseoApi);
      const going = gate(), failing = gate();
      host.runner = async () => { going.open(); await failing.wait; throw new Error("Provider connection lost"); };
      host.now += 10 * MINUTE; const run = host.service.tick(); await going.wait;
      host.now += 1000; await other.noteTurn(B, host.now, "turn-with-unknown-origin");
      await other.check();
      assert.equal((await other.list(B))[0]!.status, "waking");
      failing.open(); await run;
      host.now += 30_000; await other.check();
      // Even a log that would say yes cannot be read without the Agent's session: 未能确认, never 已续跑, never sent again.
      assert.deepEqual([(await other.list(B))[0]!.status, (await other.list(B))[0]!.reason], ["failed", "unsure"]);
      const creates = host.creates();
      for (let minute = 0; minute < 20; minute++) { host.now += MINUTE; await host.service.tick(); await other.check(); }
      assert.equal(host.creates(), creates, "nothing made again");
    } finally { await other.close(); }
  } finally { await ledger.close(); }
}));

test("a reply word for word the host's busy or load-timeout error, from a run whose prompt the Agent took, is never sent again unless the Agent's own log, read whole, shows no prompt: Grok's, a provider's that keeps none, or one that cannot be read is 未能确认 (codex-obs-resume-recheck3-F1)", async t => withHost(t, async (host, root) => {
  const D = "6f1c2a3b-0000-4000-8000-00000000000d";
  host.agents.set(D, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  // A runs on Grok, B on an ACP provider that keeps no log, C and D on Claude Code (C's log will not be readable).
  const sessions: Record<string, string> = { [A]: "c0ffee00-1111-4222-8333-444455556666", [B]: "acp-session-b", [C]: "1f0c4f8e-0000-4000-8000-0000000000c1", [D]: "1f0c4f8e-0000-4000-8000-0000000000d1" };
  for (const [id, provider] of [[A, "grok"], [B, "my-acp"], [C, "claude"], [D, "claude"]] as const) host.agents.get(id)!.persistence = { provider, sessionId: sessions[id]! };
  // Where each keeps the conversation: Grok in its session folder (the plugin only ever opens usage.json there), Claude Code a JSONL per session.
  const claude = join(root, "claude-projects"), project = join(claude, "-home-me-app"), grok = join(root, "grok-sessions"), grokSession = join(grok, encodeURIComponent("/home/me/app"), sessions[A]!);
  await mkdir(project, { recursive: true }); await mkdir(grokSession, { recursive: true });
  await writeFile(join(grokSession, "usage.json"), JSON.stringify({ turns: [] }));
  const conversation = (id: string) => id === A ? join(grokSession, "conversation.jsonl") : id === C || id === D ? join(project, `${sessions[id]}.jsonl`) : null;
  const logged = (id: string, at: number, content: string) => appendFile(conversation(id)!, JSON.stringify({ type: "user", sessionId: sessions[id], cwd: "/home/me/app", timestamp: iso(at), message: { role: "user", content } }) + "\n");
  for (const id of [C, D]) await logged(id, base - MINUTE, "earlier");
  const ingester = new TokenIngester({ roots: [{ source: "claude", path: claude }, { source: "grok", path: grok }], now: () => host.now, onCall: () => {} }), scanned = ingester.scan();
  const ledger = host.ledger(join(root, "plugin"), { logs: new LocalTokenCallSource(ingester, scanned) });
  await scanned;
  /** The ledger's next check, after the token module's next rescan (every 30 s) since the runs ended. */
  const later = async () => { host.now += 30_000; await ingester.scan(); await ledger.check(); };
  ledger.notePaseo(host.paseo);
  // The host's own executeSchedule (0.11.1) runs each heartbeat: it loads the Agent and, finding no run going, sends the prompt;
  // the Agent takes it (its provider writes it where it keeps the conversation) and the turn fails, the run with its last reply.
  const accepted: string[] = [], writes: Array<Promise<void>> = [], inFlight = new Set<string>();
  let reply = (agentId: string) => `Agent ${agentId} already has an active run`;
  Object.assign(host.manager, {
    getAgent: (id: string) => ({ id, provider: host.agents.get(id)?.persistence?.provider, activeForegroundTurnId: null, persistence: host.agents.get(id)?.persistence }),
    hasInFlightRun: (id: string) => inFlight.has(id), tryRunOutOfBand: () => false, steerOrReplaceActiveTurn: async () => ({ status: "inactive" }),
    streamAgent: (id: string, prompt: string) => { accepted.push(id); if (conversation(id)) writes.push(logged(id, host.now, prompt)); return (async function* () {})(); },
    waitForAgentEvent: async (id: string) => { await Promise.all(writes); return { status: "error", lastMessage: reply(id) }; },
  });
  host.runner = (schedule, runId) => (host.service as unknown as { executeSchedule: Runner }).executeSchedule(schedule, runId);
  const errors = async (id: string) => (await host.service.inspect((await ledger.list(id))[0]!.scheduleId!)).runs.map(run => run.error);
  const round = async (ids: readonly string[], text: (agentId: string) => string) => {
    reply = text;
    for (const id of ids) await ledger.schedule(host.paseo, { agentId: id, at: iso(host.now + 5 * MINUTE) });
    const wakes = await Promise.all(ids.map(async id => Date.parse((await ledger.list(id))[0]!.wakeAt)));
    for (const wake of wakes.sort((a, b) => a - b)) { host.now = wake; await host.service.tick(); }
  };
  try {
    await round([A, B, C, D], id => `Agent ${id} already has an active run`);
    assert.deepEqual(accepted, [A, B, C, D], "every prompt was taken");
    for (const id of [A, B, C, D]) assert.deepEqual(await errors(id), [`Agent ${id} already has an active run`], "the host's own words, from the turn's last reply");
    await chmod(conversation(C)!, 0o000);
    await later();
    const entries = await Promise.all([A, B, C, D].map(async id => (await ledger.list(id))[0]!));
    assert.deepEqual(entries.map(entry => [entry.status, entry.reason]), [["failed", "unsure"], ["failed", "unsure"], [process.getuid?.() === 0 ? "delivered" : "failed", process.getuid?.() === 0 ? null : "unsure"], ["delivered", null]],
      "only D's log could tell, and it holds the prompt");
    const creates = host.creates();
    for (let minute = 0; minute < 30; minute++) { host.now += MINUTE; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([accepted, host.creates()], [[A, B, C, D], creates], "nothing sent again, nothing made again");
    // The same with a load timeout's words, after 重新安排 (the user's call).
    await round([A, B], () => "Timed out refreshing Claude after 30000ms");
    await later();
    assert.deepEqual(await Promise.all([A, B].map(async id => { const entry = (await ledger.list(id))[0]!; return [entry.status, entry.reason, entry.attempt]; })), [["failed", "unsure", 1], ["failed", "unsure", 1]]);
    for (let minute = 0; minute < 30; minute++) { host.now += MINUTE; await host.service.tick(); await ledger.check(); }
    assert.deepEqual(accepted, [A, B, C, D, A, B]);
    // D, whose log the plugin reads: the host finds a run going and fails before the prompt; read whole, the log shows none, so it is tried again, once.
    inFlight.add(D);
    await round([D], id => `Agent ${id} already has an active run`);
    // Not before a rescan since its run ended: until then the log may not be every log of its session (codex-obs-resume-recheck5-F2).
    host.now += 30_000; await ledger.check();
    assert.equal((await ledger.list(D))[0]!.status, "scheduled");
    await later();
    const retry = (await ledger.list(D))[0]!;
    assert.deepEqual([retry.status, retry.reason, retry.attempt, accepted.length], ["retrying", "busy", 2, 6]);
    inFlight.delete(D);
    host.now = Date.parse(retry.wakeAt); await host.service.tick(); host.now += 30_000; await ledger.check();
    assert.deepEqual([(await ledger.list(D))[0]!.status, accepted], ["delivered", [A, B, C, D, A, B, D]], "its retry's prompt is in its log");
  } finally { await chmod(conversation(C)!, 0o600).catch(() => {}); await ledger.close(); await ingester.close(); }
}));

test("a prompt the Agent took into a log the plugin has not indexed (written since its last scan, left out of a scan its budget cut, or made a symlink since) is never sent again on the host's exact busy words: a decision waits for a rescan since the run ended (codex-obs-resume-recheck4-F1, recheck5-F1, F2)", async t => withHost(t, async (host, root) => {
  // A, B and C on Claude Code, each going on from another directory: the prompt goes into a log of the session the plugin has not seen.
  const sessions: Record<string, string> = { [A]: "1f0c4f8e-0000-4000-8000-0000000000a4", [B]: "1f0c4f8e-0000-4000-8000-0000000000b4", [C]: "1f0c4f8e-0000-4000-8000-0000000000c4" };
  for (const id of [A, B, C]) host.agents.get(id)!.persistence = { provider: "claude", sessionId: sessions[id]! };
  const roots: Record<string, string> = { [A]: join(root, "claude-a"), [B]: join(root, "claude-b"), [C]: join(root, "claude-c") };
  const log = (id: string, project: string) => join(roots[id]!, project, `${sessions[id]}.jsonl`);
  const logged = async (id: string, project: string, at: number, content: string) => {
    await mkdir(dirname(log(id, project)), { recursive: true });
    await appendFile(log(id, project), JSON.stringify({ type: "user", sessionId: sessions[id], cwd: "/home/me/app", timestamp: iso(at), message: { role: "user", content } }) + "\n");
  };
  for (const id of [A, B, C]) await logged(id, "-home-me-app", base - MINUTE, "earlier");
  // A's and C's roots as the plugin scans them (every 30 s); B's under a budget that holds one log (the production budget is 20,000).
  const ingesters: Record<string, TokenIngester> = Object.fromEntries([A, B, C].map(id => [id, new TokenIngester({ roots: [{ source: "claude", path: roots[id]! }], now: () => host.now, onCall: () => {}, ...(id === B ? { limits: { files: 1 } } : {}) })]));
  const sources = Object.fromEntries(await Promise.all([A, B, C].map(async id => { const scanned = ingesters[id]!.scan(); await scanned; return [sessions[id]!, new LocalTokenCallSource(ingesters[id]!, scanned)]; })));
  const ledger = host.ledger(join(root, "plugin"), { logs: { findMarker: (ids, marker, options) => sources[ids[0]!]!.findMarker(ids, marker, options) } });
  ledger.notePaseo(host.paseo);
  const accepted: string[] = [], writes: Array<Promise<void>> = [];
  Object.assign(host.manager, {
    getAgent: (id: string) => ({ id, provider: "claude", activeForegroundTurnId: null, persistence: host.agents.get(id)?.persistence }),
    hasInFlightRun: () => false, tryRunOutOfBand: () => false, steerOrReplaceActiveTurn: async () => ({ status: "inactive" }),
    streamAgent: (id: string, prompt: string) => { accepted.push(id); writes.push(logged(id, "-home-me-other", host.now, prompt)); return (async function* () {})(); },
    waitForAgentEvent: async (id: string) => { await Promise.all(writes); return { status: "error", lastMessage: `Agent ${id} already has an active run` }; },
  });
  host.runner = (schedule, runId) => (host.service as unknown as { executeSchedule: Runner }).executeSchedule(schedule, runId);
  try {
    for (const id of [A, B, C]) await ledger.schedule(host.paseo, { agentId: id, at: iso(host.now + 5 * MINUTE) });
    const wakes = await Promise.all([A, B, C].map(async id => Date.parse((await ledger.list(id))[0]!.wakeAt)));
    for (const wake of wakes.sort((a, b) => a - b)) { host.now = wake; await host.service.tick(); }
    assert.deepEqual(accepted, [A, B, C], "every prompt was taken, into logs the plugin has not indexed");
    assert.deepEqual([A, B, C].map(id => ingesters[id]!.files.has(log(id, "-home-me-other"))), [false, false, false]);
    // C's new log moved out of the logs, a symlink to it left in its place (Codex's repro): the plugin never follows one.
    const moved = join(root, "moved-out-c.txt");
    await rename(log(C, "-home-me-other"), moved); await symlink(moved, log(C, "-home-me-other"));
    host.now += 30_000; await ledger.check();
    assert.deepEqual(await Promise.all([A, B, C].map(async id => (await ledger.list(id))[0]!.status)), ["scheduled", "scheduled", "scheduled"], "not decided before a rescan since the runs ended");
    // The token module's next rescan (every 30 s).
    host.now += 30_000; for (const id of [A, B, C]) await ingesters[id]!.scan(); await ledger.check();
    assert.deepEqual(await Promise.all([A, B, C].map(async id => { const entry = (await ledger.list(id))[0]!; return [entry.status, entry.reason]; })), [["delivered", null], ["failed", "unsure"], ["failed", "unsure"]],
      "A: the rescan lists its new log, which holds the prompt; B: the rescan was cut short by the budget; C: a log of its session is a symlink, never read");
    assert.equal(ingesters[B]!.truncated.files, true);
    const creates = host.creates();
    for (let minute = 0; minute < 30; minute++) { host.now += MINUTE; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([accepted, host.creates()], [[A, B, C], creates], "nothing sent again, nothing made again");
  } finally { await ledger.close(); await Promise.all(Object.values(ingesters).map(ingester => ingester.close())); }
}));

// codex-obs-resume-recheck8 (after ec1f466), on the host's own ScheduleService.

test("what the host has when a heartbeat is read decides, not the list read before it: one the user changed in 计划 meanwhile is theirs, neither deleted nor taken up; one whose wake moved is taken up at its new wake and kept there (codex-obs-resume-recheck8-F1)", async t => withHost(t, async (host, root) => {
  const logs = sessionLog(new Set()), ledger = host.ledger(join(root, "plugin"), { logs });
  for (const id of [A, B, C]) host.agents.get(id)!.persistence = { provider: "claude", sessionId: `session-${id.slice(-1)}` };
  const asked = base + 2 * 60 * MINUTE, edits = new Map<string, Record<string, unknown>>();
  host.beforeInspect = async id => { const edit = edits.get(id); if (edit) { edits.delete(id); await host.service.update({ id, ...edit }); } };
  try {
    // Moved out a month, so the ledger would delete it; the user has since made it their daily report (Codex's repro).
    const far = await host.ownResume(A, base + 10 * 24 * 60 * MINUTE);
    edits.set(far.id, { prompt: "用户改为每日报告", maxRuns: 20, cadence: { type: "cron", expression: "0 1 * * *", timezone: "UTC" } });
    const a = await ledger.schedule(host.paseo, { agentId: A, at: iso(asked) });
    assert.deepEqual([a.status, a.existing, host.deletes(far.id), (await host.service.inspect(far.id)).prompt], ["scheduled", undefined, 0, "用户改为每日报告"]);
    // Due within the grace, so the ledger would take it up; the user has since given it a prompt of their own.
    const due = await host.ownResume(B, base - MINUTE);
    edits.set(due.id, { prompt: "用户自定义维护指令", maxRuns: 20 });
    const b = await ledger.schedule(host.paseo, { agentId: B, at: iso(asked) });
    assert.deepEqual([b.status, b.existing, b.scheduleId === due.id, host.deletes(due.id)], ["scheduled", undefined, false, 0]);
    // Due within the grace, but put off to 01:00 (and renamed) meanwhile: taken up at 01:00, as it is now.
    const moved = await host.ownResume(C, base - MINUTE);
    edits.set(moved.id, { cadence: { type: "cron", ...resumeCron(base + 60 * MINUTE) }, name: "恢复后续跑 · 改到一点" });
    const c = await ledger.schedule(host.paseo, { agentId: C, at: iso(asked) });
    assert.deepEqual([c.existing, c.scheduleId, c.runAt], [true, moved.id, iso(base + 60 * MINUTE)]);
    host.now += MINUTE; await ledger.check();
    assert.deepEqual([(await ledger.list(C))[0]!.status, (await host.service.inspect(moved.id)).nextRunAt, host.deletes(moved.id)], ["scheduled", iso(base + 60 * MINUTE), 0], "not taken for a missed wake");
    // At 01:00 C is busy: the retry carries the name it has now.
    host.runner = async schedule => { throw new Error(`Agent ${schedule.target.agentId} already has an active run`); };
    host.now = base + 60 * MINUTE; await host.service.tick();
    host.now += MINUTE; await ledger.check();
    const retry = (await ledger.list(C))[0]!;
    assert.deepEqual([retry.status, retry.attempt, (await host.service.inspect(retry.scheduleId!)).name], ["retrying", 2, "恢复后续跑 · 改到一点（第 2 次）"]);
  } finally { await ledger.close(); }
}));

test("a resume delivered while its run still goes keeps its heartbeat to delete across plugin reloads: deleted once the run ends, never while it runs (codex-obs-resume-recheck8-F2)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), taken = new Set<string>(), logs = sessionLog(taken), hold = gate(), entered = gate();
  host.agents.get(A)!.persistence = { provider: "claude", sessionId: "session-a" };
  host.runner = async (schedule, runId) => { taken.add(runId); entered.open(); await hold.wait; return { agentId: schedule.target.agentId!, output: "done" }; };
  let ledger = host.ledger(directory, { logs });
  try {
    const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 2 * MINUTE) });
    host.now = base + 2 * MINUTE; const running = host.service.tick(); await entered.wait;
    await ledger.check();
    assert.equal((await ledger.list(A))[0]!.status, "delivered");
    // The plugin reloads while that run goes, twice, a check after each: the heartbeat is still the ledger's to delete, later.
    for (let reload = 0; reload < 2; reload++) { await ledger.close(); ledger = host.ledger(directory, { logs }); host.now += MINUTE; await ledger.check(); }
    assert.deepEqual([host.deletes(first.scheduleId), (await host.service.inspect(first.scheduleId!)).runs.map(run => run.status)], [0, ["running"]]);
    hold.open(); await running;
    host.now += MINUTE; await ledger.check();
    assert.deepEqual([await host.service.list(), host.deletes(first.scheduleId)], [[], 1]);
  } finally { hold.open(); await ledger.close(); }
}));

test("asked again after a reload while the delivered resume's run still goes (a ledger file from before this fix, which kept nothing to delete): the replaced resume's heartbeat is kept to delete, through two more reloads, and deleted once its run ends (codex-obs-resume-recheck8-F2)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), file = join(directory, "resume-ledger.json"), taken = new Set<string>(), logs = sessionLog(taken), hold = gate(), entered = gate();
  host.agents.get(A)!.persistence = { provider: "claude", sessionId: "session-a" };
  host.runner = async (schedule, runId) => { taken.add(runId); entered.open(); await hold.wait; return { agentId: schedule.target.agentId!, output: "done" }; };
  let ledger = host.ledger(directory, { logs });
  try {
    const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 2 * MINUTE) });
    host.now = base + 2 * MINUTE; const running = host.service.tick(); await entered.wait;
    await ledger.check();
    assert.equal((await ledger.list(A))[0]!.status, "delivered");
    // Codex's repro: reloaded with the file as ec1f466 left it (no heartbeats kept to delete); asked again, the new one cancelled.
    await ledger.close();
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>; delete saved.tidy; await writeFile(file, JSON.stringify(saved));
    ledger = host.ledger(directory, { logs });
    const again = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 62 * MINUTE) });
    assert.deepEqual([again.status, again.existing, again.scheduleId === first.scheduleId], ["scheduled", undefined, false]);
    assert.equal((await ledger.cancel(host.paseo, { agentId: A })).status, "canceled");
    for (let reload = 0; reload < 2; reload++) { await ledger.close(); ledger = host.ledger(directory, { logs }); host.now += MINUTE; await ledger.check(); }
    assert.deepEqual([host.deletes(first.scheduleId), (await host.service.inspect(first.scheduleId!)).runs.map(run => run.status)], [0, ["running"]], "never while it runs");
    hold.open(); await running;
    for (let check = 0; check < 3; check++) { host.now += MINUTE; await ledger.check(); }
    assert.deepEqual([await host.service.list(), host.deletes(first.scheduleId), taken.size], [[], 1, 1]);
  } finally { hold.open(); await ledger.close(); }
}));

test("a retry never claims an own heartbeat run by hand in Paseo, though its wake is still ahead: the new resume's own retry sends its prompt, the hand-made run settles nothing (codex-obs-resume-recheck8-F3)", async t => withHost(t, async (host, root) => {
  const taken = new Set<string>(), logs = sessionLog(taken), hold = gate(), entered = gate();
  host.agents.get(A)!.persistence = { provider: "claude", sessionId: "session-a" };
  const ledger = host.ledger(join(root, "plugin"), { logs });
  try {
    const asked = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + MINUTE) });
    // Codex's repro: an older own heartbeat waking two hours out is run by hand (立即运行): it keeps its wake while the run goes.
    const old = await host.ownResume(A, base + 2 * 60 * MINUTE);
    host.runner = async (schedule, runId) => {
      if (schedule.id === asked.scheduleId) throw new Error(`Agent ${schedule.target.agentId} already has an active run`);
      taken.add(runId);
      if (schedule.id === old.id) { entered.open(); await hold.wait; }
      return { agentId: schedule.target.agentId!, output: "done" };
    };
    const byHand = host.service.runOnce(old.id); await entered.wait;
    assert.deepEqual([(await host.service.inspect(old.id)).nextRunAt, (await host.service.inspect(old.id)).runs.map(run => run.status)], [iso(base + 2 * 60 * MINUTE), ["running"]]);
    // The asked-for wake finds A busy (that run); the retry is made, the hand-run heartbeat neither claimed nor deleted.
    host.now = base + MINUTE; await host.service.tick();
    host.now += MINUTE; await ledger.check();
    const retrying = (await ledger.list(A))[0]!;
    assert.deepEqual([retrying.status, retrying.attempt, retrying.scheduleId === old.id, host.deletes(old.id)], ["retrying", 2, false, 0]);
    // The hand-made run ends: nothing is settled by it.
    hold.open(); await byHand;
    host.now += MINUTE; await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await ledger.list(A))[0]!.scheduleId], ["retrying", retrying.scheduleId]);
    // The retry wakes A: delivered by its own run, a prompt of its own.
    host.now = Date.parse(retrying.wakeAt); await host.service.tick();
    await ledger.check();
    const done = (await ledger.list(A))[0]!;
    assert.deepEqual([done.status, done.scheduleId, taken.size], ["delivered", retrying.scheduleId, 2], "the hand-made run's prompt and the retry's");
  } finally { hold.open(); await ledger.close(); }
}));

test("安排续跑 never takes up an own heartbeat run by hand in Paseo, waking hours ahead: not while that run goes (it is left alone), nor once it ran (it is deleted) (codex-obs-resume-recheck8-F3)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin")), hold = gate(), entered = gate();
  host.runner = async schedule => { entered.open(); await hold.wait; return { agentId: schedule.target.agentId!, output: "done" }; };
  try {
    const old = await host.ownResume(B, base + 2 * 60 * MINUTE);
    const byHand = host.service.runOnce(old.id); await entered.wait;
    const first = await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 30 * MINUTE) });
    assert.deepEqual([first.status, first.existing, first.scheduleId === old.id, first.runAt, host.deletes(old.id)], ["scheduled", undefined, false, iso(base + 30 * MINUTE), 0]);
    assert.equal((await ledger.cancel(host.paseo, { agentId: B })).status, "canceled");
    // The hand-made run ends; the heartbeat stays active at its wake until the host's next tick, but it waits for nothing.
    hold.open(); await byHand;
    assert.deepEqual([(await host.service.inspect(old.id)).status, (await host.service.inspect(old.id)).runs.map(run => run.status)], ["active", ["succeeded"]]);
    const second = await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 40 * MINUTE) });
    assert.deepEqual([second.status, second.existing, second.scheduleId === old.id, host.deletes(old.id)], ["scheduled", undefined, false, 1]);
  } finally { hold.open(); await ledger.close(); }
}));

test("a retry that takes over an own heartbeat still waiting takes it as read: one the user put off between the retry's list and its read wakes the Agent at its new time, the retry's wake (codex-obs-resume-recheck8-F1)", async t => withHost(t, async (host, root) => {
  const logs = sessionLog(new Set()), ledger = host.ledger(join(root, "plugin"), { logs });
  host.agents.get(A)!.persistence = { provider: "claude", sessionId: "session-a" };
  host.runner = async schedule => { throw new Error(`Agent ${schedule.target.agentId} already has an active run`); };
  try {
    await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 3 * MINUTE) });
    // An own heartbeat an earlier ledger left waking at 00:20; the wake at 00:03 finds A busy.
    const waiting = await host.ownResume(A, base + 20 * MINUTE);
    host.now = base + 3 * MINUTE; await host.service.tick();
    // While the retry reads it, the user puts it off to 00:30.
    host.beforeInspect = async id => { if (id === waiting.id) { host.beforeInspect = async () => {}; await host.service.update({ id, cadence: { type: "cron", ...resumeCron(base + 30 * MINUTE) } }); } };
    host.now += MINUTE; await ledger.check();
    const taken = (await ledger.list(A))[0]!;
    assert.deepEqual([taken.status, taken.attempt, taken.scheduleId, taken.wakeAt, host.creates()], ["retrying", 2, waiting.id, iso(base + 30 * MINUTE), 1], "taken over at its new wake, nothing made");
  } finally { await ledger.close(); }
}));

// Round 9 (codex-obs-resume-recheck9): a retry's own heartbeat whose answer was lost, and every wake the ledger knows, are judged
// on what the host has now; what is owed a delete is never dropped for room.
const D = "6f1c2a3b-0000-4000-8000-00000000000d";

test("a retry whose create answer was lost is taken as this attempt's and judged on what the host has now: put off in 计划 after the list was read, it wakes the Agent at the user's time, never judged missed by the time asked, deleted or made again earlier (codex-obs-resume-recheck9-F1)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  try {
    const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 120 * MINUTE) });
    // 02:04: the 02:00 wake never ran (the host was down over it); the retry reaches the host for 02:06, its answer is lost.
    host.loseCreate = 1; host.now = base + 124 * MINUTE;
    await ledger.check();
    const pending = (await ledger.list(A))[0]!;
    assert.deepEqual([pending.status, pending.scheduleId, pending.attempt, pending.wakeAt, host.deletes(first.scheduleId)], ["retrying", null, 2, iso(base + 126 * MINUTE), 1]);
    const lost = (await host.service.list()).find(schedule => schedule.target.agentId === A)!;
    assert.match(lost.name!, /（第 2 次）$/);
    // The next check reads the list; before it reads that heartbeat the user puts it off to 03:04 (Codex's madeLostReplyEditedWake).
    host.afterList = async () => { host.afterList = async () => {}; await host.service.update({ id: lost.id, cadence: { type: "cron", ...resumeCron(base + 184 * MINUTE) } }); };
    const creates = host.creates();
    await ledger.check();
    const claimed = (await ledger.list(A))[0]!;
    assert.deepEqual([claimed.status, claimed.scheduleId, claimed.attempt, claimed.wakeAt], ["retrying", lost.id, 2, iso(base + 184 * MINUTE)], "taken as read, at 03:04");
    // Checked on past 02:06 and its grace: still 03:04, never deleted, nothing made in its place.
    for (const at of [base + 127 * MINUTE, base + 140 * MINUTE, base + 175 * MINUTE]) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([(await ledger.list(A))[0]!.wakeAt, host.deletes(lost.id), host.creates(), (await host.service.inspect(lost.id)).nextRunAt],
      [iso(base + 184 * MINUTE), 0, creates, iso(base + 184 * MINUTE)]);
    // 03:04: the host runs it; delivered, and only then deleted.
    host.now = base + 184 * MINUTE; await host.service.tick(); await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, host.deletes(lost.id), host.creates()], ["delivered", 1, creates]);
  } finally { await ledger.close(); }
}));

test("a retry's own heartbeat whose answer was lost and that the user paused, changed or deleted in 计划 (after the list was read, or paused before) is theirs: the resume lets go as it would of a heartbeat it knew, and nothing is made in its place (codex-obs-resume-recheck9-F1)", async t => withHost(t, async (host, root) => {
  host.agents.set(D, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  const ledger = host.ledger(join(root, "plugin"));
  try {
    for (const [index, agentId] of [A, B, C, D].entries()) await ledger.schedule(host.paseo, { agentId, at: iso(base + (120 + index) * MINUTE) });
    // 02:10: the wakes never ran; each retry reaches the host and its answer is lost.
    host.loseCreate = 4; host.now = base + 130 * MINUTE;
    await ledger.check();
    const lost = new Map((await host.service.list()).map(schedule => [schedule.target.agentId!, schedule]));
    assert.deepEqual([A, B, C, D].map(id => [lost.get(id)?.name?.endsWith("（第 2 次）"), host.deletes(lost.get(id)?.id)]), [[true, 0], [true, 0], [true, 0], [true, 0]]);
    // D's is paused before the next check. In it each retry reads the list, and before it reads its own heartbeat the user has
    // paused A's, made B's a report of their own, deleted C's.
    const pause = (id: string) => (host.service as unknown as { pause(id: string): Promise<unknown> }).pause(id);
    await pause(lost.get(D)!.id);
    const meanwhile = [() => pause(lost.get(A)!.id), () => host.service.update({ id: lost.get(B)!.id, prompt: "用户自己的日报", maxRuns: 20 }), () => host.service.delete(lost.get(C)!.id)];
    host.afterList = async () => { await meanwhile.shift()?.(); };
    const creates = host.creates();
    await ledger.check();
    const entries = await Promise.all([A, B, C, D].map(async id => (await ledger.list(id))[0]!));
    assert.deepEqual(entries.map(entry => [entry.status, entry.reason, entry.scheduleId]),
      [["canceled", "paused", lost.get(A)!.id], ["canceled", "edited", lost.get(B)!.id], ["canceled", "deleted", lost.get(C)!.id], ["canceled", "paused", lost.get(D)!.id]]);
    assert.equal(host.creates(), creates, "nothing made in their place");
    const kept = await Promise.all([A, B, D].map(id => host.service.inspect(lost.get(id)!.id)));
    assert.deepEqual(kept.map(schedule => [schedule.status, schedule.prompt === RESUME_PROMPT]), [["paused", true], ["active", false], ["paused", true]], "kept as the user left them");
    await ledger.check();
    assert.deepEqual([A, B, D].map(id => host.deletes(lost.get(id)!.id)), [0, 0, 0], "and never deleted after");
  } finally { await ledger.close(); }
}));

test("a waiting resume's heartbeat whose time the user changed in 计划 is followed, put off or brought forward: it wakes the Agent then, never judged missed by the old time, deleted or made again earlier; one a restart moved to next month is still tried again (codex-obs-resume-recheck9-F1, self-check)", async t => withHost(t, async (host, root) => {
  host.agents.set(D, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  const ledger = host.ledger(join(root, "plugin"));
  try {
    const a = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 120 * MINUTE) });
    const b = await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 180 * MINUTE) });
    const c = await ledger.schedule(host.paseo, { agentId: C, at: iso(base + 240 * MINUTE) });
    const d = await ledger.schedule(host.paseo, { agentId: D, at: iso(base + 125 * MINUTE) });
    // 01:00: in 计划 the user puts A's off to 05:00, brings B's forward to 02:30, and makes D's wake every 3 hours (no cron to read).
    host.now = base + 60 * MINUTE;
    await host.service.update({ id: a.scheduleId!, cadence: { type: "cron", ...resumeCron(base + 300 * MINUTE) } });
    await host.service.update({ id: b.scheduleId!, cadence: { type: "cron", ...resumeCron(base + 150 * MINUTE) } });
    await host.service.update({ id: d.scheduleId!, cadence: { type: "every", everyMs: 3 * 60 * MINUTE } });
    await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.wakeAt, (await ledger.list(B))[0]!.wakeAt, (await ledger.list(D))[0]!.wakeAt], [iso(base + 300 * MINUTE), iso(base + 150 * MINUTE), iso(base + 240 * MINUTE)]);
    const creates = host.creates();
    // On through A's old 02:00 and its grace, B's 02:30 and its old 03:00: B is woken at 02:30, A waits for 05:00.
    for (let at = base + 61 * MINUTE; at <= base + 200 * MINUTE; at += 5 * MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    const [waitingA, deliveredB] = [(await ledger.list(A))[0]!, (await ledger.list(B))[0]!];
    assert.deepEqual([waitingA.status, waitingA.scheduleId, waitingA.wakeAt, host.deletes(a.scheduleId)], ["scheduled", a.scheduleId, iso(base + 300 * MINUTE), 0]);
    assert.deepEqual([(await ledger.list(D))[0]!.status, (await ledger.list(D))[0]!.wakeAt, host.deletes(d.scheduleId)], ["scheduled", iso(base + 240 * MINUTE), 0], "D past its old 02:05: waiting for 04:00");
    assert.deepEqual([deliveredB.status, deliveredB.deliveredAt, host.creates()], ["delivered", iso(base + 151 * MINUTE), creates]);
    // C: the daemon is down over 04:00 and moves it to next month when it comes back (its cron still fires at 04:00): tried again.
    host.now = base + 250 * MINUTE; await host.restart();
    assert.equal((await host.service.inspect(c.scheduleId!)).nextRunAt, "2026-11-15T04:00:00.000Z");
    await ledger.check();
    const retriedC = (await ledger.list(C))[0]!;
    assert.deepEqual([retriedC.status, retriedC.reason, retriedC.attempt, retriedC.wakeAt, host.deletes(c.scheduleId)], ["retrying", "missed", 2, iso(base + 252 * MINUTE), 1]);
    // 05:00: A is woken at the user's time.
    host.now = base + 300 * MINUTE; await host.service.tick(); await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, host.deletes(a.scheduleId)], ["delivered", 1]);
  } finally { await ledger.close(); }
}));

test("the heartbeats left to delete are never forgotten past TIDY_LIMIT: full, 安排续跑 is refused saying why and a resume ending waits for room, across reloads; once deletes go through again a check clears every one (codex-obs-resume-recheck9-F2)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), file = join(directory, "resume-ledger.json");
  host.failDelete = () => true;
  let ledger = host.ledger(directory);
  try {
    // B's resume waits for a wake after A's have filled the list.
    const b = await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 20 * 60 * MINUTE) });
    // A, one resume after another, each delivered; none of their heartbeats can be deleted.
    for (let index = 0; index < TIDY_LIMIT; index++) {
      const asked = await ledger.schedule(host.paseo, { agentId: A, at: iso(host.now + MINUTE) });
      assert.equal(asked.status, "scheduled", `resume ${index + 1}: ${asked.message}`);
      host.now = Date.parse(asked.runAt!); await host.service.tick(); await ledger.check();
      assert.equal((await ledger.list(A))[0]!.status, "delivered");
    }
    const owed = (await host.service.list()).filter(schedule => schedule.target.agentId === A).map(schedule => schedule.id);
    assert.equal(owed.length, TIDY_LIMIT);
    // Full: one more is refused, saying why, and nothing is made.
    const creates = host.creates();
    const refused = await ledger.schedule(host.paseo, { agentId: A, at: iso(host.now + MINUTE) });
    assert.deepEqual([refused.status, refused.message, host.creates()], ["failed", `还有 ${TIDY_LIMIT} 条续跑心跳等着删除（它们的运行还没结束，或者宿主暂时删不掉），删掉之前先不安排新的续跑；请稍后再试。`, creates]);
    // B is woken; its heartbeat cannot be deleted and there is no room to keep it: B waits, still naming it.
    host.now = Date.parse(b.runAt!); await host.service.tick(); await ledger.check();
    const waitingB = (await ledger.list(B))[0]!;
    assert.deepEqual([waitingB.status, waitingB.scheduleId], ["scheduled", b.scheduleId]);
    const saved = JSON.parse(await readFile(file, "utf8")) as { tidy: Array<{ id: string }> };
    assert.deepEqual(saved.tidy.map(item => item.id).sort(), [...owed].sort(), "every one of A's kept, none dropped for room");
    assert.ok((await stat(file)).size < LEDGER_MAX_BYTES / 10);
    // A reload (twice) keeps them all and stays full.
    for (let reload = 0; reload < 2; reload++) {
      await ledger.close(); ledger = host.ledger(directory);
      assert.match((await ledger.schedule(host.paseo, { agentId: C, at: iso(host.now + 10 * MINUTE) })).message, new RegExp(`还有 ${TIDY_LIMIT} 条续跑心跳等着删除`));
      await ledger.check();
    }
    // Deletes go through again: one check delivers B (its heartbeat deleted) and clears every one of A's.
    host.failDelete = () => false;
    await ledger.check();
    assert.deepEqual([(await ledger.list(B))[0]!.status, host.deletes(b.scheduleId) > 0, (await host.service.list()).length], ["delivered", true, 0]);
    // Reloaded once more: nothing left owed; a new resume is taken again.
    await ledger.close(); ledger = host.ledger(directory);
    assert.deepEqual((JSON.parse(await readFile(file, "utf8")) as { tidy: unknown[] }).tidy, []);
    assert.equal((await ledger.schedule(host.paseo, { agentId: A, at: iso(host.now + MINUTE) })).status, "scheduled");
  } finally { await ledger.close(); }
}));

test("a ledger file from before 2.14.0's reload fix (nothing kept to delete) has every ended resume's heartbeat cleared at the first check, unasked: one gone, deleted or the user's is let go (codex-obs-resume-recheck9-F2, self-check)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), file = join(directory, "resume-ledger.json");
  host.agents.set(D, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  let ledger = host.ledger(directory);
  try {
    const asked = new Map<string, string>();
    for (const [index, agentId] of [A, B, C, D].entries()) asked.set(agentId, (await ledger.schedule(host.paseo, { agentId, at: iso(base + (10 + index) * MINUTE) })).scheduleId!);
    // B's is made the user's own before its wake; A's, C's and D's are delivered while deletes fail, so they stay.
    await host.service.update({ id: asked.get(B)!, prompt: "用户自己的日报", maxRuns: 20 });
    host.failDelete = () => true;
    host.now = base + 15 * MINUTE; await host.service.tick(); await ledger.check();
    assert.deepEqual(await Promise.all([A, B, C, D].map(async id => (await ledger.list(id))[0]!.status)), ["delivered", "canceled", "delivered", "delivered"]);
    // D's the user deletes in 计划 meanwhile; the ledger file loses what it kept to delete, as 2.14.0 before the fix wrote it, and
    // C's record is over a week old, due to leave the ledger as it loads.
    await host.service.delete(asked.get(D)!);
    await ledger.close();
    const saved = JSON.parse(await readFile(file, "utf8")) as { tidy?: unknown; entries: Array<{ agentId: string; updatedAt: string }> };
    delete saved.tidy; saved.entries.find(entry => entry.agentId === C)!.updatedAt = iso(host.now - 8 * 24 * 60 * MINUTE);
    await writeFile(file, JSON.stringify(saved));
    host.failDelete = () => false;
    ledger = host.ledger(directory);
    const sent = host.sent.length;
    await ledger.check();
    const deleted = host.sent.slice(sent).filter(message => message.type === "schedule/delete").map(message => message.scheduleId);
    assert.deepEqual(deleted.sort(), [asked.get(A), asked.get(C)].sort(), "A's and C's deleted unasked; B's (the user's) and D's (gone) left alone");
    assert.equal(host.sent.slice(sent).some(message => message.scheduleId === asked.get(B)), false, "B's, the user's, is not even read");
    assert.deepEqual((await ledger.list()).map(entry => entry.agentId).sort(), [A, B, D].sort(), "C's old record left, its heartbeat deleted all the same");
    assert.deepEqual((await host.service.list()).map(schedule => schedule.id), [asked.get(B)], "only the user's own is left");
    assert.equal(host.deletes(asked.get(B)), 0);
    assert.deepEqual((JSON.parse(await readFile(file, "utf8")) as { tidy: unknown[] }).tidy, []);
  } finally { await ledger.close(); }
}));

test("安排续跑 already under way when another Agent's resume ends and fills the heartbeats to delete still records the heartbeat it took up or made: one past TIDY_LIMIT each, nothing left unrecorded or made twice; while full a new request is refused, across a reload; once deletes go through every one is cleared and each Agent is woken once (codex-obs-resume-recheck9 follow-up)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), file = join(directory, "resume-ledger.json");
  host.agents.set(D, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  const runs = new Map<string, number>();
  host.runner = async schedule => { runs.set(schedule.target.agentId!, (runs.get(schedule.target.agentId!) ?? 0) + 1); return { agentId: schedule.target.agentId!, output: "done" }; };
  const own = async (agentId: string) => (await host.service.list()).filter(schedule => schedule.target.agentId === agentId).map(schedule => schedule.id);
  let ledger = host.ledger(directory);
  try {
    // A's and D's last resumes were delivered, their heartbeats deleted: the record each new one replaces is kept to delete.
    for (const agentId of [A, D]) {
      const asked = await ledger.schedule(host.paseo, { agentId, at: iso(host.now + 2 * MINUTE) });
      host.now = Date.parse(asked.runAt!); await host.service.tick(); await ledger.check();
      assert.equal((await ledger.list(agentId))[0]!.status, "delivered");
    }
    // A has a heartbeat of its own still waiting (2.13 made it), which 安排续跑 takes up; B's resume wakes B in two minutes; C has
    // one short of TIDY_LIMIT heartbeats left to delete, which the host cannot delete for now (as the capacity test fills them).
    const legacy = await host.ownResume(A, host.now + 3 * 60 * MINUTE);
    const b = await ledger.schedule(host.paseo, { agentId: B, at: iso(host.now + 2 * MINUTE) });
    const owed: string[] = [];
    for (let index = 0; index < TIDY_LIMIT - 1; index++) owed.push((await host.ownResume(C, base + 3 * 24 * 60 * MINUTE + index * MINUTE)).id);
    await ledger.close();
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), tidy: owed.map(id => ({ id, agentId: C })) }));
    host.failDelete = () => true;
    ledger = host.ledger(directory);
    // B's prompt goes in. A and D ask at once: both pass the opening checks (one short of full); only then does the check that
    // ends B's resume keep B's heartbeat, which cannot be deleted, filling the list.
    host.now = Date.parse(b.runAt!); await host.service.tick();
    const filled = gate();
    let lists = 0;
    host.afterList = async () => { if (++lists === 2) { await ledger.check(); filled.open(); } else if (lists === 1) await filled.wait; };
    const creates = host.creates();
    const [a, d] = await Promise.all([A, D].map(agentId => ledger.schedule(host.paseo, { agentId, at: iso(host.now + 10 * MINUTE) })));
    host.afterList = async () => {};
    assert.equal((await ledger.list(B))[0]!.status, "delivered");
    assert.deepEqual([a.status, a.existing, a.scheduleId, d.status, d.existing ?? false, host.creates() - creates], ["scheduled", true, legacy.id, "scheduled", false, 1], `${a.message} / ${d.message}`);
    assert.deepEqual([(await ledger.list(A))[0]!.scheduleId, (await ledger.list(D))[0]!.scheduleId, await own(A), await own(D)], [legacy.id, d.scheduleId, [legacy.id], [d.scheduleId]]);
    const kept = (JSON.parse(await readFile(file, "utf8")) as { tidy: Array<{ id: string }> }).tidy.map(item => item.id);
    assert.deepEqual([kept.length, kept.includes(b.scheduleId!), owed.every(id => kept.includes(id))], [TIDY_LIMIT + 2, true, true], "B's and C's kept, and the records A and D replaced");
    // Asked again, each gets the one it has; full, a new request is refused, across a reload too.
    assert.deepEqual(await Promise.all([A, D].map(async agentId => (await ledger.schedule(host.paseo, { agentId, at: iso(host.now + 20 * MINUTE) })).existing)), [true, true]);
    for (let reload = 0; reload < 2; reload++) {
      assert.match((await ledger.schedule(host.paseo, { agentId: C, at: iso(host.now + 30 * MINUTE) })).message, new RegExp(`^还有 ${TIDY_LIMIT + 2} 条续跑心跳等着删除`));
      await ledger.close(); ledger = host.ledger(directory);
    }
    assert.equal(host.creates() - creates, 1);
    // Deletes go through again: one check clears every one, and A's and D's heartbeats wait on; each wakes its Agent once.
    host.failDelete = () => false;
    await ledger.check();
    assert.deepEqual([(JSON.parse(await readFile(file, "utf8")) as { tidy: unknown[] }).tidy, (await host.service.list()).map(schedule => schedule.id).sort()], [[], [legacy.id, d.scheduleId].sort()]);
    for (const at of [Date.parse(d.runAt!), Date.parse(a.runAt!)]) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await ledger.list(D))[0]!.status, runs.get(A), runs.get(D), (await host.service.list()).length], ["delivered", "delivered", 2, 2, 0]);
  } finally { await ledger.close(); }
}));

// After 5061e0d: an answer lost on the way back (the plugin session reconnecting, a timeout) after the host did the work.
const E = "6f1c2a3b-0000-4000-8000-00000000000e";
const LOST = "宿主未响应：插件会话已重新连接，请重试。", UNREACHED = "宿主未响应子任务请求。可重试，或确认 Paseo 宿主支持子任务观察。";
/** One of this Agent's own resume heartbeats made at the host's present moment (another device, or the same title). */
const madeNow = (host: Host, agentId: string, at: number, name = "恢复后续跑 · 修复登录") =>
  host.service.create({ name, prompt: RESUME_PROMPT, cadence: { type: "cron", ...resumeCron(at) }, target: { type: "agent", agentId }, maxRuns: 1 });

test("安排续跑 whose create answer was lost is a resume to confirm, taken up at the next check by what the user cannot change (this Agent's, made since the request, not one the ledger is deleting): never the Agent's earlier heartbeat still owed a delete, nor another Agent's under the same name, even past the request's time; never made twice, it wakes the Agent once (lost answer, after 5061e0d; codex-obs-resume-recheck12)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  try {
    // A's last resume was delivered; its heartbeat could not be deleted, so it is still there, completed, under the same name.
    const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 2 * MINUTE) });
    host.failDelete = id => id === first.scheduleId;
    host.now = base + 2 * MINUTE; await host.service.tick(); await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await host.service.inspect(first.scheduleId!)).status], ["delivered", "completed"]);
    // Asked again. As the create reaches the host, B's resume is made under the same name (B has the same title); the host takes
    // 7 s, past the request's 6, and the answer is lost: a resume to confirm, nothing looked for or made at once.
    host.beforeCreate = async () => { host.beforeCreate = async () => {}; await madeNow(host, B, base + 40 * MINUTE); host.now += 7_000; };
    host.loseCreate = 1;
    const creates = host.creates(), inspects = host.sent.filter(message => message.type === "schedule/inspect").length;
    const asked = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 30 * MINUTE) });
    const made = (await host.service.list()).filter(schedule => schedule.target.agentId === A && schedule.status === "active");
    assert.deepEqual([asked.status, asked.existing, made.length, asked.scheduleId, asked.runAt, host.creates() - creates, host.sent.filter(message => message.type === "schedule/inspect").length - inspects],
      ["scheduled", undefined, 1, null, iso(base + 30 * MINUTE), 1, 0], asked.message);
    assert.match(asked.message, /还不知道续跑建好没有/);
    // Asked again: the one waiting, nothing more made.
    const again = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 50 * MINUTE) });
    assert.deepEqual([again.existing, again.scheduleId, host.creates() - creates], [true, null, 1]);
    // 00:03: the check takes up the one made, never the earlier one it still owes a delete, nor B's.
    host.now = base + 3 * MINUTE; await ledger.check();
    const entry = (await ledger.list(A))[0]!;
    assert.deepEqual([entry.status, entry.scheduleId, entry.wakeAt, entry.attempt], ["scheduled", made[0]!.id, iso(base + 30 * MINUTE), 1]);
    // 00:30: it wakes A once and is deleted after, the earlier one with it now that deletes go through.
    const runs: string[] = [];
    host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
    host.failDelete = () => false;
    host.now = base + 30 * MINUTE; await host.service.tick(); await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, runs, (await host.service.list()).filter(schedule => schedule.target.agentId === A).length], ["delivered", [A], 0]);
  } finally { await ledger.close(); }
}));

test("安排续跑 whose create answer was lost is recorded as a resume to confirm, saying the observatory checks for it, and nothing is looked for or made at once; asking again returns the one waiting, never a second. The checks take up the one the host made as they find it: waiting, paused by the user (theirs, kept as it is), run by hand (that run went in); none made, or one deleted by the user, two minutes on is 未能确认, never made again. A cancel deletes the one made (lost answer, after 5061e0d; codex-obs-resume-recheck11-F3, recheck12)", async t => withHost(t, async (host, root) => {
  for (const id of [D, E, F]) host.agents.set(id, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  const ledger = host.ledger(join(root, "plugin"));
  const MAYBE = (at: string) => `安排续跑时宿主没有回话（${LOST.slice(0, -1)}），还不知道续跑建好没有。已记下 ${at} 的续跑：观测台会在下一分钟核对，确认不了时，停下卡片上会请你到 Paseo 的「计划」里查看。`;
  const own = async (agentId: string) => (await host.service.list()).filter(schedule => schedule.target.agentId === agentId);
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
  try {
    // Each create reaches the host and its answer is lost, but C's, which never reached it.
    const asked: Array<Awaited<ReturnType<ResumeLedger["schedule"]>>> = [];
    for (const [index, agentId] of [A, B, C, D, E, F].entries()) {
      if (agentId === C) host.beforeCreate = async () => { host.beforeCreate = async () => {}; throw new Error(LOST); };
      else host.loseCreate = 1;
      asked.push(await ledger.schedule(host.paseo, { agentId, at: iso(base + (30 + index) * MINUTE) }));
    }
    assert.deepEqual(asked.map(reply => [reply.status, reply.scheduleId, reply.message]), [30, 31, 32, 33, 34, 35].map(minute => ["scheduled", null, MAYBE(`00:${minute}`)]));
    assert.equal(host.sent.filter(message => message.type === "schedule/inspect").length, 0, "nothing read at once");
    const [madeA, madeB, madeD, madeE, madeF] = await Promise.all([A, B, D, E, F].map(async id => (await own(id))[0]!));
    assert.equal((await own(C)).length, 0);
    // Asked again: each one waiting is returned, saying it is being confirmed; nothing made.
    const creates = host.creates();
    const again = await Promise.all([A, B, C, D, E, F].map((agentId, index) => ledger.schedule(host.paseo, { agentId, at: iso(base + (40 + index) * MINUTE) })));
    assert.deepEqual(again.map(reply => [reply.existing, reply.scheduleId, reply.message]), [30, 31, 32, 33, 34, 35].map(minute => [true, null, `已记下 00:${minute} 的续跑，正在核对它建好没有，没有重复安排。要换时间，先取消这一次。`]));
    assert.equal(host.creates(), creates);
    // In 计划 meanwhile the user pauses D's, deletes E's and runs F's by hand (立即运行). B is cancelled from its card: the heartbeat
    // the host made for it is found and deleted.
    await host.service.pause(madeD.id); await host.service.delete(madeE.id); await host.service.runOnce(madeF.id);
    assert.deepEqual([(await ledger.cancel(host.paseo, { agentId: B })).status, host.deletes(madeB.id), (await ledger.list(B))[0]!.reason], ["canceled", 1, "user"]);
    // 00:01: the checks take up A's as read; D's, paused, is the user's (kept as it is); F's ran by hand: that run went in. C's and
    // E's are not there: looked for again, nothing made.
    const entries = async () => Promise.all([A, C, D, E, F].map(async id => { const entry = (await ledger.list(id))[0]!; return [entry.status, entry.reason, entry.scheduleId]; }));
    host.now = base + MINUTE; await ledger.check();
    assert.deepEqual(await entries(), [["scheduled", null, madeA.id], ["scheduled", null, null], ["canceled", "paused", madeD.id], ["scheduled", null, null], ["delivered", null, madeF.id]]);
    // 00:02, two minutes on: C's and E's still not there are 未能确认, never made again.
    host.now = base + 2 * MINUTE; await ledger.check();
    assert.deepEqual((await entries()).filter((_, index) => index === 1 || index === 3), [["failed", "unsure", null], ["failed", "unsure", null]]);
    // On to 00:45: A woken once at its wake, F once by hand; B (cancelled), C and E (none made) and D (paused) never; D's left
    // paused, never deleted; nothing made.
    for (let at = base + 3 * MINUTE; at <= base + 45 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs.sort(), (await ledger.list(A))[0]!.status, host.creates()], [[A, F].sort(), "delivered", creates]);
    assert.deepEqual([(await host.service.inspect(madeD.id)).status, host.deletes(madeD.id)], ["paused", 0]);
  } finally { await ledger.close(); }
}));

test("安排续跑 whose create times out while the host is still writing it: none is listed, so it is recorded as a resume to confirm; asked again it is returned, saying so, and nothing is made again. Once the write lands within two minutes the next check takes it up: one heartbeat, one prompt. One landing later is 未能确认 by then (the host has no create to retry safely): 重新安排 takes up the one that landed, never a second (codex-obs-resume-recheck11-F3, recheck12)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
  // The host's store holds the next write (a slow disk); the bridge gives up on the create meanwhile, as its 15 s timeout does.
  const store = (host.service as unknown as { store: { write(record: unknown): Promise<void> } }).store;
  const write = store.write.bind(store), request = host.bridge.request;
  const slowCreate = () => {
    const reached = gate(), landed = gate();
    let held = true, created: Promise<HostSchedule> | null = null;
    store.write = async record => { if (held) { held = false; reached.open(); await landed.wait; } return write(record); };
    host.bridge.request = async message => {
      if (message.type !== "schedule/create" || created) return request(message);
      host.sent.push(structuredClone(message));
      created = host.service.create(message); await reached.wait;
      throw new Error(UNREACHED);
    };
    return { open: () => landed.open(), land: async () => { landed.open(); const made = await created!; store.write = write; host.bridge.request = request; return made; } };
  };
  let slow = slowCreate();
  try {
    const asked = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 10 * MINUTE) });
    assert.deepEqual([asked.status, asked.scheduleId, (await host.service.list()).length, (await ledger.list(A))[0]!.wakeAt], ["scheduled", null, 0, iso(base + 10 * MINUTE)], asked.message);
    const again = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 10 * MINUTE) });
    assert.deepEqual([again.existing, again.message, host.creates()], [true, "已记下 00:10 的续跑，正在核对它建好没有，没有重复安排。要换时间，先取消这一次。", 1]);
    // 00:01, the write still held: nothing listed, nothing made.
    host.now = base + MINUTE; await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.scheduleId, host.creates()], [null, 1]);
    // The write lands; the next check takes it up.
    const made = await slow.land();
    host.now = base + 2 * MINUTE; await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await ledger.list(A))[0]!.scheduleId, made.name], ["scheduled", made.id, "恢复后续跑 · 修复登录"]);
    for (let at = base + 3 * MINUTE; at <= base + 15 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs, (await ledger.list(A))[0]!.status, host.creates()], [[A], "delivered", 1]);
    // B, at 00:15 for 00:30: the write is held past two minutes. 00:17: 未能确认, nothing made.
    slow = slowCreate();
    const b = await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 30 * MINUTE) });
    for (const at of [base + 16 * MINUTE, base + 17 * MINUTE]) { host.now = at; await ledger.check(); }
    const unconfirmed = (await ledger.list(B))[0]!;
    assert.deepEqual([b.scheduleId, unconfirmed.status, unconfirmed.reason, unconfirmed.scheduleId, host.creates()], [null, "failed", "unsure", null, 2]);
    // 00:18 it lands, at the wake it was made for; 00:19 the user asks again from the card: the one that landed is taken up.
    const late = await slow.land();
    host.now = base + 19 * MINUTE;
    const rescheduled = await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 30 * MINUTE) });
    assert.deepEqual([rescheduled.existing, rescheduled.scheduleId, rescheduled.runAt, host.creates()], [true, late.id, iso(base + 30 * MINUTE), 2]);
    for (let at = base + 20 * MINUTE; at <= base + 35 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs, (await ledger.list(B))[0]!.status], [[A, B], "delivered"]);
  } finally { slow.open(); store.write = write; host.bridge.request = request; await ledger.close(); }
}));

test("a retry whose delete of the missed heartbeat lost its answer, the host having deleted it, goes ahead: never taken for the user deleting it (canceled, never tried again); a delete that failed waits for the next check, also when the heartbeat cannot be read after it (lost answer, after 5061e0d)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
  try {
    const [a, b, c] = await Promise.all([A, B, C].map((agentId, index) => ledger.schedule(host.paseo, { agentId, at: iso(base + (120 + index) * MINUTE) })));
    // The daemon is down over the three wakes and moves them to next month when it comes back.
    host.now = base + 130 * MINUTE; await host.restart();
    // A's delete goes through, its answer lost. B's never reaches the host; nor does C's, and C's heartbeat cannot be read after it.
    host.loseDelete = id => id === a.scheduleId;
    host.failDelete = id => id === b.scheduleId || id === c.scheduleId;
    let readsOfC = 0;
    host.beforeInspect = async id => { if (id === c.scheduleId && ++readsOfC === 2) throw new Error(UNREACHED); };
    const creates = host.creates();
    await ledger.check();
    const [retriedA, waitingB, waitingC] = await Promise.all([A, B, C].map(async id => (await ledger.list(id))[0]!));
    const liveA = (await host.service.list()).filter(schedule => schedule.target.agentId === A);
    assert.deepEqual([retriedA.status, retriedA.reason, retriedA.attempt, retriedA.scheduleId, liveA.length, host.creates() - creates], ["retrying", "missed", 2, liveA[0]!.id, 1, 1]);
    assert.match(liveA[0]!.name!, /（第 2 次）$/);
    assert.deepEqual([[waitingB.status, waitingB.scheduleId], [waitingC.status, waitingC.scheduleId]], [["scheduled", b.scheduleId], ["scheduled", c.scheduleId]], "B and C wait: their heartbeats are still there");
    assert.deepEqual([(await host.service.inspect(b.scheduleId!)).status, (await host.service.inspect(c.scheduleId!)).status], ["active", "active"]);
    // Deletes go through again: B and C are tried again at the next check; each Agent is woken once.
    host.loseDelete = () => false; host.failDelete = () => false; host.beforeInspect = async () => {};
    host.now = base + 131 * MINUTE; await ledger.check();
    assert.deepEqual(await Promise.all([B, C].map(async id => [(await ledger.list(id))[0]!.status, (await ledger.list(id))[0]!.attempt])), [["retrying", 2], ["retrying", 2]]);
    for (const at of [base + 132 * MINUTE, base + 133 * MINUTE, base + 134 * MINUTE]) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([await Promise.all([A, B, C].map(async id => (await ledger.list(id))[0]!.status)), runs.sort(), (await host.service.list()).length], [["delivered", "delivered", "delivered"], [A, B, C].sort(), 0]);
  } finally { await ledger.close(); }
}));

test("the ledger's own deletes whose answer was lost count as done, never as the user deleting the heartbeat: the user carrying on ends the resume as 你已接着做, a cancel says 已取消; a delete that fails once the user carried on makes no retry in its place (lost answer, after 5061e0d)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  try {
    const [a, b, c] = await Promise.all([[A, 300], [B, 301], [C, 62]].map(([agentId, wake]) => ledger.schedule(host.paseo, { agentId: agentId as string, at: iso(base + (wake as number) * MINUTE) })));
    // C's wake is missed (the daemon down over it, moved to next month); A's and B's are hours ahead. The user then messages A and
    // C, carrying on by hand.
    host.now = base + 70 * MINUTE; await host.restart();
    host.now = base + 71 * MINUTE;
    for (const id of [A, C]) host.agents.get(id)!.lastUserMessageAt = iso(host.now);
    // A's delete goes through, its answer lost; C's first delete never reaches the host, the one after it would.
    host.loseDelete = id => id === a.scheduleId;
    let deletesOfC = 0;
    host.failDelete = id => id === c.scheduleId && ++deletesOfC === 1;
    const creates = host.creates();
    await ledger.check();
    const [endedA, waitingC] = [(await ledger.list(A))[0]!, (await ledger.list(C))[0]!];
    assert.deepEqual([endedA.status, endedA.reason], ["canceled", "resumed"]);
    assert.deepEqual([waitingC.status, waitingC.scheduleId, host.creates() - creates, (await host.service.inspect(c.scheduleId!)).status], ["scheduled", c.scheduleId, 0, "active"], "no retry made while its heartbeat is still there");
    await ledger.check();
    assert.deepEqual([(await ledger.list(C))[0]!.status, (await ledger.list(C))[0]!.reason, host.creates() - creates], ["canceled", "resumed", 0]);
    // B, cancelled from its card: the delete goes through, its answer lost.
    host.loseDelete = id => id === b.scheduleId;
    const canceled = await ledger.cancel(host.paseo, { agentId: B });
    assert.deepEqual([canceled.status, canceled.message, (await ledger.list(B))[0]!.reason], ["canceled", "已取消续跑，到点不会唤醒它。", "user"]);
    await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.reason, (await ledger.list(B))[0]!.reason, (await ledger.list(C))[0]!.reason, (await host.service.list()).length], ["resumed", "user", "resumed", 0]);
    // A 2.13 heartbeat of D's, which the ledger does not know, cancelled from the card: the delete goes through, its answer lost.
    const legacy = await host.ownResume(D, base + 400 * MINUTE);
    host.loseDelete = id => id === legacy.id;
    const old = await ledger.cancel(host.paseo, { agentId: D, scheduleId: legacy.id });
    assert.deepEqual([old.status, old.message, (await ledger.list(D))[0]!.reason, (await host.service.list()).length], ["canceled", "已取消续跑，到点不会唤醒它。", "user", 0]);
  } finally { await ledger.close(); }
}));

// Round 10 (codex-obs-resume-recheck10-F1): who moved a wake is read from the heartbeat's rule, kept from when the ledger made or
// took it up, never from whether the old wake still matches.
const F = "6f1c2a3b-0000-4000-8000-00000000000f";

test("a waiting resume's heartbeat whose rule the user changed in 计划 is followed though the new rule still matches the old wake: every two hours, a list or a stepped range put 02:00 off to 04:00, every hour brings it forward to 01:00, a zone of its own moves it to 05:04. Each wakes the Agent then, once, never deleted or made again earlier; the rule it was made with, moved by a restart, is still tried again (codex-obs-resume-recheck10-F1)", async t => withHost(t, async (host, root) => {
  for (const id of [D, E, F]) host.agents.set(id, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  const ledger = host.ledger(join(root, "plugin"));
  const runs: Array<[string, string]> = [];
  host.runner = async schedule => { runs.push([schedule.target.agentId!, iso(host.now)]); return { agentId: schedule.target.agentId!, output: "done" }; };
  const rule = (id: string, expression: string, timezone = "UTC") => host.service.update({ id, cadence: { type: "cron", expression, timezone } });
  try {
    const asked = new Map<string, string>();
    for (const [index, agentId] of [A, B, C, D, E, F].entries()) asked.set(agentId, (await ledger.schedule(host.paseo, { agentId, at: iso(base + (120 + index) * MINUTE) })).scheduleId!);
    // 00:00: D's is made to wake every hour (next 01:00), E's to wake at 02:04 São Paulo time (05:04 UTC).
    await rule(asked.get(D)!, "0 * * * *");
    await rule(asked.get(E)!, "4 2 15 * *", "America/Sao_Paulo");
    await ledger.check();
    assert.deepEqual([(await ledger.list(D))[0]!.wakeAt, (await ledger.list(E))[0]!.wakeAt], [iso(base + 60 * MINUTE), iso(base + 304 * MINUTE)], "followed at the first look");
    host.now = base + 60 * MINUTE; await host.service.tick(); await ledger.check();
    // 02:04: A's, B's and C's wakes went by without a run; the user puts each off with a rule that still matches its old wake.
    host.now = base + 124 * MINUTE;
    await rule(asked.get(A)!, "0 */2 * * *"); await rule(asked.get(B)!, "0 2,4 * * *"); await rule(asked.get(C)!, "0 2-4/2 * * *");
    const creates = host.creates();
    await ledger.check();
    const moved = await Promise.all([A, B, C].map(async id => (await ledger.list(id))[0]!));
    assert.deepEqual(moved.map(entry => [entry.status, entry.attempt, entry.scheduleId, entry.wakeAt]), [A, B, C].map(id => ["scheduled", 1, asked.get(id), iso(base + 240 * MINUTE)]));
    assert.deepEqual([host.creates(), [A, B, C].map(id => host.deletes(asked.get(id)))], [creates, [0, 0, 0]]);
    // 02:10: F's 02:05 went by while the daemon was down; it comes back and moves it to next month by its own rule: tried again.
    host.now = base + 130 * MINUTE; await host.restart(); await ledger.check();
    const retried = (await ledger.list(F))[0]!;
    assert.deepEqual([retried.status, retried.reason, retried.attempt, retried.wakeAt, host.deletes(asked.get(F)), host.creates() - creates], ["retrying", "missed", 2, iso(base + 132 * MINUTE), 1, 1]);
    // On to 06:00: each wakes its Agent at its time, once; only F's was made again.
    for (let at = base + 131 * MINUTE; at <= base + 360 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); if (at % (10 * MINUTE) === 0 || runs.length) await ledger.check(); }
    await ledger.check();
    assert.deepEqual(runs.sort(), [[A, iso(base + 240 * MINUTE)], [B, iso(base + 240 * MINUTE)], [C, iso(base + 240 * MINUTE)], [D, iso(base + 60 * MINUTE)], [E, iso(base + 304 * MINUTE)], [F, iso(base + 132 * MINUTE)]].sort());
    assert.deepEqual(await Promise.all([A, B, C, D, E, F].map(async id => (await ledger.list(id))[0]!.status)), ["delivered", "delivered", "delivered", "delivered", "delivered", "delivered"]);
    assert.deepEqual([host.creates() - creates, (await host.service.list()).length], [1, 0]);
  } finally { await ledger.close(); }
}));

test("a heartbeat the user put past the retry window in 计划 is followed there and never deleted while it can still run, also when 恢复后续跑 is asked again; unrun at its expiry, the resume ends as 未能续跑. A ledger from before the rule was kept still tries a restart's move again and follows the user's change, also once a restart moved that by the user's rule; a 2.13 heartbeat taken up keeps its own rule, so a restart's move is tried again (codex-obs-resume-recheck10-F1)", async t => withHost(t, async (host, root) => {
  host.agents.set(D, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  const directory = join(root, "plugin"), file = join(directory, "resume-ledger.json");
  let ledger = host.ledger(directory);
  try {
    // D's was made by 2.13: 22:00 on 14 October in New York (02:00 UTC), taken up as it is.
    const old = await host.service.create({ name: "恢复后续跑 · 修复登录", prompt: RESUME_PROMPT, cadence: { type: "cron", expression: "0 22 14 10 *", timezone: "America/New_York" },
      target: { type: "agent", agentId: D }, maxRuns: 1 });
    assert.equal(old.nextRunAt, iso(base + 120 * MINUTE));
    const asked = new Map<string, string>();
    for (const [index, agentId] of [A, B, C].entries()) asked.set(agentId, (await ledger.schedule(host.paseo, { agentId, at: iso(base + (121 + index) * MINUTE) })).scheduleId!);
    assert.deepEqual([(await ledger.schedule(host.paseo, { agentId: D, at: iso(base + 200 * MINUTE) })).scheduleId, (await ledger.list(D))[0]!.cadence], [old.id, { expression: "0 22 14 10 *", timezone: "America/New_York" }]);
    // B's and C's are written as a ledger from before kept them, without the rule.
    await ledger.close();
    const saved = JSON.parse(await readFile(file, "utf8")) as { entries: Array<Record<string, unknown>> };
    for (const entry of saved.entries) if (entry.agentId === B || entry.agentId === C) delete entry.cadence;
    await writeFile(file, JSON.stringify(saved));
    ledger = host.ledger(directory);
    // 01:00: A's is put off to tomorrow 02:01, past the window; C's to every two hours (still matching its 02:03).
    host.now = base + 60 * MINUTE;
    await host.service.update({ id: asked.get(A)!, cadence: { type: "cron", expression: "1 2 16 * *", timezone: "UTC" } });
    await host.service.update({ id: asked.get(C)!, cadence: { type: "cron", expression: "0 */2 * * *", timezone: "UTC" } });
    await ledger.check();
    const [later, followed] = [(await ledger.list(A))[0]!, (await ledger.list(C))[0]!];
    assert.deepEqual([[later.status, later.scheduleId, later.wakeAt], [followed.status, followed.wakeAt]], [["scheduled", asked.get(A), iso(base + (24 * 60 + 121) * MINUTE)], ["scheduled", iso(base + 120 * MINUTE)]]);
    // Asked again: the one waiting, at the user's time; nothing made, nothing deleted.
    const creates = host.creates();
    const again = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 90 * MINUTE) });
    assert.deepEqual([again.existing, again.scheduleId, again.runAt, host.creates(), host.deletes(asked.get(A))], [true, asked.get(A), iso(base + (24 * 60 + 121) * MINUTE), creates, 0]);
    // 02:30: the daemon was down over B's 02:02 and D's 02:00 and moved them by their own rules: both tried again; C's waits.
    host.now = base + 150 * MINUTE; await host.restart(); await ledger.check();
    const [b, c, d] = await Promise.all([B, C, D].map(async id => (await ledger.list(id))[0]!));
    assert.deepEqual([[b.status, b.reason, b.attempt], [d.status, d.reason, d.attempt]], [["retrying", "missed", 2], ["retrying", "missed", 2]]);
    assert.deepEqual([c.status, c.scheduleId, c.wakeAt, host.deletes(asked.get(C))], ["scheduled", asked.get(C), iso(base + 240 * MINUTE), 0]);
    for (const at of [base + 152 * MINUTE, base + 153 * MINUTE]) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([(await ledger.list(B))[0]!.status, (await ledger.list(D))[0]!.status], ["delivered", "delivered"]);
    // 04:10: the daemon was down over C's 04:00 and moved it by the user's rule to 06:00: still the user's, followed there.
    host.now = base + 250 * MINUTE; await host.restart(); await ledger.check();
    const movedC = (await ledger.list(C))[0]!;
    assert.deepEqual([movedC.status, movedC.attempt, movedC.wakeAt, host.deletes(asked.get(C)), host.creates()], ["scheduled", 1, iso(base + 360 * MINUTE), 0, creates + 2]);
    // Checked on to 08:00: C wakes its Agent at 06:00; A's waits for tomorrow, never deleted; at 08:01 its expiry (the window's
    // end) passes unrun, and the next look (a far wake is read every 10 minutes) finds it so.
    for (let at = base + 260 * MINUTE; at <= base + 480 * MINUTE; at += 20 * MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([(await ledger.list(C))[0]!.status, (await ledger.list(C))[0]!.deliveredAt], ["delivered", iso(base + 360 * MINUTE)]);
    assert.deepEqual([(await ledger.list(A))[0]!.status, host.deletes(asked.get(A))], ["scheduled", 0]);
    host.now = base + 491 * MINUTE; await host.service.tick(); await ledger.check();
    const ended = (await ledger.list(A))[0]!;
    assert.deepEqual([ended.status, ended.reason, host.deletes(asked.get(A)) <= 1], ["failed", "expired", true], "only once it cannot run any more");
  } finally { await ledger.close(); }
}));

// Round 11 (codex-obs-resume-recheck11): a lost create answer read after the user changed the heartbeat, a delete left in doubt,
// and a ledger 2.14.0 wrote after following the user's time.
const DAY = 24 * 60 * MINUTE;

test("安排续跑 whose create answer was lost, put off or brought forward by the user in 计划 before the check found it, is theirs: its rule is no longer the one sent, so the check follows the user's time, never undoes it as the host's mistake; the rule sent stays its own and it wakes the Agent then, once (codex-obs-resume-recheck11-F1, recheck12)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  const runs: Array<[string, string]> = [];
  host.runner = async schedule => { runs.push([schedule.target.agentId!, iso(host.now)]); return { agentId: schedule.target.agentId!, output: "done" }; };
  try {
    for (const [agentId, sent, moved] of [[A, 10, 20], [B, 11, 5]] as const) {
      // The create reaches the host and its answer is lost; the user moves it in 计划 right away.
      host.loseCreate = 1;
      const asked = await ledger.schedule(host.paseo, { agentId, at: iso(base + sent * MINUTE) });
      const made = (await host.service.list()).filter(schedule => schedule.target.agentId === agentId);
      assert.deepEqual([asked.status, asked.scheduleId, made.length], ["scheduled", null, 1], asked.message);
      await host.service.update({ id: made[0]!.id, cadence: { type: "cron", ...resumeCron(base + moved * MINUTE) } });
    }
    // 00:01: each found as the user left it: their time followed, the rule sent kept; nothing deleted or made.
    host.now = base + MINUTE; await ledger.check();
    for (const [agentId, sent, moved] of [[A, 10, 20], [B, 11, 5]] as const) {
      const entry = (await ledger.list(agentId))[0]!;
      assert.deepEqual([entry.status, entry.plannedAt, entry.wakeAt, entry.cadence, host.deletes(entry.scheduleId)], ["scheduled", iso(base + sent * MINUTE), iso(base + moved * MINUTE), resumeCron(base + sent * MINUTE), 0]);
    }
    // On to 00:25: B woken at 00:05, A at 00:20, once each; neither deleted before it ran, nothing made again.
    for (let at = base + 2 * MINUTE; at <= base + 25 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs, await Promise.all([A, B].map(async id => (await ledger.list(id))[0]!.status)), host.creates()],
      [[[B, iso(base + 5 * MINUTE)], [A, iso(base + 20 * MINUTE)]], ["delivered", "delivered"], 2]);
  } finally { await ledger.close(); }
}));

test("a retry whose delete of the missed heartbeat went through, its answer and the read after it both lost, ends as live did: the next check finds it gone and takes it for the user's delete in 计划, nothing made (a known limit: the host's delete has no answer to ask again, codex-obs-resume-recheck13); a cancel finding it gone records it cancelled; one the user deletes in 计划 is theirs", async t => withHost(t, async (host, root) => {
  host.agents.set(D, { title: "修复登录", archivedAt: null, lastUserMessageAt: null });
  const directory = join(root, "plugin");
  let ledger = host.ledger(directory);
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
  try {
    const asked = new Map<string, string>();
    for (const [index, agentId] of [A, B, C, D].entries()) asked.set(agentId, (await ledger.schedule(host.paseo, { agentId, at: iso(base + (120 + index) * MINUTE) })).scheduleId!);
    // The daemon is down over the four wakes and moves them to next month when it comes back; D's the user then deletes in 计划.
    host.now = base + 130 * MINUTE; await host.restart();
    await host.service.delete(asked.get(D)!);
    // A's, B's and C's deletes go through with their answers lost, and the session is still reconnecting when each is read again:
    // nothing is recorded for them, and no retry is made while each might still be there.
    const doubtful = new Set([A, B, C].map(id => asked.get(id)!));
    host.loseDelete = id => doubtful.has(id);
    host.beforeInspect = async id => { if (doubtful.has(id) && host.deletes(id) > 0) throw new Error(UNREACHED); };
    const creates = host.creates();
    await ledger.check();
    const doubted = await Promise.all([A, B, C].map(async id => (await ledger.list(id))[0]!));
    assert.deepEqual(doubted.map(entry => [entry.status, entry.scheduleId, entry.reason]), [A, B, C].map(id => ["scheduled", asked.get(id), null]));
    assert.deepEqual([(await host.service.list()).length, host.creates() - creates, (await ledger.list(D))[0]!.status, (await ledger.list(D))[0]!.reason], [0, 0, "canceled", "deleted"]);
    // C is cancelled from its card: its heartbeat is gone, recorded cancelled.
    host.loseDelete = () => false;
    doubtful.delete(asked.get(C)!);
    const canceled = await ledger.cancel(host.paseo, { agentId: C });
    assert.deepEqual([canceled.status, canceled.message, (await ledger.list(C))[0]!.reason], ["canceled", "续跑的心跳已经不在了，已标记为取消。", "user"]);
    // 02:11: A is read again: gone, taken for the user's delete. B after a plugin reload: the same.
    doubtful.delete(asked.get(A)!);
    host.now = base + 131 * MINUTE; await ledger.check();
    await ledger.close(); ledger = host.ledger(directory);
    doubtful.clear();
    host.now = base + 132 * MINUTE; await ledger.check();
    // None woken, nothing made: A and B end as deleted in 计划, C cancelled, D deleted by the user.
    for (let at = base + 133 * MINUTE; at <= base + 140 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs, await Promise.all([A, B, C, D].map(async id => { const entry = (await ledger.list(id))[0]!; return [entry.status, entry.reason]; })), host.creates() - creates],
      [[], [["canceled", "deleted"], ["canceled", "deleted"], ["canceled", "user"], ["canceled", "deleted"]], 0]);
  } finally { await ledger.close(); }
}));

test("a ledger 5061e0d wrote after following the user's time in 计划 (the wake moved off the time first confirmed, no rule kept) keeps no rule once upgraded: a restart that moves the heartbeat by the user's rule is followed, never deleted and made again earlier; one still at the time first confirmed keeps the ledger's rule, so a restart's move is tried again (codex-obs-resume-recheck11-F4)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), file = join(directory, "resume-ledger.json");
  const runs: Array<[string, string]> = [];
  host.runner = async schedule => { runs.push([schedule.target.agentId!, iso(host.now)]); return { agentId: schedule.target.agentId!, output: "done" }; };
  // 00:00: 5061e0d made A's heartbeat for 02:00 and B's for 02:01, as it makes them.
  const made = async (agentId: string, at: number) => (await host.service.create({ name: "恢复后续跑 · 修复登录", prompt: RESUME_PROMPT, cadence: { type: "cron", ...resumeCron(at) },
    target: { type: "agent", agentId }, maxRuns: 1, expiresAt: iso(at + RESUME_WINDOW_MS) })).id;
  const [a, b] = [await made(A, base + 120 * MINUTE), await made(B, base + 121 * MINUTE)];
  // 01:00: in 计划 the user puts A's off to 04:00 and lets it live 40 days; 5061e0d's check followed it there and wrote its file:
  // the fields it writes, no rule (as Codex's run of 5061e0d itself left it, review/scratch/codex-obs/recheck11/cadence).
  host.now = base + 60 * MINUTE;
  await host.service.update({ id: a, cadence: { type: "cron", ...resumeCron(base + 240 * MINUTE) }, expiresAt: iso(base + 40 * DAY) });
  const record = (agentId: string, scheduleId: string, plannedAt: number, wakeAt: number) => ({ agentId, scheduleId, stopAt: null, plannedAt: iso(plannedAt), wakeAt: iso(wakeAt), attempt: 1,
    status: "scheduled", reason: null, createdAt: iso(base), updatedAt: iso(host.now), deliveredAt: null });
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, entries: [record(A, a, base + 120 * MINUTE, base + 240 * MINUTE), record(B, b, base + 121 * MINUTE, base + 121 * MINUTE)], tidy: [] }));
  // Upgraded. 04:04: the daemon was down over A's 04:00 and B's 02:01 and moved each by its own rule, to next month.
  const ledger = host.ledger(directory);
  try {
    assert.deepEqual([(await ledger.list(A))[0]!.cadence, (await ledger.list(B))[0]!.cadence], [null, resumeCron(base + 121 * MINUTE)]);
    host.now = base + 244 * MINUTE; await host.restart();
    assert.deepEqual([(await host.service.inspect(a)).nextRunAt, (await host.service.inspect(b)).nextRunAt], ["2026-11-15T04:00:00.000Z", "2026-11-15T02:01:00.000Z"]);
    await ledger.check();
    const [followed, retried] = [(await ledger.list(A))[0]!, (await ledger.list(B))[0]!];
    assert.deepEqual([followed.status, followed.attempt, followed.scheduleId, followed.wakeAt, host.deletes(a)], ["scheduled", 1, a, "2026-11-15T04:00:00.000Z", 0]);
    assert.deepEqual([retried.status, retried.reason, retried.attempt, retried.wakeAt, host.deletes(b)], ["retrying", "missed", 2, iso(base + 246 * MINUTE), 1]);
    // On to 04:30: B's retry wakes B; A's waits for the user's time, never deleted or made again.
    for (let at = base + 245 * MINUTE; at <= base + 270 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs, (await ledger.list(A))[0]!.status, host.deletes(a), (await host.service.inspect(a)).nextRunAt], [[[B, iso(base + 246 * MINUTE)]], "scheduled", 0, "2026-11-15T04:00:00.000Z"]);
  } finally { await ledger.close(); }
}));

// Round 12 (codex-obs-resume-recheck12): after a lost answer a heartbeat is told only by what the user cannot change. Round 13
// (recheck13): by this attempt's start; no intent is kept, a cancel deletes first and records after, and nothing is taken back.

test("a cancel deletes the heartbeat first and records it cancelled after, as live did: a delete that fails, or whose answer and the read after it are lost, changes nothing and says so, also with the heartbeats to delete full. A heartbeat gone afterwards (that delete, or the user following the reply in 计划) ends the resume as deleted there, never a retry brought back; one the user moves and then deletes is theirs (codex-obs-resume-recheck12-F1, recheck13-F3)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin");
  let ledger = host.ledger(directory);
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
  // Deletes that fail (`failing`) or go through with their answer lost (`losing`); for one in `blind`, the read right after fails too.
  const failing = new Set<string>(), losing = new Set<string>(), blind = new Set<string>(), unseen = new Set<string>();
  host.failDelete = id => { if (!failing.has(id)) return false; if (blind.has(id)) unseen.add(id); return true; };
  host.loseDelete = id => { if (!losing.has(id)) return false; if (blind.has(id)) unseen.add(id); return true; };
  host.beforeInspect = async id => { if (unseen.delete(id)) throw new Error(UNREACHED); };
  try {
    const asked = new Map<string, string>();
    for (const [index, agentId] of [A, B, C].entries()) asked.set(agentId, (await ledger.schedule(host.paseo, { agentId, at: iso(base + (2 + index) * MINUTE) })).scheduleId!);
    // 00:08: the three wakes passed unrun (no tick came). Each retry's delete of its heartbeat fails: A's and B's reads after it fail
    // too, C's shows it still there. Nothing is recorded and nothing made while each may still be there.
    for (const id of asked.values()) failing.add(id);
    blind.add(asked.get(A)!); blind.add(asked.get(B)!);
    host.now = base + 8 * MINUTE; await ledger.check();
    assert.deepEqual(await Promise.all([A, B, C].map(async id => { const entry = (await ledger.list(id))[0]!; return [entry.status, entry.scheduleId]; })), [A, B, C].map(id => ["scheduled", asked.get(id)]));
    assert.equal(host.creates(), 3);
    // The heartbeats to delete fill up (Codex's recheck13-F3: TIDY_LIMIT others the host cannot delete), across a plugin reload.
    await ledger.close();
    const file = join(directory, "resume-ledger.json"), data = JSON.parse(await readFile(file, "utf8")) as { tidy: unknown[] };
    data.tidy = Array.from({ length: TIDY_LIMIT }, (_, index) => ({ id: `owed-${index}`, agentId: D }));
    await writeFile(file, JSON.stringify(data));
    ledger = host.ledger(directory); ledger.notePaseo(host.paseo);
    // A is cancelled from its card: its delete goes through, its answer and the read after it lost (Codex's recheck12-F1). B's delete
    // fails again, the read after it too. Each says the cancel failed and changes nothing.
    failing.delete(asked.get(A)!); losing.add(asked.get(A)!);
    for (const agentId of [A, B]) {
      const refused = await ledger.cancel(host.paseo, { agentId }), entry = (await ledger.list(agentId))[0]!;
      assert.deepEqual([refused.status, refused.message, entry.status, entry.scheduleId],
        ["failed", `取消续跑失败：${(agentId === A ? LOST : UNREACHED).replaceAll("子任务", "续跑")}`, "scheduled", asked.get(agentId)]);
    }
    // B: the user follows the reply and deletes it in 计划. C: the user puts it off to 02:00 there.
    failing.clear(); losing.clear();
    await host.service.delete(asked.get(B)!);
    const changed = await host.service.update({ id: asked.get(C)!, cadence: { type: "cron", ...resumeCron(base + 120 * MINUTE) } });
    host.now = base + 9 * MINUTE; await ledger.check();
    const after = await Promise.all([A, B, C].map(async id => { const entry = (await ledger.list(id))[0]!; return [entry.status, entry.reason, entry.wakeAt]; }));
    assert.deepEqual(after, [["canceled", "deleted", iso(base + 2 * MINUTE)], ["canceled", "deleted", iso(base + 3 * MINUTE)], ["scheduled", null, changed.nextRunAt]]);
    // The user then deletes C's in 计划: theirs.
    await host.service.delete(asked.get(C)!);
    host.now = base + 20 * MINUTE; await ledger.check();
    assert.deepEqual([(await ledger.list(C))[0]!.status, (await ledger.list(C))[0]!.reason], ["canceled", "deleted"]);
    // Nothing brought back: none woken, nothing made.
    for (const at of [base + 21 * MINUTE, base + 120 * MINUTE, base + 130 * MINUTE]) { host.now = at; await ledger.check(); await host.service.tick(); }
    assert.deepEqual([runs, host.creates()], [[], 3]);
  } finally { await ledger.close(); }
}));

test("安排续跑 whose create answer was lost is told by what the user cannot change: this Agent's one resume heartbeat made since the request, whatever its name or the Agent's title. Paused in 计划 while the answer was lost, it stays paused and nothing wakes the Agent, its title ending in 第 2 次 or not. Changed there into another task, it is not a resume heartbeat and may be the user's own, made while this one was not: 未能确认, never deleted or made again; the Agent gets the user's task only (codex-obs-resume-recheck12-F2, F3, recheck13-F2)", async t => withHost(t, async (host, root) => {
  host.agents.set(B, { title: "复盘（第 2 次）", archivedAt: null, lastUserMessageAt: null });
  const ledger = host.ledger(join(root, "plugin"));
  const prompts: Array<[string, string]> = [];
  host.runner = async schedule => { prompts.push([schedule.target.agentId!, schedule.prompt]); return { agentId: schedule.target.agentId!, output: "done" }; };
  const request = host.bridge.request;
  /** The create reaches the host and, before its answer (lost) comes back, the user changes the heartbeat in 计划. */
  const meanwhile = (change: (made: HostSchedule) => Promise<unknown>) => {
    host.loseCreate = 1;
    host.bridge.request = async message => {
      try { return await request(message); }
      catch (error) {
        if (message.type !== "schedule/create") throw error;
        host.bridge.request = request;
        await change((await host.service.list()).find(schedule => schedule.target.agentId === (message.target as { agentId: string }).agentId)!);
        throw error;
      }
    };
  };
  try {
    const made = new Map<string, HostSchedule>();
    const changes: Array<[string, (heartbeat: HostSchedule) => Promise<unknown>]> = [
      // Codex's: the user turns it into a summary only.
      [A, heartbeat => host.service.update({ id: heartbeat.id, prompt: "只总结，不继续执行" })],
      // Codex's: an Agent titled 复盘（第 2 次）, its first heartbeat paused; and one with a plain title.
      [B, heartbeat => host.service.pause(heartbeat.id)], [C, heartbeat => host.service.pause(heartbeat.id)],
    ];
    for (const [index, [agentId, change]] of changes.entries()) {
      meanwhile(async heartbeat => { made.set(agentId, heartbeat); await change(heartbeat); });
      const asked = await ledger.schedule(host.paseo, { agentId, at: iso(base + (10 + index) * MINUTE) });
      assert.deepEqual([asked.status, asked.scheduleId], ["scheduled", null], asked.message);
    }
    assert.equal(made.get(B)!.name, "恢复后续跑 · 复盘（第 2 次）");
    host.now = base + MINUTE; await ledger.check();
    const entries = await Promise.all([A, B, C].map(async id => (await ledger.list(id))[0]!));
    assert.deepEqual(entries.map(entry => [entry.status, entry.reason, entry.scheduleId]), [["failed", "unsure", null], ["canceled", "paused", made.get(B)!.id], ["canceled", "paused", made.get(C)!.id]]);
    // On to 00:20: A gets the user's task once; nothing else wakes any of them; nothing deleted or made again.
    for (let at = base + 2 * MINUTE; at <= base + 20 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([prompts, host.creates(), host.sent.filter(message => message.type === "schedule/delete").length], [[[A, "只总结，不继续执行"]], 3, 0]);
  } finally { host.bridge.request = request; await ledger.close(); }
}));

test("取消续跑 on a resume to confirm never guesses (codex-obs-resume-recheck12-F4): two heartbeats that could be it (another made for the Agent while the answer was lost) cancel nothing and say so, the record kept, then 未能确认 at the check with both left for the user; one alone is found and deleted; none yet stops the checks without promising the Agent stays asleep", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"));
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
  const own = async (agentId: string) => (await host.service.list()).filter(schedule => schedule.target.agentId === agentId);
  const deletes = () => host.sent.filter(message => message.type === "schedule/delete").length;
  try {
    // A: as its create reaches the host, another device makes a resume for A too, and the answer is lost. B: made, its answer lost.
    // C: its create never reached the host.
    host.loseCreate = 1; host.beforeCreate = async () => { host.beforeCreate = async () => {}; await madeNow(host, A, base + 40 * MINUTE); };
    await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 10 * MINUTE) });
    host.loseCreate = 1;
    await ledger.schedule(host.paseo, { agentId: B, at: iso(base + 11 * MINUTE) });
    host.beforeCreate = async () => { host.beforeCreate = async () => {}; throw new Error(LOST); };
    await ledger.schedule(host.paseo, { agentId: C, at: iso(base + 12 * MINUTE) });
    assert.deepEqual([(await own(A)).length, (await own(B)).length, (await own(C)).length], [2, 1, 0]);
    // A: two could be it: nothing cancelled or deleted, and it says so; the record kept, still to confirm.
    const refused = await ledger.cancel(host.paseo, { agentId: A });
    assert.deepEqual([refused.status, refused.message, deletes(), (await ledger.list(A))[0]!.status, (await ledger.list(A))[0]!.scheduleId],
      ["failed", "分不清哪条心跳是这次的续跑，没有取消；请到 Paseo 的「计划」里核实。", 0, "scheduled", null]);
    // B: the one made is found and deleted. C: none made yet: the checks stop, nothing deleted, nothing promised.
    const canceledB = await ledger.cancel(host.paseo, { agentId: B }), stoppedC = await ledger.cancel(host.paseo, { agentId: C });
    assert.deepEqual([canceledB.status, canceledB.message, (await own(B)).length, stoppedC.status, stoppedC.message, (await ledger.list(C))[0]!.reason, deletes()],
      ["canceled", "已取消续跑，到点不会唤醒它。", 0, "canceled", "已停止核对和补建。如果之后在 Paseo 的「计划」里出现这条续跑，请删除它。", "user", 1]);
    // 00:01: A's check still cannot tell the two apart: 未能确认, both left for the user, nothing deleted or made.
    host.now = base + MINUTE; await ledger.check();
    const unconfirmed = (await ledger.list(A))[0]!;
    assert.deepEqual([unconfirmed.status, unconfirmed.reason, unconfirmed.scheduleId, (await own(A)).length, deletes(), host.creates()], ["failed", "unsure", null, 2, 1, 3]);
    // On to 00:45: B and C never woken; A's two are the user's to sort out (each wakes it; the card asked them to look in 计划).
    for (let at = base + 2 * MINUTE; at <= base + 45 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs, deletes(), host.creates()], [[A, A], 1, 3]);
  } finally { await ledger.close(); }
}));

test("a ledger write that fails takes nothing back: another Agent's write meanwhile carries the record as memory has it, so memory and the file never part; the retry goes ahead as live did, and its heartbeat the user then deletes stays deleted across a reload (codex-obs-resume-recheck13-F1)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin"), file = join(directory, "resume-ledger.json");
  let ledger = host.ledger(directory);
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
  // Codex's interleaving: once armed, the next write of the ledger file waits at its rename until released, then fails (EIO).
  let armed = false;
  const entered = gate(), release = gate(), original = fsp.rename;
  fsp.rename = (async (from: Parameters<typeof original>[0], to: Parameters<typeof original>[1]) => {
    if (armed && String(to) === file) { armed = false; entered.open(); await release.wait; throw Object.assign(new Error("synthetic EIO"), { code: "EIO" }); }
    return original(from, to);
  }) as typeof fsp.rename;
  syncBuiltinESMExports();
  try {
    const a = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 2 * MINUTE) });
    // 00:06: A's wake passed unrun. Its retry deletes it, and the write before its create stalls; B is scheduled meanwhile, its
    // write queued behind; then A's write fails.
    armed = true; host.now = base + 6 * MINUTE;
    const checking = ledger.check();
    await entered.wait;
    const scheduling = ledger.schedule(host.paseo, { agentId: B, at: iso(base + 120 * MINUTE) });
    for (let tries = 0; !(await ledger.list(B)).length; tries++) { assert.ok(tries < 400, "B recorded"); await new Promise(resolve => setTimeout(resolve, 5)); }
    release.open(); await checking;
    assert.equal((await scheduling).status, "scheduled");
    // Memory and the file agree: A's retry went ahead (its heartbeat deleted, the next one made), B's recorded.
    const memory = JSON.parse(JSON.stringify(await ledger.list())) as Array<{ agentId: string }>;
    const disk = JSON.parse(await readFile(file, "utf8")) as { entries: Array<{ agentId: string }> };
    const byAgent = (entries: Array<{ agentId: string }>) => Object.fromEntries(entries.map(entry => [entry.agentId, entry]));
    assert.deepEqual(byAgent(disk.entries), byAgent(memory));
    const retried = (await ledger.list(A))[0]!;
    assert.deepEqual([retried.status, retried.attempt, retried.scheduleId !== null, host.deletes(a.scheduleId)], ["retrying", 2, true, 1]);
    // The user deletes A's retry in 计划; after a plugin reload it stays deleted, nothing woken or made.
    await host.service.delete(retried.scheduleId!);
    await ledger.close(); ledger = host.ledger(directory);
    const creates = host.creates();
    for (let at = base + 7 * MINUTE; at <= base + 15 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await ledger.list(A))[0]!.reason, runs, host.creates() - creates], ["canceled", "deleted", [], 0]);
  } finally { release.open(); fsp.rename = original; syncBuiltinESMExports(); await ledger.close(); }
}));

test("a retry's create whose answer was lost is found among this Agent's heartbeats made since this attempt began, never taken for the earlier attempt's the ledger still owes a delete (its delete failing): the check takes up the retry's own, which wakes the Agent once (codex-obs-resume-recheck12, recheck13-F2)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"), { logs: sessionLog(new Set()) });
  host.agents.get(A)!.persistence = { provider: "claude", sessionId: "session-a" };
  const runs: string[] = [];
  try {
    const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 2 * MINUTE) });
    // 00:02: A is busy; the run fails before its prompt and the heartbeat is done (completed).
    host.runner = async schedule => { throw new Error(`Agent ${schedule.target.agentId} already has an active run`); };
    host.now = base + 2 * MINUTE; await host.service.tick();
    // 00:03: the retry cannot delete it (kept to delete), and its own create's answer is lost.
    host.failDelete = id => id === first.scheduleId; host.loseCreate = 1;
    host.now = base + 3 * MINUTE; await ledger.check();
    const pending = (await ledger.list(A))[0]!;
    assert.deepEqual([pending.status, pending.reason, pending.attempt, pending.scheduleId, (await host.service.inspect(first.scheduleId!)).status], ["retrying", "busy", 2, null, "completed"]);
    // 00:04: two of A's made since the resume began; the earlier one, still owed a delete, is not it.
    host.runner = async schedule => { runs.push(schedule.target.agentId!); return { agentId: schedule.target.agentId!, output: "done" }; };
    host.now = base + 4 * MINUTE; await ledger.check();
    const retry = (await host.service.list()).find(schedule => schedule.target.agentId === A && schedule.status === "active")!;
    assert.deepEqual([(await ledger.list(A))[0]!.status, (await ledger.list(A))[0]!.scheduleId, (await ledger.list(A))[0]!.attempt], ["retrying", retry.id, 2]);
    // On to 00:15: woken once, by the retry; the earlier one deleted once deletes go through.
    host.failDelete = () => false;
    for (let at = base + 5 * MINUTE; at <= base + 15 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    assert.deepEqual([runs, (await ledger.list(A))[0]!.status, (await host.service.list()).filter(schedule => schedule.target.agentId === A).length], [[A], "delivered", 0]);
  } finally { await ledger.close(); }
}));

test("a retry's create that never reached the host is not taken for a heartbeat of the resume's own form the user made and ran by hand earlier in the resume: only one made since this attempt began counts (`attemptAt`, on disk before the create), so the retry is made again and wakes the Agent once, never shown delivered by that older run (codex-obs-resume-recheck13-F2)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"), { logs: sessionLog(new Set()) });
  host.agents.get(A)!.persistence = { provider: "claude", sessionId: "session-a" };
  const runs: string[] = [];
  try {
    await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 120 * MINUTE) });
    // 01:00: the user makes a one-off of the resume's own form for A and runs it by hand (立即运行).
    host.now = base + 60 * MINUTE;
    const older = await madeNow(host, A, base + 240 * MINUTE, "恢复后续跑 · 手动测试的旧任务");
    await host.service.runOnce(older.id);
    // 02:00: A is busy; the retry's create never reaches the host. Recorded before it went out, with its attempt's start.
    host.runner = async schedule => { throw new Error(`Agent ${schedule.target.agentId} already has an active run`); };
    host.beforeCreate = async () => { host.beforeCreate = async () => {}; throw new Error(UNREACHED); };
    host.now = base + 120 * MINUTE; await host.service.tick(); await ledger.check();
    const pending = (await ledger.list(A))[0]!;
    assert.deepEqual([pending.status, pending.scheduleId, pending.attempt, pending.wakeAt, pending.attemptAt], ["retrying", null, 2, iso(base + 130 * MINUTE), iso(base + 120 * MINUTE)]);
    // 02:01 on: the older one is not this attempt's. The retry is made two minutes before its wake and wakes A once.
    host.runner = async schedule => { runs.push(schedule.id); return { agentId: schedule.target.agentId!, output: "done" }; };
    for (let at = base + 121 * MINUTE; at <= base + 135 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    const final = (await ledger.list(A))[0]!;
    assert.deepEqual([final.status, final.attempt, final.scheduleId === older.id, final.deliveredAt, runs.length, runs.includes(older.id)], ["delivered", 2, false, iso(base + 130 * MINUTE), 1, false]);
  } finally { await ledger.close(); }
}));

test("a retry's create that never reached the host is not decided by the earlier attempt's heartbeat the user took over (changed in 计划 after its delete failed, so no longer owed one): it is no heartbeat of this attempt's, so the retry is made again and wakes the Agent once (codex-obs-resume-recheck13-F2)", async t => withHost(t, async (host, root) => {
  const ledger = host.ledger(join(root, "plugin"), { logs: sessionLog(new Set()) });
  host.agents.get(A)!.persistence = { provider: "claude", sessionId: "session-a" };
  const runs: string[] = [];
  try {
    const first = await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 120 * MINUTE) });
    // 02:00: A is busy; the retry cannot delete that heartbeat (kept to delete), and its own create never reaches the host.
    host.runner = async schedule => { throw new Error(`Agent ${schedule.target.agentId} already has an active run`); };
    host.failDelete = id => id === first.scheduleId;
    host.beforeCreate = async () => { host.beforeCreate = async () => {}; throw new Error(UNREACHED); };
    host.now = base + 120 * MINUTE; await host.service.tick(); await ledger.check();
    assert.deepEqual([(await ledger.list(A))[0]!.scheduleId, (await ledger.list(A))[0]!.attempt], [null, 2]);
    // The user takes the old one over in 计划: the next check lets go of it (no longer owed a delete), and it decides nothing.
    await host.service.update({ id: first.scheduleId, prompt: "用户自己的历史任务", name: "保留的旧任务" });
    const tried = host.deletes(first.scheduleId);
    host.runner = async schedule => { runs.push(schedule.id); return { agentId: schedule.target.agentId!, output: "done" }; };
    for (let at = base + 121 * MINUTE; at <= base + 135 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    const final = (await ledger.list(A))[0]!;
    assert.deepEqual([final.status, final.attempt, final.scheduleId === first.scheduleId, runs.length, (await host.service.inspect(first.scheduleId!)).prompt, host.deletes(first.scheduleId) - tried],
      ["delivered", 2, false, 1, "用户自己的历史任务", 0]);
  } finally { await ledger.close(); }
}));

test("a retry is recorded with its attempt's start before its create goes out (codex-obs-resume-recheck13-F2): the plugin going down while that create is out, its answer never heard, the next ledger reads the record from the file, finds the heartbeat the create made and wakes the Agent once", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin");
  const ledger = host.ledger(directory);
  let restarted: ResumeLedger | null = null;
  const runs: string[] = [];
  host.runner = async schedule => { runs.push(schedule.id); return { agentId: schedule.target.agentId!, output: "done" }; };
  const request = host.bridge.request, sent = gate(), stuck = gate();
  try {
    await ledger.schedule(host.paseo, { agentId: A, at: iso(base + 2 * MINUTE) });
    // From here the next create reaches the host, which makes it; its answer never comes back.
    let made: HostSchedule | null = null;
    host.bridge.request = async message => {
      if (message.type !== "schedule/create" || made) return request(message);
      const answer = await request(message) as { schedule: HostSchedule };
      made = answer.schedule; sent.open(); await stuck.wait; return answer;
    };
    // 00:06: the wake passed unrun; the retry deletes its heartbeat and sends its create. The plugin goes down meanwhile.
    host.now = base + 6 * MINUTE;
    const checking = ledger.check();
    await sent.wait;
    restarted = host.ledger(directory);
    const pending = (await restarted.list(A))[0]!;
    assert.deepEqual([pending.status, pending.scheduleId, pending.attempt, pending.attemptAt], ["retrying", null, 2, iso(base + 6 * MINUTE)]);
    host.now = base + 7 * MINUTE; await restarted.check();
    assert.equal((await restarted.list(A))[0]!.scheduleId, made!.id);
    for (let at = base + 8 * MINUTE; at <= base + 12 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await restarted.check(); }
    assert.deepEqual([(await restarted.list(A))[0]!.status, runs], ["delivered", [made!.id]]);
    // The first ledger is gone in truth; its answer let through only so it can be closed.
    stuck.open(); await checking;
  } finally { stuck.open(); host.bridge.request = request; await ledger.close(); await restarted?.close(); }
}));

test("a retry the live ledger (dcf049d) left to confirm, its record without attemptAt, takes no heartbeat it finds as its own once upgraded: one the user made and ran by hand meanwhile makes it 未能确认, never shown delivered by that run nor made again; with none it is made again two minutes before its wake and wakes the Agent once. A first attempt without one is still told by its request (codex-obs-resume-recheck14-F1)", async t => withHost(t, async (host, root) => {
  const directory = join(root, "plugin");
  const runs: Array<[string, string]> = [];
  host.runner = async schedule => { runs.push([schedule.target.agentId!, iso(host.now)]); return { agentId: schedule.target.agentId!, output: "done" }; };
  // 01:00: the user makes a one-off of the resume's own form for A and runs it by hand (Codex's legacyPendingManual).
  host.now = base + 60 * MINUTE;
  const older = await madeNow(host, A, base + 240 * MINUTE, "恢复后续跑 · 手动测试的旧任务");
  await host.service.runOnce(older.id);
  // 01:59: C's first create reaches the host, its answer lost.
  host.now = base + 119 * MINUTE;
  const landed = await madeNow(host, C, base + 125 * MINUTE);
  // 02:00: the file as the live ledger wrote it in Codex's run (no attemptAt, no rule, no list to delete): A's and B's retries to make
  // (A busy at 02:00, its earlier heartbeat deleted, the retry's create rejected; B the same). C's first attempt is recorded the same
  // way, without attemptAt.
  host.now = base + 120 * MINUTE;
  const record = (agentId: string, attempt: number, plannedAt: number, wakeAt: number, createdAt: number) => ({ agentId, scheduleId: null, stopAt: null,
    plannedAt: iso(plannedAt), wakeAt: iso(wakeAt), attempt, status: attempt > 1 ? "retrying" : "scheduled", reason: attempt > 1 ? "busy" : null, createdAt: iso(createdAt),
    updatedAt: iso(host.now), deliveredAt: null });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "resume-ledger.json"), JSON.stringify({ version: 1, entries: [record(A, 2, base + 120 * MINUTE, base + 130 * MINUTE, base),
    record(B, 2, base + 120 * MINUTE, base + 130 * MINUTE, base), record(C, 1, base + 125 * MINUTE, base + 125 * MINUTE, base + 119 * MINUTE)] }));
  // Upgraded. 02:01: A has a heartbeat of the resume's own form since the resume began, which may be the user's: 未能确认. B has none
  // yet and waits; C's first is told by its request and taken up.
  const ledger = host.ledger(directory);
  try {
    host.now = base + 121 * MINUTE; await ledger.check();
    const [a, b, c] = await Promise.all([A, B, C].map(async id => (await ledger.list(id))[0]!));
    assert.deepEqual([a.status, a.reason, a.scheduleId, a.deliveredAt], ["failed", "unsure", null, null]);
    assert.deepEqual([b.status, b.scheduleId, c.status, c.scheduleId], ["retrying", null, "scheduled", landed.id]);
    // On to 02:15: C woken once by its own, B once by the one made at 02:08; A by nothing of the ledger's, the user's one-off kept.
    for (let at = base + 122 * MINUTE; at <= base + 135 * MINUTE; at += MINUTE) { host.now = at; await host.service.tick(); await ledger.check(); }
    const final = await Promise.all([A, B, C].map(async id => { const entry = (await ledger.list(id))[0]!; return [entry.status, entry.reason, entry.deliveredAt]; }));
    assert.deepEqual(final, [["failed", "unsure", null], ["delivered", null, iso(base + 130 * MINUTE)], ["delivered", null, iso(base + 125 * MINUTE)]]);
    assert.deepEqual(runs, [[A, iso(base + 60 * MINUTE)], [C, iso(base + 125 * MINUTE)], [B, iso(base + 130 * MINUTE)]]);
    assert.deepEqual([host.creates(), host.deletes(older.id), (await host.service.list()).some(schedule => schedule.id === older.id)], [1, 0, true]);
  } finally { await ledger.close(); }
}));
