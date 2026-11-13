import { describe, expect, it } from "vitest";
import { byteLength } from "../shared/bytes";
import type { NumberedItem } from "../shared/model";
import { buildEnvelope, handoffBudget, itemBody, itemLimits, omittedRanges, selectItems, type Candidate } from "../shared/select";
import { stripEnvelopes } from "../shared/envelope";

const candidate = (role: string, kind: string, bytes: number, priority: 1 | 2 | 3 = 1): Candidate => ({ role, kind, bytes, priority });

describe("handoffBudget", () => {
  it("is the configured cap when the window has room", () => {
    expect(handoffBudget({ capTokens: 16_000, windowTokens: 1_000_000, messageBytes: 100 }).effective).toBe(48_000);
  });

  it("never exceeds the largest budget the settings allow", () => {
    expect(handoffBudget({ capTokens: 200_000, windowTokens: 2_000_000, messageBytes: 0 }).effective).toBe(192 * 1024);
  });

  it("assumes a 128k window when the model reports none, and keeps a quarter free", () => {
    const budget = handoffBudget({ capTokens: 64_000, windowTokens: null, usedTokens: 50_000, messageBytes: 1000, images: 1 });
    // The message counts as tokens (1000 bytes: 334), the image as 8192; what is left is in tokens, three bytes each.
    expect(budget).toMatchObject({ window: 128_000, headroom: 32_000, message: 334 + 8192 });
    expect(budget.effective).toBe((128_000 - 50_000 - (334 + 8192) - 32_000) * 3);
  });

  it("is zero when the target is full", () => {
    expect(handoffBudget({ capTokens: 16_000, windowTokens: 200_000, usedTokens: 190_000, messageBytes: 10 }).effective).toBe(0);
  });
});

describe("selectItems", () => {
  it("keeps the latest request, the latest reply and the original request first", () => {
    const list = [candidate("user", "message", 100), candidate("assistant", "message", 100), candidate("user", "message", 100), candidate("assistant", "message", 100)];
    // Room for three: the newest user message, the newest reply, the first user message.
    expect(selectItems(list, 303, 0)).toEqual([0, 2, 3]);
  });

  it("keeps the latest reply even when a minor tool line came after it", () => {
    const list = [candidate("user", "message", 100), candidate("assistant", "message", 100), candidate("system", "todo", 100), candidate("user", "message", 100), candidate("assistant", "message", 300), candidate("tool", "explored", 50, 3)];
    expect(selectItems(list, 604, 0)).toEqual([0, 2, 3, 4]);
  });

  it("skips an item that does not fit and goes on to older ones", () => {
    const list = [candidate("user", "message", 50), candidate("assistant", "message", 50), candidate("assistant", "message", 900), candidate("user", "message", 50), candidate("assistant", "message", 50)];
    expect(selectItems(list, 260, 0)).toEqual([0, 1, 3, 4]);
  });

  it("fills with background items only after the real work", () => {
    const list = [
      candidate("user", "message", 10),
      candidate("tool", "explored", 50, 3),
      candidate("tool", "command", 50, 2),
      candidate("tool", "explored", 50, 3),
      candidate("assistant", "message", 10),
    ];
    // After the pins (0 and 4), 2 (priority 2) goes in before either explored line; only one of those fits after it.
    expect(selectItems(list, 10 + 1 + 10 + 1 + 51 + 51, 0)).toEqual([0, 2, 3, 4]);
  });

  it("keeps the latest task list", () => {
    const list = [candidate("user", "message", 10), candidate("system", "todo", 30), candidate("assistant", "message", 10), candidate("assistant", "message", 500)];
    // The newest reply (500) does not fit; the task list is pinned before the older reply fills the rest.
    expect(selectItems(list, 60, 0)).toEqual([0, 1, 2]);
  });

  it("counts the overhead", () => {
    expect(selectItems([candidate("user", "message", 100)], 150, 60)).toEqual([]);
  });
});

describe("omittedRanges", () => {
  it("collapses runs", () => {
    expect(omittedRanges([1, 2, 3, 4, 5, 6, 7], new Set([3, 6]))).toEqual([
      [1, 2],
      [4, 5],
      [7, 7],
    ]);
  });
});

const items = (count: number, make: (n: number) => Partial<NumberedItem> = () => ({})): NumberedItem[] =>
  Array.from({ length: count }, (_, index) => ({
    n: index + 1,
    visit: 1,
    provider: "claude-main",
    role: index % 2 ? "assistant" : "user",
    kind: "message",
    priority: 1,
    text: `message ${index + 1} ${"lorem ipsum ".repeat(20)}`,
    ...make(index + 1),
  }));

const build = (list: NumberedItem[], budgetBytes: number, extra = {}) =>
  buildEnvelope({
    id: "d1",
    chainId: "c1",
    mode: "full",
    cwd: "/work",
    visits: [{ n: 1, provider: "claude-main", model: null }],
    items: list,
    budgetBytes,
    includeToolOutput: true,
    toolOutputBytes: 6000,
    recordPath: null,
    tool: null,
    ...extra,
  });

describe("buildEnvelope", () => {
  it("sends everything when it fits", () => {
    const built = build(items(5), 16_000);
    expect(built).toMatchObject({ selected: 5, total: 5, omitted: [] });
    expect(built.text).toContain("Included: all 5 items.");
  });

  it("stays within the budget and reports what it left out", () => {
    const built = build(items(200), 4000);
    expect(built.bytes).toBeLessThanOrEqual(4000);
    expect(built.selected).toBeLessThan(200);
    expect(built.numbers).toContain(1);
    expect(built.numbers).toContain(200);
    expect(built.numbers).toContain(199);
    expect(built.text).toMatch(/Omitted: 2-\d+/);
  });

  it("shortens a huge item instead of dropping everything for it", () => {
    const list = items(4, (n) => (n === 2 ? { text: "x".repeat(200_000), role: "assistant" } : {}));
    const built = build(list, 8000);
    expect(built.selected).toBe(4);
    expect(built.bytes).toBeLessThanOrEqual(8000);
  });

  it("leaves command output out when asked", () => {
    const list = items(1, () => ({ role: "tool", kind: "command", priority: 2, text: "$ make\nlots of output" }));
    expect(build(list, 8000, { includeToolOutput: false }).text).not.toContain("lots of output");
    expect(build(list, 8000).text).toContain("lots of output");
  });

  it("is taken off the front of the message it travels with", () => {
    const built = build(items(30), 3000);
    expect(stripEnvelopes(`${built.text}\n\nKeep going`)).toMatchObject({ typed: "Keep going", envelopeId: "d1" });
  });
});

describe("itemBody", () => {
  it("shortens each kind to its share", () => {
    const limits = itemLimits(16_000, { includeToolOutput: true, toolOutputBytes: 6000 });
    expect(limits).toEqual({ message: 4800, output: 4800 });
    const long = "y".repeat(50_000);
    const base: NumberedItem = { n: 1, visit: 1, provider: "p", role: "assistant", kind: "message", priority: 1, text: long };
    expect(byteLength(itemBody(base, limits))).toBeLessThanOrEqual(4800);
    expect(byteLength(itemBody({ ...base, role: "agent" }, limits))).toBeLessThanOrEqual(4096);
    expect(byteLength(itemBody({ ...base, kind: "explored" }, limits))).toBeLessThanOrEqual(600);
    expect(byteLength(itemBody({ ...base, kind: "command", text: `$ run\n${long}` }, limits))).toBeLessThanOrEqual(4800 + 10);
  });
});
