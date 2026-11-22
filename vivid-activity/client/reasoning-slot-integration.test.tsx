import type { PluginClientContext } from "@getpaseo/plugin/client";
import { Children, Component, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import contribute from "../index.client";
import { activitySettings } from "../shared/settings";
import { REASONING_RENDERER_KIND, REASONING_RENDERER_VERSION } from "../shared/timeline";
import { ColorfulReasoning, ReasoningBody, ReasoningSlotBoundary } from "./activity";
import { PlainDetail } from "./activity-lazy";
import { createReasoningBodySlotRegistry, REASONING_BODY_SLOT_SYMBOL, type ReasoningBodySlotProvider } from "./reasoning-slot";
import { applyTakeover } from "./takeover";

const host = vi.hoisted(() => ({ useSettings: vi.fn() }));
vi.mock("@getpaseo/plugin/client", () => ({ useAgent: () => null, useSettings: host.useSettings }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon", ScrollView: "ScrollView" }));
vi.mock("@getpaseo/plugin/client/ui", () => ({ SidebarRow: "SidebarRow" }));
vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove() {} }) },
  Easing: { out: () => () => 0, inOut: () => () => 0 },
  Platform: { OS: "android" },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1 },
  Pressable: "Pressable",
  Text: "Text",
  View: "View",
}));
vi.mock("./i18n-client", () => ({
  useI18n: () => undefined,
  createClientI18n: () => ({
    isReady: () => true,
    ready: async () => undefined,
    localized: (register: () => () => void) => register(),
    subscribe: () => () => {},
    dispose: () => undefined,
  }),
}));
// Keep React's real Component and elements. Drive the hooks for a single render in Node.
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useCallback: <T,>(callback: T) => callback,
  useContext: () => ({ ReasoningText: PlainDetail }),
  useLayoutEffect: () => undefined,
  useEffect: () => undefined,
  useMemo: <T,>(compute: () => T) => compute(),
  useRef: <T,>(current: T) => ({ current }),
  useState: <T,>(initial: T | (() => T)) => [typeof initial === "function" ? (initial as () => T)() : initial, () => {}],
  useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, snapshot: () => T) => {
    const unsubscribe = subscribe(() => {});
    try {
      return snapshot();
    } finally {
      unsubscribe();
    }
  },
}));

const layout = { compact: true, platform: "android", hostOnly: "internal" } as const;
const rowProps: Parameters<typeof ColorfulReasoning>[0] = {
  agentId: "streaming-agent",
  host: { id: "test-host", label: "Test host" },
  item: {
    type: "plugin",
    kind: REASONING_RENDERER_KIND,
    version: REASONING_RENDERER_VERSION,
    data: { text: "Streaming thought", phase: "streaming" },
  },
  layout,
  timestamp: new Date("2026-11-23T10:00:00Z"),
  theme: { colors: {
    surface0: "#101114", surface1: "#17181c", surface2: "#1f2026", border: "#2c2d33",
    foreground: "#ececf1", foregroundMuted: "#9a9aa5", accent: "#20744a", accentForeground: "#ffffff",
    statusSuccess: "#22c55e", statusWarning: "#eab308", statusDanger: "#ef4444",
  } },
};

const provider: ReasoningBodySlotProvider = { id: "reasoning-provider", Component: () => null };
type BodyProps = Parameters<typeof ReasoningBody>[0];
type BoundaryProps = ComponentProps<typeof ReasoningSlotBoundary>;
type BoundaryState = { failed: boolean; provider: ReasoningBodySlotProvider };
const Boundary = ReasoningSlotBoundary as unknown as {
  new (props: BoundaryProps): Component<BoundaryProps, BoundaryState>;
  getDerivedStateFromError(error: Error): Partial<BoundaryState>;
  getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): BoundaryState | null;
};

function findReasoningBody(node: ReactNode): ReactElement<BodyProps> | undefined {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<{ children?: ReactNode }>(child)) continue;
    if (child.type === ReasoningBody) return child as ReactElement<BodyProps>;
    const nested = findReasoningBody(child.props.children);
    if (nested) return nested;
  }
}

function expansion(thinking: "always" | "never") {
  host.useSettings.mockReturnValue({
    status: "ready",
    values: activitySettings.schema.parse({ expansion: { thinking } }),
  });
}

function mockClient() {
  const remover = vi.fn();
  const client = {
    paseo: {},
    rpc: async () => ({ status: "loading" }),
    addSettingsScreen: vi.fn(() => () => {}),
    addScreen: vi.fn(() => () => {}),
    addSidebarHeaderItem: vi.fn(() => () => {}),
    addCommandCenterItem: vi.fn(() => () => {}),
    addTimelineRenderer: vi.fn(() => () => {}),
    addTimelineTransformer: vi.fn(() => remover),
  } as unknown as PluginClientContext;
  return { client, remover };
}

const scope = globalThis as typeof globalThis & { [REASONING_BODY_SLOT_SYMBOL]?: unknown };
const cleanups = new Set<() => void>();
let registry: ReturnType<typeof createReasoningBodySlotRegistry>;
let previous: PropertyDescriptor | undefined;

function mount(client: PluginClientContext, start = contribute) {
  const cleanup = start(client);
  cleanups.add(cleanup);
  return () => {
    if (cleanups.delete(cleanup)) cleanup();
  };
}

beforeEach(() => {
  previous = Object.getOwnPropertyDescriptor(scope, REASONING_BODY_SLOT_SYMBOL);
  registry = createReasoningBodySlotRegistry();
  scope[REASONING_BODY_SLOT_SYMBOL] = registry;
  expansion("always");
});

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
  if (previous) Object.defineProperty(scope, REASONING_BODY_SLOT_SYMBOL, previous);
  else delete scope[REASONING_BODY_SLOT_SYMBOL];
});

describe("ReasoningSlotBoundary", () => {
  it("is a React component and renders the native body after a provider error", () => {
    const children = <>provider body</>;
    const fallback = <>native body</>;
    const renderDefault = vi.fn(() => fallback);
    expect(Boundary.prototype).toBeInstanceOf(Component);
    expect(Boundary.prototype).toHaveProperty("isReactComponent", expect.any(Object));

    const boundary = new Boundary({ provider, renderDefault, children });
    expect(boundary.state).toEqual({ failed: false, provider });
    expect(boundary.render()).toBe(children);
    expect(renderDefault).not.toHaveBeenCalled();

    const failed = Boundary.getDerivedStateFromError(new Error("boom"));
    expect(failed).toEqual({ failed: true });
    Object.assign(boundary.state, failed);
    expect(boundary.render()).toBe(fallback);
  });

  it("keeps a streaming provider failure until the provider reference changes", () => {
    const props = { provider, renderDefault: () => "native body", children: "provider body" };
    const failed = { failed: true, provider };
    const streaming = { ...props, renderDefault: () => "updated native body", children: "updated provider body" };
    expect(Boundary.getDerivedStateFromProps(streaming, failed)).toBeNull();

    const nextProvider = { ...provider };
    const nextProps = { ...streaming, provider: nextProvider };
    const recovered = Boundary.getDerivedStateFromProps(nextProps, failed);
    expect(recovered).toEqual({ failed: false, provider: nextProvider });
    expect(recovered?.provider).toBe(nextProvider);
    const boundary = new Boundary(nextProps);
    Object.assign(boundary.state, failed);
    expect(boundary.render()).toBe(streaming.renderDefault());
    Object.assign(boundary.state, recovered);
    expect(boundary.render()).toBe(streaming.children);
  });
});

describe("reasoning body integration", () => {
  it("mounts and subscribes the reasoning body only for expanded rows", () => {
    const subscribe = vi.spyOn(registry, "subscribe");
    registry.registerProvider(provider);
    expansion("never");
    expect(findReasoningBody(ColorfulReasoning(rowProps))).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();

    expansion("always");
    const body = findReasoningBody(ColorfulReasoning(rowProps));
    expect(body).toBeDefined();
    expect(ReasoningBody(body!.props).type).toBe(ReasoningSlotBoundary);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("returns the native reasoning element directly when there is no provider", () => {
    const body = findReasoningBody(ColorfulReasoning(rowProps))!;
    const fallback = ReasoningBody(body.props);
    expect(fallback.type).toBe(PlainDetail);
    expect(fallback.props).toEqual({
      text: rowProps.item.data.text,
      phase: rowProps.item.data.phase,
      theme: rowProps.theme,
      palette: body.props.palette,
      styles: body.props.styles,
    });
  });

  it.each(["streaming", "complete"] as const)("passes the seven %s slot props through the error boundary", (phase) => {
    registry.registerProvider(provider);
    const item = { ...rowProps.item, data: { ...rowProps.item.data, phase } };
    const body = findReasoningBody(ColorfulReasoning({ ...rowProps, item }))!;
    const result = ReasoningBody(body.props);
    expect(result.type).toBe(ReasoningSlotBoundary);
    expect(result.props.provider).toBe(provider);
    const { children, renderDefault } = result.props;
    expect(children.type).toBe(provider.Component);
    expect(children.props).toStrictEqual({
      agentId: rowProps.agentId,
      text: rowProps.item.data.text,
      phase,
      theme: rowProps.theme,
      layout: { compact: true, platform: "android" },
      timestamp: rowProps.timestamp,
      renderDefault,
    });
    expect(children.props.theme).toBe(rowProps.theme);
    expect(children.props.timestamp).toBe(rowProps.timestamp);
    expect(renderDefault().type).toBe(PlainDetail);
  });
});

describe("reasoning slot host lifecycle", () => {
  it("toggles the active host synchronously with takeover and releases it on cleanup", () => {
    const { client, remover } = mockClient();
    expect(registry.hasActiveHost()).toBe(false);
    const cleanup = mount(client);
    expect(registry.hasActiveHost()).toBe(true);

    applyTakeover("off");
    expect(registry.hasActiveHost()).toBe(false);
    expect(remover).toHaveBeenCalled();
    applyTakeover("reasoning");
    expect(registry.hasActiveHost()).toBe(true);

    remover.mockClear();
    cleanup();
    expect(remover).not.toHaveBeenCalled();
    expect(registry.hasActiveHost()).toBe(false);
  });

  it("keeps the host active when a reloaded contribution overlaps the old one", async () => {
    const states: boolean[] = [];
    registry.subscribe(() => states.push(registry.hasActiveHost()));
    const cleanupOld = mount(mockClient().client);
    expect(registry.hasActiveHost()).toBe(true);

    vi.resetModules();
    const { default: reloaded } = await import("../index.client");
    const cleanupNew = mount(mockClient().client, reloaded);
    cleanupOld();
    expect(registry.hasActiveHost()).toBe(true);
    expect(states).toEqual([true]);

    cleanupNew();
    expect(registry.hasActiveHost()).toBe(false);
    expect(states).toEqual([true, false]);
  });
});
