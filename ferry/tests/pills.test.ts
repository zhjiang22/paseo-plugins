import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FIRST_DELAY_MS, NEW_AGENT_DELAY_MS, registerPills } from "../client/pills";

// A pretend app: composer buttons kept in the order they were added (as Paseo lists them), an agent observation the
// test drives, and Ferry's settings document.

interface Shown {
  agentId: string;
  button: { label?: string; title: string; behavior: Behavior };
}
type Behavior = { kind: "action"; onPress(): void } | { kind: "menu"; items: { kind: "item"; id: string; title: string; behavior: Behavior }[] };

function fakeApp(values: Record<string, unknown>) {
  const shown: Shown[] = [];
  const added: string[] = [];
  let observer: { snapshot(page: unknown): void; update(message: unknown): void } | null = null;
  const client = {
    addComposerPill(contribution: { agentId: string; button: Shown["button"] }) {
      const entry: Shown = { agentId: contribution.agentId, button: contribution.button };
      shown.push(entry);
      added.push(contribution.agentId);
      return {
        update(patch: Partial<Shown["button"]>) {
          entry.button = { ...entry.button, ...patch };
        },
        remove() {
          const index = shown.indexOf(entry);
          if (index >= 0) shown.splice(index, 1);
        },
      };
    },
    rpc: async () => ({ status: "ready", revision: "1", values }),
    paseo: {
      agents: {
        async list(options: { subscribe?: unknown }) {
          if (!options.subscribe) return { entries: [], pageInfo: { hasMore: false, nextCursor: null } };
          return {
            entries: [],
            pageInfo: { hasMore: false, nextCursor: null },
            subscription: {
              subscribe(next: typeof observer) {
                observer = next;
                return () => undefined;
              },
              release: async () => undefined,
            },
          };
        },
      },
    },
  };
  const opened: [string, string | null][] = [];
  const stop = registerPills(client as unknown as PluginClientContext, (agentId, target) => opened.push([agentId, target]), () => () => undefined);
  const agent = (id: string, extra: Record<string, unknown> = {}) => ({ id, provider: "claude-main", workspaceId: "ws-1", status: "idle", archivedAt: null, ...extra });
  return {
    shown,
    added,
    opened,
    stop,
    agent,
    /** The observation's first (or a later) snapshot. */
    async snapshot(agents: unknown[], hasMore = false) {
      await vi.waitFor(() => expect(observer).not.toBeNull());
      observer!.snapshot({ entries: agents.map((entry) => ({ agent: entry })), pageInfo: { hasMore, nextCursor: null } });
      await vi.advanceTimersByTimeAsync(0);
    },
    async upsert(entry: unknown) {
      observer!.update({ type: "agent_update", payload: { kind: "upsert", agent: entry } });
      await vi.advanceTimersByTimeAsync(0);
    },
    async remove(agentId: string) {
      observer!.update({ type: "agent_update", payload: { kind: "remove", agentId } });
      await vi.advanceTimersByTimeAsync(0);
    },
    of: (agentId: string) => shown.find((entry) => entry.agentId === agentId)?.button ?? null,
  };
}

/** Presses a button, or one item of its menu. */
const press = (behavior: Behavior, item?: string) => {
  const chosen = behavior.kind === "menu" ? behavior.items.find((entry) => entry.id === item)!.behavior : behavior;
  if (chosen.kind === "action") chosen.onPress();
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Ferry's composer button", () => {
  it("sits by every agent's composer, added a moment after the others so it lands to their right", async () => {
    const app = fakeApp({ partners: [{ from: "claude-main", to: "claude-alt" }] });
    await app.snapshot([app.agent("a"), app.agent("b", { provider: "codex-team" }), app.agent("c", { archivedAt: "2026-11-09T00:00:00Z" }), app.agent("d", { workspaceId: null })]);
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS - 100);
    expect(app.shown).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(app.shown.map((entry) => entry.agentId)).toEqual(["a", "b"]);
    // With a partner: a menu, the partner one step away; without one, the picker at once.
    const withPartner = app.of("a")!;
    expect(withPartner.label).toBe("摆渡");
    expect(withPartner.behavior.kind).toBe("menu");
    if (withPartner.behavior.kind === "menu") expect(withPartner.behavior.items.map((item) => item.title)).toEqual(["交给 claude-alt", "换一个…"]);
    press(withPartner.behavior, "partner");
    press(withPartner.behavior, "pick");
    press(app.of("b")!.behavior);
    expect(app.opened).toEqual([
      ["a", "claude-alt"],
      ["a", null],
      ["b", null],
    ]);
    app.stop();
    expect(app.shown).toEqual([]);
  });

  it("says what went wrong after a failed turn, in place, and goes back when the agent recovers", async () => {
    const app = fakeApp({ partners: [{ from: "claude-main", to: "claude-alt" }] });
    await app.snapshot([app.agent("a"), app.agent("b")]);
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
    await app.upsert(app.agent("a", { status: "error", lastError: "You've hit your limit · resets 3pm" }));
    // The same button, changed in place: still first, never added again.
    expect(app.shown.map((entry) => entry.agentId)).toEqual(["a", "b"]);
    expect(app.added).toEqual(["a", "b"]);
    const failed = app.of("a")!;
    expect(failed.label).toBe("额度用完 → claude-alt");
    press(failed.behavior);
    expect(app.opened).toEqual([["a", "claude-alt"]]);
    await app.upsert(app.agent("a"));
    expect(app.of("a")!.label).toBe("摆渡");
    expect(app.of("a")!.behavior.kind).toBe("menu");
  });

  it("follows new, removed and archived agents", async () => {
    const app = fakeApp({});
    await app.snapshot([app.agent("a"), app.agent("b")]);
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
    await app.upsert(app.agent("n"));
    expect(app.of("n")).toBeNull();
    await vi.advanceTimersByTimeAsync(NEW_AGENT_DELAY_MS);
    expect(app.of("n")).not.toBeNull();
    await app.remove("b");
    await app.upsert(app.agent("a", { archivedAt: "2026-11-10T00:00:00Z" }));
    expect(app.shown.map((entry) => entry.agentId)).toEqual(["n"]);
    // A reconnect snapshot that is only a first page keeps the agents it does not list.
    await app.snapshot([app.agent("x")], true);
    await vi.advanceTimersByTimeAsync(NEW_AGENT_DELAY_MS);
    expect(app.shown.map((entry) => entry.agentId).sort()).toEqual(["n", "x"]);
    // A complete one drops them.
    await app.snapshot([app.agent("x")]);
    expect(app.shown.map((entry) => entry.agentId)).toEqual(["x"]);
  });

  it("shows only after a failed turn when the always-on button is switched off", async () => {
    const app = fakeApp({ composerButton: false });
    await app.snapshot([app.agent("a"), app.agent("b", { status: "error", lastError: "connect ECONNREFUSED 192.0.2.1:7890" })]);
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
    expect(app.shown.map((entry) => [entry.agentId, entry.button.label])).toEqual([["b", "线路不通 · 换一个"]]);
    await app.upsert(app.agent("b"));
    expect(app.shown).toEqual([]);
  });

  it("shows nothing at all with both buttons switched off", async () => {
    const app = fakeApp({ composerButton: false, failurePill: false });
    await app.snapshot([app.agent("a"), app.agent("b", { status: "error", lastError: "boom" })]);
    await vi.advanceTimersByTimeAsync(FIRST_DELAY_MS);
    expect(app.shown).toEqual([]);
  });
});
