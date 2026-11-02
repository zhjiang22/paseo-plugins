import type { Dirent, Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate as yieldLoop } from "node:timers/promises";
import { GROK_USAGE_FILE, initialParser, subagentParent } from "./parser";
import { HERMES_DB_FILE, isHermesDb, readHermesStateDb } from "./hermes-db";
import { isMimoDb, isOpendencodeDb, MIMO_DB_FILE, OPENCODE_DB_FILE, readOpendencodeDb } from "./opencode-db";
import { readFirstLine, tailFile } from "./reader";
import { defaultRoots, isInsightDirectory, MAX_ROOTS } from "./roots";
import { DAY, safeError, type Backfill, type CallSink, type Candidate, type LedgerCall, type LogFile, type LogRoot, type ParserState } from "./types";
import { TOKEN_IMPORT_LIMITS, type TokenImportLimits } from "../../shared/tokens";
/** Work and memory budgets (TOKEN_IMPORT_LIMITS): logs tracked, their total bytes, dedupe keys and directory entries per scan. */
export type IngesterLimits = TokenImportLimits;
export interface IngesterTruncation { files: boolean; bytes: boolean; index: boolean; scan: boolean }
export interface IngesterOptions {
  roots?: LogRoot[]; now?: () => number; limits?: Partial<IngesterLimits>;
  onCall: (call: LedgerCall, previous: LedgerCall | null) => void;
  /** A distinct next response closes the previous call; EOF stays open for later blocks. */
  onSettle?: (call: LedgerCall) => void;
  onChange?: () => void;
  /** A Codex subagent thread and the thread that spawned it (repeated on every read of its rollout; cheap to ignore). */
  onThread?: (child: string, parent: string) => void;
}

/**
 * Dedupe keys are kept this long. Past the floor an unseen call can only be copied history (a resumed or forked session
 * re-writes old lines with their original timestamps), so it is dropped instead of being counted twice.
 */
const SEEN_DAYS = 60;
/** Session ids whose lost logs are remembered (`noteLoss`); past it the oldest go, and what they covered can no longer be vouched for. */
const MAX_LOSSES = 20_000;

/** A Cline / Roo / Kilo task transcript: `ui_messages.json` inside the task's directory. */
const isTaskMessages = (source: LogRoot["source"], name: string): boolean =>
  (source === "cline" || source === "roo" || source === "kilo") && name === "ui_messages.json";
/**
 * Which files of a root are logs: Claude Code and Pi write one `.jsonl` per session, Codex `rollout-*.jsonl`. Grok
 * keeps a directory per session and is walked apart (`scanGrok`). Cline / Roo / Kilo write one `ui_messages.json`
 * per task, walked normally.
 */
const isLog = (source: LogRoot["source"], name: string): boolean =>
  source === "zcode" ? name === "db.sqlite" : source === "kimi" ? name === "wire.jsonl"
  : name.endsWith(".jsonl") && (source !== "codex" || name.startsWith("rollout-")) || isTaskMessages(source, name)
  || (source === "dsh" && name === "ledger.json");
/** A sub-agent's log (`<session>/subagents/<agent>.jsonl`): its parent session's, never the place a prompt is logged. */
const subagentLog = (source: LogRoot["source"], path: string): boolean => (source === "claude" || source === "codebuddy") && basename(dirname(path)) === "subagents";
/** A Grok session group's working directory, from its URL-encoded name; null when the name is not one (a long cwd's slug). */
function grokGroupCwd(name: string): string | null {
  try { const cwd = decodeURIComponent(name); return isAbsolute(cwd) ? cwd : null; } catch { return null; }
}

/** Owns file cursors and the global, persisted 64-bit dedupe index, not a full call history. */
export class TokenIngester {
  readonly roots: Array<LogRoot & { files: number; error: string | null }>;
  /** The roots given at construction (the standard ones); roots appended later come from provider configs. */
  readonly baseRoots: number;
  /**
   * Roots added after the first import (a custom provider's config directory, a source an upgrade added) that no scan has listed yet.
   * What such a root holds when first listed was never seen: those logs (`freshFiles`) import calls past `seenFloor`. The root leaves
   * the set at that scan; logs that appear in it later are deduplicated like any other, so a session resumed or forked from one older
   * than the dedupe window does not count the turns it copies again (r3-F2).
   */
  private readonly lateRoots = new Set<number>();
  /** Logs found at their late root's first listing, until their first import ends. */
  private readonly freshFiles = new Set<string>();
  readonly files = new Map<string, LogFile>();
  readonly seen = new Map<string, number>();
  /** Keys older than this were pruned from `seen`; null until the first prune after the initial import. */
  seenFloor: number | null = null;
  readonly backfill: Backfill = { done: false, files: 0, filesDone: 0, bytes: 0, bytesDone: 0 };
  readonly diagnostics = { calls: 0, duplicates: 0, corrections: 0, bytesRead: 0 };
  readonly limits: IngesterLimits;
  /** Which budget cut the last scan (files, bytes, scan) or the dedupe index (until the plugin restarts). */
  readonly truncated: IngesterTruncation = { files: false, bytes: false, index: false, scan: false };
  /**
   * What 恢复后续跑's 「确认没有」 needs to know of the index (./source.ts `findMarker`; codex-obs-resume-recheck5-F1, F2), kept by
   * the scans the ledger makes anyway; no scan is ever made for a question. `scanned`: the last scan to end (when it began,
   * whether a budget cut it). `clean`: per source, when the last scan began that listed every root of that source whole with no
   * budget cut. A root added drops `scanned` and its source's `clean` until a scan lists it; a scan going on when it is added
   * lists it too, its walk reading the roots as it reaches them (codex-obs-resume-recheck6-F1). `losses`: per session id, when
   * one of its logs last left the index (deleted, a symlink now, its root gone) or lost what the index had read of it (replaced,
   * cut short; noted as the read that finds it starts over, `read`); `rootLosses`: per source, when a root listed before could
   * not be listed any more (gone or unreadable). `linked`: the session ids one of whose logs is a symlink (or not a regular file), and
   * the sources a root of which holds a symlinked directory, at the last scan: logs that are never read. Nothing is known of
   * losses before this ingester began watching, nor of those past MAX_LOSSES (`lossFloor`).
   */
  private scanned: { startedAt: number; cut: boolean } | null = null;
  private readonly clean = new Map<LogRoot["source"], number>();
  private readonly losses = new Map<string, number>();
  private readonly rootLosses = new Map<LogRoot["source"], number>();
  private linked: { ids: Set<string>; sources: Set<LogRoot["source"]> } = { ids: new Set(), sources: new Set() };
  private lossFloor: number;
  /** Roots this ingester has listed: one not listed later was lost (`rootLosses`); an optional root never there was not. */
  private readonly listedRoots = new Set<number>();
  private readonly now: () => number;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly options: IngesterOptions) {
    this.now = options.now ?? Date.now;
    this.limits = { ...TOKEN_IMPORT_LIMITS, ...options.limits };
    this.roots = (options.roots ?? defaultRoots()).slice(0, MAX_ROOTS).map(root => ({ ...root, files: 0, error: null }));
    this.baseRoots = this.roots.length;
    this.lossFloor = this.now();
  }
  /**
   * Appends roots (never reorders: saved files refer to roots by index) and skips paths already watched. `late`
   * roots appear after the first import; nothing in them was seen before, so the logs they hold when first listed
   * keep calls older than the dedupe window instead of treating them as copied history. Returns how many were added.
   */
  addRoots(roots: readonly LogRoot[], late = true): number {
    let added = 0;
    for (const root of roots) {
      if (this.roots.length >= MAX_ROOTS) break;
      if (this.roots.some(other => resolve(other.path) === resolve(root.path))) continue;
      this.roots.push({ source: root.source, path: root.path, ...(root.provider ? { provider: root.provider } : {}), files: 0, error: null });
      if (late) this.lateRoots.add(this.roots.length - 1);
      // Not listed yet: neither its source nor the roots as a whole are, until a scan lists it (codex-obs-resume-recheck6-F1).
      this.clean.delete(root.source); this.scanned = null;
      added++;
    }
    return added;
  }
  /**
   * After restoring a ledger saved by a version that did not watch some of today's roots (2.14 adds Grok and Pi): those
   * roots were never imported, so like roots found later, what they hold when first listed keeps calls past the dedupe window.
   */
  markNewRoots(saved: readonly LogRoot[]): void {
    for (const [index, root] of this.roots.entries()) {
      if (!saved.some(other => other.source === root.source && resolve(other.path) === resolve(root.path))) this.lateRoots.add(index);
    }
  }
  private changed(): void { this.options.onChange?.(); }
  private consume(candidate: Candidate, previous: Candidate | null, phase: "original" | "fork" | "all", settled?: Candidate | null, fresh = false): void {
    if (settled?.accepted) this.options.onSettle?.(settled.call);
    const call = candidate.call;
    if (call.at < this.now() - 400 * DAY || call.at > this.now() + DAY) return;
    if ((phase === "original" && candidate.forked) || (phase === "fork" && !candidate.forked)) return;
    if (previous?.accepted && previous.call.key === call.key) {
      candidate.accepted = true;
      if (call.at === previous.call.at && call.start === previous.call.start && call.output === previous.call.output && call.reasoning === previous.call.reasoning &&
          call.input === previous.call.input && call.cacheRead === previous.call.cacheRead && call.cacheWrite === previous.call.cacheWrite && call.model === previous.call.model) { this.diagnostics.duplicates++; return; }
      this.seen.set(call.key, call.at); this.diagnostics.corrections++;
      this.options.onCall(call, previous.call); this.changed(); return;
    }
    if (this.seen.has(call.key) || (!fresh && this.seenFloor !== null && call.at < this.seenFloor)) { this.diagnostics.duplicates++; return; }
    this.seen.set(call.key, call.at); candidate.accepted = true; this.diagnostics.calls++;
    if (this.seen.size > this.limits.index) this.trimSeen();
    this.options.onCall(call, null); this.changed();
  }
  /**
   * Keeps the newest 90 % of the index cap. Calls older than the oldest key kept are then treated like expired keys:
   * copied history, dropped instead of counted again.
   */
  private trimSeen(): void {
    const times = [...this.seen.values()].sort((a, b) => b - a), floor = times[Math.max(0, Math.floor(this.limits.index * 0.9) - 1)];
    for (const [key, at] of this.seen) if (at < floor) this.seen.delete(key);
    this.seenFloor = Math.max(this.seenFloor ?? floor, floor);
    this.truncated.index = true;
  }
  /**
   * Directory traversal ignores symlinks and tolerates vanished/unreadable entries. It visits at most `scanEntries`
   * entries; new logs are admitted newest first while the file and byte budgets last. A walk cut short keeps the
   * files it did not reach.
   */
  async scan(): Promise<LogFile[]> {
    const added: LogFile[] = [], found = new Set<string>(), late = new Set<number>(), startedAt = this.now();
    const linked: { ids: Set<string>; sources: Set<LogRoot["source"]> } = { ids: new Set(), sources: new Set() };
    let candidates: Array<{ path: string; root: number; source: LogRoot["source"]; details: Stats }> = [];
    let lastYield = performance.now(), visited = 0, stopped = false;
    for (const [rootIndex, root] of this.roots.entries()) {
      root.files = 0; root.error = null;
      // Read when the walk reaches the root: one appended while a scan runs (provider discovery) is late from that walk on.
      if (this.lateRoots.has(rootIndex)) late.add(rootIndex);
      let listed = false;
      const list = async (path: string): Promise<Dirent[] | null> => {
        try { const entries = await readdir(path, { withFileTypes: true }); if (path === root.path) listed = true; return entries; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); return null; }
      };
      const visit = (): boolean => { if (stopped || ++visited > this.limits.scanEntries) stopped = true; return !stopped; };
      const pause = async () => { if (performance.now() - lastYield >= 20) { await yieldLoop(); lastYield = performance.now(); } };
      const note = async (child: string, known?: Stats): Promise<void> => {
        found.add(child); root.files++;
        if (this.files.has(child)) return;
        try { const details = known ?? await lstat(child); if (details.isFile()) candidates.push({ path: child, root: rootIndex, source: root.source, details }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); }
      };
      const walk = async (path: string, depth: number): Promise<void> => {
        const entries = await list(path);
        for (const entry of entries ?? []) {
          if (!visit()) return;
          const child = join(path, entry.name);
          if (entry.isDirectory() && depth < 12) await walk(child, depth + 1);
          else if (entry.isFile() && isLog(root.source, entry.name)) await note(child);
          // Never followed: a log that is a symlink (or a pipe) is one of its session's that is never read; a symlinked directory
          // may hold any session's.
          else if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
            if (isLog(root.source, entry.name)) { if (!subagentLog(root.source, child)) linked.ids.add(initialParser(child, null, root.source).sessionId); }
            else linked.sources.add(root.source);
          }
          await pause();
        }
      };
      // Grok: `<encoded cwd>/<session>/usage.json`. Only that file is ever opened (never the conversation logs next to
      // it), and the observatory's own analysis sessions are skipped whole.
      const scanGrok = async (): Promise<void> => {
        for (const group of await list(root.path) ?? []) {
          if (!visit()) return;
          const cwd = grokGroupCwd(group.name);
          if (!group.isDirectory() || (cwd !== null && isInsightDirectory(cwd))) continue;
          for (const session of await list(join(root.path, group.name)) ?? []) {
            if (!visit()) return;
            if (session.isDirectory()) {
              const usage = join(root.path, group.name, session.name, GROK_USAGE_FILE);
              let details: Stats | null = null;
              try { details = await lstat(usage); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); }
              if (details?.isFile()) await note(usage, details);
            }
            await pause();
          }
        }
      };
      // OpenCode: the database (`opencode.db`, ≥ 1.2) holds every session; the legacy `storage/message/<session>/<message>.json`
      // tree (before 1.2, and what a migration can leave behind) is read beside it. The message ids both carry deduplicate them.
      const scanOpenCode = async (): Promise<void> => {
        const database = join(root.path, OPENCODE_DB_FILE);
        let details: Stats | null = null;
        try { details = await lstat(database); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); }
        if (details?.isFile()) { if (!visit()) return; await note(database, details); }
        const legacy = join(root.path, "storage", "message");
        for (const session of await list(legacy) ?? []) {
          if (!visit() || !session.isDirectory()) continue;
          for (const message of await list(join(legacy, session.name)) ?? []) {
            if (!visit()) return;
            if (!message.name.endsWith(".json")) continue;
            const path = join(legacy, session.name, message.name);
            let stats: Stats | null = null;
            try { stats = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); }
            if (stats?.isFile()) await note(path, stats);
            await pause();
          }
          await pause();
        }
      };
      // MiMoCode: just its OpenCode-shaped database (no legacy tree).
      const scanMimo = async (): Promise<void> => {
        const database = join(root.path, MIMO_DB_FILE);
        let details: Stats | null = null;
        try { details = await lstat(database); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); }
        if (details?.isFile()) { if (!visit()) return; await note(database, details); }
      };
      // Hermes: just its state database (the rest of its home is tools and caches).
      const scanHermes = async (): Promise<void> => {
        const database = join(root.path, HERMES_DB_FILE);
        let details: Stats | null = null;
        try { details = await lstat(database); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") root.error = safeError(error); }
        if (details?.isFile()) { if (!visit()) return; await note(database, details); }
      };
      await (root.source === "grok" ? scanGrok() : root.source === "opencode" ? scanOpenCode() : root.source === "mimo" ? scanMimo() : root.source === "hermes" ? scanHermes() : walk(root.path, 0));
      // A late root listed for the first time: the logs it holds now are its history (marked fresh below), later ones are new.
      if (listed) { this.lateRoots.delete(rootIndex); this.listedRoots.add(rootIndex); }
      else if (this.listedRoots.has(rootIndex)) this.rootLosses.set(root.source, this.now());
      if (stopped) break;
    }
    // A log moved within the watched roots is the same file (Codex moves an archived session's rollout from sessions/ to
    // archived_sessions/): it keeps its read position and parser state instead of being read again from the start.
    // Same device, inode and name: a reused inode under another name is a new file. Grok never moves a usage.json, and
    // every one has that name: one deleted and another session's written over the same inode is a new file (r3-F3).
    if (!stopped) {
      const gone = new Map<string, LogFile>();
      for (const [path, file] of this.files) if (!found.has(path) && file.source !== "grok" && file.source !== "kimi" && file.source !== "zcode") gone.set(`${file.source}:${file.dev}:${file.ino}:${basename(path)}`, file);
      if (gone.size) candidates = candidates.filter(({ path, root, source, details }) => {
        const key = `${source}:${details.dev}:${details.ino}:${basename(path)}`, file = gone.get(key);
        if (!file) return true;
        gone.delete(key); this.files.delete(file.path);
        if (this.freshFiles.delete(file.path)) this.freshFiles.add(path);
        file.path = path; file.root = root; this.files.set(path, file);
        return false;
      });
    }
    let bytes = 0, overFiles = false, overBytes = false;
    for (const file of this.files.values()) bytes += file.size;
    candidates.sort((a, b) => b.details.mtimeMs - a.details.mtimeMs || a.path.localeCompare(b.path));
    for (const { path, root, source, details } of candidates) {
      if (this.files.size >= this.limits.files) { overFiles = true; continue; }
      if (bytes + details.size > this.limits.bytes) { overBytes = true; continue; }
      const parentSession = subagentLog(source, path) ? basename(dirname(dirname(path))) : null;
      const file: LogFile = { path, root, source, parentSession, dev: details.dev, ino: details.ino, size: details.size, mtime: details.mtimeMs, offset: 0, partialBytes: 0,
        state: initialParser(path, parentSession, source), imported: false };
      this.files.set(path, file); added.push(file); bytes += details.size;
      if (late.has(root)) this.freshFiles.add(path);
    }
    if (!stopped) for (const [path, file] of this.files) if (!found.has(path) && !this.roots[file.root]?.error) {
      if (file.state.open?.accepted) this.options.onSettle?.(file.state.open.call);
      this.files.delete(path); this.freshFiles.delete(path); this.noteLoss(file);
    }
    Object.assign(this.truncated, { files: overFiles, bytes: overBytes, scan: stopped });
    const cut = overFiles || overBytes || stopped;
    this.scanned = { startedAt, cut };
    if (!cut) for (const source of new Set(this.roots.map(root => root.source))) if (!this.roots.some(root => root.source === source && root.error !== null)) this.clean.set(source, startedAt);
    this.linked = stopped ? { ids: new Set([...this.linked.ids, ...linked.ids]), sources: new Set([...this.linked.sources, ...linked.sources]) } : linked;
    added.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
    return added;
  }
  private async read(file: LogFile, phase: "original" | "fork" | "all", progress = false): Promise<void> {
    const oldState = file.state, fresh = !file.imported && this.freshFiles.has(file.path);
    const sink: CallSink = (call, previous, _file, settled) => this.consume(call, previous, phase, settled, fresh);
    const onBytes = (bytes: number) => {
      this.diagnostics.bytesRead += bytes;
      if (progress) this.backfill.bytesDone = Math.min(this.backfill.bytes, this.backfill.bytesDone + bytes);
    };
    try {
      // OpenCode's and MiMoCode's databases are not read as bytes: their rows are queried read-only (opencode-db).
      if (isOpendencodeDb(file) || isMimoDb(file)) {
        if (await readOpendencodeDb(file, sink, onBytes)) this.changed();
        return;
      }
      // Hermes's state database is queried read-only per closed session (hermes-db).
      if (isHermesDb(file)) {
        if (await readHermesStateDb(file, sink, onBytes)) this.changed();
        return;
      }
      // Read again from the start (replaced, cut short, rewritten): what was read of it before is gone, noted before the index takes
      // in the new file, so a marker read while this read goes never vouches for it (codex-obs-resume-recheck6-F1).
      if (await tailFile(file, sink, onBytes, lost => this.noteLoss(file, lost))) this.changed();
    } catch (error) { const root = this.roots[file.root]; if (root) root.error = safeError(error); this.changed(); }
    finally {
      if (file.state !== oldState && oldState.open?.accepted) this.options.onSettle?.(oldState.open.call);
      this.noteThread(file);
    }
  }
  /** One of these sessions' logs left the index or lost what the index had read of it (`losses`). A Claude subagent's log is no session's own. */
  private noteLoss(file: LogFile, state: ParserState = file.state): void {
    if (file.parentSession !== null) return;
    const at = this.now();
    for (const id of new Set([initialParser(file.path, null, file.source).sessionId, state.sessionId, ...state.sessions])) if (id) { this.losses.delete(id); this.losses.set(id, at); }
    for (const [id, when] of this.losses) {
      if (this.losses.size <= MAX_LOSSES) break;
      this.losses.delete(id); this.lossFloor = Math.max(this.lossFloor, when);
    }
  }
  /** The last scan to end: when it began, and whether a budget cut it (null before the first, and from a root added until a scan lists it). */
  lastScan(): { startedAt: number; cut: boolean } | null { return this.scanned; }
  /** When the last scan began that listed every root of `source` whole with no budget cut; -Infinity before one. */
  cleanSince(source: LogRoot["source"]): number { return this.clean.get(source) ?? -Infinity; }
  /**
   * Whether these sessions may have lost a log since `since`: one left the index or lost what the index had read of it since
   * then, a root of these sources could not be listed since then, one of their logs is a symlink, a root of these sources holds
   * a symlinked directory, or the record does not reach back that far (before this ingester began watching; past MAX_LOSSES).
   */
  lostSince(ids: Iterable<string>, sources: Iterable<LogRoot["source"]>, since: number): boolean {
    if (since <= this.lossFloor) return true;
    for (const id of ids) if (this.linked.ids.has(id) || (this.losses.get(id) ?? -Infinity) >= since) return true;
    for (const source of sources) if (this.linked.sources.has(source) || (this.rootLosses.get(source) ?? -Infinity) >= since) return true;
    return false;
  }
  private noteThread(file: LogFile): void {
    const { threadId, parentThread } = file.state;
    if (file.source === "codex" && threadId && parentThread) this.options.onThread?.(threadId, parentThread);
  }
  /**
   * Codex rollouts read before 2.13 were parsed without their subagent parent. Their first line (`session_meta`, at most
   * 1 MB) is read once to learn it, so subagent threads counted earlier move to their parent session too. Returns how
   * many states were completed (they are saved with the next checkpoint).
   */
  async probeThreads(): Promise<number> {
    let probed = 0;
    for (const file of [...this.files.values()]) {
      if (this.closed) break;
      if (file.source !== "codex" || !file.state.metaSeen || file.state.parentThread !== undefined) continue;
      const line = await readFirstLine(file.path);
      let payload: Record<string, unknown> = {};
      try { const row = line ? JSON.parse(line) as Record<string, unknown> : null; if (row?.type === "session_meta" && row.payload && typeof row.payload === "object") payload = row.payload as Record<string, unknown>; }
      catch { /* not JSON: treated as not a subagent */ }
      const own = typeof payload.id === "string" && payload.id ? payload.id.slice(0, 256) : file.state.legacySessionId, parent = subagentParent(payload.source);
      file.state.threadId = own; file.state.parentThread = parent && parent !== own ? parent.slice(0, 256) : null;
      if (file.state.parentThread && !file.state.links.includes(file.state.parentThread) && file.state.links.length < 256) file.state.links.push(file.state.parentThread);
      this.noteThread(file); probed++;
    }
    return probed;
  }
  /**
   * Originals across all files win before copied fork history; the second pass only visits files with forks: Claude's lines
   * marked `forkedFrom`, and the entries a Pi fork copied (older than the fork itself, see the parser), so a fork read first
   * (older on disk than the session it came from) does not take the replies that session wrote.
   */
  private async importFiles(files: LogFile[], progress = false): Promise<void> {
    for (const file of files) {
      if (this.closed) return;
      await this.read(file, file.imported ? "all" : "original", progress);
      if (progress) { this.backfill.filesDone++; this.changed(); }
    }
    for (const file of files) {
      if (this.closed) return;
      if (file.imported) continue;
      if (file.state.hasForks && (file.source === "claude" || file.source === "pi" || file.source === "omp")) {
        const second: LogFile = { ...file, offset: 0, state: initialParser(file.path, file.parentSession, file.source) };
        await this.read(second, "fork");
        if (second.state.open?.accepted) file.state.open = second.state.open;
      }
      file.imported = true; this.freshFiles.delete(file.path);
    }
  }
  /** The first import, queued like the polls: a rescan asked meanwhile never interleaves with it. */
  backfillAll(): Promise<void> {
    const run = this.pending.then(async () => {
      await this.scan();
      const files = [...this.files.values()].sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
      this.backfill.files = files.length; this.backfill.filesDone = 0;
      this.backfill.bytes = files.reduce((n, f) => n + f.size, 0);
      this.backfill.bytesDone = files.reduce((n, f) => n + Math.min(f.offset, f.size), 0);
      this.changed();
      await this.importFiles(files, true);
      this.backfill.done = !this.closed; this.changed();
    });
    this.pending = run.then(() => {}, () => {});
    return run;
  }
  poll(rescan = false): Promise<void> {
    this.pending = this.pending.then(async () => {
      if (this.closed) return;
      const added = rescan ? await this.scan() : [];
      if (added.length) { await this.importFiles(added); this.changed(); }
      const newPaths = new Set(added.map(file => file.path));
      for (const file of this.files.values()) {
        if (this.closed) break;
        // The 30s rescan also stats cold files so a resumed old session becomes hot.
        if (!newPaths.has(file.path) && (rescan || file.source === "zcode" || file.mtime >= this.now() - 900_000)) await this.read(file, "all");
      }
      if (rescan) {
        const cutoff = this.now() - SEEN_DAYS * DAY;
        for (const [key, at] of this.seen) if (at < cutoff) this.seen.delete(key);
        this.seenFloor = Math.max(this.seenFloor ?? cutoff, cutoff);
      }
    }).catch(() => {});
    return this.pending;
  }
  async close(): Promise<void> { this.closed = true; await this.pending; }
}
