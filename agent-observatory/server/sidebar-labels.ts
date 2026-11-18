import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import type { AttentionPhase } from "../shared/attention";
import { getSidebarLabelStatus, type SidebarLabelStatus } from "../shared/alerts";
import { t, type MessageId } from "../shared/text";
import { ensurePrivateDirectory } from "./paseo-home";
import type { PaseoApi } from "./paseo-types";
import { bridgeErrorCode, type ProviderBridge } from "./provider-subagents";
import { telemetryDirectory } from "./telemetry";

/** The colours the host's labels come in (`@getpaseo/protocol` WORKSPACE_LABEL_COLORS, Paseo 0.11.1). */
export type LabelColor = "violet" | "sky" | "emerald" | "orange" | "pink" | "indigo" | "teal" | "red" | "amber" | "blue";
/** Each 需要处理 phase as a label: its words (in the plugin's language when written) and the host colour nearest the observatory's. */
const LABELS: Record<AttentionPhase, { id: MessageId; color: LabelColor }> = {
  approval: { id: "alertsLabels.approval", color: "amber" },
  question: { id: "alertsLabels.question", color: "violet" },
  plan: { id: "alertsLabels.plan", color: "amber" },
  error: { id: "alertsLabels.error", color: "red" },
  quota: { id: "alertsLabels.quota", color: "orange" },
  silent: { id: "alertsLabels.silent", color: "amber" },
  unfinished: { id: "alertsLabels.unfinished", color: "amber" },
  looping: { id: "alertsLabels.looping", color: "orange" },
  stuck: { id: "alertsLabels.stuck", color: "amber" },
  idle: { id: "alertsLabels.idle", color: "violet" },
  unread: { id: "alertsLabels.unread", color: "pink" },
};
export interface WorkspaceLabel { name: string; color: LabelColor }
export const labelOf = (phase: AttentionPhase): WorkspaceLabel => ({ name: t(LABELS[phase].id), color: LABELS[phase].color });
/** The host's own rule for telling label names apart (`workspaceLabelKey`): whitespace collapsed, case ignored. */
export const labelKey = (name: string) => name.replace(/\s+/g, " ").trim().toLowerCase();
const colorOf = (name: string): LabelColor => (Object.keys(LABELS) as AttentionPhase[]).map(labelOf).find(label => labelKey(label.name) === labelKey(name))?.color ?? "amber";
/** Whether a name is one the plugin writes now (in its current language). */
const currentName = (name: string) => (Object.keys(LABELS) as AttentionPhase[]).some(phase => labelKey(labelOf(phase).name) === labelKey(name));

/** What the plugin needs from the host: a workspace's labels and pin, its label catalog, and the label and pin writes. */
export interface LabelHost {
  /** The workspace's labels in order, its pin and whether it is a background workspace (Paseo 0.12+); null when it is gone. */
  workspace(id: string): Promise<{ labels: string[]; pinnedAt: string | null; background?: boolean } | null>;
  /** The names of the host's labels (the catalog the label picker lists). */
  catalog(): Promise<string[]>;
  assign(workspaceId: string, label: WorkspaceLabel, assigned: boolean): Promise<void>;
  /** Pins or unpins; the pin time the host recorded, or null. */
  pin(workspaceId: string, pinned: boolean): Promise<string | null>;
  /** How many workspaces carry a label (before a catalog entry is removed). */
  affected(name: string): Promise<number>;
  remove(name: string): Promise<void>;
}

/**
 * The host's label and pin requests (`workspace.label.*`, `workspace.pin.set`) over the plugin's own session (the process
 * bridge): Paseo 0.11.1's plugin API has none. Both need the session's `workspace.manage`, which a plugin session has.
 */
export function bridgeLabelHost(bridge: Pick<ProviderBridge, "request">, paseo: PaseoApi): LabelHost {
  const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    async workspace(id) {
      const workspace = await paseo.workspaces.ref(id).refresh();
      return workspace ? { labels: (workspace.labels ?? []).filter((name): name is string => typeof name === "string"), pinnedAt: workspace.pinnedAt ?? null,
        ...("background" in workspace && workspace.background === true ? { background: true } : {}) } : null;
    },
    async catalog() {
      const payload = await bridge.request({ type: "workspace.label.list.request" }, "workspace.label.list.response");
      if (!Array.isArray(payload.labels)) throw new Error("unexpected label list");
      return payload.labels.map(label => String(record(label).name ?? "")).filter(Boolean);
    },
    async assign(workspaceId, label, assigned) {
      await bridge.request({ type: "workspace.label.assignment.set.request", workspaceId, label, assigned }, "workspace.label.assignment.set.response");
    },
    async pin(workspaceId, pinned) {
      const payload = await bridge.request({ type: "workspace.pin.set.request", workspaceId, pinned }, "workspace.pin.set.response");
      if (payload.accepted === false) throw new Error(typeof payload.error === "string" ? payload.error : "pin refused");
      return typeof payload.pinnedAt === "string" ? payload.pinnedAt : null;
    },
    async affected(name) {
      const payload = await bridge.request({ type: "workspace.label.delete.inspect.request", name }, "workspace.label.delete.inspect.response");
      return typeof payload.affectedWorkspaceCount === "number" ? payload.affectedWorkspaceCount : Number.POSITIVE_INFINITY;
    },
    async remove(name) { await bridge.request({ type: "workspace.label.delete.request", name }, "workspace.label.delete.response"); },
  };
}

/**
 * What the plugin wrote, kept across reloads (`sidebar-labels.json`): per workspace the label names it assigned and the pin it
 * set (by the pin time the host confirmed, so a pin the user made again is theirs), and the catalog names it created. Nothing
 * else is ever removed: a label the user typed, or had before, is not the plugin's.
 */
interface Owned { version: 1; labels: Record<string, string[]>; pins: Record<string, string>; created: string[] }
const empty = (): Owned => ({ version: 1, labels: {}, pins: {}, created: [] });
const MAX_FILE = 1024 * 1024, MAX_WORKSPACES = 2_000, MAX_NAMES = 8;
function ownedOf(value: unknown): Owned {
  const raw = value as Partial<Owned> | null;
  if (!raw || raw.version !== 1) return empty();
  const names = (list: unknown) => Array.isArray(list) ? list.filter((name): name is string => typeof name === "string" && name.length <= 200).slice(0, MAX_NAMES) : [];
  const labels: Record<string, string[]> = {}, pins: Record<string, string> = {};
  for (const [id, list] of Object.entries(raw.labels ?? {}).slice(0, MAX_WORKSPACES)) if (id.length <= 256 && names(list).length) labels[id] = names(list);
  for (const [id, at] of Object.entries(raw.pins ?? {}).slice(0, MAX_WORKSPACES)) if (id.length <= 256 && typeof at === "string" && at.length <= 64) pins[id] = at;
  return { version: 1, labels, pins, created: Array.isArray(raw.created) ? raw.created.filter((name): name is string => typeof name === "string" && name.length <= 200).slice(0, 64) : [] };
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error ?? "")).slice(0, 300);
/** The host no longer has the workspace (deleted, archived): what the plugin owned there is gone with it. */
const gone = (error: unknown) => /not found|workspace_not_found/i.test(errorText(error));
/** A daemon without the label requests (or one that turned them off). */
const unsupported = (error: unknown) => /unknown (message|request|type)|unsupported|unavailable|invalid_request|not supported|no handler/i.test(errorText(error));
/** Why a file write failed, as a code only (ENOSPC, EACCES…): no path in what the settings show. */
const failureCode = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^E[A-Z0-9]{2,20}$/.test(code) ? code : error instanceof Error ? error.name.slice(0, 40) : "error";
};
/** Nothing new goes to the host while what the plugin owns cannot be kept: without the file it could never take it back. */
const persistFailure = (reason: string) => Object.assign(new Error(t("alertsLabels.persistFailed", { reason })), { persistFailure: true });
const isPersistFailure = (error: unknown) => (error as { persistFailure?: unknown } | null)?.persistFailure === true;
/**
 * What the settings show for a failed request: the host's own error, or (by the bridge's code, never its wording, which is about
 * subtasks) that Paseo did not answer or that nothing was sent.
 */
const describe = (error: unknown) => {
  const code = bridgeErrorCode(error);
  return code === "timeout" || code === "closed" ? t("alertsLabels.noAnswer") : code === "busy" || code === "disposed" ? t("alertsLabels.notSent") : errorText(error);
};

export interface SidebarLabelOptions {
  /** The host, once the plugin has a daemon handle (from any call or hook); null before. */
  host(): LabelHost | null;
  /** Each workspace's most urgent phase by the badge's rules (server/attention.ts `workspaces`); null without a daemon handle. */
  waiting(): Promise<{ phases: Map<string, AttentionPhase>; ready: boolean; known: boolean } | null>;
  file?: string;
  /** Debounce after a change (default 2.5 s); a safety pass also runs every minute while on. */
  delayMs?: number;
  log?: (message: string) => void;
}
/** At most this many workspaces are written per pass; the rest follow in the next one. */
const PER_PASS = 12;

/**
 * 同步到侧栏标签 (sidebar-organizer's idea, 2.17): each workspace's 需要处理 reason as one of the host's own workspace labels, in the
 * observatory's colours, removed once the reason clears; optionally the workspace pinned while it waits for you. Only what the
 * reasons say changes is written, a dozen workspaces a pass, debounced; only labels and pins the plugin made are ever taken away
 * (kept in a file, so a reload remembers them). Labels the user typed stay where they are, before the plugin's: a label of
 * the plugin's that ended up before one of theirs is put back after it when the plugin next writes that workspace. Turning it
 * off takes the plugin's labels and pins away again, and the catalog entries it created that no workspace uses.
 */
export class SidebarLabels {
  private settings = { labels: false, pin: false };
  private owned: Owned = empty();
  private readonly loaded: Promise<void>;
  private readonly file: string;
  /**
   * The reason each workspace was last brought to (null: none); a workspace whose reason did not change is not written, not even
   * when the plugin's language changed meanwhile (devices in two languages would otherwise rename labels back and forth): its
   * label takes the new language with the next reason, or after a reload.
   */
  private readonly applied = new Map<string, AttentionPhase | null>();
  private state: SidebarLabelStatus["state"] = "off";
  private error: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private writing: Promise<void> = Promise.resolve();
  private probedAt = Number.NEGATIVE_INFINITY;
  /** Why the ownership file could not be written the last time (an error code); null once a write worked again. */
  private persistError: string | null = null;

  constructor(private readonly options: SidebarLabelOptions) {
    this.file = options.file ?? join(telemetryDirectory(), "sidebar-labels.json");
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    try {
      if ((await stat(this.file)).size > MAX_FILE) throw new Error("too large");
      this.owned = ownedOf(JSON.parse(await readFile(this.file, "utf8")));
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") this.options.log?.(`sidebar labels: ownership file unreadable (${error instanceof Error ? error.name : "error"}); starting over`);
      this.owned = empty();
    }
  }
  /** Writes the ownership file (atomically, 0600); false when it could not be written, the reason kept for the status. */
  private save(): Promise<boolean> {
    const text = `${JSON.stringify(this.owned)}\n`;
    const attempt = this.writing.then(async () => {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await ensurePrivateDirectory(join(this.file, ".."));
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
        this.persistError = null;
        return true;
      } catch (error) {
        this.persistError = failureCode(error);
        this.options.log?.(`sidebar labels: could not save the ownership file (${this.persistError})`);
        return false;
      } finally { await rm(temporary, { force: true }).catch(() => {}); }
    });
    this.writing = attempt.then(() => undefined);
    return attempt;
  }
  /** Around anything new written to the host: what the plugin owns is on disk, or the pass stops writing (persistFailure). */
  private async saveOrStop(): Promise<void> {
    if (!(await this.save())) throw persistFailure(this.persistError ?? "error");
  }
  private hasOwned(): boolean {
    return Object.keys(this.owned.labels).length > 0 || Object.keys(this.owned.pins).length > 0 || this.owned.created.length > 0;
  }

  /** The settings changed (or were read): start, stop (cleaning up) or re-check the pins. */
  configure(next: { labels: boolean; pin: boolean }): void {
    const before = this.settings;
    this.settings = { ...next };
    if (next.labels && !before.labels) { this.state = "starting"; this.error = null; this.applied.clear(); }
    if (next.pin !== before.pin) this.applied.clear();
    if (next.labels && !this.interval) { this.interval = setInterval(() => this.poke(), 60_000); this.interval.unref?.(); }
    if (!next.labels && this.interval) { clearInterval(this.interval); this.interval = null; }
    if (!next.labels) this.state = "off";
    this.poke(0);
  }
  /** Something may have changed: a pass after the debounce (one at a time; another follows if asked meanwhile). */
  poke(delay = this.options.delayMs ?? 2_500): void {
    if (this.closed || this.timer) return;
    if (!this.settings.labels && !this.hasOwned() && delay !== 0) return;
    this.timer = setTimeout(() => { this.timer = null; void this.pass(); }, delay);
    this.timer.unref?.();
  }
  status(): SidebarLabelStatus {
    const labels = Object.values(this.owned.labels).reduce((sum, names) => sum + names.length, 0), pins = Object.keys(this.owned.pins).length;
    // The ownership file cannot be written: shown until a write works again (nothing new is written to the host meanwhile).
    if (this.settings.labels && this.persistError) return { state: "error", labels, pins, error: t("alertsLabels.persistFailed", { reason: this.persistError }) };
    return { state: this.state, labels, pins, error: this.error };
  }

  /** One pass: bring changed workspaces to their reason's label (or clean up while off). Exposed for tests. */
  pass(): Promise<void> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.passNow().catch(error => { this.state = this.settings.labels ? "error" : "off"; this.error = describe(error); }).finally(() => {
      this.running = null;
      if (this.again && !this.closed) { this.again = false; this.poke(); }
    });
    return this.running;
  }

  private async passNow(): Promise<void> {
    await this.loaded;
    const host = this.options.host();
    if (!host || this.closed) return;
    if (!this.settings.labels) { if (this.hasOwned()) await this.cleanup(host); return; }
    // Whether this daemon takes the label requests at all: asked when starting and after a failure (a daemon without them at
    // most every ten minutes); the catalog read is harmless.
    if (this.state !== "on") {
      if (this.state === "unsupported" && Date.now() - this.probedAt < 10 * 60_000) return;
      this.probedAt = Date.now();
      try { await host.catalog(); }
      catch (error) {
        if (unsupported(error)) { this.state = "unsupported"; this.error = null; return; }
        throw error;
      }
    }
    const view = await this.options.waiting();
    if (!view?.ready) return;
    this.state = "on"; this.error = null;
    // The host's catalog, read once a pass and only when a label is about to be added: a new name there is one the plugin created.
    let names: Set<string> | null = null;
    const catalog = async () => names ??= new Set((await host.catalog()).map(labelKey));
    const targets = new Map<string, AttentionPhase | null>();
    for (const [workspaceId, phase] of view.phases) targets.set(workspaceId, phase);
    // A workspace no Agent waits in is cleared only when the whole directory was read: missing from a cut read proves nothing.
    if (view.known) for (const workspaceId of new Set([...Object.keys(this.owned.labels), ...Object.keys(this.owned.pins), ...this.applied.keys()])) if (!targets.has(workspaceId)) targets.set(workspaceId, null);
    let written = 0;
    for (const [workspaceId, phase] of targets) {
      if (this.closed || !this.settings.labels) return;
      if (this.applied.has(workspaceId) && this.applied.get(workspaceId) === phase) continue;
      if (phase === null && !this.owned.labels[workspaceId] && !this.owned.pins[workspaceId]) { this.applied.set(workspaceId, null); continue; }
      if (written >= PER_PASS) { this.again = true; return; }
      written++;
      try { await this.reconcile(host, workspaceId, phase ? labelOf(phase) : null, catalog); this.applied.set(workspaceId, phase); }
      catch (error) {
        // The ownership file cannot be written: the pass stops, the status says why, the next pass tries the file again.
        if (isPersistFailure(error)) return;
        if (gone(error)) { this.forget(workspaceId); await this.save(); continue; }
        if (unsupported(error)) { this.state = "unsupported"; return; }
        this.error = describe(error);
        this.options.log?.(`sidebar labels: ${workspaceId}: ${this.error}`);
      }
    }
  }

  private forget(workspaceId: string): void { delete this.owned.labels[workspaceId]; delete this.owned.pins[workspaceId]; this.applied.delete(workspaceId); }
  private setOwned(workspaceId: string, names: string[]): void { if (names.length) this.owned.labels[workspaceId] = names.slice(0, MAX_NAMES); else delete this.owned.labels[workspaceId]; }

  /** One workspace to its label (or none) and pin, touching only the plugin's own. */
  private async reconcile(host: LabelHost, workspaceId: string, want: WorkspaceLabel | null, catalog: () => Promise<Set<string>>): Promise<void> {
    const current = await host.workspace(workspaceId);
    if (!current) { this.forget(workspaceId); await this.save(); return; }
    // A background workspace is not in the sidebar (显示后台工作区 only lists its Agents): no label or pin of the plugin's goes there.
    if (current.background) want = null;
    const has = (name: string) => current.labels.some(present => labelKey(present) === labelKey(name));
    const owned = this.owned.labels[workspaceId] ?? [], mine = (name: string) => owned.some(own => labelKey(own) === labelKey(name));
    // A label of the plugin's the user took off is the user's decision: forgotten, not put back for the same reason.
    const kept = owned.filter(has);
    if (kept.length !== owned.length) { this.setOwned(workspaceId, kept); await this.save(); }
    const remove = kept.filter(name => !want || labelKey(name) !== labelKey(want.name));
    // The user's labels stay in front: one of theirs after the plugin's label moves the plugin's to the end.
    let readd = false;
    if (want && kept.some(name => labelKey(name) === labelKey(want.name))) {
      const at = current.labels.findIndex(present => labelKey(present) === labelKey(want.name));
      readd = current.labels.slice(at + 1).some(present => !mine(present));
    }
    for (const name of readd && want ? [...remove, want.name] : remove) {
      await host.assign(workspaceId, { name, color: colorOf(name) }, false);
      this.setOwned(workspaceId, (this.owned.labels[workspaceId] ?? []).filter(own => labelKey(own) !== labelKey(name)));
      await this.save();
      await this.dropStale(host, name);
    }
    // A label of the same name the user already has there is theirs: nothing to add, nothing owned.
    if (want && (readd || !has(want.name))) {
      const known = await catalog(), created = !known.has(labelKey(want.name));
      // Owned (on disk) before it is written, and kept when the write fails: an answer that never came may have come with the
      // label on, and the next pass drops the name unless the host has it. One the file cannot record is not written at all.
      this.setOwned(workspaceId, [...(this.owned.labels[workspaceId] ?? []), want.name]);
      if (created && !this.owned.created.some(name => labelKey(name) === labelKey(want.name))) this.owned.created.push(want.name);
      if (!(await this.save())) {
        this.setOwned(workspaceId, (this.owned.labels[workspaceId] ?? []).filter(own => labelKey(own) !== labelKey(want.name)));
        throw persistFailure(this.persistError ?? "error");
      }
      await host.assign(workspaceId, want, true);
      if (created) known.add(labelKey(want.name));
    }
    const pinned = this.owned.pins[workspaceId];
    if (want && this.settings.pin) {
      // Pinned already (by the user, or by the plugin before): left as it is.
      if (!current.pinnedAt) {
        // The plugin's only once the host confirms it, by the pin time it answers with: one whose answer never came is not
        // claimed (it may stay pinned after the reason clears, for the user to unpin), so a pin the user makes meanwhile is
        // never taken for the plugin's. The file must be writable first: a pin it could not record is not made.
        await this.saveOrStop();
        const at = await host.pin(workspaceId, true);
        if (at) { this.owned.pins[workspaceId] = at; await this.saveOrStop(); }
      }
    } else if (pinned !== undefined) {
      // Only the plugin's own pin is undone: one the user took off, or pinned again since, is theirs.
      if (current.pinnedAt === pinned) await host.pin(workspaceId, false);
      delete this.owned.pins[workspaceId]; await this.save();
    }
  }

  /**
   * A catalog entry the plugin created in a language it no longer writes in (its language changed): removed from the label
   * picker once no workspace carries it. Best effort; the rest go when the sync is turned off.
   */
  private async dropStale(host: LabelHost, name: string): Promise<void> {
    if (currentName(name) || !this.owned.created.some(own => labelKey(own) === labelKey(name))) return;
    try {
      if (await host.affected(name) !== 0) return;
      await host.remove(name);
      this.owned.created = this.owned.created.filter(own => labelKey(own) !== labelKey(name)); await this.save();
    } catch (error) { this.options.log?.(`sidebar labels: could not remove an old label from the catalog (${errorText(error)})`); }
  }

  /** Off: every label and pin the plugin made comes off, and the catalog entries it created that no workspace uses. */
  private async cleanup(host: LabelHost): Promise<void> {
    for (const [workspaceId, names] of Object.entries(this.owned.labels)) {
      if (this.closed || this.settings.labels) return;
      let current: Awaited<ReturnType<LabelHost["workspace"]>>;
      try { current = await host.workspace(workspaceId); } catch { continue; }
      for (const name of names) {
        if (!current?.labels.some(present => labelKey(present) === labelKey(name))) continue;
        try { await host.assign(workspaceId, { name, color: colorOf(name) }, false); } catch (error) { if (!gone(error)) throw error; }
      }
      delete this.owned.labels[workspaceId]; await this.save();
    }
    for (const [workspaceId, at] of Object.entries(this.owned.pins)) {
      if (this.closed || this.settings.labels) return;
      let current: Awaited<ReturnType<LabelHost["workspace"]>>;
      try { current = await host.workspace(workspaceId); } catch { continue; }
      if (current?.pinnedAt === at) { try { await host.pin(workspaceId, false); } catch (error) { if (!gone(error)) throw error; } }
      delete this.owned.pins[workspaceId]; await this.save();
    }
    for (const name of [...this.owned.created]) {
      if (this.closed || this.settings.labels) return;
      // Removing a catalog entry takes it off every workspace: only one that no workspace carries is removed.
      try { if (await host.affected(name) === 0) await host.remove(name); } catch (error) { if (!unsupported(error) && !gone(error)) throw error; }
      this.owned.created = this.owned.created.filter(own => own !== name); await this.save();
    }
    this.applied.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null; this.interval = null;
    await this.running?.catch(() => {});
    await this.writing;
  }
}

/** `observatory.alerts.labels`: what the settings show next to the switch. */
export function registerSidebarLabels(server: Pick<PluginServerContext, "handle">, labels: SidebarLabels): void {
  server.handle(getSidebarLabelStatus, () => labels.status());
}
