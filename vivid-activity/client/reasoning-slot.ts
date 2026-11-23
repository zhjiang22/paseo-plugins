import type { PluginTheme } from "@getpaseo/plugin";
import type { ComponentType, ReactNode } from "react";

export const REASONING_BODY_SLOT_SYMBOL = Symbol.for(
  "paseo.vividActivity.reasoningBodySlot.v1",
);

export interface ReasoningBodyRenderOverride {
  readonly text?: string;
  readonly phase?: "streaming" | "complete";
}

export interface ReasoningBodySlotProps {
  readonly agentId: string;
  readonly text: string;
  readonly phase: "streaming" | "complete";
  readonly theme: PluginTheme;
  readonly layout: {
    readonly compact: boolean;
    readonly platform: "ios" | "android" | "web";
  };
  readonly timestamp: Date;
  /** Renders vivid-activity's native ReasoningText, optionally with overridden text/phase. */
  readonly renderDefault: (override?: ReasoningBodyRenderOverride) => ReactNode;
}

export interface ReasoningBodySlotProvider {
  readonly id: string;
  readonly priority?: number;
  readonly Component: ComponentType<ReasoningBodySlotProps>;
}

export interface ReasoningBodySlotRegistry {
  readonly version: 1;
  registerHost(hostId: string): () => void;
  hasActiveHost(): boolean;
  registerProvider(provider: ReasoningBodySlotProvider): () => void;
  getActiveProvider(): ReasoningBodySlotProvider | null;
  subscribe(listener: () => void): () => void;
}

export function createReasoningBodySlotRegistry(): ReasoningBodySlotRegistry {
  const hosts = new Map<string, number>();
  const providers = new Map<string, { provider: ReasoningBodySlotProvider; priority: number }>();
  const listeners = new Set<() => void>();
  let activeProvider: ReasoningBodySlotProvider | null = null;

  function notify() {
    const snapshot = [...listeners];
    for (const listener of snapshot) {
      try {
        listener();
      } catch {
        // Each subscriber is independent.
      }
    }
  }

  function updateActiveProvider() {
    let nextProvider: ReasoningBodySlotProvider | null = null;
    let highestPriority = -Infinity;
    for (const { provider, priority } of providers.values()) {
      if (priority >= highestPriority) {
        nextProvider = provider;
        highestPriority = priority;
      }
    }
    if (activeProvider !== nextProvider) {
      activeProvider = nextProvider;
      notify();
    }
  }

  return {
    version: 1,
    registerHost(hostId) {
      const wasActive = hosts.size > 0;
      hosts.set(hostId, (hosts.get(hostId) ?? 0) + 1);
      if (!wasActive) notify();

      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;

        const count = hosts.get(hostId)!;
        if (count > 1) {
          hosts.set(hostId, count - 1);
        } else {
          hosts.delete(hostId);
          if (hosts.size === 0) notify();
        }
      };
    },
    hasActiveHost: () => hosts.size > 0,
    registerProvider(provider) {
      const { id, priority = 0 } = provider;
      const entry = { provider, priority: Number.isFinite(priority) ? priority : 0 };
      // Reinsertion moves an existing ID to the end for priority ties.
      providers.delete(id);
      providers.set(id, entry);
      updateActiveProvider();

      return () => {
        if (providers.get(id) !== entry) return;
        providers.delete(id);
        updateActiveProvider();
      };
    },
    getActiveProvider: () => activeProvider,
    subscribe(listener) {
      const subscription = () => listener();
      listeners.add(subscription);
      return () => {
        listeners.delete(subscription);
      };
    },
  };
}

export function getReasoningBodySlotRegistry(): ReasoningBodySlotRegistry {
  const scope = globalThis as typeof globalThis & {
    [REASONING_BODY_SLOT_SYMBOL]?: Partial<ReasoningBodySlotRegistry>;
  };
  const registry = scope[REASONING_BODY_SLOT_SYMBOL];
  if (
    registry &&
    typeof registry === "object" &&
    registry.version === 1 &&
    typeof registry.registerHost === "function" &&
    typeof registry.hasActiveHost === "function" &&
    typeof registry.registerProvider === "function" &&
    typeof registry.getActiveProvider === "function" &&
    typeof registry.subscribe === "function"
  ) {
    return registry as ReasoningBodySlotRegistry;
  }

  return (scope[REASONING_BODY_SLOT_SYMBOL] = createReasoningBodySlotRegistry());
}
