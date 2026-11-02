import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { object } from "./tokens/values";

const MAX_BYTES = 4 * 1024 * 1024, CACHE_MS = 5000;
export interface ZcodeSessionOptions {
  /** Homes discovered from this provider's actual environment/command/launcher, in precedence order. */
  homes?: readonly string[];
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  /** Bounded metadata reader; null for a missing, unreadable or oversized map. */
  readText?: (path: string) => Promise<string | null>;
}

async function readAliases(path: string): Promise<string | null> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { return null; }
  try {
    const details = await handle.stat();
    if (!details.isFile() || details.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(details.size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read);
      if (!bytesRead) return null;
      read += bytesRead;
    }
    return buffer.toString("utf8");
  } catch { return null; }
  finally { await handle.close(); }
}

/** ACP UUID -> native SQLite id. Each owner has its own cache; concurrent requests share one metadata read. */
export class ZcodeSessions {
  private readonly homes: string[];
  private readonly now: () => number;
  private readonly readText: (path: string) => Promise<string | null>;
  private aliases = new Map<string, string>();
  private expiresAt = -Infinity;
  private pending: Promise<void> | null = null;

  constructor(options: ZcodeSessionOptions = {}) {
    const home = options.home ?? homedir(), env = options.env ?? process.env;
    this.homes = [...new Set([...(options.homes ?? []), env.ZCODE_HOME || join(home, ".zcode"), join(home, ".zcode")])];
    this.now = options.now ?? Date.now; this.readText = options.readText ?? readAliases;
  }

  async resolve(id: string): Promise<string> {
    if (id.startsWith("sess_")) return id;
    if (!this.pending && this.now() >= this.expiresAt) {
      this.pending = this.refresh().finally(() => { this.expiresAt = this.now() + CACHE_MS; this.pending = null; });
    }
    if (this.pending) await this.pending;
    return this.aliases.get(id) ?? id;
  }

  private async refresh(): Promise<void> {
    const next = new Map<string, string>();
    for (const home of this.homes) {
      try {
        const text = await this.readText(join(home, "v2", "acp-lazy-sessions.json"));
        if (text === null || Buffer.byteLength(text) > MAX_BYTES) continue;
        for (const [key, value] of Object.entries(object(JSON.parse(text)))) {
          const native = object(value).zcodeSid;
          if (key.length <= 256 && typeof native === "string" && /^sess_[A-Za-z0-9_-]{1,240}$/.test(native) && !next.has(key)) next.set(key, native);
        }
      } catch { /* A missing or incomplete bridge map leaves the id unmatched until the next refresh. */ }
    }
    this.aliases = next;
  }
}
