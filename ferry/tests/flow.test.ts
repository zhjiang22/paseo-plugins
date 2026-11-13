import { describe, expect, it } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { trackTurn } from "../server/delivery";
import { answerHistory } from "../server/history-tool";
import { createOperations } from "../server/operations";
import { describe as describeProviders, preview, retry, start } from "../server/service";
import { stripEnvelopes } from "../shared/envelope";
import { LABEL_CHAIN, ROW_HANDOFF, ROW_MOVED } from "../shared/plugin-id";
import type { StartOutput } from "../shared/rpc";
import { addAgent, assistant, createContext, createFake, createLink, say, shell, user, type Fake } from "./harness";

let request = 0;
const run = async (fake: Fake, ctx: ReturnType<typeof createContext>, input: { agentId: string; target?: string; message?: string; stopRunning?: boolean; fresh?: boolean }) => {
  const operations = createOperations(ctx.newId);
  let output: StartOutput = await start(fake.paseo, ctx, operations, { requestId: `request-${++request}`, ...input });
  while (output.status === "pending") output = await operations.answer(operations.get(output.opId)!, 25_000);
  return output;
};

function conversation(fake: Fake) {
  const source = addAgent(fake, { id: "agent-a", provider: "claude-main", model: "opus-9", currentModeId: "acceptEdits", thinkingOptionId: "high" });
  say(source, user("Fix the login bug"), assistant("Looking at the auth module."), shell("npm test", "1 failing: login refresh", 1), assistant("The token refresh was missing; fixed it."));
  return source;
}

describe("handoff to a new agent", () => {
  it("creates the agent, shows the row, sends the history, and only then archives the source", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const output = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    expect(output.status).toBe("done");
    if (output.status !== "done") return;
    const result = output.result;
    expect(result).toMatchObject({ route: "handoff", to: { provider: "codex-team", model: "gpt-big" }, archivedSource: true, selected: 4, total: 4 });
    const target = fake.agents.get(result.agentId)!;
    expect(fake.creates[0]).toMatchObject({ workspaceId: "ws-1", config: { provider: "codex-team/gpt-big", modeId: "auto", thinkingOptionId: "high" }, title: "Fix the login bug" });
    expect(target.labels?.[LABEL_CHAIN]).toBe(result.chainId);
    // Order: the new agent exists and has its row before the message; the source goes last.
    expect(fake.log.filter((entry) => !entry.startsWith("row"))).toEqual([`create ${result.agentId}`, `send ${result.agentId}`, "archive agent-a"]);
    expect(fake.log.indexOf(`row ${result.agentId} ${ROW_HANDOFF}`)).toBeLessThan(fake.log.indexOf(`send ${result.agentId}`));
    const sent = target.sends[0]!;
    expect(sent.text).toContain("接着上一个 Agent 停下的地方继续");
    expect(sent.attachments?.[0]).toMatchObject({ type: "text", mimeType: "text/plain", contextKind: "chat_history" });
    const envelope = sent.attachments![0]!.text;
    expect(envelope).toContain("Fix the login bug");
    expect(envelope).toContain("$ npm test");
    expect(envelope).toContain(`id="${result.deliveryId}"`);
    expect(envelope).toContain("ferry_read_history");
    // The row says it was sent; the chain file is private.
    const row = target.plugin.find((entry) => entry.kind === ROW_HANDOFF)!;
    expect(row.data).toMatchObject({ route: "handoff", status: "accepted", selected: 4, total: 4 });
    expect(statSync(join(ctx.dir, "chains", `${result.chainId}.json`)).mode & 0o777).toBe(0o600);
  });

  it("refuses a provider that is off, the same provider, or an unknown name, and touches nothing", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    for (const [target, code] of [
      ["claude", "errors.targetDisabled"],
      ["claude-main", "errors.sameProvider"],
      ["nobody", "errors.unknownTarget"],
    ] as const) {
      const output = await run(fake, ctx, { agentId: "agent-a", target });
      expect(output).toMatchObject({ status: "refused", reason: { code } });
    }
    expect(fake.creates).toEqual([]);
    expect(fake.agents.get("agent-a")!.archivedAt).toBeNull();
  });

  it("starts a new agent on the same provider only when another of its models is named", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { link: createLink(fake) });
    conversation(fake);
    expect(await run(fake, ctx, { agentId: "agent-a", target: "claude-main/opus-9" })).toMatchObject({ status: "refused", reason: { code: "errors.sameProvider" } });
    const output = await run(fake, ctx, { agentId: "agent-a", target: "claude-main/sonnet-9" });
    expect(output).toMatchObject({ status: "done", result: { route: "handoff", to: { provider: "claude-main", model: "sonnet-9" } } });
    if (output.status === "done") expect(output.result.notes.map((note) => note.code)).toEqual(["notes.sameProviderNew"]);
    expect(fake.creates[0]).toMatchObject({ config: { provider: "claude-main/sonnet-9", modeId: "acceptEdits", thinkingOptionId: "high" } });
  });

  it("keeps the thinking level of the source's model when the source never chose one", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    Object.assign(conversation(fake), { model: "sonnet-9", thinkingOptionId: null });
    const plan = await preview(fake.paseo, ctx, { agentId: "agent-a", target: "codex-team" });
    // sonnet-9 runs at "low" by default; the target's default would be "high".
    expect(plan).toMatchObject({ status: "ok", target: { thinkingId: "low" } });
  });

  it("asks before stopping a running turn, and stops it when told", async () => {
    const fake = createFake();
    const link = createLink(fake);
    const ctx = createContext(fake, { link });
    conversation(fake).status = "running";
    expect(await run(fake, ctx, { agentId: "agent-a", target: "codex-team" })).toMatchObject({ status: "running", reason: { code: "errors.running" } });
    expect(fake.creates).toEqual([]);
    const output = await run(fake, ctx, { agentId: "agent-a", target: "codex-team", stopRunning: true });
    expect(output.status).toBe("done");
    expect(link.calls).toContain("cancel agent-a");
  });

  it("stops a running turn before planning, so what it did last goes along", async () => {
    const fake = createFake();
    const link = createLink(fake);
    const ctx = createContext(fake, { link });
    const source = conversation(fake);
    source.status = "running";
    const cancel = link.cancelAgent;
    link.cancelAgent = async (agentId) => {
      say(source, assistant("Stopped halfway through the migration."));
      return cancel(agentId);
    };
    const output = await run(fake, ctx, { agentId: "agent-a", target: "codex-team", stopRunning: true });
    if (output.status !== "done") throw new Error(`move failed: ${JSON.stringify(output)}`);
    expect(output.result.notes.map((note) => note.code)).toContain("notes.stopped");
    expect(fake.agents.get(output.result.agentId)!.sends[0]!.attachments![0]!.text).toContain("Stopped halfway through the migration.");
  });

  it("writes nothing when a running turn cannot be stopped", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake).status = "running";
    expect(await run(fake, ctx, { agentId: "agent-a", target: "codex-team", stopRunning: true })).toMatchObject({ status: "refused", reason: { code: "errors.cannotStop" } });
    expect(readdirSync(ctx.dir)).toEqual([]);
  });

  it("reads a mode its provider no longer reports as careful, so the target never gets its default unasked", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    // The provider is gone from the snapshot (removed or still loading): its "default" mode can only be read by name.
    const source = addAgent(fake, { id: "agent-g", provider: "gone", currentModeId: "default" });
    say(source, user("Fix the login bug"), assistant("Looking at it."));
    const plan = await preview(fake.paseo, ctx, { agentId: "agent-g", target: "codex-team" });
    expect(plan).toMatchObject({ status: "ok", target: { modeId: "auto" } });
    if (plan.status === "ok") expect(plan.warnings.map((warning) => warning.code)).toContain("warnings.modeEscalated");
  });

  it("leaves the source alone when the new agent cannot be created", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    fake.failCreate.value = true;
    const output = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    expect(output).toMatchObject({ status: "refused", reason: { code: "errors.createFailed" } });
    expect(fake.agents.get("agent-a")!.archivedAt).toBeNull();
    const chain = await ctx.store.read(ctx.store.chainOf("agent-a")!);
    expect(chain!.visits.map((visit) => visit.openedBy)).toEqual(["origin"]);
    expect(chain!.deliveries).toEqual([]);
  });

  it("creates the agent without the thinking level when the provider refuses it in that mode", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    fake.failThinking.value = true;
    const output = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    expect(output).toMatchObject({ status: "done", result: { route: "handoff", archivedSource: true } });
    if (output.status !== "done") return;
    expect(output.result.notes.map((note) => note.code)).toContain("notes.thinkingRefused");
    expect(fake.creates[0]!.config).toEqual({ provider: "codex-team/gpt-big", modeId: "auto" });
    // A new id for the second try; the chain, the delivery and the agent agree on it.
    const chain = (await ctx.store.read(output.result.chainId))!;
    expect(chain.visits.at(-1)!.agentId).toBe(output.result.agentId);
    expect(chain.deliveries.at(-1)!.targetAgentId).toBe(output.result.agentId);
    expect(fake.agents.get(output.result.agentId)!.sends).toHaveLength(1);
  });

  it("keeps the source when the message does not get through, and says so", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    fake.failSend.add("id-3");
    fake.failSend.add("id-2");
    fake.failSend.add("id-1");
    const output = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    expect(output.status).toBe("done");
    if (output.status !== "done") return;
    expect(output.result.archivedSource).toBe(false);
    expect(output.result.warnings.map((warning) => warning.code)).toContain("warnings.sendFailed");
    expect(fake.agents.get("agent-a")!.archivedAt).toBeNull();
    const row = fake.agents.get(output.result.agentId)!.plugin.find((entry) => entry.kind === ROW_HANDOFF)!;
    expect(row.data).toMatchObject({ status: "failed" });
  });

  it("keeps the source with a row pointing on, when the setting says keep", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { settings: { afterHandoff: "keep" } });
    conversation(fake);
    const output = await run(fake, ctx, { agentId: "agent-a", target: "acp-alpha" });
    expect(output).toMatchObject({ status: "done", result: { archivedSource: false } });
    expect(fake.agents.get("agent-a")!.plugin.map((row) => row.kind)).toEqual([ROW_MOVED]);
  });

  it("previews without writing anything", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const plan = await preview(fake.paseo, ctx, { agentId: "agent-a", target: "codex-team", preview: true });
    expect(plan).toMatchObject({ status: "ok", route: "handoff", target: { model: "gpt-big", modeId: "auto" }, selection: { selected: 4, total: 4 } });
    if (plan.status === "ok") expect(plan.preview).toContain("<ferry-handoff");
    expect(ctx.store.chainOf("agent-a")).toBeNull();
    expect(fake.creates).toEqual([]);
  });
});

describe("switching back", () => {
  it("returns to the earlier agent with only what it missed", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const codex = fake.agents.get(first.result.agentId)!;
    say(codex, assistant("Picked it up; the fix looks right."), user("now add a test"), assistant("Test added in auth.test.ts."));
    const back = await run(fake, ctx, { agentId: codex.id, target: "claude-main" });
    expect(back).toMatchObject({ status: "done", result: { route: "switch-back", agentId: "agent-a", archivedSource: true } });
    const source = fake.agents.get("agent-a")!;
    expect(source.archivedAt).toBeNull();
    const envelope = source.sends[0]!.attachments![0]!.text;
    expect(envelope).toContain('mode="delta"');
    expect(envelope).toContain("now add a test");
    expect(envelope).toContain("Test added in auth.test.ts.");
    expect(envelope).not.toContain("Fix the login bug");
    expect(codex.archivedAt).not.toBeNull();
    // And forward again: the codex agent gets only what happened on the first one since.
    say(source, assistant("Ran the new test: passing."), user("ship it"), assistant("Done."));
    const again = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    expect(again).toMatchObject({ status: "done", result: { route: "switch-back", agentId: codex.id } });
    const second = codex.sends[1]!.attachments![0]!.text;
    expect(second).toContain("ship it");
    expect(second).not.toContain("now add a test");
  });

  it("puts its row above the message when the earlier agent is still open", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { settings: { afterHandoff: "keep" } });
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    fake.log.length = 0;
    await run(fake, ctx, { agentId: first.result.agentId, target: "claude-main" });
    expect(fake.log.filter((entry) => entry.startsWith("row agent-a") || entry === "send agent-a")).toEqual([`row agent-a ${ROW_HANDOFF}`, "send agent-a", `row agent-a ${ROW_HANDOFF}`]);
  });

  it("hands over to a new agent when the earlier one refuses the message, and says so on its row", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { settings: { afterHandoff: "keep" } });
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    fake.failSend.add("agent-a");
    const back = await run(fake, ctx, { agentId: first.result.agentId, target: "claude-main" });
    expect(back).toMatchObject({ status: "done", result: { route: "handoff" } });
    if (back.status === "done") expect(back.result.notes.map((note) => note.code)).toContain("notes.switchBackFailed");
    const row = fake.agents.get("agent-a")!.plugin.find((entry) => entry.kind === ROW_HANDOFF)!;
    expect(row.data).toMatchObject({ route: "switch-back", status: "canceled", deliveryId: null });
  });

  it("gives the new agent after a refused switch-back the settings chosen for a new agent, not the earlier agent's", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { settings: { afterHandoff: "keep" } });
    Object.assign(conversation(fake), { currentModeId: "bypassPermissions" });
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    // The conversation carries on in the target's careful default; going back, the earlier agent refuses the message.
    fake.agents.get(first.result.agentId)!.currentModeId = "auto";
    fake.failSend.add("agent-a");
    const back = await run(fake, ctx, { agentId: first.result.agentId, target: "claude-main" });
    expect(back).toMatchObject({ status: "done", result: { route: "handoff" } });
    expect(fake.creates.at(-1)).toMatchObject({ config: { provider: "claude-main/opus-9", modeId: "acceptEdits" } });
  });

  it("archives the other open agents of a session when it returns to one of them", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { link: createLink(fake), settings: { afterHandoff: "keep" } });
    conversation(fake);
    await run(fake, ctx, { agentId: "agent-a", target: "claude-alt" });
    const toCodex = await run(fake, ctx, { agentId: "imported-1", target: "codex-team" });
    if (toCodex.status !== "done") throw new Error("handoff failed");
    expect(fake.agents.get("imported-1")!.archivedAt).toBeNull();
    const back = await run(fake, ctx, { agentId: toCodex.result.agentId, target: "claude-main" });
    expect(back).toMatchObject({ status: "done", result: { route: "switch-back", agentId: "agent-a" } });
    // imported-1 holds the same session as agent-a: two agents must not write one session file.
    expect(fake.agents.get("imported-1")!.archivedAt).not.toBeNull();
    expect(fake.agents.get("agent-a")!.archivedAt).toBeNull();
  });

  it("finds its own message after a restart replayed it with the history joined", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const codex = fake.agents.get(first.result.agentId)!;
    say(codex, assistant("On it."));
    // After a restart the provider replays the message with the attachment joined, and the ids are gone.
    const envelope = codex.sends[0]!.attachments![0]!.text;
    const typed = codex.sends[0]!.text;
    codex.rows[0] = { item: user(`${envelope}\n\n${typed}`), timestamp: codex.rows[0]!.timestamp };
    fake.renumber(codex.id);
    const back = await run(fake, ctx, { agentId: codex.id, target: "claude-main" });
    expect(back).toMatchObject({ status: "done", result: { route: "switch-back" } });
    const delta = fake.agents.get("agent-a")!.sends[0]!.attachments![0]!.text;
    expect(delta).toContain("On it.");
    // The earlier envelope is not nested inside the new one.
    expect(delta.match(/<ferry-handoff/g)).toHaveLength(1);
    expect(stripEnvelopes(`${delta}\n\nhi`).typed).toBe("hi");
  });

  it("picks up turns someone made on an earlier agent without Ferry", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    const source = conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const codex = fake.agents.get(first.result.agentId)!;
    say(codex, assistant("Codex reply."));
    // The user goes back to the first agent by hand and carries on there.
    source.archivedAt = null;
    say(source, user("one more thing by hand"), assistant("Handled by hand."));
    const output = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    expect(output).toMatchObject({ status: "done", result: { route: "switch-back", agentId: codex.id } });
    const chain = await ctx.store.read(ctx.store.chainOf("agent-a")!);
    expect(chain!.visits.map((visit) => [visit.n, visit.openedBy, visit.agentId === "agent-a"])).toEqual([
      [1, "origin", true],
      [2, "handoff", false],
      [3, "manual", true],
      [4, "delta", false],
    ]);
    const delta = codex.sends[1]!.attachments![0]!.text;
    expect(delta).toContain("one more thing by hand");
    expect(delta).not.toContain("Codex reply.");
  });

  it("starts a new agent instead when the earlier one has no room left", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    fake.agents.get("agent-a")!.lastUsage = { contextWindowUsedTokens: 120_000 };
    const back = await run(fake, ctx, { agentId: first.result.agentId, target: "claude-main" });
    expect(back).toMatchObject({ status: "done", result: { route: "handoff" } });
    if (back.status === "done") expect(back.result.notes.map((note) => note.code)).toContain("notes.deltaTooSmall");
  });

  it("shows the earlier agent's own settings, and starts a new agent when another model is named", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team/gpt-small" });
    if (first.status !== "done") throw new Error("first move failed");
    const plan = await preview(fake.paseo, ctx, { agentId: "agent-a", target: "codex-team" });
    expect(plan).toMatchObject({ status: "ok", route: "switch-back", target: { model: "gpt-small", modeId: "auto", thinkingId: "high" }, warnings: [] });
    const same = await preview(fake.paseo, ctx, { agentId: "agent-a", target: "codex-team/gpt-small" });
    expect(same).toMatchObject({ status: "ok", route: "switch-back" });
    const other = await preview(fake.paseo, ctx, { agentId: "agent-a", target: "codex-team/gpt-big" });
    expect(other).toMatchObject({ status: "ok", route: "handoff", target: { model: "gpt-big" } });
    if (other.status === "ok") expect(other.notes.map((note) => note.code)).toContain("notes.backOtherModel");
  });

  it("starts a new agent when asked to, even where it could switch back", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const fresh = await run(fake, ctx, { agentId: first.result.agentId, target: "claude-main", fresh: true });
    expect(fresh).toMatchObject({ status: "done", result: { route: "handoff" } });
    if (fresh.status === "done") expect(fresh.result.agentId).not.toBe("agent-a");
  });
});

describe("native continuation", () => {
  it("continues the same session on a provider that shares the store", async () => {
    const fake = createFake();
    const link = createLink(fake);
    const ctx = createContext(fake, { link });
    conversation(fake);
    const output = await run(fake, ctx, { agentId: "agent-a", target: "claude-alt" });
    expect(output).toMatchObject({ status: "done", result: { route: "native", archivedSource: true, to: { model: "vendor/opus-9" } } });
    expect(link.imports[0]).toMatchObject({ providerId: "claude-alt", providerHandleId: "agent-a-session", workspaceId: "ws-1", cwd: "/work/app" });
    expect(link.calls).toEqual(expect.arrayContaining(["model imported-1 vendor/opus-9", "thinking imported-1 high", "mode imported-1 acceptEdits"]));
    expect(fake.agents.get("imported-1")!.sends).toEqual([]);
    expect(fake.agents.get("agent-a")!.archivedAt).not.toBeNull();
  });

  it("sends the user's words when there are some", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { link: createLink(fake) });
    conversation(fake);
    await run(fake, ctx, { agentId: "agent-a", target: "claude-alt", message: "keep going" });
    expect(fake.agents.get("imported-1")!.sends.map((send) => [send.text, send.attachments])).toEqual([["keep going", undefined]]);
  });

  it("hands over instead when the session cannot be imported, or native is off", async () => {
    for (const setup of ["refused", "off", "no-link", "no-file"] as const) {
      const fake = createFake();
      const link = createLink(fake);
      if (setup === "refused") link.failImport.value = true;
      const ctx = createContext(fake, { link: setup === "no-link" ? null : link, settings: { native: setup !== "off" }, sessionFile: setup !== "no-file" });
      conversation(fake);
      const output = await run(fake, ctx, { agentId: "agent-a", target: "claude-alt" });
      expect(output, setup).toMatchObject({ status: "done", result: { route: "handoff" } });
      if (setup === "refused" && output.status === "done") expect(output.result.notes.map((note) => note.code)).toContain("notes.nativeFailed");
    }
  });

  it("does not repeat what the session already holds when a later handoff includes it", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { link: createLink(fake) });
    conversation(fake);
    await run(fake, ctx, { agentId: "agent-a", target: "claude-alt" });
    const imported = fake.agents.get("imported-1")!;
    say(imported, user("continue on the alt route"), assistant("Alt route reply."));
    const output = await run(fake, ctx, { agentId: "imported-1", target: "codex-team" });
    expect(output).toMatchObject({ status: "done", result: { route: "handoff" } });
    const envelope = fake.agents.get((output as Extract<StartOutput, { status: "done" }>).result.agentId)!.sends[0]!.attachments![0]!.text;
    expect(envelope.match(/Fix the login bug/g)).toHaveLength(1);
    expect(envelope).toContain("Alt route reply.");
  });

  it("goes back natively to an earlier session through a provider that shares its store", async () => {
    const fake = createFake();
    const link = createLink(fake);
    const ctx = createContext(fake, { link });
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    say(fake.agents.get(first.result.agentId)!, assistant("Codex did the migration."));
    const back = await run(fake, ctx, { agentId: first.result.agentId, target: "claude-alt" });
    expect(back).toMatchObject({ status: "done", result: { route: "native-switch-back" } });
    expect(link.imports[0]).toMatchObject({ providerId: "claude-alt", providerHandleId: "agent-a-session" });
    const imported = fake.agents.get(link.imports.length ? "imported-1" : "")!;
    const envelope = imported.sends[0]!.attachments![0]!.text;
    expect(envelope).toContain('mode="delta"');
    expect(envelope).toContain("Codex did the migration.");
    expect(envelope).not.toContain("Fix the login bug");
  });
});

describe("the picker's view", () => {
  it("shows how each provider would take over", async () => {
    const fake = createFake();
    const ctx = createContext(fake, { link: createLink(fake), settings: { partners: [{ from: "claude-main", to: "claude-alt" }] } });
    conversation(fake);
    const info = await describeProviders(fake.paseo, ctx, "agent-a");
    const kinds = Object.fromEntries(info.routes.map((route) => [route.provider, route.kind]));
    expect(kinds).toMatchObject({ "claude-main": "same", "claude-alt": "native", "claude-iso": "handoff", "codex-team": "handoff", claude: "unavailable" });
    expect(info.partner).toBe("claude-alt");
    expect(info.agent).toMatchObject({ provider: "claude-main", failure: null, blocked: null });
  });

  it("offers the agent's own provider after a failure, for another model", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    Object.assign(conversation(fake), { status: "error", lastError: "unknown provider for model opus-9" });
    const info = await describeProviders(fake.paseo, ctx, "agent-a");
    expect(info.routes.find((route) => route.provider === "claude-main")).toMatchObject({ kind: "handoff", reason: { code: "reasons.sameProviderNew" } });
    // A provider with a single model has nothing else to offer.
    const pi = addAgent(fake, { id: "agent-pi", provider: "pi", status: "error", lastError: "boom" });
    say(pi, user("hi"), assistant("hello"));
    expect((await describeProviders(fake.paseo, ctx, "agent-pi")).routes.find((route) => route.provider === "pi")).toMatchObject({ kind: "same" });
  });
});

describe("deliveries", () => {
  it("are read once the turn completes, and retried once when the route was down", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const agentId = first.result.agentId;
    const scheduled: (() => void)[] = [];
    await trackTurn(fake.paseo, ctx, { agent: { id: agentId }, outcome: { kind: "failed", error: { message: "connect ECONNREFUSED 192.0.2.1:443" } } }, (task) => scheduled.push(task));
    let chain = await ctx.store.read(first.result.chainId);
    expect(chain!.deliveries[0]).toMatchObject({ status: "failed" });
    expect(scheduled).toHaveLength(1);
    scheduled[0]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    chain = await ctx.store.read(first.result.chainId);
    expect(chain!.deliveries[0]!.status).toBe("accepted");
    expect(new Set(chain!.deliveries[0]!.attempts.map((attempt) => attempt.messageId)).size).toBe(2);
    expect(fake.agents.get(agentId)!.sends).toHaveLength(2);
    await trackTurn(fake.paseo, ctx, { agent: { id: agentId }, outcome: { kind: "completed" } });
    chain = await ctx.store.read(first.result.chainId);
    expect(chain!.deliveries[0]!.status).toBe("read");
    const row = fake.agents.get(agentId)!.plugin.find((entry) => entry.kind === ROW_HANDOFF)!;
    expect(row.data).toMatchObject({ status: "read" });
  });
});

describe("deliveries after the conversation moved on", () => {
  it("are not sent again, automatically or by hand", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const agentId = first.result.agentId;
    const scheduled: (() => void)[] = [];
    await trackTurn(fake.paseo, ctx, { agent: { id: agentId }, outcome: { kind: "failed", error: { message: "connect ECONNREFUSED 192.0.2.1:443" } } }, (task) => scheduled.push(task));
    expect(scheduled).toHaveLength(1);
    // Before the automatic retry fires, the user takes the conversation elsewhere.
    expect(await run(fake, ctx, { agentId, target: "acp-alpha" })).toMatchObject({ status: "done" });
    scheduled[0]!();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fake.agents.get(agentId)!.sends).toHaveLength(1);
    expect(fake.agents.get(agentId)!.archivedAt).not.toBeNull();
    expect(await retry(fake.paseo, ctx, { chainId: first.result.chainId, deliveryId: first.result.deliveryId! })).toMatchObject({ status: "refused", reason: { code: "errors.movedOn" } });
  });

  it("keep a conversation still in use from the retention sweep", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const agentId = first.result.agentId;
    await trackTurn(fake.paseo, ctx, { agent: { id: agentId }, outcome: { kind: "completed" } });
    const stale = (await ctx.store.read(first.result.chainId))!;
    stale.updatedAt = "2026-01-01T00:00:00.000Z";
    await ctx.store.write(stale);
    await trackTurn(fake.paseo, ctx, { agent: { id: agentId }, outcome: { kind: "completed" } });
    expect(Date.parse((await ctx.store.read(first.result.chainId))!.updatedAt)).toBeGreaterThan(Date.parse("2026-11-01T00:00:00Z"));
  });
});

describe("the history tool", () => {
  it("pages, reads one item and searches the chain's history", async () => {
    const fake = createFake();
    const ctx = createContext(fake);
    conversation(fake);
    const first = await run(fake, ctx, { agentId: "agent-a", target: "codex-team" });
    if (first.status !== "done") throw new Error("first move failed");
    const chain = (await ctx.store.read(first.result.chainId))!;
    const items = await ctx.store.history(chain);
    const page = answerHistory(chain, items, { from: 1, limit: 2 });
    expect(page.text).toContain("Conversation history: 4 items.");
    expect(page.text).toContain("Items 1-2:");
    expect(page.text).toContain('More: {"from": 3}.');
    expect(answerHistory(chain, items, { item: 3 }).text).toContain("1 failing: login refresh");
    expect(answerHistory(chain, items, { query: "TOKEN REFRESH" }).text).toContain("[4] assistant");
    expect(answerHistory(chain, items, { item: 99 }).text).toContain("There is no item 99");
  });
});
