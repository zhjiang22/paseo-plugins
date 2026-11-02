import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { CallSink, Candidate, LogFile } from "./types";
import { callKey, count, object, validStart, type ObjectValue } from "./values";

/** Only cwd is retained from session metadata; prompts and agent state never enter the ledger. */
export async function readKimiMetadata(file: LogFile): Promise<void> {
  const path = join(dirname(dirname(dirname(file.path))), "state.json");
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const details = await handle.stat();
    if (!details.isFile() || details.size > 1024 * 1024) return;
    const row = object(JSON.parse(await handle.readFile("utf8")));
    if (typeof row.cwd === "string") file.state.cwd = row.cwd.slice(0, 4096);
    file.state.metaSeen = true;
  } catch { /* A session may be written before its metadata; retry next poll. */ }
  finally { await handle?.close(); }
}

/** Kimi Code's wire usage.record is incremental per request, not context size or a cumulative turn total. */
export function parseKimiLine(line: string, file: LogFile, sink: CallSink): void {
  if (!/"type"\s*:\s*"(?:profile.bind|llm.request|usage.record)"/.test(line)) return;
  let row: ObjectValue;
  try { row = object(JSON.parse(line)); } catch { return; }
  const state = file.state;
  if (row.type === "profile.bind" || row.type === "llm.request") {
    const model = row.modelAlias || row.model;
    if (typeof model === "string") state.model = model.slice(0, 240);
    if (row.type === "llm.request") state.inputAt = typeof row.time === "number" && Number.isFinite(row.time) ? row.time : null;
    return;
  }
  const usage = object(row.usage), at = row.time;
  if (row.type !== "usage.record" || !usage || typeof at !== "number" || !Number.isFinite(at) || at < 0 ||
      ![usage.inputOther, usage.output, usage.inputCacheRead, usage.inputCacheCreation].some(n => typeof n === "number" && Number.isFinite(n))) return;
  const agent = basename(dirname(file.path));
  const model = typeof row.model === "string" ? row.model.slice(0, 240) : state.model;
  const candidate: Candidate = { forked: false, call: {
    key: callKey(["kimi", state.sessionId, agent, at, state.inputAt, model]), source: "kimi", sessionId: state.sessionId, cwd: state.cwd,
    at, start: validStart(state.inputAt, at), model, input: count(usage.inputOther), cacheRead: count(usage.inputCacheRead),
    cacheWrite: count(usage.inputCacheCreation), output: count(usage.output), reasoning: 0, subagent: agent !== "main",
  } };
  const previous = state.open?.call.key === candidate.call.key ? state.open : null;
  const settled = previous ? null : state.open;
  state.open = candidate; sink(candidate, previous, file, settled);
}
