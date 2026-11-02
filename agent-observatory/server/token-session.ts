import { homedir } from "node:os";
import { dirname } from "node:path";
import type { PaseoApi } from "./paseo-types";
import { providerRoots, providerSource } from "./tokens/roots";
import { object } from "./tokens/values";
import { ZcodeSessions, type ZcodeSessionOptions } from "./zcode-session";

const OTHER_BUILTINS = new Set(["claude", "codex", "grok", "pi", "kimi"]);
/** Pure provider id decoding. Reading ZCode's bridge map belongs to the owning service's TokenSessions. */
export function tokenSessionId(provider: unknown, persistence: unknown): string | null {
  const record = object(persistence);
  if (typeof record.sessionId !== "string") return null;
  const id = record.sessionId.trim();
  if (provider !== "zcode" || !id.startsWith("plugin:")) return id.slice(0, 256) || null;
  if (id.length > 8192) return null;
  try {
    const envelope = object(JSON.parse(id.slice(7))), session = envelope.version === 1 ? object(envelope.data).sessionId : null;
    return typeof session === "string" && session.trim().length > 0 && session.length <= 256 ? session.trim() : null;
  } catch { return null; }
}

export class TokenSessions {
  private readonly zcode: ZcodeSessions;
  private custom = new Map<string, ZcodeSessions>();
  private expiresAt = -Infinity;
  private pending: Promise<void> | null = null;
  private readonly now: () => number;
  constructor(private readonly options: ZcodeSessionOptions = {}) {
    this.zcode = new ZcodeSessions(options); this.now = options.now ?? Date.now;
  }
  async resolve(provider: unknown, persistence: unknown, paseo?: Pick<PaseoApi, "config">): Promise<string | null> {
    if (typeof provider === "string" && !OTHER_BUILTINS.has(provider) && paseo?.config?.get) await this.refresh(paseo);
    const aliases = (typeof provider === "string" ? this.custom.get(provider) : undefined) ?? (provider === "zcode" ? this.zcode : undefined);
    const id = tokenSessionId(aliases ? "zcode" : provider, persistence);
    return aliases && id ? aliases.resolve(id) : id;
  }

  /** Only actual provider definitions identify a custom ZCode provider; its display id is never guessed. */
  private refresh(paseo: Pick<PaseoApi, "config">): Promise<void> {
    if (this.pending) return this.pending;
    if (this.now() < this.expiresAt) return Promise.resolve();
    this.pending = (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const { config } = await Promise.race([paseo.config.get(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("READ_ERROR")), 1500); timer.unref?.();
        })]);
        const providers = Object.fromEntries(Object.entries(object(config.providers)).filter(([id, raw]) => providerSource(id, object(raw)) === "zcode"));
        const roots = await providerRoots(providers, { home: this.options.home ?? homedir(), env: this.options.env ?? process.env });
        this.custom = new Map(Object.keys(providers).map(id => [id, new ZcodeSessions({ ...this.options,
          homes: roots.filter(root => root.provider === id).map(root => dirname(dirname(root.path))),
        })]));
      } catch { /* Preserve the last known definitions until the daemon can be read again. */ }
      finally { if (timer) clearTimeout(timer); }
    })().finally(() => { this.expiresAt = this.now() + 300_000; this.pending = null; });
    return this.pending;
  }
}
