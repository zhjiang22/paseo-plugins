import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TOKEN_SOURCES, type TokenSource } from "../../shared/tokens";
import type { TokenCall, TokenCallSource } from "../token-source";
import type { TokenIngester } from "./ingester";
import { initialParser } from "./parser";
import { validStart } from "./values";
import { isMimoDb, isOpendencodeDb, readOpendencodeDb } from "./opencode-db";
import { isHermesDb, readHermesStateDb } from "./hermes-db";
import { tailFile } from "./reader";
import { zcodeSessionIds } from "./zcode-reader";
import { safeError, type Candidate, type LogFile, type ParserState } from "./types";

/**
 * Cache budget (opus-F70), by parsed calls rather than files: a Claude session with many subagents is one log per
 * subagent (24 files, 641 MB for the largest session group on a heavy host in October 2026), while its calls number in
 * the thousands. 60,000 calls (about 12 MB, some 210 bytes each) hold the largest session groups several times over; a
 * single log with more calls than that is read but not kept.
 */
const MAX_FILES = 512, MAX_CALLS = 60_000;
/**
 * `findMarker` compares at most the last MARKER_TAIL bytes of a log (MARKER_WHOLE when it has to tell a marker is not there), of at
 * most MARKER_FILES logs (the newest), MARKER_CHUNK at a time from the end: a prompt sent hours ago is behind at most that turn's
 * own output, and nothing read is kept. Telling it is not there also takes each log read whole while it did not change, in at
 * most MARKER_READS reads twice MARKER_REST apart.
 */
export const MARKER_TAIL = 16 * 1024 * 1024, MARKER_WHOLE = 128 * 1024 * 1024, MARKER_FILES = 4, MARKER_CHUNK = 1024 * 1024;
export const MARKER_READS = 3, MARKER_REST = 50;
/**
 * What a session's own logs say of a marker (`findMarker`): in them; surely not in them (every log of the session that could hold
 * it was found and read from its first byte to its end, unchanged); not known yet (the logs have not been scanned since the run
 * ended: ask again after the next scan); or nothing can be told.
 */
export type MarkerEvidence = "found" | "absent" | "pending" | "unknown";
/** The run a decision is about (`findMarker`): when it began and ended, by the clock the ingester runs on (the host's). */
export interface MarkerRun { startedAt: number; endedAt: number }
/**
 * One read of a log for a marker (`markerPass`), besides the answer: it grew while read (appended to, or changed too recently for
 * its times to tell), or was rewritten (shrank, was replaced at its path, or changed in place).
 */
type MarkerPass = Exclude<MarkerEvidence, "pending"> | "grew" | "rewritten";
/** The CLIs that write each prompt into the session's own log as it is sent: Claude Code, Codex and Pi (Grok's files are never opened). */
const MARKER_SOURCES: ReadonlySet<TokenSource> = new Set<TokenSource>(["claude", "codex", "pi"]);
/** A log path that has become a symlink is not followed (as `tailFile`). */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
/** A byte that would continue an id ([A-Za-z0-9_-]): a marker followed by one is the start of a longer id, not this one. */
const idByte = (byte: number) => (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122) || byte === 45 || byte === 95;
/** `counted`: the calls this entry adds to the budget, as of its last touch (its map grows in place while a log is read on). */
interface CachedFile { file: LogFile; calls: Map<string, Candidate>; counted?: number; cacheKey?: string; databaseIdentity?: string }
interface OwnedCandidate { candidate: Candidate; path: string }
interface FileLinks { ids: string[]; links: string[] }

function freshFile(file: LogFile): LogFile {
  return { ...file, offset: 0, partialBytes: 0, imported: false, state: initialParser(file.path, file.parentSession, file.source) };
}
function copy(candidate: Candidate): Candidate { return { forked: candidate.forked, call: { ...candidate.call } }; }
const databaseReader = (file: LogFile) => isOpendencodeDb(file) || isMimoDb(file) ? readOpendencodeDb : isHermesDb(file) ? readHermesStateDb : null;
function merge(previous: Candidate, next: Candidate, contiguous = false): Candidate {
  if (next.call.source === "kimi") return copy(next); // A corrected usage.record replaces the same request sample.
  if (previous.forked !== next.forked) return copy(previous.forked ? next : previous);
  const at = Math.max(previous.call.at, next.call.at);
  return { forked: previous.forked, call: { ...previous.call, at,
    start: validStart(contiguous ? next.call.start : previous.call.start, at),
    output: Math.max(previous.call.output, next.call.output), reasoning: Math.max(previous.call.reasoning, next.call.reasoning) } };
}
function publicCall({ at, start, model, input, cacheWrite, cacheRead, output, reasoning, subagent, calls }: TokenCall): TokenCall {
  return { at, start, model, input, cacheWrite, cacheRead, output, reasoning, subagent, ...(calls !== undefined && calls > 1 ? { calls } : {}) };
}

/**
 * On-demand call history; the ledger itself never retains full history for every provider session. Each log is kept with
 * its identity (device, inode, size, modification time) and read position: a log that only grew is read from where the
 * last read stopped, a truncated or replaced one again from the start, and a finished one (a subagent's) whose identity
 * did not change is reused without reading. The cache is least recently used by parsed calls (see MAX_CALLS); the logs
 * of the request being served are touched first and evicted last, so reading a session with more logs than fit never
 * evicts its own logs on the way (a sequential scan would otherwise miss every time).
 */
export class LocalTokenCallSource implements TokenCallSource {
  private readonly cache = new Map<string, CachedFile>();
  private cachedCalls = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly sources: ReadonlySet<TokenSource>;
  private readonly budget: { files: number; calls: number };
  /** Bytes read from logs by this source, the reads served from the cache alone, and bytes compared by `findMarker` (diagnostics and tests). */
  readonly diagnostics = { bytesRead: 0, reused: 0, markerBytes: 0 };

  /** `sources`: the log sources served (the others answer null); `budget`: a smaller cache (tests). */
  constructor(private readonly ingester: TokenIngester, private readonly initialized: Promise<unknown> = Promise.resolve(),
    options: { sources?: Iterable<TokenSource>; budget?: Partial<{ files: number; calls: number }> } = {}) {
    this.sources = new Set(options.sources ?? TOKEN_SOURCES);
    this.budget = { files: MAX_FILES, calls: MAX_CALLS, ...options.budget };
  }

  /**
   * 提示缓存倒计时 (server/cache-clock.ts): a Claude session's own log, `<session id>.jsonl` as the scans indexed it (custom
   * `CLAUDE_CONFIG_DIR` roots included; not a subagent's), the newest when there are several; null when none is known. `identity`
   * changes whenever the scans saw the log change.
   */
  claudeTranscript(sessionId: string): { path: string; identity: string } | null {
    let found: LogFile | null = null;
    for (const file of this.ingester.files.values()) {
      if (file.source !== "claude" || file.parentSession !== null || basename(file.path, ".jsonl") !== sessionId) continue;
      if (!found || file.mtime > found.mtime) found = file;
    }
    return found ? { path: found.path, identity: `${found.dev}:${found.ino}:${found.size}:${found.mtime}` } : null;
  }

  callsForSessions(sessionIds: readonly string[]): Promise<{ source: TokenSource; calls: TokenCall[]; version: string } | null> {
    const ids = [...new Set(sessionIds)];
    const request = this.pending.then(async () => { await this.initialized; return this.readSessions(ids); });
    // A failed initialization/read must not leave subsequent requests attached to a rejected queue.
    this.pending = request.catch(() => {});
    return request;
  }

  /**
   * Whether `marker`, an id the host wrote into a prompt it sent (`run=<runId>`, 恢复后续跑's evidence), is in these sessions' own
   * logs: Claude Code, Codex and Pi write each prompt into the session's log as it is sent. Only the logs indexed under these
   * session ids (not their subagents' logs), the newest MARKER_FILES, the last MARKER_TAIL bytes of each (MARKER_WHOLE with
   * `whole` or a `run`), compared byte for byte and dropped: nothing is parsed, kept or returned but the answer. Grok logs are
   * never opened. It reads the index as the ledger's own scans (every 30 s) left it, at once: no scan is made for it and it waits
   * for nothing, neither the first import nor the token reads queued here (codex-obs-resume-recheck5-F2).
   *
   * "absent" only about a `run` (a decision), when the index can vouch for every log these sessions could have written its
   * prompt into (codex-obs-resume-recheck3-F1, recheck4-F1, recheck5-F1, recheck6-F1, `vouch`): a scan that began after the run
   * ended listed every root of their logs' sources whole, and no root was added since; since the run began none of their logs
   * left the index or lost what it had read, and no root of those sources stopped listing; none of their logs is a symlink; and
   * each of their logs, at most MARKER_FILES, none longer than the window, was read whole and unchanged without it (`markerIn`).
   * The losses and the roots are read again once the logs were: a loss or a root added while they were read counts too.
   * "pending" while no scan has begun since the run ended or listed a root added since, or the last one could not list a root of
   * those sources (it may next time): the ledger asks again at its next check. Anything else is "unknown": no log of theirs once
   * a scan has run since, a scan a budget cut, a loss, a log that cannot be read or kept changing.
   */
  async findMarker(sessionIds: readonly string[], marker: string, options: { whole?: boolean; run?: MarkerRun } = {}): Promise<MarkerEvidence> {
    const ids = new Set(sessionIds.filter(Boolean)), needle = Buffer.from(marker, "utf8"), run = options.run;
    if (!ids.size || needle.length < 8) return "unknown";
    const discovered = new Map<string, ParserState>(), roots = this.ingester.roots.length;
    const own = [...this.ingester.files.values()].filter(file => MARKER_SOURCES.has(file.source) && this.sources.has(file.source) && file.parentSession === null
      && this.links(file, discovered).ids.some(id => ids.has(id))).sort((a, b) => b.mtime - a.mtime);
    const index = run ? this.vouch(own, ids, run) : "unknown";
    let told = index === "whole";
    for (const file of own.slice(0, MARKER_FILES)) {
      const seen = await this.markerIn(file, needle, options.whole || run ? MARKER_WHOLE : MARKER_TAIL, told);
      if (seen === "found") return "found";
      if (seen === "unknown") told = false;
    }
    if (!told || !run) return index === "pending" ? "pending" : "unknown";
    // A log of theirs lost while they were read is no proof either; a root added meanwhile (roots are only ever appended) may hold
    // one no scan has listed yet, which the next one lists (codex-obs-resume-recheck6-F1).
    if (this.ingester.lostSince(ids, new Set(own.map(file => file.source)), run.startedAt)) return "unknown";
    return this.ingester.roots.length === roots ? "absent" : "pending";
  }
  /**
   * What the index can vouch for about these sessions' logs, for a decision about `run` (`findMarker`): "whole" when absence can be
   * told from them; "pending" when a later scan may still tell it; "unknown" when none will. A scan that began after the run ended
   * is the first sure to have listed a log written while it went (the prompt is logged as it is sent), unless a root was added
   * since: the ingester forgets the scans before it until one lists it (codex-obs-resume-recheck6-F1).
   */
  private vouch(own: readonly LogFile[], ids: ReadonlySet<string>, run: MarkerRun): "whole" | "pending" | "unknown" {
    const last = this.ingester.lastScan(), since = last !== null && last.startedAt > run.endedAt ? last : null;
    // No log of theirs known: one written while the run went is listed by the next scan (found then); none after it, nothing to tell.
    if (!own.length) return since ? "unknown" : "pending";
    const sources = new Set(own.map(file => file.source));
    if (own.length > MARKER_FILES || this.ingester.lostSince(ids, sources, run.startedAt)) return "unknown";
    if ([...sources].every(source => this.ingester.cleanSince(source) > run.endedAt)) return "whole";
    // Not yet listed whole since the run ended: a budget that cut a scan since cuts the next too; a root that failed may not fail again.
    return since?.cut ? "unknown" : "pending";
  }
  /**
   * `needle` as a whole id in the last `limit` bytes of a log. "absent" only to `settle`, when that was the whole log and it did
   * not change while read (`markerPass`), and is still the log the index knew (same device and inode, no shorter): one replaced
   * or cut short since it was indexed has lost what it held (codex-obs-resume-recheck5-F1). One that grew is read again, in at
   * most MARKER_READS reads twice MARKER_REST apart (a timer may fire a little early by the wall clock): CLIs append to their
   * logs while a turn runs. One rewritten while read (shrunk, replaced, changed in place) may still show the marker when read
   * again, but no longer tells it is absent: what it held before is gone.
   */
  private async markerIn(file: LogFile, needle: Buffer, limit: number, settle: boolean): Promise<MarkerEvidence> {
    const known = settle ? { dev: file.dev, ino: file.ino, size: file.size } : null;
    let rewritten = false;
    for (let pass = 0; pass < (known ? MARKER_READS : 1); pass++) {
      if (pass) await delay(2 * MARKER_REST);
      const seen = await this.markerPass(file.path, needle, limit, known);
      if (seen === "found" || seen === "unknown") return seen;
      if (seen === "absent") return rewritten ? "unknown" : "absent";
      if (seen === "rewritten") rewritten = true;
    }
    return "unknown";
  }
  /**
   * One read of a log, back from the end; never kept. Without `known` (the log as the index knew it) it can only find the marker.
   * With it, a log read whole without the marker is checked again at its path: the same file (device, inode), of the same size,
   * modification and change times as when it was opened, and last changed at least MARKER_REST before: the file system's clock
   * moves in ticks (some milliseconds), so a change within the same tick as the one before moves no time.
   */
  private async markerPass(path: string, needle: Buffer, limit: number, known: { dev: number; ino: number; size: number } | null): Promise<MarkerPass> {
    const started = BigInt(Date.now()) * 1_000_000n;
    let handle;
    try { handle = await open(path, OPEN_FLAGS); } catch { return "unknown"; }
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) return "unknown";
      const replaced = known !== null && (Number(before.dev) !== known.dev || Number(before.ino) !== known.ino || Number(before.size) < known.size);
      const size = Number(before.size), floor = Math.max(0, size - limit), buffer = Buffer.allocUnsafe(MARKER_CHUNK);
      // Each window is a chunk and the start of the chunk after it (read just before), so a marker across the two is found
      // with the byte after it; one starting in that later chunk was judged with it.
      let end = size, after = Buffer.alloc(0);
      while (end > floor) {
        const begin = Math.max(floor, end - MARKER_CHUNK);
        let read = 0;
        while (read < end - begin) { const { bytesRead } = await handle.read(buffer, read, end - begin - read, begin + read); if (!bytesRead) break; read += bytesRead; }
        this.diagnostics.markerBytes += read;
        if (read < end - begin) return "rewritten"; // shrunk while read
        const window = Buffer.concat([buffer.subarray(0, read), after]);
        for (let at = window.indexOf(needle); at !== -1 && at < read; at = window.indexOf(needle, at + 1)) {
          const next = window[at + needle.length];
          if (next === undefined || !idByte(next)) return "found";
        }
        after = Buffer.from(window.subarray(0, Math.min(window.length, needle.length + 1)));
        end = begin;
      }
      if (floor > 0 || !known || replaced) return "unknown";
      const now = await lstat(path, { bigint: true }).catch(() => null);
      if (!now || now.dev !== before.dev || now.ino !== before.ino || now.size < before.size) return "rewritten";
      if (now.size > before.size) return "grew";
      if (now.mtimeNs !== before.mtimeNs || now.ctimeNs !== before.ctimeNs) return "rewritten";
      return before.ctimeNs + BigInt(MARKER_REST) * 1_000_000n > started ? "grew" : "absent";
    } catch { return "unknown"; }
    finally { await handle.close(); }
  }

  private links(file: LogFile, discovered: Map<string, ParserState>): FileLinks {
    const states = [file.state, this.cache.get(file.path)?.file.state, discovered.get(file.path)].filter((state): state is ParserState => !!state);
    return { ids: [...new Set([initialParser(file.path, file.parentSession, file.source).sessionId, file.parentSession ?? "",
      ...states.flatMap(state => [state.sessionId, ...state.sessions])].filter(Boolean))],
    links: [...new Set(states.flatMap(state => state.links))] };
  }

  private related(files: LogFile[], source: TokenSource, sessionIds: readonly string[], discovered: Map<string, ParserState>): LogFile[] {
    // A shared database's indexed session ids are not links between otherwise unrelated sessions.
    const connected = new Set(sessionIds), candidates = files.filter(file => file.source === source && !databaseReader(file)).map(file => ({ file, ...this.links(file, discovered) }));
    let changed = true;
    while (changed) {
      changed = false;
      for (const { ids, links } of candidates) {
        if (![...ids, ...links].some(id => connected.has(id))) continue;
        for (const id of [...ids, ...links]) if (!connected.has(id)) { connected.add(id); changed = true; }
      }
    }
    return candidates.filter(({ ids }) => ids.some(id => connected.has(id))).map(({ file }) => file)
      .sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  }

  /** Makes a log the most recently used. Eviction waits for the end of the request (`trim`). */
  private touch(entry: CachedFile): void {
    const key = entry.cacheKey ?? entry.file.path;
    this.drop(key);
    if (entry.calls.size > this.budget.calls) return;
    entry.counted = entry.calls.size;
    this.cache.set(key, entry); this.cachedCalls += entry.counted;
  }
  private drop(path: string): void {
    const entry = this.cache.get(path);
    if (entry) { this.cache.delete(path); this.cachedCalls -= entry.counted ?? 0; }
  }
  /**
   * Back within budget: least recently used logs of other requests first; then, when this request alone is too large,
   * its most recently read logs, so the same leading logs stay cached for its next read.
   */
  private trim(pinned: ReadonlySet<string>): void {
    const within = () => this.cache.size <= this.budget.files && this.cachedCalls <= this.budget.calls;
    for (const path of [...this.cache.keys()]) {
      if (within()) return;
      if (!pinned.has(this.cache.get(path)!.file.path)) this.drop(path);
    }
    for (const path of [...this.cache.keys()].reverse()) {
      if (within()) return;
      this.drop(path);
    }
  }

  /** Shared databases are cached per requested session set; WAL-only commits invalidate their snapshots too. */
  private async readDatabase(file: LogFile, sessions: ReadonlySet<string>): Promise<CachedFile | null> {
    const ids = [...sessions].sort(), key = JSON.stringify([file.path, ids]), previous = this.cache.get(key);
    try {
      const details = await lstat(file.path, { bigint: true });
      if (!details.isFile()) { this.drop(key); return null; }
      const wal = await lstat(file.path + "-wal", { bigint: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (wal && !wal.isFile()) throw new Error("Database WAL is not a regular file");
      const identity = JSON.stringify([details, wal].map(info => info ? [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].map(String) : null));
      if (previous?.databaseIdentity === identity) { this.diagnostics.reused++; this.touch(previous); return previous; }
      // Counters can be rewritten inside a database without growing it. Re-read just these sessions from the start.
      const current: CachedFile = { file: freshFile(file), calls: new Map(), cacheKey: key, databaseIdentity: identity };
      current.file.dev = Number(details.dev); current.file.ino = Number(details.ino);
      await databaseReader(file)!(current.file, candidate => {
        if (sessions.has(candidate.call.sessionId)) current.calls.set(candidate.call.key, copy(candidate));
      }, bytes => { this.diagnostics.bytesRead += bytes; }, ids);
      this.touch(current);
      return current;
    } catch (error) {
      const root = this.ingester.roots[file.root];
      if (root) root.error = safeError(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.drop(key); return null; }
      // This entry belongs only to this session set, including when a transient read failure uses the last snapshot.
      return previous ?? null;
    }
  }

  private async read(file: LogFile, sessions: ReadonlySet<string>): Promise<CachedFile | null> {
    if (databaseReader(file)) return this.readDatabase(file, sessions);
    let entry = this.cache.get(file.path);
    try {
      const details = await stat(file.path);
      if (!details.isFile()) { this.drop(file.path); return null; }
      if (file.source !== "zcode" && entry && details.dev === entry.file.dev && details.ino === entry.file.ino && details.size === entry.file.size && details.mtimeMs === entry.file.mtime) {
        this.diagnostics.reused++; this.touch(entry); return entry;
      }
      if (!entry || details.dev !== entry.file.dev || details.ino !== entry.file.ino || (file.source !== "zcode" && (details.size < entry.file.size || details.size < entry.file.offset ||
          (details.size === entry.file.size && details.mtimeMs !== entry.file.mtime)))) entry = { file: freshFile(file), calls: new Map() };
      const current = entry;
      let parsedState = current.file.state;
      const reconcileReset = () => {
        // tailFile stats again; a replacement between the two stats must also clear the old call cache.
        if (parsedState !== current.file.state) { current.calls.clear(); parsedState = current.file.state; }
      };
      await tailFile(current.file, (candidate, previous) => {
        reconcileReset();
        const before = current.calls.get(candidate.call.key);
        current.calls.set(candidate.call.key, before ? merge(before, candidate, previous?.call.key === candidate.call.key) : copy(candidate));
      }, bytes => { this.diagnostics.bytesRead += bytes; });
      reconcileReset();
      this.touch(current);
      return current;
    } catch (error) {
      const root = this.ingester.roots[file.root];
      if (root) root.error = safeError(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.drop(file.path); return null; }
      // Preserve the last readable counters on transient permission/I/O errors; never retain log bodies.
      return entry ?? { file: freshFile(file), calls: new Map() };
    }
  }

  private async readSessions(sessionIds: readonly string[]): Promise<{ source: TokenSource; calls: TokenCall[]; version: string } | null> {
    if (!sessionIds.length) return null;
    const files = [...this.ingester.files.values()].filter(file => this.sources.has(file.source)), discovered = new Map<string, ParserState>();
    const databases = files.filter(file => databaseReader(file));
    const discoverZcode = async (file: LogFile, ids: readonly string[]): Promise<boolean> => {
      const indexed = this.links(file, discovered).ids, missing = ids.filter(id => !indexed.includes(id));
      if (!missing.length) return false;
      try {
        const matched = await zcodeSessionIds(file, missing);
        if (!matched.length) return false;
        const state = discovered.get(file.path) ?? file.state;
        discovered.set(file.path, { ...state, sessions: [...state.sessions, ...matched] });
        return true;
      } catch (error) {
        const root = this.ingester.roots[file.root];
        if (root) root.error = safeError(error);
        return false;
      }
    };
    let source: TokenSource | undefined;
    // TokenCallSource has one source. Mixed-provider requests use the first requested known provider session.
    for (const id of sessionIds) {
      const known = files.find(file => { if (databaseReader(file)) return false; const links = this.links(file, discovered); return links.ids.includes(id) || links.links.includes(id); });
      if (known) { source = known.source; break; }
      // Resolve every database's bounded-index miss before moving to the next requested id, preserving provider order.
      for (const file of files) {
        if (databaseReader(file) ? (await this.readDatabase(file, new Set([id])))?.calls.size
          : file.source === "zcode" && await discoverZcode(file, [id])) { source = file.source; break; }
      }
      if (source) break;
    }
    if (!source) { this.trim(new Set()); return null; }
    if (source === "zcode") for (const file of files) if (file.source === "zcode") await discoverZcode(file, sessionIds);
    const merged = new Map<string, OwnedCandidate>(), read = new Set<string>(), identity: unknown[] = [source];
    let found = false;
    // Touch every cached log of this session group first: reading the first ones must not evict the later ones.
    for (const file of this.related(files, source, sessionIds, discovered)) { const entry = this.cache.get(file.path); if (entry) this.touch(entry); }
    while (true) {
      const selected = [...this.related(files, source, sessionIds, discovered), ...databases.filter(file => file.source === source)].filter(file => !read.has(file.path));
      if (!selected.length) break;
      for (const file of selected) {
        read.add(file.path);
        const entry = await this.read(file, new Set(sessionIds));
        if (!entry) continue;
        found = true; discovered.set(file.path, entry.file.state);
        identity.push([file.path, entry.file.dev, entry.file.ino, entry.file.size, entry.file.mtime, entry.file.offset, entry.file.state.zcode, entry.calls.size, entry.databaseIdentity]);
        for (const candidate of entry.calls.values()) {
          // SQLite contains every ZCode session, not just the requested agent.
          if (source === "zcode" && !sessionIds.includes(candidate.call.sessionId)) continue;
          const before = merged.get(candidate.call.key);
          if (!before || (before.candidate.forked && !candidate.forked)) merged.set(candidate.call.key, { candidate: copy(candidate), path: file.path });
          else if (before.path === file.path) before.candidate = merge(before.candidate, candidate);
        }
      }
    }
    this.trim(read);
    if (!found) return null;
    // The calls follow from the logs read and their state: the same logs at the same size, time and position give the same calls.
    const version = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);
    return { source, calls: [...merged.values()].map(({ candidate }) => publicCall(candidate.call)).sort((a, b) => a.at - b.at), version };
  }
}
