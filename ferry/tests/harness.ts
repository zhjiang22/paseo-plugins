// A pretend daemon for Ferry's server tests: agents with projected timelines (paged, numbered per epoch), sends that
// become user messages, plugin rows, workspaces that create agents, providers and config, and a pretend second
// connection for imports. Provider names are made up.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { FerryContext } from "../server/context";
import { createChainStore } from "../server/chain-store";
import type { DaemonLink, ImportAgentRequest } from "../server/daemon-link";
import type { AgentLike, CreateOptions, PaseoLike, PluginRow, TextAttachment } from "../server/types";
import type { ProviderConfigLike, SnapshotEntryLike } from "../shared/families";
import { DEFAULT_SETTINGS, type FerrySettings } from "../shared/settings";

// Every test file's directories live under one folder, removed when the file is done (the hook is registered while
// the file loads this module; a hook added inside a running test would never run).
let scratchRoot: string | null = null;
afterAll(() => {
  if (scratchRoot) rmSync(scratchRoot, { recursive: true, force: true });
  scratchRoot = null;
});
export function scratchDir(prefix: string): string {
  scratchRoot ??= mkdtempSync(join(tmpdir(), "ferry-tests-"));
  return mkdtempSync(join(scratchRoot, prefix));
}

export const CLAUDE_MODES = [
  { id: "plan", label: "Plan Mode", colorTier: "planning" },
  { id: "default", label: "Always Ask", colorTier: "safe" },
  { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
  { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous", isUnattended: true },
];

export const CONFIG: Record<string, ProviderConfigLike> = {
  claude: { enabled: false },
  codex: { enabled: false },
  "claude-main": { extends: "claude", label: "Claude Main" },
  "claude-alt": { extends: "claude", label: "Claude Alt" },
  "claude-iso": { extends: "claude", label: "Claude Isolated", env: { CLAUDE_CONFIG_DIR: "/srv/other-claude" } },
  "codex-team": { extends: "codex", label: "Codex Team", env: { OPENAI_BASE_URL: "https://example.invalid" } },
  "acp-alpha": { extends: "acp", label: "Alpha ACP" },
  pi: { enabled: true },
};

const model = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, isDefault: false, thinkingOptions: [{ id: "low" }, { id: "high", isDefault: true }], defaultThinkingOptionId: "high", ...extra });

export const SNAPSHOT: SnapshotEntryLike[] = [
  { provider: "claude", status: "unavailable", enabled: false, source: "builtin" },
  { provider: "codex", status: "unavailable", enabled: false, source: "builtin" },
  { provider: "claude-main", status: "ready", enabled: true, source: "custom", label: "Claude Main", defaultModeId: "acceptEdits", modes: CLAUDE_MODES, models: [model("opus-9", { isDefault: true }), model("sonnet-9", { defaultThinkingOptionId: "low" })] },
  { provider: "claude-alt", status: "ready", enabled: true, source: "custom", label: "Claude Alt", defaultModeId: "acceptEdits", modes: CLAUDE_MODES, models: [model("vendor/opus-9", { isDefault: true })] },
  { provider: "claude-iso", status: "ready", enabled: true, source: "custom", label: "Claude Isolated", defaultModeId: "acceptEdits", modes: CLAUDE_MODES, models: [model("opus-9", { isDefault: true })] },
  {
    provider: "codex-team",
    status: "ready",
    enabled: true,
    source: "custom",
    label: "Codex Team",
    defaultModeId: "auto",
    modes: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous", isUnattended: true },
    ],
    models: [model("gpt-big", { isDefault: true }), model("gpt-small")],
  },
  {
    provider: "acp-alpha",
    status: "ready",
    enabled: true,
    source: "custom",
    label: "Alpha ACP",
    modes: [
      { id: "default", label: "Workspace Edit" },
      { id: "plan", label: "Plan" },
      { id: "yolo", label: "YOLO" },
    ],
    models: [model("alpha-1", { isDefault: true })],
  },
  { provider: "pi", status: "ready", enabled: true, source: "builtin", label: "Pi", models: [model("pi-model", { isDefault: true })] },
];

export interface FakeAgent extends AgentLike {
  rows: { item: Record<string, unknown>; timestamp: string }[];
  epoch: string;
  plugin: PluginRow[];
  sends: { text: string; messageId?: string; attachments?: TextAttachment[] }[];
}

export interface Fake {
  paseo: PaseoLike;
  agents: Map<string, FakeAgent>;
  creates: (CreateOptions & { workspaceId?: string; cwd?: string })[];
  failSend: Set<string>;
  failCreate: { value: boolean };
  /** Refuse a thinking level at creation, as Cursor does in its "ask" mode. */
  failThinking: { value: boolean };
  /** Renumber an agent's timeline, as a restart or a reload does. */
  renumber(agentId: string): void;
  log: string[];
}

let clock = Date.parse("2026-11-09T10:00:00Z");
export const tick = () => new Date((clock += 1000));

export function addAgent(fake: Fake, agent: Partial<FakeAgent> & { id: string; provider: string }): FakeAgent {
  const full: FakeAgent = {
    cwd: "/work/app",
    workspaceId: "ws-1",
    status: "idle",
    title: "Fix the login bug",
    model: null,
    labels: {},
    persistence: { provider: agent.provider, sessionId: `${agent.id}-session` },
    createdAt: tick().toISOString(),
    archivedAt: null,
    rows: [],
    epoch: "epoch-1",
    plugin: [],
    sends: [],
    ...agent,
  };
  fake.agents.set(full.id, full);
  return full;
}

export const user = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user_message", text, ...extra });
export const assistant = (text: string) => ({ type: "assistant_message", text });
export const shell = (command: string, output: string, exitCode = 0) => ({ type: "tool_call", callId: `c-${command}`, name: "Bash", status: "completed", error: null, detail: { type: "shell", command, output, exitCode } });

export function say(agent: FakeAgent, ...items: Record<string, unknown>[]) {
  for (const item of items) agent.rows.push({ item, timestamp: tick().toISOString() });
}

export function createFake(): Fake {
  const agents = new Map<string, FakeAgent>();
  const creates: Fake["creates"] = [];
  const failSend = new Set<string>();
  const failCreate = { value: false };
  const failThinking = { value: false };
  const log: string[] = [];
  const strip = (agent: FakeAgent): AgentLike => {
    const { rows: _rows, epoch: _epoch, plugin: _plugin, sends: _sends, ...rest } = agent;
    return { ...rest };
  };
  const ref = (id: string) => ({
    async refresh() {
      const agent = agents.get(id);
      return agent ? { agent: strip(agent) } : null;
    },
    async archive() {
      const agent = agents.get(id);
      if (!agent) throw new Error("no such agent");
      agent.archivedAt = tick().toISOString();
      log.push(`archive ${id}`);
      return { archivedAt: agent.archivedAt };
    },
    async send(text: string, options: { messageId?: string; attachments?: TextAttachment[] } = {}) {
      const agent = agents.get(id);
      if (!agent) throw new Error("no such agent");
      if (failSend.has(id)) throw new Error("send refused");
      agent.sends.push({ text, ...options });
      agent.archivedAt = null;
      // Live, the bubble shows only the typed text; the attachment does not appear.
      say(agent, user(text, { clientMessageId: options.messageId, messageId: options.messageId }));
      log.push(`send ${id}`);
    },
    timeline: {
      async refetch(options: { direction: "tail" | "before" | "after"; cursor?: { epoch: string; seq: number }; limit: number }) {
        const agent = agents.get(id);
        if (!agent) throw new Error("no such agent");
        const entries = agent.rows.map((row, index) => ({ provider: agent.provider, item: row.item, timestamp: row.timestamp, seqStart: index + 1, seqEnd: index + 1 }));
        let slice: typeof entries;
        if (options.direction === "tail") slice = entries.slice(-options.limit);
        else if (options.direction === "before") {
          const before = entries.filter((entry) => entry.seqStart < (options.cursor?.seq ?? Infinity));
          slice = before.slice(-options.limit);
        } else slice = entries.filter((entry) => entry.seqStart > (options.cursor?.seq ?? 0)).slice(0, options.limit);
        const first = slice[0]?.seqStart ?? null;
        return {
          epoch: agent.epoch,
          reset: false,
          staleCursor: !!options.cursor && options.cursor.epoch !== agent.epoch,
          hasOlder: first !== null && first > 1,
          startCursor: first !== null ? { epoch: agent.epoch, seq: first } : null,
          entries: slice,
        };
      },
      async append(row: PluginRow) {
        const agent = agents.get(id);
        if (!agent) throw new Error("no such agent");
        if (agent.archivedAt) throw new Error("agent not loaded");
        agent.plugin = agent.plugin.filter((existing) => existing.id !== row.id);
        agent.plugin.push(row);
        log.push(`row ${id} ${row.kind}`);
        return { seq: 0, epoch: agent.epoch };
      },
    },
  });
  // Like the daemon, a creation that failed stays failed under its id.
  const failedIds = new Map<string, string>();
  const create = async (options: CreateOptions & { workspaceId?: string; cwd?: string }) => {
    const remembered = options.agentId ? failedIds.get(options.agentId) : undefined;
    if (remembered) throw new Error(remembered);
    const refuse = (message: string) => {
      if (options.agentId) failedIds.set(options.agentId, message);
      throw new Error(message);
    };
    if (failCreate.value) refuse("provider refused");
    if (failThinking.value && options.config.thinkingOptionId) refuse("Invalid params: Unknown model config option: reasoning");
    creates.push(options);
    const [provider, ...model] = options.config.provider.split("/");
    const id = options.agentId ?? `agent-${creates.length}`;
    addAgent(fake, {
      id,
      provider: provider!,
      model: model.join("/") || null,
      currentModeId: options.config.modeId ?? null,
      thinkingOptionId: options.config.thinkingOptionId ?? null,
      title: options.title ?? null,
      labels: options.labels ?? {},
      workspaceId: options.workspaceId ?? null,
      cwd: options.cwd ?? "/work/app",
      persistence: { provider: provider!, sessionId: `${id}-session` },
    });
    log.push(`create ${id}`);
    return { id };
  };
  const paseo: PaseoLike = {
    agents: {
      ref: ref as unknown as PaseoLike["agents"]["ref"],
      create: (options) => create(options),
      async list() {
        return { entries: [...agents.values()].map((agent) => ({ agent: strip(agent) })), pageInfo: { nextCursor: null, hasMore: false } };
      },
    },
    workspaces: { ref: (workspaceId: string) => ({ agents: { create: (options: CreateOptions) => create({ ...options, workspaceId }) } }) },
    providers: {
      async snapshot() {
        return { entries: SNAPSHOT };
      },
    },
    config: {
      async get() {
        return { config: { providers: CONFIG, mcp: { enabled: true, injectIntoAgents: true } } };
      },
    },
  };
  const fake: Fake = {
    paseo,
    agents,
    creates,
    failSend,
    failCreate,
    failThinking,
    log,
    renumber(agentId) {
      const agent = agents.get(agentId)!;
      agent.epoch = `${agent.epoch}+`;
    },
  };
  return fake;
}

export interface FakeLink extends DaemonLink {
  imports: ImportAgentRequest[];
  calls: string[];
  failImport: { value: boolean };
}

/** The second connection: an import shares the source session's rows (it is the same session file). */
export function createLink(fake: Fake): FakeLink {
  const imports: ImportAgentRequest[] = [];
  const calls: string[] = [];
  const failImport = { value: false };
  return {
    imports,
    calls,
    failImport,
    async importAgent(input) {
      if (failImport.value) throw new Error("import refused");
      imports.push(input);
      const existing = [...fake.agents.values()].find((agent) => agent.provider === input.providerId && agent.persistence?.sessionId === input.providerHandleId);
      if (existing) {
        existing.archivedAt = null;
        return { ...existing, rows: undefined } as unknown as AgentLike;
      }
      const holder = [...fake.agents.values()].find((agent) => agent.persistence?.sessionId === input.providerHandleId);
      const agent = addAgent(fake, {
        id: `imported-${imports.length}`,
        provider: input.providerId,
        workspaceId: input.workspaceId ?? null,
        cwd: input.cwd,
        labels: input.labels ?? {},
        persistence: { provider: input.providerId, sessionId: input.providerHandleId },
        // The same session: the provider replays its history (a new epoch, the attachment joined to the message).
        rows: (holder?.rows ?? []).map((row) => ({ ...row })),
        epoch: "imported",
      });
      fake.log.push(`import ${agent.id}`);
      return { ...agent } as AgentLike;
    },
    async setAgentMode(agentId, modeId) {
      calls.push(`mode ${agentId} ${modeId}`);
      fake.agents.get(agentId)!.currentModeId = modeId;
    },
    async setAgentModel(agentId, modelId) {
      calls.push(`model ${agentId} ${modelId}`);
      fake.agents.get(agentId)!.model = modelId;
    },
    async setAgentThinkingOption(agentId, thinkingId) {
      calls.push(`thinking ${agentId} ${thinkingId}`);
    },
    async updateAgent(agentId, updates) {
      calls.push(`update ${agentId} ${JSON.stringify(updates)}`);
      const agent = fake.agents.get(agentId);
      if (agent && updates.labels) agent.labels = { ...agent.labels, ...updates.labels };
      if (agent && updates.name) agent.title = updates.name;
    },
    async cancelAgent(agentId) {
      calls.push(`cancel ${agentId}`);
      fake.agents.get(agentId)!.status = "idle";
    },
    async close() {
      calls.push("close");
    },
  };
}

export function createContext(fake: Fake, options: { settings?: Partial<FerrySettings>; link?: FakeLink | null; sessionFile?: boolean } = {}): FerryContext & { dir: string } {
  const dir = scratchDir("context-");
  let id = 0;
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  return {
    dir,
    store: createChainStore(dir),
    settings: async () => settings,
    daemonEnv: {},
    userHome: "/home/tester",
    connect: async () => {
      if (!options.link) throw new Error("no link");
      return options.link;
    },
    canConnect: async () => !!options.link,
    findSessionFile: async () => (options.sessionFile === false ? null : "/home/tester/.claude/projects/x/s.jsonl"),
    readStoredAgent: async () => null,
    now: () => tick(),
    newId: () => `id-${++id}`,
    sleep: async () => undefined,
    zone: "UTC",
    log: () => undefined,
    pending: new Map(),
  };
}
