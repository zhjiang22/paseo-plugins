import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DigestService } from "../server/digest";
import type { PaseoApi } from "../server/paseo-types";
import { StatsDirectory } from "../server/stats-directory";
import { TokenSessions, tokenSessionId } from "../server/token-session";
import { ZcodeSessions } from "../server/zcode-session";

const NOW = Date.parse("2026-10-28T04:00:00Z");
const mapping = (native: string) => JSON.stringify({ bridge: { zcodeSid: native } });
const persistence = { sessionId: "plugin:" + JSON.stringify({ version: 1, data: { sessionId: "bridge" } }) };

test("session decoding rejects malformed shapes without reading metadata", () => {
  for (const value of [null, [], 1, {}, { sessionId: [] }]) assert.equal(tokenSessionId("zcode", value), null);
  for (const envelope of [null, [], { version: 1, data: [] }, { version: 1, data: { sessionId: {} } }, { version: 2, data: { sessionId: "wrong" } }]) {
    assert.equal(tokenSessionId("zcode", { sessionId: "plugin:" + JSON.stringify(envelope) }), null);
  }
  assert.equal(tokenSessionId("zcode", persistence), "bridge");
});

test("ZCode aliases share in-flight reads, respect expiry and remain isolated between instances", async () => {
  let now = NOW, reads = 0, native = "sess_first";
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sessions = new ZcodeSessions({ home: "/host", env: {}, now: () => now, readText: async () => { reads++; await gate; return mapping(native); } });
  const first = sessions.resolve("bridge"), second = sessions.resolve("bridge");
  assert.equal(reads, 1); release(); assert.deepEqual(await Promise.all([first, second]), ["sess_first", "sess_first"]);
  native = "sess_next"; now += 4999;
  assert.equal(await sessions.resolve("bridge"), "sess_first"); assert.equal(reads, 1);
  now++;
  assert.equal(await sessions.resolve("bridge"), "sess_next"); assert.equal(reads, 2);
  const other = new ZcodeSessions({ home: "/other", env: {}, now: () => now, readText: async () => mapping("sess_other") });
  assert.equal(await other.resolve("bridge"), "sess_other"); assert.equal(await sessions.resolve("bridge"), "sess_next");
  assert.equal(await sessions.resolve("sess_native"), "sess_native"); assert.equal(reads, 2);
});

test("ZCode alias discovery prefers the explicit home and retries missing or malformed maps", async () => {
  let now = NOW, phase = 0;
  const paths: string[] = [];
  const sessions = new ZcodeSessions({ home: "/host", env: { ZCODE_HOME: "/custom" }, now: () => now, readText: async path => {
    paths.push(path);
    if (phase === 0) return path.startsWith("/custom/") ? mapping("sess_custom") : mapping("sess_default");
    if (phase === 1) { if (path.startsWith("/custom/")) throw new Error("unreadable"); return "{"; }
    if (phase === 2) return "[]";
    return mapping("sess_recovered");
  } });
  assert.equal(await sessions.resolve("bridge"), "sess_custom");
  assert.deepEqual(paths, ["/custom/v2/acp-lazy-sessions.json", "/host/.zcode/v2/acp-lazy-sessions.json"]);
  for (phase = 1; phase <= 2; phase++) { now += 5000; assert.equal(await sessions.resolve("bridge"), "bridge"); }
  now += 5000; assert.equal(await sessions.resolve("bridge"), "sess_recovered");
});

test("ZCode alias reader skips symlinks and oversized metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-alias-"));
  try {
    await mkdir(join(root, "v2"));
    const map = join(root, "v2", "acp-lazy-sessions.json"), target = join(root, "target.json");
    await writeFile(target, mapping("sess_hidden")); await symlink(target, map);
    const options = { home: root, env: { ZCODE_HOME: root }, now: () => NOW };
    assert.equal(await new ZcodeSessions(options).resolve("bridge"), "bridge");
    await rm(map); await writeFile(map, " ".repeat(4 * 1024 * 1024 + 1));
    assert.equal(await new ZcodeSessions(options).resolve("bridge"), "bridge");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("agent directory and execution review await the same native ZCode attribution", async () => {
  let reads = 0;
  const sessions = new TokenSessions({ home: "/host", env: {}, now: () => NOW, readText: async () => { reads++; return mapping("sess_mapped"); } });
  const agent = { id: "a", cwd: "/work", createdAt: new Date(NOW).toISOString(), provider: "zcode", status: "idle", persistence };
  const paseo = { agents: { list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }), ref: () => ({
    refresh: async () => ({ agent }), timeline: { refetch: async () => ({ epoch: "e", entries: [] }) },
  }) } } as unknown as PaseoApi;
  const directory = new StatsDirectory(() => NOW, sessions);
  let requested: readonly string[] = [];
  const service = new DigestService({ sessions, now: () => NOW, telemetry: { snapshot: async () => ({ events: [] }) },
    tokens: { callsForSessions: async ids => { requested = ids; return null; } } });
  try {
    await Promise.all([directory.refresh(paseo), service.read({ agentId: "a" }, paseo)]);
    assert.equal(directory.agents[0]?.sessionId, "sess_mapped"); assert.deepEqual(requested, ["sess_mapped"]); assert.equal(reads, 1);
  } finally { await service.close(); }
});

test("custom ZCode attribution follows the actual provider command and home in both consumers", async () => {
  let configReads = 0;
  const paths: string[] = [];
  const sessions = new TokenSessions({ home: "/host", env: {}, now: () => NOW, readText: async path => {
    paths.push(path); return mapping(path.startsWith("/provider/") ? "sess_custom" : "sess_default");
  } });
  const agent = { id: "custom", cwd: "/work", createdAt: new Date(NOW).toISOString(), provider: "team-coding", status: "idle", persistence };
  const paseo = {
    config: { get: async () => { configReads++; return { config: { providers: {
      "team-coding": { extends: "acp", command: ["env", "ZCODE_HOME=/provider", "zcode", "--acp"] },
      zcode: { env: { ZCODE_HOME: "/provider" } },
      "zcode-display-only": { extends: "acp", command: ["unrelated-cli"] },
    } } }; } },
    agents: { list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }), ref: () => ({
      refresh: async () => ({ agent }), timeline: { refetch: async () => ({ epoch: "e", entries: [] }) },
    }) },
  } as unknown as PaseoApi;
  const directory = new StatsDirectory(() => NOW, sessions);
  let requested: readonly string[] = [];
  const service = new DigestService({ sessions, now: () => NOW, telemetry: { snapshot: async () => ({ events: [] }) },
    tokens: { callsForSessions: async ids => { requested = ids; return null; } } });
  try {
    await Promise.all([directory.refresh(paseo), service.read({ agentId: "custom" }, paseo)]);
    assert.equal(directory.agents[0]?.sessionId, "sess_custom"); assert.deepEqual(requested, ["sess_custom"]);
    assert.equal(configReads, 1); assert.equal(paths.filter(path => path.startsWith("/provider/")).length, 1);
    assert.equal(await sessions.resolve("team-coding", { sessionId: "bridge" }, paseo), "sess_custom");
    assert.equal(await sessions.resolve("zcode", persistence, paseo), "sess_custom", "the canonical provider also respects its configured home");
    assert.equal(await sessions.resolve("zcode-display-only", persistence, paseo), persistence.sessionId, "a suggestive id cannot reinterpret another provider's persistence");
    assert.equal(configReads, 1);
  } finally { await service.close(); }
});

test("non-ZCode built-ins decode persistence without reading daemon provider metadata", async () => {
  const sessions = new TokenSessions();
  const paseo = { config: { get: async () => { assert.fail("unnecessary provider read"); } } } as unknown as PaseoApi;
  for (const provider of ["claude", "codex", "grok", "pi", "kimi"]) {
    assert.equal(await sessions.resolve(provider, { sessionId: "native" }, paseo), "native");
  }
});
