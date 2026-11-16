import { afterEach, describe, expect, it, vi } from "vitest";
// These behavioral suites bind Chinese in setup; locale I/O and settings are covered by i18n.test.ts.
vi.mock("../server/i18n-server", () => ({ createLocaleService: () => ({ dispose() {}, ready: Promise.resolve() }) }));

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The client type the plugin hands these helpers (PluginPaseoApi from Paseo 0.16, PaseoApi before).
import type { PaseoApi } from "../client/paseo-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { notesDeferred } from "../shared/composer";
import { deferredBadge, type DeferredView } from "../shared/deferred-rpc";
import { checkPromptSend, promptSource, serverCheck } from "../client/composer-send";
import { DEFERRED_POLL_MS, OUTCOME_SHOWN_MS, deferredPollInterval, onItsWayLabel, promptKey, promptRecord, visibleDeferred } from "../client/deferred-state";
import { DeferredSend } from "../server/deferred-send";

// 「等这一轮结束再发」 and sending now in the prompt picker: when waiting is offered, what is drawn, and the server's ledger.

const view = (patch: Partial<DeferredView>): DeferredView => ({ messageId: "m-1", agentId: "agent-1", key: "k-1", source: "手记 #3f1c2d4e 提示词", preview: "来源：手记", createdAt: 1, at: 1, state: "queued", note: "已排队", ...patch });

/** A daemon with one agent; `send` records what arrives as its user message and can lose its answer after that. */
function target(provider: string, status = "running", permissions: { id: string }[] = []) {
  const agent = { id: "agent-1", provider, status, pendingPermissions: permissions, activeTurn: status === "running" ? { turnId: "turn-1" } : null, archivedAt: null as string | null, lastUserMessageAt: "2026-10-12T09:00:00.000Z" };
  const sent: unknown[][] = [];
  const users: string[] = [];
  const losing = { count: 0 };
  const paseo = { agents: { ref: () => ({
    refresh: async () => ({ agent: { ...agent } }),
    send: async (...args: unknown[]) => {
      sent.push(args); users.push((args[1] as { messageId: string }).messageId);
      if (losing.count > 0) { losing.count--; throw new Error("agent_request_outcome_unknown"); }
    },
    timeline: { refetch: async () => ({ entries: users.map(clientMessageId => ({ item: { type: "user_message", clientMessageId } })) }) },
  }) } };
  return { agent, sent, users, losing, paseo: paseo as unknown as PaseoApi };
}
const capabilities = { steerableProviders: [] as string[], slashSteerableProviders: [] as string[] };

describe("the offer next to a confirmation", () => {
  it("is made only when the send would interrupt the turn or cancel an approval", async () => {
    const running = target("example-provider");
    expect((await checkPromptSend(running.paseo, "agent-1", "提示词", capabilities)).offer?.label).toBe("等这一轮结束再发");
    const approval = target("codex", "running", [{ id: "permission-1" }]);
    expect((await checkPromptSend(approval.paseo, "agent-1", "提示词", capabilities)).offer?.label).toBe("等审批处理完再发");
    const steering = target("codex");
    expect((await checkPromptSend(steering.paseo, "agent-1", "提示词", capabilities)).offer).toBeNull();
    const idle = target("example-provider", "idle");
    expect((await checkPromptSend(idle.paseo, "agent-1", "提示词", capabilities)).offer).toBeNull();
  });
  it("judges commands into a custom id by the base the server reports", async () => {
    const custom = target("custom-assistant");
    const reported = { steerableProviders: ["custom-assistant"], slashSteerableProviders: [], bases: { "custom-assistant": "codex" } };
    // Codex runs /compact beside the turn: sent at once, nothing to wait for; other commands replace the turn.
    expect((await checkPromptSend(custom.paseo, "agent-1", "/compact", reported)).plan.kind).toBe("send");
    const review = await checkPromptSend(custom.paseo, "agent-1", "/review", reported);
    expect(review.plan.kind).toBe("confirm");
    expect(review.offer?.label).toBe("等这一轮结束再发");
  });
  it("is made next to the server's confirmation too, naming the approval it would cancel", () => {
    const check = serverCheck({ text: "提示词", messageId: "message-0007" }, { status: "confirm", plan: { label: "仍然发送", note: "n", confirm: "Agent 正在等你审批。仍然发送吗？" }, consent: { interrupt: false, approvals: ["permission-9"] } });
    expect(check).toMatchObject({ text: "提示词", messageId: "message-0007", plan: { kind: "confirm", label: "仍然发送" }, consent: { interrupt: false, approvals: ["permission-9"] }, offer: { label: "等审批处理完再发" } });
  });
  it("names the queued prompt by its title, cut well inside the queue's limit", () => {
    expect(promptSource("复核改动")).toBe("提示词「复核改动」");
    expect(promptSource("  多行\n标题  ")).toBe("提示词「多行 标题」");
    expect(promptSource("")).toBe("提示词");
    const long = promptSource("长".repeat(300));
    expect(Array.from(long)).toHaveLength(66);
    expect(long.endsWith("…」")).toBe(true);
  });
});

describe("one delivery of a prompt at a time (review F4, F5)", () => {
  it("finds a prompt's record by its key for this agent: on its way first, else the newest outcome", () => {
    const key = promptKey("来源：手记 #1\n评审");
    const views = [
      view({ messageId: "a", key, state: "canceled", at: 5 }),
      view({ messageId: "b", key, state: "held", at: 2 }),
      view({ messageId: "c", key: promptKey("另一条"), state: "queued", at: 9 }),
      view({ messageId: "d", key, agentId: "agent-2", state: "queued", at: 9 }),
    ];
    expect(promptRecord(views, "agent-1", key)?.state).toBe("held");
    expect(promptRecord(views.slice(0, 1), "agent-1", key)?.state).toBe("canceled");
    expect(promptRecord([view({ messageId: "e", key, state: "sending" }), ...views], "agent-1", key)?.state).toBe("sending");
    expect(promptRecord(views, "agent-2", key)?.messageId).toBe("d");
    expect(promptRecord(views, "agent-1", promptKey("没排过"))).toBeNull();
    expect(promptRecord(undefined, "agent-1", key)).toBeNull();
    expect(onItsWayLabel({ state: "held" })).toBe("在等你确认");
  });
  it("keeps the keys of the first release, so prompts queued before still lock their preview", () => {
    expect(promptKey("来源：手记 #n1\n周报")).toBe("5waoznlinl");
  });
});

describe("what the picker draws", () => {
  it("keeps prompts on their way, shows outcomes for a while, and polls only while one is on its way in front", () => {
    const seen = new Map<string, number>();
    const views = [view({ messageId: "q" }), view({ messageId: "h", state: "held" }), view({ messageId: "g", state: "sending" }), view({ messageId: "s", state: "sent" }), view({ messageId: "u", state: "maybe-sent" }), view({ messageId: "d", state: "discarded" }), view({ messageId: "e", state: "expired" })];
    expect(visibleDeferred(views, 10_000, seen).views.map(entry => entry.messageId)).toEqual(["q", "h", "g", "s", "u", "d", "e"]);
    expect(visibleDeferred(views, 10_000 + OUTCOME_SHOWN_MS.sent + 1, seen).views.map(entry => entry.messageId)).toEqual(["q", "h", "g", "u", "d", "e"]);
    expect(visibleDeferred(views, 10_000 + OUTCOME_SHOWN_MS.expired + 1, seen)).toEqual({ views: [views[0], views[1], views[2]], until: null });
    expect(deferredPollInterval(views, true)).toBe(DEFERRED_POLL_MS);
    expect(deferredPollInterval(views, false)).toBe(false);
    expect(deferredPollInterval([view({ state: "sending" })], true)).toBe(DEFERRED_POLL_MS);
    expect(deferredPollInterval([view({ state: "sent" })], true)).toBe(false);
  });
  it("names sending and the four outcomes in the suite's state colours", () => {
    expect(["sending", "sent", "maybe-sent", "discarded", "expired"].map(state => deferredBadge({ state: state as DeferredView["state"] }))).toEqual([
      { label: "发送中", tone: "warning" }, { label: "已送达", tone: "success" }, { label: "可能已送达", tone: "warning" }, { label: "未发送", tone: "danger" }, { label: "已过期", tone: "danger" },
    ]);
  });
});

describe("project-notes.deferred RPCs", () => {
  const homes: string[] = [];
  afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
  async function plugin(existing?: string) {
    const home = existing ?? await mkdtemp(join(tmpdir(), "notes-deferred-")); if (!existing) homes.push(home);
    vi.stubEnv("PASEO_HOME", home);
    const handlers = new Map<string, (input: unknown, context: unknown) => Promise<unknown>>();
    const cleanup = contribute({ handle: (contract: { name: string }, handler: never) => handlers.set(contract.name, handler) } as unknown as PluginServerContext);
    return { home, call: (contract: { name: string }, input: unknown, paseo: unknown) => handlers.get(contract.name)!(input, { paseo }), cleanup };
  }
  it("every one hands the queue the daemon API, and a queued prompt waits in the plugin's own file under the client's id", async () => {
    const use = vi.spyOn(DeferredSend.prototype, "use");
    const { home, call, cleanup } = await plugin();
    const a = target("example-provider");
    for (const [contract, input] of [
      [notesDeferred.send, { agentId: "agent-1", text: "来源：手记 #1\n其他", messageId: "message-0009", what: "提示词" }],
      [notesDeferred.enqueue, { agentId: "agent-1", text: "来源：手记 #1\n评审", messageId: "message-0001", source: "手记 #3f1c2d4e 提示词" }],
      [notesDeferred.list, { agentId: "agent-1" }],
      [notesDeferred.resume, { messageId: "message-0001" }],
      [notesDeferred.cancel, { messageId: "message-0001" }],
    ] as const) {
      use.mockClear();
      await call(contract, input, a.paseo);
      expect(use, contract.name).toHaveBeenCalledWith(a.paseo);
    }
    const file = JSON.parse(await readFile(join(home, "plugin-data", "project-notes", "deferred-send.json"), "utf8")) as { receipts: { messageId: string; state: string; source: string }[] };
    expect(file.receipts.map(({ messageId, state, source }) => ({ messageId, state, source }))).toEqual([{ messageId: "message-0001", state: "canceled", source: "手记 #3f1c2d4e 提示词" }]);
    expect(a.sent).toEqual([]);
    await cleanup();
  });
  it("sends the queued prompt with its id once the turn ends", async () => {
    const use = vi.spyOn(DeferredSend.prototype, "use");
    const { call, cleanup } = await plugin();
    const a = target("example-provider");
    expect(await call(notesDeferred.enqueue, { agentId: "agent-1", text: "提示词", messageId: "message-0002" }, a.paseo)).toMatchObject({ state: "queued" });
    Object.assign(a.agent, { status: "idle", activeTurn: null });
    await (use.mock.instances[0] as DeferredSend).flush();
    expect(a.sent).toEqual([["提示词", { activeTurnBehavior: "steer", messageId: "message-0002" }]]);
    expect(await call(notesDeferred.list, { agentId: "agent-1" }, a.paseo)).toMatchObject([{ messageId: "message-0002", state: "sent" }]);
    await cleanup();
  });

  describe("send now: the server plans again from the agent as it is", () => {
    const send = (call: Awaited<ReturnType<typeof plugin>>["call"], a: ReturnType<typeof target>, input: Record<string, unknown>) =>
      call(notesDeferred.send, { agentId: "agent-1", text: "来源：手记 #1\n评审", key: promptKey("来源：手记 #1\n评审"), source: "提示词「评审」", what: "提示词", ...input }, a.paseo) as Promise<{ status: string; consent?: unknown; view?: { messageId: string; state: string; note: string } }>;

    it("confirm round trip: interrupting needs the user's OK, and the same id with the returned consent goes out once", async () => {
      const { call, cleanup } = await plugin();
      const a = target("example-provider");
      const asked = await send(call, a, { messageId: "message-0101", consent: null });
      expect(asked).toMatchObject({ status: "confirm", consent: { interrupt: true, approvals: [] } });
      expect(a.sent).toEqual([]);
      expect(await send(call, a, { messageId: "message-0101", consent: asked.consent })).toMatchObject({ status: "sent", view: { messageId: "message-0101" } });
      expect(a.sent).toEqual([["来源：手记 #1\n评审", { activeTurnBehavior: "interrupt", messageId: "message-0101" }]]);
      await cleanup();
    });

    it("binds a confirmation to the approvals it named: one that replaced them is asked again (R1)", async () => {
      const { call, cleanup } = await plugin();
      const a = target("codex", "running", [{ id: "permission-1" }]);
      const check = await checkPromptSend(a.paseo, "agent-1", "来源：手记 #1\n评审", capabilities);
      a.agent.pendingPermissions = [{ id: "permission-2" }];
      const asked = await send(call, a, { messageId: check.messageId, consent: check.consent });
      expect(asked).toMatchObject({ status: "confirm", consent: { interrupt: false, approvals: ["permission-2"] } });
      expect(a.sent).toEqual([]);
      await cleanup();
    });

    it("existing: a prompt on its way from another picker answers a send under its own id", async () => {
      const { call, cleanup } = await plugin();
      const a = target("example-provider");
      await call(notesDeferred.enqueue, { agentId: "agent-1", text: "来源：手记 #1\n评审", messageId: "message-0102", key: promptKey("来源：手记 #1\n评审") }, a.paseo);
      expect(await send(call, a, { messageId: "message-0103", consent: { interrupt: true, approvals: [] } })).toMatchObject({ status: "existing", view: { messageId: "message-0102", state: "queued" } });
      expect(a.sent).toEqual([]);
      await cleanup();
    });

    it("a send whose answer was lost is held, still held when the plugin opens again, and 仍然发送 finds it instead of sending twice", async () => {
      const first = await plugin();
      const a = target("example-provider", "idle");
      a.losing.count = 1;
      expect(await send(first.call, a, { messageId: "message-0104" })).toMatchObject({ status: "held", view: { state: "held", note: expect.stringContaining("仍然发送") } });
      await first.cleanup();
      const second = await plugin(first.home);
      expect(await second.call(notesDeferred.list, { agentId: "agent-1" }, a.paseo)).toMatchObject([{ messageId: "message-0104", state: "held" }]);
      expect(await second.call(notesDeferred.resume, { messageId: "message-0104" }, a.paseo)).toMatchObject({ state: "sent", note: expect.stringContaining("会话记录里找到") });
      expect(a.sent).toHaveLength(1);
      await second.cleanup();
    });

    it("plans a custom id by the daemon's provider config", async () => {
      const { home, call, cleanup } = await plugin();
      await writeFile(join(home, "config.json"), JSON.stringify({ agents: { providers: { "custom-assistant": { extends: "codex" } } } }));
      const a = target("custom-assistant");
      expect(await send(call, a, { messageId: "message-0105", consent: null })).toMatchObject({ status: "sent" });
      expect(a.sent).toEqual([["来源：手记 #1\n评审", { activeTurnBehavior: "steer", messageId: "message-0105" }]]);
      await cleanup();
    });
  });
});
