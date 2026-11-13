import { describe, expect, it } from "vitest";
import {
  baseProvider,
  chooseMode,
  chooseModel,
  chooseThinking,
  equivalentModel,
  findProvider,
  parseCommand,
  readProviders,
  sharesStore,
  storeKeyFor,
  storeLabel,
  tierOf,
  type ProviderInfo,
} from "../shared/families";
import { failureKind } from "../shared/failure";
import { partnerFor, settingsSchema } from "../shared/settings";
import { CONFIG, SNAPSHOT } from "./harness";

const providers = readProviders(CONFIG, SNAPSHOT, { daemonEnv: {}, home: "/home/tester", toolName: "ferry_read_history" });
const get = (id: string) => providers.find((provider) => provider.id === id)!;

describe("readProviders", () => {
  it("knows each provider's family through extends", () => {
    expect(Object.fromEntries(providers.map((provider) => [provider.id, provider.family]))).toMatchObject({
      "claude-main": "claude",
      "claude-alt": "claude",
      "codex-team": "codex",
      "acp-alpha": "acp",
      pi: "pi",
    });
    expect(baseProvider("claude-main", CONFIG)).toBe("claude");
    expect(baseProvider("loop", { loop: { extends: "loop2" }, loop2: { extends: "loop" } })).toBeNull();
  });

  it("keeps providers that are off, marked so", () => {
    expect(get("claude")).toMatchObject({ enabled: false, ready: false, status: "disabled" });
    expect(get("claude-main")).toMatchObject({ enabled: true, ready: true });
  });

  it("finds the session store from the provider's env, then the daemon's, then the default", () => {
    expect(get("claude-main").storeKey).toBe("claude:/home/tester/.claude");
    expect(get("claude-iso").storeKey).toBe("claude:/srv/other-claude");
    expect(get("codex-team").storeKey).toBe("codex:/home/tester/.codex");
    expect(get("acp-alpha").storeKey).toBeNull();
    expect(storeKeyFor("claude-main", "claude", CONFIG, { daemonEnv: { CLAUDE_CONFIG_DIR: "~/shared" }, home: "/home/tester" })).toBe("claude:/home/tester/shared");
  });

  it("shows a store with the home directory as ~", () => {
    expect(storeLabel("claude:/home/tester/.claude", "/home/tester")).toBe("~/.claude");
    expect(storeLabel("claude:/srv/other-claude", "/home/tester")).toBe("/srv/other-claude");
    expect(storeLabel("claude:/home/someone/.claude", "/home/tester")).toBe("/home/someone/.claude");
    // A directory that only starts like the home directory is not under it.
    expect(storeLabel("claude:/home/users/.claude", "/home/user")).toBe("/home/users/.claude");
    expect(storeLabel("custom:team-store", "/home/tester")).toBe("team-store");
    expect(storeLabel(null, "/home/tester")).toBeNull();
  });

  it("lets the settings mark a store isolated or name a shared one", () => {
    const tuned = readProviders(CONFIG, SNAPSHOT, { daemonEnv: {}, home: "/h", toolName: "t", stores: { "claude-alt": "isolated", "acp-alpha": "team-store" } });
    expect(tuned.find((provider) => provider.id === "claude-alt")!.storeKey).toBeNull();
    expect(tuned.find((provider) => provider.id === "acp-alpha")!.storeKey).toBe("custom:team-store");
  });

  it("notices when the user switched Ferry's tool off for a provider", () => {
    const off = readProviders({ ...CONFIG, pi: { paseoTools: { disabledTools: ["create_workspace", "ferry_read_history"] } } }, SNAPSHOT, { daemonEnv: {}, home: "/h", toolName: "ferry_read_history" });
    expect(off.find((provider) => provider.id === "pi")!.toolDisabled).toBe(true);
    expect(get("pi").toolDisabled).toBe(false);
  });

  it("reads permission tiers, from Paseo or from the mode's name", () => {
    expect(get("claude-main").modes.map((mode) => mode.tier)).toEqual(["planning", "safe", "moderate", "dangerous"]);
    expect(get("acp-alpha").modes.map((mode) => [mode.id, mode.tier])).toEqual([
      ["default", "moderate"],
      ["plan", "planning"],
      ["yolo", "dangerous"],
    ]);
    expect(tierOf({ id: "ask", label: "Ask" })).toBe("safe");
    expect(tierOf({ id: "default", label: "Default" })).toBe("safe");
    expect(tierOf({ id: "x", label: "Full Access" })).toBe("dangerous");
  });
});

describe("sharesStore", () => {
  it("is true only for the same CLI on the same store", () => {
    expect(sharesStore(get("claude-main"), get("claude-alt"))).toBe(true);
    expect(sharesStore(get("claude-main"), get("claude-iso"))).toBe(false);
    expect(sharesStore(get("claude-main"), get("codex-team"))).toBe(false);
    expect(sharesStore(get("claude-main"), get("claude-main"))).toBe(false);
    expect(sharesStore(get("acp-alpha"), get("acp-alpha"))).toBe(false);
  });
});

describe("findProvider and parseCommand", () => {
  it("finds by id, provider/model, prefix and label fragment", () => {
    expect(findProvider(providers, "codex-team")).toMatchObject({ provider: { id: "codex-team" }, model: null, exact: true });
    expect(findProvider(providers, "codex-team/gpt-small")).toMatchObject({ provider: { id: "codex-team" }, model: { id: "gpt-small" }, exact: true });
    expect(findProvider(providers, "codex-team/small")).toMatchObject({ model: { id: "gpt-small" }, exact: false });
    expect(findProvider(providers, "cod")).toMatchObject({ provider: { id: "codex-team" }, exact: false });
    expect(findProvider(providers, "alpha")).toMatchObject({ provider: { id: "acp-alpha" } });
    expect(findProvider(providers, "claude-a")).toMatchObject({ provider: { id: "claude-alt" } });
    // Ambiguous or too short: nothing.
    expect(findProvider(providers, "claude-")).toBeNull();
    expect(findProvider(providers, "c")).toBeNull();
    expect(findProvider(providers, "codex-team/nope")).toBeNull();
  });

  it("takes the first word as the target when it names one", () => {
    expect(parseCommand("codex-team fix the tests", providers)).toMatchObject({ target: "codex-team", message: "fix the tests", match: { provider: { id: "codex-team" } } });
    expect(parseCommand("to claude-alt", providers)).toMatchObject({ target: "claude-alt", message: "" });
    expect(parseCommand("→ pi go on", providers)).toMatchObject({ target: "pi", message: "go on" });
    expect(parseCommand("please carry on with the refactor", providers)).toEqual({ target: null, match: null, message: "please carry on with the refactor" });
    // With a message after it, only an exact id names a provider: "cod" or "alpha" alone still do.
    expect(parseCommand("cod fix the tests", providers)).toEqual({ target: null, match: null, message: "cod fix the tests" });
    expect(parseCommand("alpha release notes", providers)).toEqual({ target: null, match: null, message: "alpha release notes" });
    expect(parseCommand("cod", providers)).toMatchObject({ target: "cod", match: { provider: { id: "codex-team" } } });
    expect(parseCommand("codex-team/small go on", providers)).toMatchObject({ target: "codex-team/small", message: "go on", match: { model: { id: "gpt-small" } } });
    expect(parseCommand("  ", providers)).toEqual({ target: null, match: null, message: "" });
  });
});

describe("target settings", () => {
  it("chooses the model named, else the equivalent, else the default", () => {
    expect(chooseModel(get("codex-team"), { named: "gpt-small", sourceModel: "opus-9" })).toEqual({ modelId: "gpt-small", equivalent: true });
    expect(chooseModel(get("claude-alt"), { sourceModel: "opus-9" })).toEqual({ modelId: "vendor/opus-9", equivalent: true });
    expect(chooseModel(get("codex-team"), { sourceModel: "opus-9" })).toEqual({ modelId: "gpt-big", equivalent: false });
    expect(equivalentModel("vendor/opus-9", get("claude-main").models)).toBe("opus-9");
  });

  it("keeps the thinking level when the model offers it", () => {
    const model = get("codex-team").models[0]!;
    expect(chooseThinking(model, "low")).toEqual({ thinkingId: "low", kept: true });
    expect(chooseThinking(model, "max")).toEqual({ thinkingId: "high", kept: false });
    expect(chooseThinking(model, null)).toEqual({ thinkingId: "high", kept: true });
  });

  it("never picks a more permissive mode when there is a choice", () => {
    const target: Pick<ProviderInfo, "modes" | "defaultModeId"> = get("acp-alpha");
    expect(chooseMode({ modeId: "acceptEdits", tier: "moderate" }, target)).toEqual({ modeId: "default", escalated: false, none: false });
    expect(chooseMode({ modeId: "bypassPermissions", tier: "dangerous" }, target)).toEqual({ modeId: "yolo", escalated: false, none: false });
    expect(chooseMode({ modeId: "plan", tier: "planning" }, target)).toEqual({ modeId: "plan", escalated: false, none: false });
    // Codex Team has nothing as careful as "Always Ask": the most careful one, with a warning.
    expect(chooseMode({ modeId: "default", tier: "safe" }, get("codex-team"))).toEqual({ modeId: "auto", escalated: true, none: false });
    // The same id is kept when it is no more permissive.
    expect(chooseMode({ modeId: "acceptEdits", tier: "moderate" }, get("claude-alt"))).toEqual({ modeId: "acceptEdits", escalated: false, none: false });
    expect(chooseMode({ modeId: "x", tier: "moderate" }, get("pi"))).toEqual({ modeId: null, escalated: false, none: true });
    expect(chooseMode({ modeId: null, tier: null }, get("codex-team")).modeId).toBe("auto");
  });
});

describe("partners and failures", () => {
  it("takes the first usable partner", () => {
    const settings = settingsSchema.parse({ partners: [{ from: "claude-main", to: "claude-alt" }, { from: "claude-main", to: "codex-team/gpt-big" }] });
    expect(partnerFor(settings, "claude-main", () => true)).toBe("claude-alt");
    expect(partnerFor(settings, "claude-main", (target) => target !== "claude-alt")).toBe("codex-team/gpt-big");
    expect(partnerFor(settings, "pi", () => true)).toBeNull();
  });

  it("reads a hand-edited settings file without failing", () => {
    expect(settingsSchema.parse({ budgetTokens: "lots", afterHandoff: "explode", partners: "nope", slashAlias: "Bad Alias" })).toMatchObject({ budgetTokens: 16000, afterHandoff: "archive", partners: [], slashAlias: "" });
  });

  it("classifies a failed turn", () => {
    expect(failureKind("idle", null, "anything")).toBeNull();
    expect(failureKind("error", null, "You've hit your limit · resets 3pm")).toBe("limit");
    expect(failureKind("error", null, "API Error: 429 Too Many Requests")).toBe("limit");
    expect(failureKind("error", null, "prompt is too long: 210000 tokens > 200000 maximum context length")).toBe("context");
    expect(failureKind("error", null, "connect ECONNREFUSED 127.0.0.1:7890 (proxy)")).toBe("connection");
    expect(failureKind(null, "error", "Claude Code process terminated by signal SIGKILL")).toBe("error");
  });
});
