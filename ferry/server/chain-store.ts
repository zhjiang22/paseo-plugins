// Ferry's files under `$PASEO_HOME/plugin-data/<plugin id>/`:
//
//   chains/<chain>.json                    the chain: its visits and deliveries
//   transcripts/<chain>/<visit>.jsonl      the items of each closed visit, numbered across the chain (never rewritten)
//   records/<chain>/<delivery>.md          the full history as of a handoff, for agents to read with their own tools
//   sent/<chain>/<delivery>.txt            exactly what a delivery sent (the envelope)
//
// Directories are 0700 and files 0600; every write goes to a temporary file first and is renamed into place, so a
// crash never leaves half a file. A chain file that cannot be parsed is set aside (`.corrupt-<time>`) and that chain
// starts over; nothing else is affected. Which chain an agent belongs to is kept in memory, rebuilt from the chain
// files at start, so there is no second index to drift.

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Chain, NumberedItem } from "../shared/model";

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
/** Ferry's folders under its data directory; the language folder (`locales/`) is not conversation data. */
const PARTS = ["chains", "transcripts", "records", "sent"] as const;

export interface ChainStore {
  readonly dir: string;
  /** Scan the chain files (once; later calls wait for the first). */
  ready(): Promise<void>;
  chainOf(agentId: string): string | null;
  read(chainId: string): Promise<Chain | null>;
  write(chain: Chain): Promise<void>;
  writeSnapshot(chainId: string, visit: number, items: readonly NumberedItem[]): Promise<void>;
  readSnapshot(chainId: string, visit: number): Promise<NumberedItem[]>;
  /** Every closed visit's items, in number order. */
  history(chain: Chain): Promise<NumberedItem[]>;
  writeRecord(chainId: string, deliveryId: string, text: string): Promise<string>;
  readRecord(chainId: string, deliveryId: string): Promise<string | null>;
  recordPath(chainId: string, deliveryId: string): string;
  /** The exact history text a delivery sent: for "show what was sent" and a retry. */
  writeSent(chainId: string, deliveryId: string, text: string): Promise<void>;
  readSent(chainId: string, deliveryId: string): Promise<string | null>;
  /**
   * Runs `task` with the chain files to itself. There is one queue for all chains: a move does not know its chain until
   * it has planned, and moves are rare, so the key only names what the task is about.
   */
  withLock<T>(key: string, task: () => Promise<T>): Promise<T>;
  forget(chainId: string | "all"): Promise<number>;
  /** Removes chains not touched for `days`, and what belongs to them. */
  sweep(days: number, now?: number): Promise<number>;
}

const isId = (value: string) => ID.test(value);

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

async function writePrivate(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  // A file that already existed keeps its mode through rename of a new inode; make sure anyway.
  await chmod(path, 0o600).catch(() => undefined);
}

function validChain(value: unknown): value is Chain {
  const chain = value as Partial<Chain> | null;
  return !!chain && chain.v === 1 && typeof chain.id === "string" && isId(chain.id) && Array.isArray(chain.visits) && Array.isArray(chain.deliveries) && typeof chain.cwd === "string";
}

export function createChainStore(dir: string): ChainStore {
  const chainsDir = join(dir, "chains");
  const index = new Map<string, string>();
  let queue: Promise<unknown> = Promise.resolve();
  let scanning: Promise<void> | null = null;

  const chainFile = (chainId: string) => {
    if (!isId(chainId)) throw new Error(`invalid chain id: ${chainId}`);
    return join(chainsDir, `${chainId}.json`);
  };
  const transcriptDir = (chainId: string) => join(dir, "transcripts", chainId);
  const recordDir = (chainId: string) => join(dir, "records", chainId);
  const sentDir = (chainId: string) => join(dir, "sent", chainId);

  const remember = (chain: Chain) => {
    for (const visit of chain.visits) index.set(visit.agentId, chain.id);
  };

  async function readChainFile(chainId: string): Promise<Chain | null> {
    let text: string;
    try {
      text = await readFile(chainFile(chainId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const value: unknown = JSON.parse(text);
      if (validChain(value)) return value;
    } catch {
      // Falls through to quarantine.
    }
    await rename(chainFile(chainId), `${chainFile(chainId)}.corrupt-${Date.now()}`).catch(() => undefined);
    return null;
  }

  async function scan(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(chainsDir);
    } catch {
      return;
    }
    // Older chains first, so an agent that moved to a newer chain is indexed there.
    const chains: Chain[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const chain = await readChainFile(name.slice(0, -".json".length)).catch(() => null);
      if (chain) chains.push(chain);
    }
    chains.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const chain of chains) remember(chain);
  }

  const store: ChainStore = {
    dir,
    ready() {
      scanning ??= scan();
      return scanning;
    },
    chainOf(agentId) {
      return index.get(agentId) ?? null;
    },
    async read(chainId) {
      await store.ready();
      const chain = await readChainFile(chainId);
      if (chain) remember(chain);
      return chain;
    },
    async write(chain) {
      await ensureDir(chainsDir);
      await writePrivate(chainFile(chain.id), `${JSON.stringify(chain, null, 1)}\n`);
      remember(chain);
    },
    async writeSnapshot(chainId, visit, items) {
      const directory = transcriptDir(chainId);
      await ensureDir(directory);
      await writePrivate(join(directory, `${visit}.jsonl`), items.map((item) => JSON.stringify(item)).join("\n") + (items.length ? "\n" : ""));
    },
    async readSnapshot(chainId, visit) {
      let text: string;
      try {
        text = await readFile(join(transcriptDir(chainId), `${visit}.jsonl`), "utf8");
      } catch {
        return [];
      }
      const items: NumberedItem[] = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          items.push(JSON.parse(line) as NumberedItem);
        } catch {
          // A damaged line loses that item only.
        }
      }
      return items;
    },
    async history(chain) {
      const closed = chain.visits.filter((visit) => visit.closedAt && visit.itemCount > 0);
      const parts = await Promise.all(closed.map((visit) => store.readSnapshot(chain.id, visit.n)));
      return parts.flat().sort((a, b) => a.n - b.n);
    },
    recordPath(chainId, deliveryId) {
      if (!isId(chainId) || !isId(deliveryId)) throw new Error("invalid record id");
      return join(recordDir(chainId), `${deliveryId}.md`);
    },
    async writeRecord(chainId, deliveryId, text) {
      const path = store.recordPath(chainId, deliveryId);
      await ensureDir(recordDir(chainId));
      await writePrivate(path, text);
      return path;
    },
    async readRecord(chainId, deliveryId) {
      try {
        return await readFile(store.recordPath(chainId, deliveryId), "utf8");
      } catch {
        return null;
      }
    },
    async writeSent(chainId, deliveryId, text) {
      if (!isId(chainId) || !isId(deliveryId)) throw new Error("invalid delivery id");
      await ensureDir(sentDir(chainId));
      await writePrivate(join(sentDir(chainId), `${deliveryId}.txt`), text);
    },
    async readSent(chainId, deliveryId) {
      if (!isId(chainId) || !isId(deliveryId)) return null;
      try {
        return await readFile(join(sentDir(chainId), `${deliveryId}.txt`), "utf8");
      } catch {
        return null;
      }
    },
    withLock(_key, task) {
      const run = queue.then(task);
      queue = run.catch(() => undefined);
      return run;
    },
    async forget(chainId) {
      await store.ready();
      if (chainId === "all") {
        const ids = new Set(index.values());
        for (const name of await readdir(chainsDir).catch(() => [])) if (name.endsWith(".json")) ids.add(name.slice(0, -".json".length));
        // Everything, including chain files set aside as damaged and what no chain owns any more.
        for (const part of PARTS) await rm(join(dir, part), { recursive: true, force: true });
        index.clear();
        return ids.size;
      }
      if (!isId(chainId)) return 0;
      await rm(chainFile(chainId), { force: true });
      await rm(transcriptDir(chainId), { recursive: true, force: true });
      await rm(recordDir(chainId), { recursive: true, force: true });
      await rm(sentDir(chainId), { recursive: true, force: true });
      for (const [agentId, owner] of index) if (owner === chainId) index.delete(agentId);
      return 1;
    },
    async sweep(days, now = Date.now()) {
      await store.ready();
      let names: string[];
      try {
        names = await readdir(chainsDir);
      } catch {
        return 0;
      }
      const limit = days * 86_400_000;
      const old = async (path: string) => now - ((await stat(path).catch(() => null))?.mtimeMs ?? now) > limit;
      let removed = 0;
      for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const id = name.slice(0, -".json".length);
        const chain = await readChainFile(id).catch(() => null);
        const touched = chain ? Date.parse(chain.updatedAt) : (await stat(join(chainsDir, name)).catch(() => null))?.mtimeMs ?? now;
        if (Number.isFinite(touched) && now - touched > limit) removed += await store.forget(id);
      }
      // What no chain owns (a chain file set aside as damaged, a move cut short by a crash) goes by its own age.
      const owners = new Set((await readdir(chainsDir).catch(() => [])).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -".json".length)));
      for (const name of await readdir(chainsDir).catch(() => [])) {
        if (!name.endsWith(".json") && (await old(join(chainsDir, name)))) await rm(join(chainsDir, name), { force: true });
      }
      for (const part of PARTS.slice(1)) {
        for (const name of await readdir(join(dir, part)).catch(() => [])) {
          if (!owners.has(name) && (await old(join(dir, part, name)))) await rm(join(dir, part, name), { recursive: true, force: true });
        }
      }
      return removed;
    },
  };
  return store;
}
