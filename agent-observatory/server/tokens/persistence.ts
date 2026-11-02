import { t } from "../../shared/text";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { MAX_TOKEN_ROOTS, TOKEN_SOURCES, tokenCountsSchema } from "../../shared/tokens";
import { bucketKey, emptyData, MAX_THREADS, noteThread, projectHourKey, RECORD_DEPTH, sessionHourKey, sessionKey, type TokenData } from "./data";
import type { TokenIngester } from "./ingester";
import { dayOf, safeError } from "./types";
import { ensurePrivateDirectory } from "../paseo-home";

const MAX_BYTES = 64 * 1024 * 1024;
const time = z.number().finite().nonnegative(), count = z.number().int().nonnegative();
// 2.14 adds the grok and pi sources; 2.18 adds omp, opencode, codebuddy, qoder, gemini and qwen. A ledger holding a
// source an older version's enum lacks is quarantined by it and its logs are imported again; the version stays 2, so
// upgrading adds nothing for readers that never saw the new source.
const source = z.enum(TOKEN_SOURCES), id = z.string().min(1).max(256), cwd = z.string().max(4096);
const model = z.string().max(240).nullable(), hash = z.string().regex(/^[a-f0-9]{16}$/);
const callSchema = z.object({ key: hash, source, sessionId: id, cwd, at: time, start: time.nullable(), model,
  input: count, cacheWrite: count, cacheRead: count, output: count, reasoning: count, subagent: z.boolean(),
  // 2.14: model calls of a Grok turn record (absent: one).
  calls: count.optional() });
const candidate = z.object({ call: callSchema, forked: z.boolean(), accepted: z.boolean().optional() });
const parser = z.object({ sessionId: id, cwd, model, inputAt: time.nullable(), lastTotal: z.string().max(512).nullable(),
  open: candidate.nullable(), openInputAt: time.nullable(), sessions: z.array(id).max(5000), links: z.array(id).max(256), hasForks: z.boolean(),
  metaSeen: z.boolean(), pendingRecord: z.boolean(), legacySessionId: id,
  // 2.13: a Codex rollout's own thread and the parent thread of a subagent rollout (null: not a subagent; absent: saved before 2.13).
  zcode: z.object({ row: count, signature: z.string().max(512), anchor: hash.optional() }).optional(),
  day: z.string().max(32).optional(),
  threadId: id.optional(), parentThread: id.nullable().optional() });
const fileSchema = z.object({ path: z.string().max(8192), root: count, source, parentSession: id.nullable(), dev: count, ino: count,
  size: count, mtime: time, offset: count, partialBytes: count, state: parser, imported: z.boolean() });
const bounds = { settledFirstAt: time.optional(), settledLastAt: time.optional() };
const bucket = tokenCountsSchema.extend({ at: time, source, model, firstAt: time.optional(), lastAt: time, ...bounds });
const sessionHour = bucket.extend({ sessionId: id, cwd, firstAt: time, subagentCalls: count });
const projectHour = tokenCountsSchema.extend({ at: time, cwd, lastAt: time, ...bounds });
const record = z.object({ key: hash, at: time, model, output: count, tps: time });
const savedSchema = z.object({ version: z.literal(2), change: count, earliestAt: time.nullable(), latestAt: time.nullable(),
  roots: z.array(z.object({ source, path: z.string().max(4096), provider: z.string().min(1).max(256).optional() })).max(MAX_TOKEN_ROOTS),
  hours: z.array(bucket).max(250_000), days: z.array(bucket).max(100_000),
  sessionDays: z.array(z.object({ day: time, sessionId: id, source, hours: z.array(sessionHour).max(24_000) })).max(460_000),
  projectDays: z.array(z.object({ day: time, cwd, hours: z.array(projectHour).max(24) })).max(460_000),
  sessions: z.array(z.object({ sessionId: id, source, cwd, project: z.string().max(240), firstAt: time, lastAt: time,
    models: z.record(z.string().max(240), count), subagentCalls: count, ...bounds })).max(5000),
  recordHours: z.array(z.object({ at: time, speeds: z.record(z.string(), count), fastest: z.array(record).max(32), biggest: z.array(record).max(32),
    settledFastest: z.array(record).max(32).optional(), settledBiggest: z.array(record).max(32).optional() })).max(92 * 24),
  recent: z.array(callSchema).max(100_000), mutable: z.array(callSchema).max(100_000), seen: z.array(z.tuple([hash, time])).max(1_000_000), seenFloor: time.nullable().optional(), files: z.array(fileSchema).max(50_000),
  /** Codex subagent thread → parent thread (2.13). */
  threads: z.array(z.tuple([id, id])).max(MAX_THREADS).optional(),
});
type Saved = z.infer<typeof savedSchema>;

export class TokenPersistence {
  readonly file: string;
  private readable = true;
  constructor(readonly directory: string) { this.file = join(directory, "tokens.json"); }
  async restore(ingester: TokenIngester): Promise<{ data: TokenData; change: number }> {
    const empty = { data: emptyData(), change: 0 };
    let content: string;
    try {
      const details = await stat(this.file);
      if (details.size > MAX_BYTES) { await this.quarantine(); return empty; }
      content = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") { this.readable = false; console.warn(t("serverTokensPersistence.m001", { value1: safeError(error) })); }
      return empty;
    }
    let saved: Saved;
    try { saved = savedSchema.parse(JSON.parse(content)); }
    catch { await this.quarantine(); return empty; }
    const data = emptyData(); data.earliestAt = saved.earliestAt; data.latestAt = saved.latestAt;
    for (const row of saved.hours) data.hours.set(bucketKey(row.at, row.source, row.model), row);
    for (const row of saved.days) data.days.set(bucketKey(row.at, row.source, row.model), row);
    for (const group of saved.sessionDays) for (const row of group.hours) data.sessionHours.set(sessionHourKey(row), row);
    for (const group of saved.projectDays) for (const row of group.hours) data.projectHours.set(projectHourKey(row), row);
    for (const row of saved.sessions) data.sessions.set(sessionKey(row.source, row.sessionId), row);
    for (const row of saved.recordHours) {
      for (const kind of ["fastest", "biggest", "settledFastest", "settledBiggest"] as const) if (row[kind]) row[kind] = row[kind].slice(0, RECORD_DEPTH);
      data.recordHours.set(row.at, row);
    }
    for (const row of saved.recent) data.recent.set(row.key, row);
    for (const row of saved.mutable) data.mutable.set(row.key, row);
    for (const [child, parent] of saved.threads ?? []) noteThread(data, child, parent);
    for (const [key, at] of saved.seen) ingester.seen.set(key, at);
    ingester.seenFloor = saved.seenFloor ?? null;
    // Roots found from the provider config in an earlier run are watched again at once, so their files keep their
    // read positions instead of being imported a second time when the config is read.
    ingester.addRoots(saved.roots, false);
    // Roots this ledger never watched (a source added by an upgrade) are imported in full, past the dedupe window.
    ingester.markNewRoots(saved.roots);
    for (const file of saved.files) {
      const oldRoot = saved.roots[file.root];
      const root = ingester.roots.findIndex(candidate => candidate.source === oldRoot?.source && resolve(candidate.path) === resolve(oldRoot.path));
      if (root < 0 || !resolve(file.path).startsWith(resolve(ingester.roots[root].path) + sep) || file.source !== ingester.roots[root].source) continue;
      file.root = root; ingester.files.set(file.path, file);
    }
    return { data, change: saved.change };
  }
  private async quarantine(): Promise<void> {
    try { await rename(this.file, `${this.file}.corrupt`); }
    catch { this.readable = false; }
  }
  serialize(data: TokenData, ingester: TokenIngester, change: number): string {
    const sessionDays = new Map<string, Saved["sessionDays"][number]>(), projectDays = new Map<string, Saved["projectDays"][number]>();
    for (const row of data.sessionHours.values()) {
      const day = dayOf(row.at), key = JSON.stringify([day, row.source, row.sessionId]);
      const group = sessionDays.get(key) ?? { day, sessionId: row.sessionId, source: row.source, hours: [] };
      group.hours.push(row); sessionDays.set(key, group);
    }
    for (const row of data.projectHours.values()) {
      const day = dayOf(row.at), key = JSON.stringify([day, row.cwd]);
      const group = projectDays.get(key) ?? { day, cwd: row.cwd, hours: [] }; group.hours.push(row); projectDays.set(key, group);
    }
    return JSON.stringify({ version: 2, change, earliestAt: data.earliestAt, latestAt: data.latestAt,
      roots: ingester.roots.map(({ source: rootSource, path, provider }) => ({ source: rootSource, path, ...(provider ? { provider } : {}) })),
      hours: [...data.hours.values()], days: [...data.days.values()], sessionDays: [...sessionDays.values()], projectDays: [...projectDays.values()],
      sessions: [...data.sessions.values()], recordHours: [...data.recordHours.values()], recent: [...data.recent.values()], mutable: [...data.mutable.values()],
      seen: [...ingester.seen], seenFloor: ingester.seenFloor, files: [...ingester.files.values()], threads: [...data.threads] });
  }
  async write(payload: string, durable = false): Promise<boolean> {
    if (!this.readable) return false;
    if (Buffer.byteLength(payload) > MAX_BYTES) { console.warn(t("serverTokensPersistence.m002")); return false; }
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await ensurePrivateDirectory(this.directory);
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(payload, "utf8"); if (durable) await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file);
      return true;
    } catch (error) { console.warn(t("serverTokensPersistence.m003", { value1: safeError(error) })); return false; }
    finally { await unlink(temporary).catch(() => {}); }
  }
}
