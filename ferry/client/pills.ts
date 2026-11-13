import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { failureKind, type FailureKind } from "../shared/failure";
import { t } from "../shared/text";
import { readStubSettings, stubSettings, type StubSettings } from "./settings-read";

interface AgentEntry {
  id: string;
  provider: string;
  workspaceId?: string | null;
  status: string;
  attentionReason?: string | null;
  lastError?: string | null;
  archivedAt?: string | null;
}

interface AgentPage {
  entries: { agent: unknown }[];
  pageInfo?: { hasMore?: boolean; nextCursor?: string | null } | null;
}

interface Observation {
  subscribe(observer: { snapshot(page: AgentPage): void; update(message: { type: string; payload?: unknown }): void; error?(error: unknown): void }): () => void;
  release(): Promise<void>;
}

const SETTINGS_TTL_MS = 60_000;
/**
 * Paseo lists composer buttons in the order they were added, and other plugins add theirs as soon as they know an
 * agent. Waiting a moment puts Ferry's to their right; later changes go through update(), which keeps the place.
 */
export const FIRST_DELAY_MS = 1500;
export const NEW_AGENT_DELAY_MS = 500;
const RETRY_MIN_MS = 2000;
const RETRY_MAX_MS = 60_000;

const REASON = {
  limit: () => t("boot.pillLimit"),
  connection: () => t("boot.pillConnection"),
  context: () => t("boot.pillContext"),
  error: () => t("boot.pillError"),
} satisfies Record<FailureKind, () => string>;

interface Pill {
  workspaceId: string;
  registration: PluginButtonRegistration;
  signature: string;
}

/**
 * Ferry's button by the composer. With the setting on, every agent has one: "⇄ Ferry", a menu with the partner
 * configured for its provider ("Continue on provider-b") and "Pick another…", or the picker at once when there is no partner.
 * After a failed turn (out of quota, a route that does not connect, a full context, a crash) the same button says so,
 * "Out of quota → provider-b", and one press continues there. With the setting off, only failed agents get the button.
 *
 * The agents come from one observation of the host's list (a snapshot, again after every reconnect, then updates);
 * Paseo mounts a button only while its agent's composer is on screen. Settings are read once before the first button
 * and again at most once a minute as agents change.
 */
export function registerPills(client: PluginClientContext, open: (agentId: string, target: string | null) => void, onLanguage: (listener: () => void) => () => void): () => void {
  const pills = new Map<string, Pill>();
  const agents = new Map<string, AgentEntry>();
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  const lifetime = new AbortController();
  let settings: StubSettings | null = null;
  let settingsAt = 0;
  let reading: Promise<void> | null = null;
  let observation: Observation | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = RETRY_MIN_MS;
  let snapshots = 0;
  /** Agents changed since the last snapshot: a page fetched later must not overwrite them. */
  const changed = new Set<string>();

  const freshSettings = () => {
    if (settings && Date.now() - settingsAt < SETTINGS_TTL_MS) return;
    reading ??= readStubSettings(client)
      .then((values) => {
        const before = settings ? JSON.stringify([settings.composerButton, settings.failurePill, settings.partners]) : null;
        settings = values;
        settingsAt = Date.now();
        if (before !== null && before !== JSON.stringify([values.composerButton, values.failurePill, values.partners])) refreshAll();
      })
      .catch(() => {
        // Unreadable for now: the defaults, and another try a minute later.
        settings ??= stubSettings(null);
        settingsAt = Date.now();
      })
      .finally(() => {
        reading = null;
      });
  };

  /** The button an agent should have now, or null. */
  const wanted = (agent: AgentEntry): (PluginButton & { signature: string }) | null => {
    if (!settings || !agent.workspaceId || agent.archivedAt) return null;
    const failure = settings.failurePill ? failureKind(agent.status, agent.attentionReason, agent.lastError) : null;
    if (!failure && !settings.composerButton) return null;
    const partner = settings.partners.find((entry) => entry.from === agent.provider)?.to ?? null;
    const name = partner ? partner.split("/")[0]! : null;
    if (failure) {
      const reason = REASON[failure]();
      const label = name ? t("boot.pillTo", { reason, target: name }) : t("boot.pillPick", { reason });
      return {
        title: name ? t("boot.pillTitleTo", { target: name }) : t("boot.pillTitlePick"),
        icon: "ArrowLeftRight",
        label,
        behavior: { kind: "action", onPress: () => open(agent.id, partner) },
        signature: `failed|${label}|${partner ?? ""}`,
      };
    }
    return {
      title: t("boot.pillTitleIdle"),
      icon: "ArrowLeftRight",
      label: t("boot.pillIdle"),
      behavior: name
        ? {
            kind: "menu",
            items: [
              { kind: "item", id: "partner", title: t("boot.pillMenuTo", { target: name }), behavior: { kind: "action", onPress: () => open(agent.id, partner) } },
              { kind: "item", id: "pick", title: t("boot.pillMenuPick"), behavior: { kind: "action", onPress: () => open(agent.id, null) } },
            ],
          }
        : { kind: "action", onPress: () => open(agent.id, null) },
      signature: `idle|${t("boot.pillIdle")}|${partner ?? ""}`,
    };
  };

  const drop = (agentId: string) => {
    const timer = waiting.get(agentId);
    if (timer) clearTimeout(timer);
    waiting.delete(agentId);
    pills.get(agentId)?.registration.remove();
    pills.delete(agentId);
  };

  /** Brings an agent's button in line with its state; a new button is added after `delay`. */
  const apply = (agentId: string, delay: number) => {
    if (lifetime.signal.aborted) return;
    const agent = agents.get(agentId);
    const want = agent ? wanted(agent) : null;
    const pill = pills.get(agentId);
    if (!agent || !want) {
      drop(agentId);
      return;
    }
    if (pill && pill.workspaceId !== agent.workspaceId) drop(agentId);
    const current = pills.get(agentId);
    const { signature, ...button } = want;
    if (current) {
      if (current.signature !== signature) {
        current.registration.update(button);
        current.signature = signature;
      }
      return;
    }
    if (waiting.has(agentId)) return;
    waiting.set(
      agentId,
      setTimeout(() => {
        waiting.delete(agentId);
        const latest = agents.get(agentId);
        const now = latest ? wanted(latest) : null;
        if (lifetime.signal.aborted || !latest || !now || pills.has(agentId)) return;
        const { signature: sign, ...shown } = now;
        pills.set(agentId, { workspaceId: latest.workspaceId!, registration: client.addComposerPill({ id: "continue", workspaceId: latest.workspaceId!, agentId, button: shown }), signature: sign });
      }, delay),
    );
  };

  function refreshAll() {
    for (const pill of pills.values()) pill.signature = "";
    for (const agentId of agents.keys()) apply(agentId, NEW_AGENT_DELAY_MS);
  }

  const take = (agent: AgentEntry, delay: number) => {
    agents.set(agent.id, agent);
    freshSettings();
    apply(agent.id, delay);
  };

  const snapshot = (page: AgentPage) => {
    const version = ++snapshots;
    const delay = version === 1 ? FIRST_DELAY_MS : NEW_AGENT_DELAY_MS;
    changed.clear();
    const listed = new Set<string>();
    for (const { agent } of page.entries) {
      const entry = agent as AgentEntry;
      listed.add(entry.id);
      agents.set(entry.id, entry);
    }
    // A snapshot may be the first page only: never drop what it does not list until the last page is in.
    const complete = () => {
      for (const agentId of [...agents.keys()]) {
        if (!listed.has(agentId) && !changed.has(agentId)) {
          agents.delete(agentId);
          drop(agentId);
        }
      }
    };
    const settle = () => {
      for (const agentId of listed) apply(agentId, delay);
    };
    void (async () => {
      let next = page;
      const cursors = new Set<string>();
      while (!lifetime.signal.aborted && version === snapshots && next.pageInfo?.hasMore && next.pageInfo.nextCursor && !cursors.has(next.pageInfo.nextCursor)) {
        cursors.add(next.pageInfo.nextCursor);
        next = (await client.paseo.agents.list({ page: { cursor: next.pageInfo.nextCursor, limit: 200 } })) as unknown as AgentPage;
        for (const { agent } of next.entries) {
          const entry = agent as AgentEntry;
          listed.add(entry.id);
          if (!changed.has(entry.id)) agents.set(entry.id, entry);
        }
      }
      if (lifetime.signal.aborted || version !== snapshots) return;
      if (!next.pageInfo?.hasMore) complete();
      if (!settings) {
        freshSettings();
        await reading;
      }
      settle();
    })().catch((error: unknown) => {
      if (!lifetime.signal.aborted) console.warn("[ferry] could not read every agent for the composer buttons", error);
    });
  };

  const update = (message: { type: string; payload?: unknown }) => {
    if (message.type !== "agent_update") return;
    const change = message.payload as { kind: "upsert"; agent: AgentEntry } | { kind: "remove"; agentId: string };
    if (change.kind === "upsert") {
      changed.add(change.agent.id);
      take(change.agent, NEW_AGENT_DELAY_MS);
    } else {
      changed.add(change.agentId);
      agents.delete(change.agentId);
      drop(change.agentId);
    }
  };

  // An observation that fails (a re-request after a reconnect, say) is released by Paseo: reopen it, backing off.
  const reopen = (error: unknown) => {
    observation = null;
    if (lifetime.signal.aborted || retry) return;
    console.warn("[ferry] agent observation failed; reopening", error);
    retry = setTimeout(() => {
      retry = null;
      observe();
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  };

  function observe() {
    (client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }) as unknown as Promise<AgentPage & { subscription?: Observation }>)
      .then(({ subscription }) => {
        if (lifetime.signal.aborted) return;
        if (!subscription) throw new Error("no agent observation");
        observation = subscription;
        subscription.subscribe({
          snapshot: (page) => {
            retryDelay = RETRY_MIN_MS;
            snapshot(page);
          },
          update,
          error: reopen,
        });
      })
      .catch(reopen);
  }

  // Labels follow the language.
  const stopLanguage = onLanguage(refreshAll);
  freshSettings();
  observe();

  return () => {
    lifetime.abort();
    if (retry) clearTimeout(retry);
    stopLanguage();
    void observation?.release().catch(() => undefined);
    for (const agentId of [...pills.keys(), ...waiting.keys()]) drop(agentId);
    agents.clear();
  };
}
