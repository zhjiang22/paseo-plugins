import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentDirectory, type AgentDirectoryApi, type AgentDirectoryListOptions, type AgentDirectorySubscription } from "../shared/directory-store";
import { AttentionIndex } from "../server/attention";
import { PreferencesStore } from "../server/preferences";
import { labelOf, SidebarLabels, type LabelHost } from "../server/sidebar-labels";
import { defaultViewPreferences, preferencesSnapshotSchema } from "../shared/preferences";

// 显示后台工作区 (issue 16): Paseo Bots 0.3 keeps every chat in a background workspace, which Paseo leaves out of its lists unless a
// request asks for `includeBackground`. The observatory asks only when the host setting is on.

const T = "2026-10-11T04:00:00.000Z", later = "2026-10-11T04:05:00.000Z";
interface DaemonAgent { id: string; workspaceId: string; status: string; updatedAt: string; title?: string; background?: boolean; archivedAt?: string | null;
  requiresAttention?: boolean; attentionReason?: string; attentionTimestamp?: string; lastUserMessageAt?: string; pendingPermissions?: unknown[]; labels?: Record<string, string> }
type Observer = Parameters<AgentDirectorySubscription["subscribe"]>[0];

/**
 * Paseo 0.16's discovery (`AgentDirectory.admits`, for a client with the background-agent capability): an Agent in a background
 * workspace, and a background agent (a helper), are listed only when the request asks for `includeBackground`; the live updates of
 * an observation follow the same rule.
 */
function fakeDaemon(agents: DaemonAgent[], backgroundWorkspaces: ReadonlySet<string>) {
  const filters: Array<AgentDirectoryListOptions["filter"]> = [], observations: Array<{ filter: AgentDirectoryListOptions["filter"]; observer: Observer | null }> = [];
  const admits = (agent: DaemonAgent, filter: AgentDirectoryListOptions["filter"]) => (filter.includeArchived || !agent.archivedAt)
    && (filter.includeBackground === true || !agent.background && !backgroundWorkspaces.has(agent.workspaceId));
  const api: Required<AgentDirectoryApi> = {
    async list(options) {
      filters.push(options.filter);
      const entries = agents.filter(agent => admits(agent, options.filter) && (!options.filter.requiresAttention || agent.requiresAttention === true)).map(agent => ({ agent: { ...agent } }));
      return { entries, pageInfo: { nextCursor: null, hasMore: false } };
    },
    async observe(options) {
      filters.push(options.filter);
      const observation: { filter: AgentDirectoryListOptions["filter"]; observer: Observer | null } = { filter: options.filter, observer: null };
      observations.push(observation);
      return { subscribe(next) { observation.observer = next; next.snapshot({ entries: [] }); return () => { observation.observer = null; }; }, async release() { observation.observer = null; } };
    },
  };
  const update = (agent: DaemonAgent) => {
    for (const { filter, observer } of observations) if (observer && admits(agent, filter)) observer.update({ type: "agent_update", payload: { kind: "upsert", agent: { ...agent } } });
  };
  // The plugin SDK's `agents.list`: `subscribe` makes it an observation.
  const paseo = {
    agents: {
      list: async (options: AgentDirectoryListOptions & { subscribe?: object }) => options.subscribe
        ? { entries: [], pageInfo: { nextCursor: null, hasMore: false }, subscription: await api.observe(options) } : api.list(options),
      ref: () => ({ timeline: { refetch: async () => ({ rows: [] }) } }),
    },
    observeEvents: () => ({ subscribe: () => () => {}, release: async () => {} }),
  };
  return { api, filters, update, paseo: paseo as never };
}

const unread = { status: "idle", requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-10-11T01:00:00.000Z", updatedAt: "2026-10-11T01:00:00.000Z", lastUserMessageAt: "2026-10-11T00:50:00.000Z" };
const desk: DaemonAgent = { id: "desk", workspaceId: "w-desk", title: "日常任务", ...unread };
const botChat: DaemonAgent = { id: "bot-chat", workspaceId: "w-bots", title: "Bot 的邮件摘要", labels: { "paseo-bots.bot": "mail" }, ...unread };
// A background agent waiting on a tool approval: if it were listed it would count as 待审批.
const helper: DaemonAgent = { id: "helper", workspaceId: "w-desk", title: "helper", background: true, status: "running", pendingPermissions: [{ id: "1", kind: "tool", name: "Bash" }], updatedAt: T };
const bots = new Set(["w-bots"]);
const ids = (store: ReturnType<typeof createAgentDirectory>) => store.getSnapshot().agents.map(agent => agent.id).sort();
const asksForBackground = (filter: AgentDirectoryListOptions["filter"]) => "includeBackground" in filter;

/** A started directory on the fake daemon, stopped whatever the test's outcome (a live store keeps a timer). */
async function withDirectory(api: AgentDirectoryApi, options: Parameters<typeof createAgentDirectory>[1], run: (store: ReturnType<typeof createAgentDirectory>) => Promise<void> | void) {
  const store = createAgentDirectory(api, { notifyDelayMs: 0, ...options });
  try { store.start(); await store.refresh(); await run(store); } finally { store.stop(); }
}

test("by default the directory asks exactly as before, so Agents in background workspaces stay out (issue 16)", async () => {
  const daemon = fakeDaemon([desk, botChat, helper], bots);
  await withDirectory(daemon.api, { includeArchived: false }, store => {
    assert.deepEqual(ids(store), ["desk"], "Paseo leaves the background workspace's chat out unless asked");
    assert.deepEqual(daemon.filters, [{ includeArchived: false }, { includeArchived: false, requiresAttention: true }, { includeArchived: false }]);
    daemon.update({ ...botChat, status: "running", updatedAt: later });
    assert.deepEqual(ids(store), ["desk"], "nor do its live updates reach the observation");
  });
});

test("with 显示后台工作区 on, the directory asks for background workspaces and lists their Agents, live updates included (issue 16)", async () => {
  const daemon = fakeDaemon([desk, botChat, helper], bots);
  await withDirectory(daemon.api, { includeArchived: false, backgroundWorkspaces: true }, store => {
    assert.deepEqual(ids(store), ["bot-chat", "desk"]);
    assert.ok(daemon.filters.length === 3 && daemon.filters.every(filter => filter.includeBackground === true && filter.includeArchived === false), "every read and the observation ask for them");
    daemon.update({ ...botChat, status: "running", updatedAt: later });
    assert.equal(store.getSnapshot().agents.find(agent => agent.id === "bot-chat")?.status, "running", "the observation carries the chat's updates");
  });
  const archive = fakeDaemon([{ ...botChat, archivedAt: T }], bots);
  await withDirectory(archive.api, { includeArchived: true, backgroundWorkspaces: true }, store => {
    assert.deepEqual(ids(store), ["bot-chat"], "the archive page lists archived background chats too");
    assert.ok(archive.filters.every(filter => filter.includeArchived && filter.includeBackground === true));
  });
});

test("a background agent (a Paseo 0.16 helper) is never listed, even when the request asks for background workspaces", async () => {
  const daemon = fakeDaemon([desk, helper], bots);
  await withDirectory(daemon.api, { includeArchived: false, backgroundWorkspaces: true }, store => {
    assert.ok(daemon.filters.every(filter => filter.includeBackground === true), "the host sends it, since the request asks for background");
    assert.deepEqual(ids(store), ["desk"], "the observatory leaves it out");
    daemon.update({ ...helper, updatedAt: later });
    assert.deepEqual(ids(store), ["desk"], "its live updates are ignored too");
  });
});

test("the sidebar badge counts background-workspace Agents only while the host setting is on, and follows a change (issue 16)", async () => {
  const daemon = fakeDaemon([desk, botChat, helper], bots);
  let backgroundWorkspaces: boolean | undefined;
  const index = new AttentionIndex({
    telemetry: async () => ({ startedAt: T, persistenceError: null, agents: [], events: [] }), background: () => [], isLive: () => false,
    receipts: async () => ({ receipts: [], archiveOrigins: [] }),
    preferences: async () => ({ snoozes: [], settings: { childCompletions: false, ...(backgroundWorkspaces === undefined ? {} : { backgroundWorkspaces }) } }),
  }, { now: () => Date.parse(T) });
  try {
    // Settings written before this one existed have no such key: off.
    await index.attach(daemon.paseo);
    const before = await index.read();
    assert.equal(before.mode === "full" && before.count, 1);
    assert.deepEqual(before.mode === "full" && before.entries.map(entry => entry.agentId), ["desk"]);
    assert.equal(daemon.filters.some(asksForBackground), false, "off: never asked for");

    backgroundWorkspaces = true;
    daemon.filters.length = 0;
    await index.attach(daemon.paseo);
    const shown = await index.read();
    assert.equal(shown.mode === "full" && shown.count, 2, "the bot chat's unread result counts, the helper's approval does not");
    assert.deepEqual(shown.mode === "full" && shown.entries.map(entry => entry.agentId).sort(), ["bot-chat", "desk"]);
    assert.ok(daemon.filters.length > 0 && daemon.filters.every(filter => filter.includeBackground === true), "the badge reads the background scope from the start");
    // The label sync gets the chat's workspace like any other; it decides itself what to do with a background one.
    const { phases } = await index.workspaces();
    assert.deepEqual([...phases.keys()].sort(), ["w-bots", "w-desk"]);

    backgroundWorkspaces = false;
    daemon.filters.length = 0;
    await index.attach(daemon.paseo);
    const after = await index.read();
    assert.equal(after.mode === "full" && after.count, 1, "turned off again, the chat leaves the badge");
    assert.equal(daemon.filters.some(asksForBackground), false);
  } finally { index.close(); }
});

test("显示后台工作区 is a host setting: off by default, kept apart from the subagent switch, and an older reply still parses", async () => {
  const directory = await mkdtemp(join(tmpdir(), "obs-background-settings-"));
  try {
    const store = new PreferencesStore({ directory, now: () => Date.parse(T) });
    const first = await store.get("overview");
    assert.equal(first.settings?.backgroundWorkspaces, false);
    await store.update({ viewKey: "overview", expectedRevision: first.revision, settings: { backgroundWorkspaces: true } });
    const second = await store.get("overview");
    await store.update({ viewKey: "overview", expectedRevision: second.revision, settings: { childCompletions: true } });
    assert.deepEqual((await store.attentionInputs()).settings, { childCompletions: true, backgroundWorkspaces: true }, "one switch never resets the other");
    await store.close();
    const reloaded = new PreferencesStore({ directory, now: () => Date.parse(T) });
    assert.deepEqual((await reloaded.attentionInputs()).settings, { childCompletions: true, backgroundWorkspaces: true }, "kept on disk");
    await reloaded.close();
    const older = preferencesSnapshotSchema.parse({ revision: 0, view: defaultViewPreferences(), savedViews: [], snoozes: [], error: null, settings: { childCompletions: false } });
    assert.equal(older.settings?.backgroundWorkspaces ?? false, false, "a server from before the setting answers without it: off");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("the sidebar label sync puts no label or pin on a background workspace", async () => {
  const calls: string[] = [];
  const workspaces: Record<string, { labels: string[]; pinnedAt: string | null; background?: boolean }> = { "w-desk": { labels: [], pinnedAt: null }, "w-bots": { labels: [], pinnedAt: null, background: true } };
  const host: LabelHost = {
    async workspace(id) { const workspace = workspaces[id]; return workspace ? { ...workspace, labels: [...workspace.labels] } : null; },
    async catalog() { return []; },
    async assign(workspaceId, label, assigned) { calls.push(`${assigned ? "+" : "-"}${workspaceId}:${label.name}`); if (assigned) workspaces[workspaceId]!.labels.push(label.name); },
    async pin(workspaceId, pinned) { calls.push(`${pinned ? "pin" : "unpin"}:${workspaceId}`); return workspaces[workspaceId]!.pinnedAt = pinned ? T : null; },
    async affected() { return 0; },
    async remove() {},
  };
  const directory = await mkdtemp(join(tmpdir(), "obs-background-labels-"));
  const labels = new SidebarLabels({ host: () => host, waiting: async () => ({ phases: new Map([["w-desk", "unread" as const], ["w-bots", "unread" as const]]), ready: true, known: true }),
    file: join(directory, "sidebar-labels.json"), delayMs: 3_600_000 });
  try {
    labels.configure({ labels: true, pin: true });
    await labels.pass();
    assert.deepEqual(calls, [`+w-desk:${labelOf("unread").name}`, "pin:w-desk"], "the ordinary workspace is labelled and pinned, the background one is left alone");
    assert.deepEqual(workspaces["w-bots"], { labels: [], pinnedAt: null, background: true });
  } finally { await labels.close(); await rm(directory, { recursive: true, force: true }); }
});
