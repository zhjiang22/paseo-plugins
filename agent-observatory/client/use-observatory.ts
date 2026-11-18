import { usePaseo } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { createAgentDirectory } from "../shared/directory-store";
import { isForeground } from "./use-foreground";

type Directory = ReturnType<typeof createAgentDirectory>;
interface Shared { directory: Directory; users: number; release: ReturnType<typeof setTimeout> | null; appState: { remove(): void } | null; stopped: boolean }
type Paseo = ReturnType<typeof usePaseo>;

/**
 * One directory per host connection and scope (archive, 显示后台工作区), shared by the page, the workspace panel and anything else
 * open at the same time (opus-F7): one observation and one paged read instead of one per view. A page switch remounts within
 * moments, so the last user keeps it a little longer instead of re-reading every Agent.
 */
const shared = new WeakMap<Paseo, Map<string, Shared>>();
const LINGER_MS = 15_000;
const scopeKey = (includeArchived: boolean, backgroundWorkspaces: boolean) => `${includeArchived}:${backgroundWorkspaces}`;

function sharedDirectory(paseo: Paseo, includeArchived: boolean, backgroundWorkspaces: boolean): Shared {
  let scopes = shared.get(paseo);
  if (!scopes) { scopes = new Map(); shared.set(paseo, scopes); }
  const key = scopeKey(includeArchived, backgroundWorkspaces);
  let entry = scopes.get(key);
  if (!entry || entry.stopped) {
    entry = { users: 0, release: null, appState: null, stopped: false, directory: createAgentDirectory({
      list: options => paseo.agents.list(options),
      // Paseo 0.9 routes directory events only to observations this surface's API owns.
      observe: options => paseo.agents.list({ ...options, subscribe: {} }).then(result => result.subscription),
    }, { includeArchived, backgroundWorkspaces }) };
    scopes.set(key, entry);
  }
  return entry;
}

function retain(paseo: Paseo, key: string, entry: Shared): () => void {
  if (entry.stopped) { entry.stopped = false; shared.get(paseo)?.set(key, entry); }
  entry.users += 1;
  if (entry.release) { clearTimeout(entry.release); entry.release = null; }
  if (!entry.appState) {
    entry.directory.start(isForeground(AppState.currentState));
    entry.appState = AppState.addEventListener("change", next => entry.directory.setActive(isForeground(next)));
  }
  return () => {
    entry.users -= 1;
    if (entry.users > 0) return;
    entry.release = setTimeout(() => {
      entry.release = null;
      if (entry.users > 0) return;
      entry.appState?.remove(); entry.appState = null;
      entry.stopped = true; entry.directory.stop();
      const scopes = shared.get(paseo);
      if (scopes?.get(key) === entry) scopes.delete(key);
    }, LINGER_MS);
  };
}

/** Keeps the shared directory of a connection and scope running; `release` lets it go after a short while. */
export function retainDirectory(paseo: Paseo, includeArchived: boolean, backgroundWorkspaces = false): { directory: Directory; release: () => void } {
  const entry = sharedDirectory(paseo, includeArchived, backgroundWorkspaces);
  return { directory: entry.directory, release: retain(paseo, scopeKey(includeArchived, backgroundWorkspaces), entry) };
}

/** Host changes get their own directory; disposed host requests cannot leak data. */
export function useObservatory({ includeArchived, backgroundWorkspaces = false }: { includeArchived: boolean; backgroundWorkspaces?: boolean }) {
  const paseo = usePaseo();
  const entry = useMemo(() => sharedDirectory(paseo, includeArchived, backgroundWorkspaces), [paseo, includeArchived, backgroundWorkspaces]);
  useEffect(() => retain(paseo, scopeKey(includeArchived, backgroundWorkspaces), entry), [paseo, includeArchived, backgroundWorkspaces, entry]);
  const state = useSyncExternalStore(entry.directory.subscribe, entry.directory.getSnapshot, entry.directory.getSnapshot);
  return useMemo(() => ({ ...state, refresh: entry.directory.refresh }), [state, entry]);
}
