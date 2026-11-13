import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createChainStore } from "../server/chain-store";
import { registerHistoryTool } from "../server/history-tool";
import { quotaNotice, turnLimit, turnTrouble } from "../server/limit-notice";
import { createOperations } from "../server/operations";
import type { Chain } from "../shared/model";
import { LABEL_CHAIN, TOOL_NAME } from "../shared/plugin-id";
import { DEFAULT_SETTINGS } from "../shared/settings";
import { stubSettings } from "../client/settings-read";
import { createContext, createFake, scratchDir } from "./harness";

const chain = (id: string, updatedAt: string, agentIds: string[] = []): Chain => ({
  v: 1,
  id,
  workspaceId: "ws",
  cwd: "/w",
  title: null,
  createdAt: updatedAt,
  updatedAt,
  deliveries: [],
  visits: agentIds.map((agentId, index) => ({
    n: index + 1,
    agentId,
    provider: "p",
    model: null,
    sessionId: null,
    storeKey: null,
    family: "other",
    openedBy: index ? "handoff" : "origin",
    deliveryId: null,
    start: null,
    openedAt: updatedAt,
    closedAt: updatedAt,
    end: null,
    firstItem: null,
    itemCount: 0,
  })),
});

describe("the chain store", () => {
  it("writes privately and indexes agents from the files at start", async () => {
    const dir = scratchDir("store-");
    const store = createChainStore(dir);
    await store.write(chain("c1", "2026-11-01T00:00:00Z", ["a1", "a2"]));
    await store.writeSnapshot("c1", 1, [{ n: 1, visit: 1, provider: "p", role: "user", kind: "message", priority: 1, text: "hi" }]);
    expect(statSync(join(dir, "chains")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "chains", "c1.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "transcripts", "c1", "1.jsonl")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "chains")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    const fresh = createChainStore(dir);
    await fresh.ready();
    expect(fresh.chainOf("a2")).toBe("c1");
    expect(await fresh.readSnapshot("c1", 1)).toMatchObject([{ n: 1, text: "hi" }]);
  });

  it("sets a damaged chain file aside and carries on", async () => {
    const dir = scratchDir("store-");
    mkdirSync(join(dir, "chains"), { recursive: true });
    writeFileSync(join(dir, "chains", "bad.json"), "{ not json");
    const store = createChainStore(dir);
    await store.ready();
    expect(await store.read("bad")).toBeNull();
    expect(readdirSync(join(dir, "chains")).some((name) => name.startsWith("bad.json.corrupt-"))).toBe(true);
  });

  it("refuses ids that could leave its folder", async () => {
    const store = createChainStore(scratchDir("store-"));
    await expect(store.read("../../etc/passwd")).rejects.toThrow();
    expect(() => store.recordPath("c1", "../x")).toThrow();
    expect(await store.readSent("c1", "../x")).toBeNull();
  });

  it("forgets old chains and everything that belongs to them", async () => {
    const dir = scratchDir("store-");
    const store = createChainStore(dir);
    await store.write(chain("old", "2026-09-01T00:00:00Z", ["a1"]));
    await store.write(chain("new", "2026-11-08T00:00:00Z", ["a2"]));
    await store.writeRecord("old", "d1", "record");
    await store.writeSent("old", "d1", "sent");
    expect(await store.sweep(30, Date.parse("2026-11-09T00:00:00Z"))).toBe(1);
    expect(store.chainOf("a1")).toBeNull();
    expect(store.chainOf("a2")).toBe("new");
    expect(await store.readRecord("old", "d1")).toBeNull();
    expect(await store.readSent("old", "d1")).toBeNull();
    expect(await store.forget("all")).toBe(1);
    expect(store.chainOf("a2")).toBeNull();
  });

  it("forgets everything at once, set-aside and orphaned files included", async () => {
    const dir = scratchDir("store-");
    mkdirSync(join(dir, "chains"), { recursive: true });
    writeFileSync(join(dir, "chains", "bad.json.corrupt-1"), "{ not json");
    const store = createChainStore(dir);
    await store.write(chain("c1", "2026-11-08T00:00:00Z", ["a1"]));
    await store.writeSnapshot("orphan", 1, []);
    await store.writeSent("orphan", "d1", "sent");
    expect(await store.forget("all")).toBe(1);
    for (const part of ["chains", "transcripts", "records", "sent"]) expect(existsSync(join(dir, part)), part).toBe(false);
    expect(store.chainOf("a1")).toBeNull();
  });

  it("sweeps what no chain owns once it is old", async () => {
    const dir = scratchDir("store-");
    const store = createChainStore(dir);
    await store.write(chain("kept", "2026-11-08T00:00:00Z", ["a1"]));
    await store.writeSnapshot("kept", 1, []);
    await store.writeSnapshot("orphan", 1, []);
    await store.writeSent("young", "d1", "x");
    writeFileSync(join(dir, "chains", "bad.json.corrupt-1"), "{");
    const old = new Date("2026-09-01T00:00:00Z");
    for (const path of [join(dir, "transcripts", "orphan"), join(dir, "transcripts", "kept"), join(dir, "chains", "bad.json.corrupt-1")]) utimesSync(path, old, old);
    await store.sweep(30, Date.parse("2026-11-09T00:00:00Z"));
    expect(existsSync(join(dir, "transcripts", "orphan"))).toBe(false);
    expect(existsSync(join(dir, "chains", "bad.json.corrupt-1"))).toBe(false);
    expect(existsSync(join(dir, "transcripts", "kept"))).toBe(true);
    expect(existsSync(join(dir, "sent", "young"))).toBe(true);
  });

  it("runs work on one chain one at a time", async () => {
    const store = createChainStore(scratchDir("store-"));
    const order: string[] = [];
    const slow = store.withLock("c", async () => {
      order.push("a start");
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("a end");
    });
    const fast = store.withLock("c", async () => {
      order.push("b");
    });
    await Promise.all([slow, fast]);
    expect(order).toEqual(["a start", "a end", "b"]);
  });
});

describe("operations", () => {
  it("answer pending, join a repeated request and refuse a second move from the same agent", async () => {
    let id = 0;
    const operations = createOperations(() => `op-${++id}`);
    let finish!: () => void;
    const first = operations.start({ requestId: "r1", agentId: "a" }, (phase) => {
      phase("creating");
      return new Promise((resolve) => {
        finish = () => resolve({ status: "refused", reason: { code: "x" } });
      });
    });
    if (first === "busy") throw new Error("busy");
    expect(await operations.answer(first, 5)).toEqual({ status: "pending", opId: "op-1", phase: "creating" });
    expect(operations.start({ requestId: "r1", agentId: "a" }, async () => ({ status: "refused", reason: { code: "y" } }))).toBe(first);
    expect(operations.start({ requestId: "r2", agentId: "a" }, async () => ({ status: "refused", reason: { code: "y" } }))).toBe("busy");
    finish();
    expect(await operations.answer(first, 1000)).toEqual({ status: "refused", reason: { code: "x" } });
    expect(operations.start({ requestId: "r3", agentId: "a" }, async () => ({ status: "refused", reason: { code: "z" } }))).not.toBe("busy");
  });

  it("turn an unexpected error into an answer", async () => {
    const operations = createOperations(() => "op");
    const operation = operations.start({ requestId: "r", agentId: "a" }, async () => {
      throw new Error("boom");
    });
    if (operation === "busy") throw new Error("busy");
    expect(await operations.answer(operation, 1000)).toEqual({ status: "refused", reason: { code: "errors.unexpected", params: { error: "boom" } } });
  });
});

describe("limit notices", () => {
  const now = Date.parse("2026-11-09T10:00:00Z");
  const turn = (...texts: string[]) => [{ type: "user_message", text: "go" }, ...texts.map((text) => ({ type: "assistant_message", text }))];

  it("recognise a completed turn whose reply is the provider's limit", () => {
    expect(turnLimit({ outcome: "completed", items: turn("You've hit your limit · resets 3pm (UTC)"), now, zone: "UTC" })).toMatchObject({ kind: "limit", resetAt: "2026-11-09T15:00:00.000Z" });
    expect(turnLimit({ outcome: "completed", items: turn("You've hit your usage limit. Try again in 2 hours."), now })).toMatchObject({ kind: "limit", resetAt: "2026-11-09T12:00:00.000Z" });
    expect(turnLimit({ outcome: "completed", items: turn("5-hour limit reached ∙ resets 11pm"), now, zone: "UTC" })).toMatchObject({ kind: "limit", resetGuessed: true });
  });

  it("leave ordinary replies about rate limits alone", () => {
    expect(turnLimit({ outcome: "completed", items: turn("Rate limit exceeded errors are now caught and retried with backoff; added tests."), now })).toBeNull();
    expect(turnLimit({ outcome: "completed", items: turn("I added a usage limit check to the API."), now })).toBeNull();
    expect(quotaNotice("超出配额时现在会自动降级", "reply", now)).toBeNull();
  });

  it("read a provider error printed as the reply", () => {
    const quota = "API Error: Request rejected (429) · Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 121h43m38s.";
    expect(turnLimit({ outcome: "completed", items: turn(quota), now })).toMatchObject({ kind: "limit" });
    expect(turnTrouble({ items: turn("API Error: Connection error."), now })).toMatchObject({ kind: "connection", resetAt: null });
    expect(turnTrouble({ items: turn("API Error: 500 Internal server error"), now })).toMatchObject({ kind: "error" });
    expect(turnTrouble({ items: turn("[System Error] unknown provider for model gpt-x"), now })).toMatchObject({ kind: "error" });
    // An answer that quotes an API error is an answer.
    expect(turnTrouble({ items: turn("The log shows API Error: 500 twice; I added a retry."), now })).toBeNull();
    expect(turnTrouble({ items: turn("All done."), now })).toBeNull();
  });

  it("read failures, and tell a full context from a limit", () => {
    expect(turnLimit({ outcome: "failed", error: "429 Too Many Requests", items: [], now })).toMatchObject({ kind: "limit" });
    expect(turnLimit({ outcome: "failed", error: "prompt is too long: 250000 tokens > 200000 maximum", items: [], now })).toMatchObject({ kind: "context" });
    expect(turnLimit({ outcome: "failed", error: "segfault", items: [], now })).toBeNull();
    expect(turnLimit({ outcome: "canceled", items: turn("You've hit your limit"), now })).toBeNull();
  });
});

describe("the history tool's hook", () => {
  it("gives the tool only to interactive sessions of agents in a chain, once", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    await ctx.store.write(chain("c1", "2026-11-08T00:00:00Z", ["member"]));
    let hook!: (input: { request: { agentId: string; purpose: string; labels: Record<string, string>; tools: { name: string }[] } }) => Promise<unknown>;
    const server = { before: (_name: string, handler: typeof hook) => ((hook = handler), () => undefined) } as never;
    let settings = DEFAULT_SETTINGS;
    registerHistoryTool(server, ctx, () => settings);
    const open = async (agentId: string, purpose = "interactive", labels: Record<string, string> = {}, tools: { name: string }[] = []) => {
      const request = { agentId, purpose, labels, tools };
      await hook({ request });
      return request.tools.map((tool) => tool.name);
    };
    expect(await open("member")).toEqual([TOOL_NAME]);
    expect(await open("member", "history")).toEqual([]);
    expect(await open("stranger")).toEqual([]);
    expect(await open("labelled", "interactive", { [LABEL_CHAIN]: "c9" })).toEqual([TOOL_NAME]);
    ctx.pending.set("being-created", "c1");
    expect(await open("being-created")).toEqual([TOOL_NAME]);
    expect(await open("member", "interactive", {}, [{ name: TOOL_NAME }])).toEqual([TOOL_NAME]);
    settings = { ...DEFAULT_SETTINGS, historyTool: false };
    expect(await open("member")).toEqual([]);
  });
});

describe("the resident client's helpers", () => {
  it("read the settings they need without the schema", () => {
    expect(stubSettings({ failurePill: false, partners: [{ from: "a", to: "b" }, { from: 1 }], slashAlias: "switch" })).toEqual({ composerButton: true, failurePill: false, partners: [{ from: "a", to: "b" }], slashAlias: "switch" });
    expect(stubSettings({ composerButton: false })).toMatchObject({ composerButton: false, failurePill: true });
    expect(stubSettings(null)).toEqual({ composerButton: true, failurePill: true, partners: [], slashAlias: "" });
    expect(stubSettings({ slashAlias: "Bad Alias" }).slashAlias).toBe("");
  });

  it("keep chain files readable as JSON", async () => {
    const dir = scratchDir("store-");
    const store = createChainStore(dir);
    await store.write(chain("c2", "2026-11-08T00:00:00Z", ["x"]));
    expect(JSON.parse(readFileSync(join(dir, "chains", "c2.json"), "utf8")).id).toBe("c2");
  });
});
