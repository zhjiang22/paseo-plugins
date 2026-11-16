import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The client type the plugin hands these helpers (PluginPaseoApi from Paseo 0.16, PaseoApi before).
import type { PaseoApi } from "../client/paseo-types";
import { interpolateTemplate, quickNoteFields, templateVariables, composerAttachmentsRpc } from "../shared/composer";
import { checkPromptSend } from "../client/composer-send";
import { BoardStore } from "../server/store";
import { ProjectDirectory } from "../server/dashboard";
import { ComposerLibrary } from "../server/composer";

describe("prompt templates", () => {
  it("deduplicates Unicode variables and interpolates values once as literal text", () => {
    const template = "评审 {{ 项目 }}：{{目标}}。再核对 {{项目}}";
    expect(templateVariables(template)).toEqual(["项目", "目标"]);
    expect(interpolateTemplate(template, { 项目: "{{目标}}", 目标: "$&" })).toEqual({ text: "评审 {{目标}}：$&。再核对 {{目标}}", missing: [], tooLong: false });
  });
  it("requires own, non-empty values and refuses expanded bodies beyond the note limit", () => {
    expect(interpolateTemplate("{{constructor}} {{名字}}", { 名字: " " }).missing).toEqual(["constructor", "名字"]);
    expect(interpolateTemplate("{{内容}}", { 内容: "字".repeat(32001) }).tooLong).toBe(true);
  });
  it("creates a full idea from multiline quick notes with a bounded first-line title", () => {
    const fields = quickNoteFields(`  ${"长".repeat(180)}\n正文  `);
    expect(fields.title).toHaveLength(160);
    expect(fields.body).toContain("\n正文");
    expect(fields.kind).toBe("idea");
    expect(() => quickNoteFields("  ")).toThrow("填写");
    expect(() => quickNoteFields("字".repeat(32001))).toThrow("32000");
  });
});

// The plugin server sends (server/deferred-send.ts) and plans again at that moment; see deferred.test.ts. The picker
// only reads the selected agent to show what a send would do and what confirming it agrees to.
describe("safe prompt delivery", () => {
  function target(provider: string, status = "running", permissions: { id: string }[] = []) {
    const agent = { id: "agent-1", provider, status, pendingPermissions: permissions, activeTurn: { turnId: "turn-1" }, archivedAt: null as string | null };
    const send = vi.fn(async () => {}), refresh = vi.fn(async () => ({ agent }));
    return { agent, send, refresh, paseo: { agents: { ref: () => ({ refresh, send }) } } as unknown as PaseoApi };
  }
  const capabilities = { steerableProviders: [] as string[], slashSteerableProviders: [] as string[] };
  it("steers a custom provider only when the server identifies its steering support", async () => {
    const a = target("custom-assistant");
    expect((await checkPromptSend(a.paseo, "agent-1", "提示词", capabilities)).plan.kind).toBe("confirm");
    const check = await checkPromptSend(a.paseo, "agent-1", "提示词", { ...capabilities, steerableProviders: ["custom-assistant"] });
    expect(check.plan.kind).toBe("steer");
    expect(check.consent).toBeNull();
    expect(a.send).not.toHaveBeenCalled();
  });
  it("asks before interrupting, and names what confirming agrees to: the interrupt, and the approvals by id, in this turn", async () => {
    const a = target("example-provider");
    const check = await checkPromptSend(a.paseo, "agent-1", "提示词", capabilities);
    expect(check.plan.kind).toBe("confirm");
    // The OK is for the turn running now: the server does not let it interrupt a turn that starts later (r3-F1).
    expect(check.consent).toEqual({ interrupt: true, approvals: [], turn: "turn-1" });
    const b = target("codex", "running", [{ id: "permission-1" }]);
    b.agent.activeTurn = { turnId: "turn-2", startedAt: "2026-10-12T10:00:00.000Z" } as never;
    const approval = await checkPromptSend(b.paseo, "agent-1", "提示词", capabilities);
    expect(approval.plan.confirm).toContain("取消这次审批");
    expect(approval.consent).toEqual({ interrupt: false, approvals: ["permission-1"], turn: "turn-2@2026-10-12T10:00:00.000Z" });
    // Every check is a new message unless the picker hands over the id of one whose reply was lost; saying yes sends it.
    expect(approval.messageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(approval.messageId).not.toBe(check.messageId);
    expect((await checkPromptSend(b.paseo, "agent-1", "提示词", capabilities, "message-kept")).messageId).toBe("message-kept");
    expect(a.send).not.toHaveBeenCalled();
    expect(b.send).not.toHaveBeenCalled();
  });
  it("sends to an unloaded closed agent and refuses an archived or missing target", async () => {
    const a = target("codex", "closed");
    expect((await checkPromptSend(a.paseo, "agent-1", "提示词", capabilities)).plan).toMatchObject({ kind: "send", note: expect.stringContaining("未载入") });
    a.agent.archivedAt = "2026-10-01";
    expect((await checkPromptSend(a.paseo, "agent-1", "新提示词", capabilities)).plan.kind).toBe("unavailable");
    a.refresh.mockResolvedValueOnce({ agent: undefined } as never);
    expect((await checkPromptSend(a.paseo, "agent-1", "新提示词", capabilities)).plan).toMatchObject({ kind: "unavailable", note: expect.stringContaining("不可用") });
  });
  it("uses slash capabilities rather than ordinary steering support", async () => {
    const a = target("custom-assistant");
    expect((await checkPromptSend(a.paseo, "agent-1", "/review", { ...capabilities, steerableProviders: ["custom-assistant"] })).plan.kind).toBe("confirm");
    expect((await checkPromptSend(a.paseo, "agent-1", "/review", { steerableProviders: ["custom-assistant"], slashSteerableProviders: ["custom-assistant"] })).plan.kind).toBe("steer");
  });
});

describe("composer library", () => {
  let directory = "", store: BoardStore, projects: ProjectDirectory, library: ComposerLibrary;
  const paseo = { projects: { list: async () => ({ projects: [{ projectId: "p1", projectDisplayName: "示例项目", projectRootPath: "/example/project" }] }), subscribe: () => () => {} } } as unknown as PaseoApi;
  const fields = { kind: "prompt" as const, title: "发布检查", body: "检查 {{项目}}", status: "todo" as const, priority: "normal" as const, pinned: false };
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "notes-composer-")); store = new BoardStore(directory); projects = new ProjectDirectory(); library = new ComposerLibrary(store, projects); });
  afterEach(async () => { projects.stop(); await rm(directory, { recursive: true, force: true }); });
  it("searches current note content and project names while hiding trash", async () => {
    const created = await store.write({ projectId: "p1", requestId: "create-first", operation: { type: "create", fields } });
    const first = await library.search(paseo, "示例", true);
    expect(first.items.map(item => item.title)).toEqual(["发布检查"]);
    await store.write({ projectId: "p1", requestId: "edit-first", operation: { type: "update", id: created.itemId, expectedRevision: 1, fields: { body: "核对回归" } } });
    expect((await library.search(paseo, "{{项目}}", true)).items).toEqual([]);
    expect((await library.search(paseo, "回归", true)).items).toHaveLength(1);
    await store.write({ projectId: "p1", requestId: "delete-first", operation: { type: "delete", id: created.itemId, expectedRevision: 2 } });
    expect((await library.search(paseo, "", true)).items).toEqual([]);
  });
  it("returns host-valid draft attachments for all note kinds, with provenance and template hints", async () => {
    await store.write({ projectId: "p1", requestId: "create-prompt", operation: { type: "create", fields } });
    await store.write({ projectId: "p1", requestId: "create-idea", operation: { type: "create", fields: { ...fields, kind: "idea", title: "随手想法", body: "稍后处理" } } });
    const payload = composerAttachmentsRpc.output.parse(await library.attachments(paseo, ""));
    expect(payload.items).toHaveLength(2);
    expect(payload.items.every(item => item.text.startsWith("来源：手记 #") && item.url.startsWith("paseo-notes://note/"))).toBe(true);
    expect(payload.items.find(item => item.title === "发布检查")!.subtitle).toContain("含模板变量");
    expect((await library.search(paseo, "", true)).items).toHaveLength(1);
  });
  it("caps large result sets and gives pinned prompts priority", async () => {
    for (let i = 0; i < 42; i++) await store.write({ projectId: "p1", requestId: `create-note-${i}`, operation: { type: "create", fields: { ...fields, title: `提示词 ${i}`, pinned: i === 0 } } });
    const found = await library.search(paseo, "", true);
    expect(found.items).toHaveLength(40);
    expect(found.truncated).toBe(true);
    expect(found.items[0]!.title).toBe("提示词 0");
  });
});
