import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPANSION } from "../shared/settings";
import { TURN_TIME_RENDERER_KIND } from "../shared/turn-time";
import { TurnTimePublisher } from "./turn-time";

type Appended = { agentId: string; item: { id: string; kind: string; data: { at: number; turnId: string | null; outcome: string } } };

function values(turnTime: boolean) {
  return { takeover: "all" as const, palette: "vivid" as const, expansion: DEFAULT_EXPANSION, fold: true, density: "compact" as const, turnTime };
}

function harness(turnTime: boolean) {
  const appended: Appended[] = [];
  const settings = {
    read: async () => ({ status: "ready" as const, revision: "r", values: values(turnTime) }),
    subscribe: () => () => undefined,
  };
  const paseo = {
    agents: {
      ref: (agentId: string) => ({
        timeline: {
          append: async (item: Appended["item"]) => {
            appended.push({ agentId, item });
            return { seq: appended.length, epoch: "e" };
          },
        },
      }),
    },
  };
  return { appended, settings, paseo };
}

function ended(turnId: string | null = "t1", kind: "completed" | "failed" | "canceled" = "completed"): PluginLifecycleEvents["agent.turn_ended"] {
  const outcome =
    kind === "failed"
      ? ({ kind: "failed", error: { message: "boom" } } as const)
      : kind === "canceled"
        ? ({ kind: "canceled", reason: "stopped" } as const)
        : ({ kind: "completed" } as const);
  return {
    agent: { id: "a1", workspaceId: null, parentAgentId: null, provider: "codex", cwd: "/tmp", title: null },
    turnId,
    outcome,
    timeline: [],
  };
}

describe("TurnTimePublisher", () => {
  it("appends one row at the end of a finished turn", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended(), { paseo } as never);

    expect(appended).toHaveLength(1);
    expect(appended[0]!.agentId).toBe("a1");
    expect(appended[0]!.item.kind).toBe(TURN_TIME_RENDERER_KIND);
    expect(appended[0]!.item.data.outcome).toBe("completed");
    expect(appended[0]!.item.data.turnId).toBe("t1");
    expect(appended[0]!.item.data.at).toBeGreaterThan(0);
  });

  it("writes one row per turn", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended("t1"), { paseo } as never);
    await publisher.finish(ended("t2"), { paseo } as never);

    expect(appended).toHaveLength(2);
    expect(appended.map((entry) => entry.item.data.turnId)).toEqual(["t1", "t2"]);
    expect(new Set(appended.map((entry) => entry.item.id)).size).toBe(2);
  });

  it("carries the failure outcome", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended("t1", "failed"), { paseo } as never);

    expect(appended[0]!.item.data.outcome).toBe("failed");
  });

  it("writes nothing when the setting is off", async () => {
    const { appended, settings, paseo } = harness(false);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended(), { paseo } as never);

    expect(appended).toEqual([]);
  });

  it("keeps a readable id for a turn without a turn id", async () => {
    const { appended, settings, paseo } = harness(true);
    const publisher = new TurnTimePublisher(settings as never);
    publisher.start();
    await Promise.resolve();

    await publisher.finish(ended(null), { paseo } as never);

    expect(appended).toHaveLength(1);
    expect(appended[0]!.item.id).toBe("turn-end");
  });
});
