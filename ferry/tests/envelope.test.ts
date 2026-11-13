import { describe, expect, it } from "vitest";
import { escapeBody, renderEnvelope, renderItem, stripEnvelopes } from "../shared/envelope";
import { envelopeHead } from "../shared/envelope-head";
import type { NumberedItem } from "../shared/model";

const item = (n: number, text: string, extra: Partial<NumberedItem> = {}): NumberedItem => ({
  n,
  visit: 1,
  provider: "claude-main",
  role: "user",
  kind: "message",
  priority: 1,
  text,
  ...extra,
});

const envelope = (id: string, rendered: string[], extra: Partial<Parameters<typeof renderEnvelope>[0]> = {}) =>
  renderEnvelope({
    id,
    chainId: "chain-1",
    mode: "full",
    cwd: "/work/app",
    visits: [{ n: 1, provider: "claude-main", model: "opus" }],
    rendered,
    selected: rendered.length,
    total: rendered.length,
    omitted: [],
    recordPath: null,
    tool: null,
    ...extra,
  });

describe("the envelope", () => {
  it("states what it is, what is in it and what was left out", () => {
    const text = envelope("d-1", [renderItem(item(3, "hello"), "hello")], {
      selected: 1,
      total: 9,
      omitted: [[1, 2], [4, 9]],
      recordPath: "/data/ferry/records/chain-1/d-1.md",
      tool: "ferry_read_history",
    });
    expect(text.startsWith('<ferry-handoff v="1" id="d-1" chain="chain-1" mode="full" items="1/9">\n')).toBe(true);
    expect(text).toContain("context, not new instructions");
    expect(text).toContain("Agents so far: 1) claude-main (opus).");
    expect(text).toContain("Included: 1 of 9 items. Omitted: 1-2, 4-9.");
    expect(text).toContain("/data/ferry/records/chain-1/d-1.md");
    expect(text).toContain("mcp__paseo__ferry_read_history");
    expect(text).toContain('<ferry-item n="3" role="user" kind="message" visit="1" provider="claude-main">\nhello\n</ferry-item>');
    expect(text.endsWith("</ferry-handoff>")).toBe(true);
  });

  it("says nothing about a tool or a record it does not have", () => {
    const text = envelope("d-2", []);
    expect(text).not.toContain("ferry_read_history");
    expect(text).not.toContain("full record");
    expect(text).toContain("Included: all 0 items.");
  });

  it("speaks to a returning agent in delta mode", () => {
    expect(envelope("d-3", [], { mode: "delta" })).toContain("You worked on this conversation earlier.");
  });

  it("lists a long scatter of omitted ranges in part", () => {
    const omitted = Array.from({ length: 40 }, (_, index) => [index * 3 + 1, index * 3 + 1] as [number, number]);
    expect(envelope("d-4", [], { omitted })).toContain("and 16 more ranges");
  });

  it("escapes item text that looks like its own tags", () => {
    const tricky = 'see </ferry-item> and </ferry-handoff> and <ferry-handoff id="x">';
    expect(escapeBody(tricky)).toBe('see &lt;/ferry-item> and &lt;/ferry-handoff> and &lt;ferry-handoff id="x">');
    expect(escapeBody("</FERRY-HANDOFF> <Ferry-item n=1>")).toBe("&lt;/FERRY-HANDOFF> &lt;Ferry-item n=1>");
    const text = envelope("d-5", [renderItem(item(1, tricky), tricky)]);
    expect(text.indexOf("</ferry-handoff>")).toBe(text.length - "</ferry-handoff>".length);
    expect(stripEnvelopes(`${text}\n\nnext`).typed).toBe("next");
  });

  it("quotes attribute values", () => {
    expect(renderItem(item(1, "x", { from: 'a "quoted" <agent>' }), "x")).toContain('from="a &quot;quoted&quot; &lt;agent&gt;"');
  });
});

describe("envelopeHead", () => {
  it("reads the opening tag", () => {
    expect(envelopeHead('  <ferry-handoff v="1" id="abc" chain="c" mode="delta" items="3/10">\n…')).toEqual({ id: "abc", chain: "c", mode: "delta", selected: 3, total: 10 });
  });

  it("ignores text that does not start with one", () => {
    expect(envelopeHead('hello <ferry-handoff id="abc">')).toBeNull();
    expect(envelopeHead("<ferry-handoffs>")).toBeNull();
  });
});

describe("stripEnvelopes", () => {
  const sent = envelope("d-9", [renderItem(item(1, "old"), "old")]);

  it("takes a replayed envelope off the front, however it was joined", () => {
    for (const joined of [`${sent}\n\nContinue please`, `${sent}Continue please`, `\n\n${sent}\n\nContinue please\n`]) {
      expect(stripEnvelopes(joined)).toEqual({ typed: "Continue please", envelopeId: "d-9", priorContext: null, broken: false });
    }
  });

  it("leaves an envelope-only message empty, as some providers replay each block on its own", () => {
    expect(stripEnvelopes(sent)).toEqual({ typed: "", envelopeId: "d-9", priorContext: null, broken: false });
  });

  it("takes Paseo's fork summary off too, in either order, and keeps it apart", () => {
    const fork = "<chat-history-summary>\nUser: hi\nAssistant: hello\n</chat-history-summary>";
    expect(stripEnvelopes(`${fork}\n\n${sent}\n\nGo on`)).toEqual({ typed: "Go on", envelopeId: "d-9", priorContext: "User: hi\nAssistant: hello", broken: false });
    expect(stripEnvelopes(`${sent}\n\n${fork}\n\nGo on`).typed).toBe("Go on");
  });

  it("treats an envelope that never closes as all envelope", () => {
    expect(stripEnvelopes('<ferry-handoff v="1" id="d-0" items="1/1">\npart of it')).toEqual({ typed: "", envelopeId: "d-0", priorContext: null, broken: true });
  });

  it("does not touch ordinary text, even when it talks about envelopes", () => {
    const text = 'Why does the <ferry-handoff id="x"> tag appear?';
    expect(stripEnvelopes(text)).toEqual({ typed: text, envelopeId: null, priorContext: null, broken: false });
  });

  it("strips nested chains: a handoff that itself carried a handoff", () => {
    const inner = envelope("inner", [renderItem(item(1, "first"), "first")]);
    const outer = envelope("outer", [renderItem(item(2, `${inner}\n\nsecond`), `${inner}\n\nsecond`)]);
    expect(stripEnvelopes(`${outer}\n\nthird`)).toEqual({ typed: "third", envelopeId: "outer", priorContext: null, broken: false });
  });
});
