import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TokenIngester } from "../server/tokens/ingester";
import { tokenSourceNames } from "../shared/tokens";
import { iso, type LedgerCall, type LogRoot } from "../server/tokens/types";

// Fictional logs in the shape Qoder CLI writes (field names checked against real logs; values invented).
const NOW = Date.parse("2026-10-11T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const SESSION = "c1000000-0000-4000-8000-00000000000a", SUB = "c2000000-0000-4000-8000-00000000000b";
const runtimeRow = (sessionId: string, model: string) => ({ type: "runtime-config", sessionId, model, reasoningEffort: null, contextWindow: null, generation: null });
const qoderRow = (parts: { type: string; id: string; session?: string; role?: string; at?: number; cwd?: string; sidechain?: boolean; usage?: Record<string, number>; error?: boolean; model?: string }) => ({
  type: parts.type, uuid: parts.id, parentUuid: null, sessionId: parts.session ?? SESSION, timestamp: iso(parts.at ?? NOW - 8_000),
  ...(parts.cwd ? { cwd: parts.cwd } : { cwd: "/home/me/app" }), version: "1.1.78", isSidechain: parts.sidechain ?? false,
  isMeta: false, userType: "external", ...(parts.error ? { isApiErrorMessage: true, error: "authentication_failed" } : {}),
  ...(parts.type === "user" ? { message: { role: "user", content: "PRIVATE_PROMPT" } }
    : { message: { id: parts.id, type: "message", role: "assistant", content: [{ type: "text", text: "PRIVATE_OUTPUT" }],
        ...(parts.model ? { model: parts.model } : {}), stop_reason: "stop",
        ...(parts.usage ? { usage: parts.usage } : {}) } }),
});
const qoderUsage = (input: number, cachedRead: number, cacheWrite: number, output: number) => ({
  input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cachedRead });
async function qoderSession(root: string, name: string, rows: unknown[]): Promise<string> {
  const path = join(root, "home-me-app", `${name}.jsonl`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, rows.map(line).join(""));
  return path;
}
async function ingest(roots: (root: string) => LogRoot[], run: (root: string, ingester: TokenIngester, calls: Map<string, LedgerCall>) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "tokens-qoder-")), calls = new Map<string, LedgerCall>();
  const ingester = new TokenIngester({ roots: roots(root), now: () => NOW, onCall: call => { calls.set(call.key, call); } });
  try { await run(root, ingester, calls); } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
}

test("Qoder: assistant messages with their cache split and response time, the model from runtime-config; errors and side lines are not calls", () => ingest(root => [{ source: "qoder", path: root }], async (root, ingester, calls) => {
  await qoderSession(root, SESSION, [
    { type: "workspace-directories", sessionId: SESSION, directories: ["/home/me/app"] },
    runtimeRow(SESSION, "q-test-model"),
    qoderRow({ type: "user", id: SESSION + "u", at: NOW - 50_000 }),
    qoderRow({ type: "assistant", id: "qmsg1", at: NOW - 40_000, usage: qoderUsage(12, 9_000, 600, 340) }),
    qoderRow({ type: "assistant", id: "qsub", at: NOW - 30_000, session: SESSION, sidechain: true, usage: qoderUsage(70, 0, 0, 7) }),
    qoderRow({ type: "assistant", id: "qerr", at: NOW - 20_000, usage: qoderUsage(5_000, 0, 0, 400), error: true }),
    qoderRow({ type: "assistant", id: "qzero", at: NOW - 10_000, usage: qoderUsage(0, 0, 0, 0) }),
  ]);
  await ingester.backfillAll();
  const rows = [...calls.values()].sort((a, b) => a.at - b.at);
  assert.deepEqual(rows.map(call => [call.source, call.sessionId, call.cwd, call.model, call.input, call.cacheRead, call.cacheWrite, call.output, call.at, call.start, call.subagent]), [
    ["qoder", SESSION, "/home/me/app", "q-test-model", 12, 9_000, 600, 340, NOW - 40_000, NOW - 50_000, false],
    ["qoder", SESSION, "/home/me/app", "q-test-model", 70, 0, 0, 7, NOW - 30_000, NOW - 50_000, true],
  ], "a sidechain row is a sub-agent's; the model comes from runtime-config; the request start is the user row");
  assert.equal(tokenSourceNames.qoder, "Qoder");
  assert.ok(!JSON.stringify([...ingester.files.values()]).includes("PRIVATE_"));
  assert.deepEqual(ingester.roots.map(item => [item.files, item.error]), [[1, null]]);
}));

test("Qoder: a log is read on from where it stopped, and a log in a foreign shape is skipped quietly", () => ingest(root => [{ source: "qoder", path: root }], async (root, ingester, calls) => {
  const path = await qoderSession(root, SESSION, [qoderRow({ type: "assistant", id: "qmsg1", usage: qoderUsage(10, 0, 0, 100) })]);
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  await writeFile(path, line(qoderRow({ type: "assistant", id: "qmsg2", at: NOW - 4_000, usage: qoderUsage(20, 0, 0, 200) })));
  await ingester.poll(true);
  assert.deepEqual([...calls.values()].map(call => call.output).sort((a, b) => a - b), [100, 200]);
  await writeFile(join(root, "home-me-app", "broken.jsonl"), "not json\n{\"type\":\"assistant\"}\n");
  await ingester.poll(true);
  assert.equal(calls.size, 2); assert.equal(ingester.roots[0]!.error, null);
}));

test("Qoder: QODER_CONFIG_DIR moves the project root", () => ingest(root => [{ source: "qoder", path: join(root, "qd") }], async (root, ingester, calls) => {
  await mkdir(join(root, "qd", "projects", "home-me-app"), { recursive: true });
  await writeFile(join(root, "qd", "projects", "home-me-app", `${SESSION}.jsonl`), [
    runtimeRow(SESSION, "q-test-model"), qoderRow({ type: "assistant", id: "qmsg9", usage: qoderUsage(1, 0, 0, 2) }),
  ].map(line).join(""));
  await ingester.backfillAll();
  assert.equal(calls.size, 1);
  assert.equal([...calls.values()][0]!.sessionId, SESSION);
}));
