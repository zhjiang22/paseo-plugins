// Whether a provider session exists in a session store, before importing it on another provider. Claude Code keeps
// `<config>/projects/<encoded cwd>/<id>.jsonl`; Codex keeps `<home>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`.
// The encoded directory and the date depend on details Ferry cannot know, so the store is searched.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isSessionId } from "../shared/families";

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function list(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function findClaudeSession(configDir: string, sessionId: string): Promise<string | null> {
  const projects = join(configDir, "projects");
  for (const directory of await list(projects)) {
    const file = join(projects, directory, `${sessionId}.jsonl`);
    if (await isFile(file)) return file;
  }
  return null;
}

async function findCodexSession(home: string, sessionId: string): Promise<string | null> {
  const sessions = join(home, "sessions");
  const suffix = `-${sessionId}.jsonl`;
  // Newest days first: a session being continued is usually recent.
  for (const year of (await list(sessions)).sort().reverse()) {
    for (const month of (await list(join(sessions, year))).sort().reverse()) {
      for (const day of (await list(join(sessions, year, month))).sort().reverse()) {
        for (const name of await list(join(sessions, year, month, day))) {
          if (name.endsWith(suffix)) return join(sessions, year, month, day, name);
        }
      }
    }
  }
  return null;
}

/**
 * The session's file in the store a `storeKey` names ("claude:<dir>" or "codex:<dir>"). Null when it is not there;
 * `undefined` when the store cannot be searched (a store named in the settings), and the import itself must tell.
 */
export async function findSessionFile(storeKey: string, sessionId: string): Promise<string | null | undefined> {
  if (!isSessionId(sessionId)) return null;
  const colon = storeKey.indexOf(":");
  const family = storeKey.slice(0, colon);
  const dir = storeKey.slice(colon + 1);
  if (family === "claude") return findClaudeSession(dir, sessionId);
  if (family === "codex") return findCodexSession(dir, sessionId);
  return undefined;
}
