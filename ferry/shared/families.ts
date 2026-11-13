// What Ferry knows about providers: their family (the agent CLI underneath), their session store, their models and
// permission modes, and how to name one in `/ferry`. Pure, so the picker, the server and the tests agree.
//
// Two providers continue each other's sessions natively when they are the same CLI reading the same session store:
// custom providers with `extends: "claude"` whose CLAUDE_CONFIG_DIR is the same directory, for instance. Everything
// else gets a handoff.

export type Family = "claude" | "codex" | "pi" | "omp" | "opencode" | "acp" | "plugin" | "other";
/** Paseo's permission tiers, from the most careful to the most permissive. */
export type Tier = "planning" | "safe" | "moderate" | "dangerous";
export const TIERS: readonly Tier[] = ["planning", "safe", "moderate", "dangerous"];

export interface ProviderConfigLike {
  extends?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  env?: Readonly<Record<string, string>> | null;
  paseoTools?: { disabledTools?: readonly string[] | null } | null;
}

export interface SnapshotModelLike {
  id: string;
  label?: string;
  isDefault?: boolean;
  contextWindowMaxTokens?: number | null;
  defaultThinkingOptionId?: string | null;
  thinkingOptions?: readonly { id: string; label?: string; isDefault?: boolean }[] | null;
}

export interface SnapshotModeLike {
  id: string;
  label?: string;
  colorTier?: string | null;
  isUnattended?: boolean;
}

export interface SnapshotEntryLike {
  provider: string;
  status?: string;
  enabled?: boolean;
  source?: string;
  label?: string;
  description?: string;
  defaultModeId?: string | null;
  models?: readonly SnapshotModelLike[] | null;
  modes?: readonly SnapshotModeLike[] | null;
}

export interface ProviderModel {
  id: string;
  label: string;
  isDefault: boolean;
  window: number | null;
  thinking: string[];
  defaultThinking: string | null;
}

export interface ProviderMode {
  id: string;
  label: string;
  tier: Tier;
}

export interface ProviderInfo {
  id: string;
  label: string;
  description: string | null;
  family: Family;
  /** The built-in provider underneath (`extends` followed to its end). */
  base: string;
  source: "builtin" | "custom";
  /** Switched off in Settings → Providers: its conversations can still move away; nothing moves to it. */
  enabled: boolean;
  ready: boolean;
  status: string;
  models: ProviderModel[];
  modes: ProviderMode[];
  defaultModeId: string | null;
  /** The session store shared with others for native continuation; null when there is none to share. */
  storeKey: string | null;
  /** Whether the user switched Paseo tools off for this provider in a way that hides Ferry's history tool. */
  toolDisabled: boolean;
}

/** The provider a custom id stands on, following `extends`: claude-main → claude. A cycle yields null. */
export function baseProvider(id: string, providers: Readonly<Record<string, ProviderConfigLike | undefined>>): string | null {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const parent = providers[current]?.extends?.trim();
    if (!parent) return current;
    current = parent;
  }
}

const KNOWN_FAMILIES: readonly Family[] = ["claude", "codex", "pi", "omp", "opencode", "acp"];

export function familyOf(id: string, providers: Readonly<Record<string, ProviderConfigLike | undefined>>, source?: string): Family {
  const base = baseProvider(id, providers);
  if (base && (KNOWN_FAMILIES as readonly string[]).includes(base)) return base as Family;
  if (base === id && source === "custom") return "plugin";
  return "other";
}

/** The environment variable that names a family's session store, and its default under the home directory. */
export const STORE_ENV: Readonly<Partial<Record<Family, { variable: string; home: string }>>> = {
  claude: { variable: "CLAUDE_CONFIG_DIR", home: ".claude" },
  codex: { variable: "CODEX_HOME", home: ".codex" },
};

/** A setting per provider: "auto" (detect), "isolated" (never continue natively), or a store name of the user's own. */
export type StoreSetting = string;

/**
 * Where a provider keeps its sessions, as a key two providers share exactly when they share the store: the store
 * variable from the provider's own env (following `extends`), else the daemon's, else the family's default directory.
 * Wrapper launchers that set the variable themselves cannot be seen from here; the setting covers them.
 */
export function storeKeyFor(
  id: string,
  family: Family,
  providers: Readonly<Record<string, ProviderConfigLike | undefined>>,
  options: { daemonEnv: Readonly<Record<string, string | undefined>>; home: string; setting?: StoreSetting },
): string | null {
  const setting = options.setting?.trim();
  if (setting === "isolated") return null;
  if (setting && setting !== "auto") return `custom:${setting}`;
  const store = STORE_ENV[family];
  if (!store) return null;
  const seen = new Set<string>();
  let current: string | undefined = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const value = providers[current]?.env?.[store.variable]?.trim();
    if (value) return `${family}:${expandHome(value, options.home)}`;
    current = providers[current]?.extends?.trim();
  }
  const daemon = options.daemonEnv[store.variable]?.trim();
  return `${family}:${daemon ? expandHome(daemon, options.home) : `${options.home.replace(/\/+$/, "")}/${store.home}`}`;
}

/** A store key as people read it: the directory, with the home directory written `~` (or the store's own name). */
export function storeLabel(storeKey: string | null, home: string): string | null {
  if (!storeKey) return null;
  const path = storeKey.slice(storeKey.indexOf(":") + 1);
  const root = home.replace(/\/+$/, "");
  return root && (path === root || path.startsWith(`${root}/`)) ? `~${path.slice(root.length)}` : path;
}

function expandHome(path: string, home: string): string {
  const expanded = path === "~" ? home : path.startsWith("~/") ? `${home.replace(/\/+$/, "")}/${path.slice(2)}` : path;
  return expanded.replace(/\/+$/, "") || "/";
}

/** Whether a conversation on `from` can continue natively on `to`: same CLI, same session store. */
export function sharesStore(source: Pick<ProviderInfo, "id" | "family" | "storeKey">, target: Pick<ProviderInfo, "id" | "family" | "storeKey">): boolean {
  return (
    source.id !== target.id &&
    source.family === target.family &&
    STORE_ENV[source.family] !== undefined &&
    source.storeKey !== null &&
    source.storeKey === target.storeKey
  );
}

/**
 * A mode's tier: Paseo's own when the provider reports one, else read from the mode's name, else `unknown` (moderate
 * for a target's modes; the source's mode passes "safe", so a mode Ferry cannot place never widens what follows).
 */
export function tierOf(mode: SnapshotModeLike, unknown: Tier = "moderate"): Tier {
  if (mode.colorTier && (TIERS as readonly string[]).includes(mode.colorTier)) return mode.colorTier as Tier;
  if (mode.isUnattended) return "dangerous";
  const text = `${mode.id} ${mode.label ?? ""}`.toLowerCase();
  if (/\bplan/.test(text)) return "planning";
  if (/yolo|bypass|full[ _-]?access|danger|allow[ _-]?all|unattended|no[ _-]?approval/.test(text)) return "dangerous";
  if (/edit|auto|accept|agent|workspace|write/.test(text)) return "moderate";
  if (/\bask\b|default|read[ _-]?only|safe|suggest|always/.test(text)) return "safe";
  return unknown;
}

/** Providers from the daemon's config and snapshot: the snapshot's order, then providers only the config knows. */
export function readProviders(
  providers: Readonly<Record<string, ProviderConfigLike | undefined>>,
  entries: readonly SnapshotEntryLike[],
  options: { daemonEnv: Readonly<Record<string, string | undefined>>; home: string; stores?: Readonly<Record<string, StoreSetting>>; toolName: string },
): ProviderInfo[] {
  const ids = [...new Set([...entries.map((entry) => entry.provider), ...Object.keys(providers)])];
  return ids.map((id) => {
    const entry = entries.find((candidate) => candidate.provider === id);
    const config = providers[id];
    const source = entry?.source === "builtin" || (!entry && !config?.extends && KNOWN_FAMILIES.includes(id as Family)) ? "builtin" : "custom";
    const family = familyOf(id, providers, entry?.source ?? (config?.extends ? "custom" : undefined));
    const enabled = entry?.enabled !== false && config?.enabled !== false;
    const status = enabled ? (entry?.status ?? "unknown") : "disabled";
    const disabledTools = config?.paseoTools?.disabledTools ?? [];
    return {
      id,
      label: entry?.label?.trim() || config?.label?.trim() || id,
      description: entry?.description?.trim() || config?.description?.trim() || null,
      family,
      base: baseProvider(id, providers) ?? id,
      source,
      enabled,
      ready: enabled && status === "ready",
      status,
      models: (entry?.models ?? []).map((model) => ({
        id: model.id,
        label: model.label?.trim() || model.id,
        isDefault: model.isDefault === true,
        window: typeof model.contextWindowMaxTokens === "number" && model.contextWindowMaxTokens > 0 ? model.contextWindowMaxTokens : null,
        thinking: (model.thinkingOptions ?? []).map((option) => option.id),
        defaultThinking: model.defaultThinkingOptionId ?? model.thinkingOptions?.find((option) => option.isDefault)?.id ?? null,
      })),
      modes: (entry?.modes ?? []).map((mode) => ({ id: mode.id, label: mode.label?.trim() || mode.id, tier: tierOf(mode) })),
      defaultModeId: entry?.defaultModeId ?? null,
      storeKey: storeKeyFor(id, family, providers, { daemonEnv: options.daemonEnv, home: options.home, setting: options.stores?.[id] }),
      toolDisabled: disabledTools.some((name) => name === options.toolName || name.endsWith(`__${options.toolName}`)),
    };
  });
}

/** The target's model for the conversation's model: the same id, else the same id without a vendor prefix. */
export function equivalentModel(model: string | null | undefined, models: readonly Pick<ProviderModel, "id">[]): string | null {
  if (!model) return null;
  if (models.some((candidate) => candidate.id === model)) return model;
  const tail = (id: string) => id.slice(id.lastIndexOf("/") + 1);
  return models.find((candidate) => tail(candidate.id) === tail(model))?.id ?? null;
}

/** A model of `provider` named by id, a unique id prefix or suffix, or a unique label fragment. */
export function findModel(provider: Pick<ProviderInfo, "models">, wanted: string): ProviderModel | null {
  const text = wanted.trim().toLowerCase();
  if (!text) return null;
  const exact = provider.models.find((model) => model.id.toLowerCase() === text);
  if (exact) return exact;
  for (const test of [
    (model: ProviderModel) => model.id.toLowerCase().startsWith(text) || model.id.toLowerCase().endsWith(`/${text}`),
    (model: ProviderModel) => model.label.toLowerCase().includes(text) || model.id.toLowerCase().includes(text),
  ]) {
    const found = provider.models.filter(test);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) return null;
  }
  return null;
}

export interface TargetMatch {
  provider: ProviderInfo;
  /** A model the user named, when they did. */
  model: ProviderModel | null;
  /** Named exactly (`id` or `id/model`), as opposed to a prefix or a fragment of the label. */
  exact: boolean;
}

/**
 * A provider named by id, `id/model`, a unique id prefix (two characters or more) or a unique label fragment (three or
 * more). Ready providers are searched first, so one switched off does not make a prefix ambiguous; then all of them,
 * so naming one that is off still finds it and can be told why it cannot be used.
 */
export function findProvider(providers: readonly ProviderInfo[], wanted: string): TargetMatch | null {
  const text = wanted.trim();
  if (!text) return null;
  const slash = text.indexOf("/");
  const name = (slash > 0 ? text.slice(0, slash) : text).toLowerCase();
  const modelText = slash > 0 ? text.slice(slash + 1) : "";
  const withModel = (provider: ProviderInfo, exact: boolean): TargetMatch | null => {
    if (!modelText) return { provider, model: null, exact };
    const model = findModel(provider, modelText);
    return model ? { provider, model, exact: exact && model.id.toLowerCase() === modelText.toLowerCase() } : null;
  };
  const exact = providers.find((provider) => provider.id.toLowerCase() === name);
  if (exact) return withModel(exact, true);
  for (const pool of [providers.filter((provider) => provider.ready), providers]) {
    if (name.length >= 2) {
      const prefix = pool.filter((provider) => provider.id.toLowerCase().startsWith(name));
      if (prefix.length === 1) return withModel(prefix[0]!, false);
      if (prefix.length > 1) return null;
    }
    if (name.length >= 3) {
      const labelled = pool.filter((provider) => provider.label.toLowerCase().includes(name) || provider.id.toLowerCase().includes(name));
      if (labelled.length === 1) return withModel(labelled[0]!, false);
      if (labelled.length > 1) return null;
    }
  }
  return null;
}

export interface ParsedCommand {
  /** The target as typed, when the first word named one. */
  target: string | null;
  match: TargetMatch | null;
  message: string;
}

/**
 * `/ferry [to] provider[/model] [message]`. The first word is the target when it names a provider; otherwise the whole
 * text is the message and the picker asks for the target.
 */
export function parseCommand(args: string, providers: readonly ProviderInfo[]): ParsedCommand {
  const text = args.trim().replace(/^(?:to\b|→|->|=>|到|去|切到|换到|交给)\s*/i, "").trim();
  if (!text) return { target: null, match: null, message: "" };
  const space = text.search(/\s/);
  const first = space < 0 ? text : text.slice(0, space);
  const rest = space < 0 ? "" : text.slice(space).trim();
  const match = findProvider(providers, first);
  // Followed by a message, the first word names a provider only exactly: "open the PR" is not OpenCode.
  const named = !rest || (match && match.provider.id.toLowerCase() === first.split("/")[0]!.toLowerCase());
  if (match && named) return { target: first, match, message: rest };
  return { target: null, match: null, message: text };
}

export interface ModeChoice {
  modeId: string | null;
  /** The target only has more permissive modes than the conversation had. */
  escalated: boolean;
  /** The target has no permission modes to choose from. */
  none: boolean;
}

/**
 * The target's permission mode for a conversation in `sourceMode`: the same mode when it is no more permissive,
 * else the most permissive mode that is still no more permissive than the source, else the most careful one (with a
 * warning). Never more permissive when a choice exists.
 */
export function chooseMode(source: { modeId: string | null; tier: Tier | null }, target: Pick<ProviderInfo, "modes" | "defaultModeId">): ModeChoice {
  if (!target.modes.length) return { modeId: null, escalated: false, none: true };
  if (!source.modeId || !source.tier) {
    const fallback = target.modes.find((mode) => mode.id === target.defaultModeId) ?? null;
    return { modeId: fallback?.id ?? null, escalated: false, none: false };
  }
  const rank = (tier: Tier) => TIERS.indexOf(tier);
  const limit = rank(source.tier);
  const same = target.modes.find((mode) => mode.id === source.modeId);
  if (same && rank(same.tier) <= limit) return { modeId: same.id, escalated: false, none: false };
  const allowed = target.modes.filter((mode) => rank(mode.tier) <= limit);
  if (allowed.length) {
    const best = Math.max(...allowed.map((mode) => rank(mode.tier)));
    const tops = allowed.filter((mode) => rank(mode.tier) === best);
    return { modeId: (tops.find((mode) => mode.id === target.defaultModeId) ?? tops[0]!).id, escalated: false, none: false };
  }
  const careful = Math.min(...target.modes.map((mode) => rank(mode.tier)));
  return { modeId: target.modes.find((mode) => rank(mode.tier) === careful)!.id, escalated: true, none: false };
}

/** The target's model: the one named, else the partner setting's, else the equivalent, else its default, else its first. */
export function chooseModel(target: Pick<ProviderInfo, "models">, options: { named?: string | null; partner?: string | null; sourceModel?: string | null }): { modelId: string | null; equivalent: boolean } {
  const has = (id: string | null | undefined) => (id && target.models.some((model) => model.id === id) ? id : null);
  const named = has(options.named) ?? has(options.partner);
  if (named) return { modelId: named, equivalent: true };
  const equivalent = equivalentModel(options.sourceModel, target.models);
  if (equivalent) return { modelId: equivalent, equivalent: true };
  return { modelId: target.models.find((model) => model.isDefault)?.id ?? target.models[0]?.id ?? null, equivalent: false };
}

/** The target model's thinking option for the conversation's: the same, else the model's default. */
export function chooseThinking(model: ProviderModel | null | undefined, sourceThinking: string | null | undefined): { thinkingId: string | null; kept: boolean } {
  if (!model || !model.thinking.length) return { thinkingId: null, kept: !sourceThinking };
  if (sourceThinking && model.thinking.includes(sourceThinking)) return { thinkingId: sourceThinking, kept: true };
  return { thinkingId: model.defaultThinking, kept: !sourceThinking };
}

/** Claude Code session ids are UUIDs; anything that could walk out of a sessions directory is refused. */
export function isSessionId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
}
