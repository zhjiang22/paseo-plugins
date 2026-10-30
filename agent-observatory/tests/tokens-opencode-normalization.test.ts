import assert from "node:assert/strict";
import test from "node:test";
import { initialParser, parseOpendencodeMessage } from "../server/tokens/parser";
import type { LedgerCall, LogFile } from "../server/tokens/types";
import { tokenTotal } from "../shared/tokens";

test("OpenCode and MiMo normalize separate visible output and reasoning into total output", () => {
  for (const source of ["opencode", "mimo"] as const) {
    const path = `/tmp/${source}.db`;
    const file: LogFile = { path, source, root: 0, parentSession: null, dev: 0, ino: 0, size: 0, mtime: 0, offset: 0, partialBytes: 0, imported: false, state: initialParser(path, null, source) };
    const calls: LedgerCall[] = [];
    const message = (id: string, input: number, output: number, reasoning: number) => ({ id, sessionID: "session", role: "assistant", modelID: "thinking-model", time: { created: 1_000, completed: 3_000 }, tokens: { input, output, reasoning, cache: { read: 0, write: 0 } } });
    // OpenCode 1.19.4 getUsage subtracts reasoning from outputTokens before persisting tokens.output.
    parseOpendencodeMessage(message("visible", 100, 20, 200), file, candidate => calls.push(candidate.call), false);
    parseOpendencodeMessage(message("reasoning-only", 0, 0, 50), file, candidate => calls.push(candidate.call), false);
    parseOpendencodeMessage(message("zero", 0, 0, 0), file, candidate => calls.push(candidate.call), false);
    assert.deepEqual(calls.map(call => [call.output, call.reasoning, tokenTotal(call)]), [[220, 200, 320], [50, 50, 50]]);
  }
});
