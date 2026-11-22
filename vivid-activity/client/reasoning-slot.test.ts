import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReasoningBodySlotRegistry,
  getReasoningBodySlotRegistry,
  REASONING_BODY_SLOT_SYMBOL,
  type ReasoningBodySlotProvider,
  type ReasoningBodySlotRegistry,
} from "./reasoning-slot";

function provider(id: string, priority?: number): ReasoningBodySlotProvider {
  return { id, priority, Component: () => null };
}

describe("getReasoningBodySlotRegistry", () => {
  const scope = globalThis as typeof globalThis & { [REASONING_BODY_SLOT_SYMBOL]?: unknown };
  let previous: PropertyDescriptor | undefined;

  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(scope, REASONING_BODY_SLOT_SYMBOL);
    delete scope[REASONING_BODY_SLOT_SYMBOL];
  });

  afterEach(() => {
    if (previous) Object.defineProperty(scope, REASONING_BODY_SLOT_SYMBOL, previous);
    else delete scope[REASONING_BODY_SLOT_SYMBOL];
  });

  it("publishes one v1 registry for later callers, including another module instance", async () => {
    expect(REASONING_BODY_SLOT_SYMBOL).toBe(Symbol.for("paseo.vividActivity.reasoningBodySlot.v1"));
    const registry = getReasoningBodySlotRegistry();
    registry.registerHost("host");
    expect(registry.version).toBe(1);
    expect(scope[REASONING_BODY_SLOT_SYMBOL]).toBe(registry);
    expect(getReasoningBodySlotRegistry()).toBe(registry);

    vi.resetModules();
    const reloaded = await import("./reasoning-slot");
    expect(reloaded.getReasoningBodySlotRegistry()).toBe(registry);
    expect(reloaded.getReasoningBodySlotRegistry().hasActiveHost()).toBe(true);
  });

  it("adopts a v1 registry published before the module loads", async () => {
    const existingProvider = provider("existing");
    const existing: ReasoningBodySlotRegistry = {
      version: 1,
      registerHost: () => () => {},
      hasActiveHost: () => true,
      registerProvider: () => () => {},
      getActiveProvider: () => existingProvider,
      subscribe: () => () => {},
    };
    scope[REASONING_BODY_SLOT_SYMBOL] = existing;

    vi.resetModules();
    const reloaded = await import("./reasoning-slot");
    const registry = reloaded.getReasoningBodySlotRegistry();
    expect(registry).toBe(existing);
    expect(registry.getActiveProvider()).toBe(existingProvider);
    expect(scope[REASONING_BODY_SLOT_SYMBOL]).toBe(existing);
  });

  it("replaces a value missing the v1 registry methods", () => {
    const incomplete = { version: 1 };
    scope[REASONING_BODY_SLOT_SYMBOL] = incomplete;

    const registry = getReasoningBodySlotRegistry();
    expect(registry).not.toBe(incomplete);
    expect(scope[REASONING_BODY_SLOT_SYMBOL]).toBe(registry);
    expect(registry.hasActiveHost()).toBe(false);
  });
});

describe("createReasoningBodySlotRegistry", () => {
  it("counts overlapping registrations for the same host and notifies on activity changes", () => {
    const registry = createReasoningBodySlotRegistry();
    const states: boolean[] = [];
    registry.subscribe(() => states.push(registry.hasActiveHost()));

    expect(registry.hasActiveHost()).toBe(false);
    const unregisterOld = registry.registerHost("host");
    const unregisterNew = registry.registerHost("host");
    unregisterOld();
    unregisterOld();
    expect(registry.hasActiveHost()).toBe(true);
    expect(states).toEqual([true]);

    unregisterNew();
    unregisterNew();
    expect(registry.hasActiveHost()).toBe(false);
    expect(states).toEqual([true, false]);
  });

  it("keeps the host active until the last distinct host unregisters", () => {
    const registry = createReasoningBodySlotRegistry();
    const listener = vi.fn();
    registry.subscribe(listener);

    const unregisterFirst = registry.registerHost("first");
    const unregisterSecond = registry.registerHost("second");
    unregisterFirst();
    expect(registry.hasActiveHost()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    unregisterSecond();
    expect(registry.hasActiveHost()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("selects the highest priority, using zero for an omitted priority", () => {
    const registry = createReasoningBodySlotRegistry();
    const low = provider("low", -1);
    const normal = provider("normal");
    const high = provider("high", 1);

    expect(registry.getActiveProvider()).toBeNull();
    const unregisterLow = registry.registerProvider(low);
    expect(registry.getActiveProvider()).toBe(low);
    const unregisterNormal = registry.registerProvider(normal);
    expect(registry.getActiveProvider()).toBe(normal);
    const unregisterHigh = registry.registerProvider(high);
    expect(registry.getActiveProvider()).toBe(high);

    unregisterHigh();
    expect(registry.getActiveProvider()).toBe(normal);
    unregisterNormal();
    expect(registry.getActiveProvider()).toBe(low);
    unregisterLow();
    expect(registry.getActiveProvider()).toBeNull();
  });

  it.each([NaN, Infinity, -Infinity])("treats priority %s as zero", (priority) => {
    const registry = createReasoningBodySlotRegistry();
    registry.registerProvider(provider("zero", 0));
    const nonFinite = provider("non-finite", priority);
    registry.registerProvider(nonFinite);
    expect(registry.getActiveProvider()).toBe(nonFinite);

    const high = provider("high", 1);
    registry.registerProvider(high);
    expect(registry.getActiveProvider()).toBe(high);
  });

  it("gives ties to the latest registration and preserves a same-ID replacement during old cleanup", () => {
    const registry = createReasoningBodySlotRegistry();
    const old = provider("primary");
    const other = provider("other", 0);
    const replacement = provider("primary", 0);

    const unregisterOld = registry.registerProvider(old);
    registry.registerProvider(other);
    expect(registry.getActiveProvider()).toBe(other);
    const unregisterNew = registry.registerProvider(replacement);
    expect(registry.getActiveProvider()).toBe(replacement);

    unregisterOld();
    unregisterOld();
    expect(registry.getActiveProvider()).toBe(replacement);
    unregisterNew();
    unregisterNew();
    expect(registry.getActiveProvider()).toBe(other);
  });

  it("keeps provider snapshots stable and notifies only when the active reference changes", () => {
    const registry = createReasoningBodySlotRegistry();
    const active = provider("active", 1);
    const snapshots: (ReasoningBodySlotProvider | null)[] = [];
    registry.subscribe(() => snapshots.push(registry.getActiveProvider()));

    const unregisterFirst = registry.registerProvider(active);
    const snapshot = registry.getActiveProvider();
    const unregisterLow = registry.registerProvider(provider("low"));
    expect(registry.getActiveProvider()).toBe(snapshot);
    unregisterLow();
    const unregisterLatest = registry.registerProvider(active);
    unregisterFirst();
    expect(registry.getActiveProvider()).toBe(snapshot);
    expect(snapshots).toEqual([active]);

    unregisterLatest();
    expect(snapshots).toEqual([active, null]);
  });

  it("isolates listener errors and supports idempotent unsubscription", () => {
    const registry = createReasoningBodySlotRegistry();
    const failing = vi.fn(() => { throw new Error("listener failed"); });
    const listener = vi.fn();
    registry.subscribe(failing);
    const unsubscribe = registry.subscribe(listener);

    const unregister = registry.registerHost("host");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    unsubscribe();

    unregister();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("uses a listener snapshot when subscriptions change during a notification", () => {
    const registry = createReasoningBodySlotRegistry();
    const removed = vi.fn();
    const added = vi.fn();
    registry.subscribe(() => {
      unsubscribeRemoved();
      registry.subscribe(added);
    });
    const unsubscribeRemoved = registry.subscribe(removed);

    const unregister = registry.registerHost("host");
    expect(removed).toHaveBeenCalledTimes(1);
    expect(added).not.toHaveBeenCalled();

    unregister();
    expect(removed).toHaveBeenCalledTimes(1);
    expect(added).toHaveBeenCalledTimes(1);
  });
});
