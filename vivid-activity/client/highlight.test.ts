import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// @ts-expect-error -- prismjs does not declare default export for prism-core
import Prism from "prismjs/components/prism-core.min.js"; // the instance client/highlight.ts registers its grammars on
import { describe, expect, it } from "vitest";
import { BASH_STRING, HIGHLIGHT_BUDGET_MS, HIGHLIGHT_CHUNK_CHARS, highlightCode, highlightCodeSync, MAX_HIGHLIGHT_CHARS, tokenizeInChunks, type HighlightToken } from "./highlight";

describe("Syntax highlighting", () => {
  it("tokenizes shell commands without HTML or DOM APIs", async () => {
    const tokens = await highlightCode("$ bun run test\n170 pass", "bash", true);
    const content = tokens?.flat().map((token) => token.content).join("");
    expect(content).toContain("bun");
    expect(content).toContain("170 pass");
    expect(tokens?.flat().some((token) => token.color)).toBe(true);
  });

  it("tokenizes arbitrary JSON payloads", async () => {
    const tokens = await highlightCode(
      '{\n  "content": [{"type": "text"}]\n}',
      "json",
      true,
    );
    const content = tokens?.flat().map((token) => token.content).join("");
    expect(content).toContain('"content"');
    expect(content).toContain('"text"');
    expect(tokens?.flat().some((token) => token.color)).toBe(true);
  });

  it("tokenizes ANSI terminal output with color sequences", async () => {
    const tokens = await highlightCode("Normal \u001b[32mPASS\u001b[0m \u001b[38;2;255;0;0mFAIL\u001b[0m", "ansi", true);
    const content = tokens?.flat().map((token) => token.content).join("");
    expect(content).toBe("Normal PASS FAIL");
    expect(tokens?.flat().some((token) => token.color)).toBe(true);
    expect(tokens?.flat().find((token) => token.content === "FAIL")?.color).toBe("rgb(255,0,0)");
  });

  it("returns a fallback signal for oversized output", async () => {
    await expect(highlightCode("x".repeat(MAX_HIGHLIGHT_CHARS + 1), "ansi", true)).resolves.toBeNull();
  });

  it("maps syntax tokens to custom theme colors", async () => {
    const themeColors = {
      foreground: "#ffffff",
      foregroundMuted: "#888888",
      accent: "#00aaff",
      statusSuccess: "#00ff88",
      statusWarning: "#ffaa00",
      statusDanger: "#ff4444",
    };
    const code = 'const count = 42; // comment\nconst name = "hello";';
    const tokens = (await highlightCode(code, "javascript", themeColors))?.flat();
    expect(tokens).toBeDefined();

    const commentToken = tokens?.find((t) => t.content === "// comment");
    expect(commentToken?.color).toBe(themeColors.foregroundMuted);

    const stringToken = tokens?.find((t) => t.content === '"hello"');
    expect(stringToken?.color).toBe(themeColors.statusSuccess);

    const keywordToken = tokens?.find((t) => t.content === "const");
    expect(keywordToken?.color).toBe(themeColors.accent);

    const numberToken = tokens?.find((t) => t.content === "42");
    expect(numberToken?.color).toBe(themeColors.statusWarning);
  });

  it("colors bash strings, comments, variables, and keywords with the lightweight grammar", async () => {
    const themeColors = {
      foreground: "#ffffff",
      foregroundMuted: "#888888",
      accent: "#00aaff",
      statusSuccess: "#00ff88",
      statusWarning: "#ffaa00",
      statusDanger: "#ff4444",
    };
    const code = 'if [ -f "$FILE" ]; then\n  echo "found" # check file\nfi';
    const tokens = (await highlightCode(code, "bash", themeColors))?.flat();
    expect(tokens).toBeDefined();

    const comment = tokens?.find((t) => t.content.includes("# check file"));
    expect(comment?.color).toBe(themeColors.foregroundMuted);

    const str = tokens?.find((t) => t.content === '"found"');
    expect(str?.color).toBe(themeColors.statusSuccess);

    const keyword = tokens?.find((t) => t.content === "if");
    expect(keyword?.color).toBe(themeColors.accent);
  });
});

describe("highlighting stays bounded in time (codex-vivid-F1 audit: Prism's own grammars backtrack)", () => {
  const colors = { foreground: "#ffffff", foregroundMuted: "#888888", accent: "#00aaff" };
  const coloured = (line: HighlightToken[] | undefined) => (line ?? []).some((token) => token.color && token.color !== colors.foreground);
  const source = readFileSync(fileURLToPath(new URL("../shared/presentation.ts", import.meta.url)), "utf8").slice(0, 90_000);

  it("still colours long ordinary code from top to bottom, chunk by chunk", () => {
    // A zero clock: highlightCodeSync's real 100 ms budget legitimately ran out mid-file when the suite ran
    // under parallel load, leaving the tail plain (this test flaked on wall time). The budget mechanism itself
    // is audited by the injected-clock test below and the hostile input's small real bound; this one now pins
    // only the colouring contract for ordinary code.
    const tokens = tokenizeInChunks(source, Prism.languages.typescript!, colors, () => 0);
    expect(tokens).toHaveLength(source.split("\n").length);
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(source);
    // The last screenful is coloured like the first one (no budget ran out on ordinary code).
    expect(tokens.slice(-40).some(coloured)).toBe(true);
  });

  it("stops colouring and shows the rest as it is once the budget is spent", () => {
    // 25 lines of one long identifier: Prism's function-variable pattern rescans it from every start (quadratic).
    const hostile = Array.from({ length: 25 }, () => "a".repeat(HIGHLIGHT_CHUNK_CHARS - 10)).join("\n");
    const started = performance.now();
    const tokens = highlightCodeSync(hostile, "tsx", colors)!;
    const took = performance.now() - started;
    expect(tokens).toHaveLength(25);
    expect(tokens.at(-1)).toEqual([{ content: "a".repeat(HIGHLIGHT_CHUNK_CHARS - 10), color: colors.foreground }]);
    expect(took).toBeLessThan(1_500);
    // A line longer than a chunk is never handed to Prism.
    const minified = highlightCodeSync(`${"x".repeat(HIGHLIGHT_CHUNK_CHARS + 1)}\nconst a = 1;\n${"y".repeat(HIGHLIGHT_CHUNK_CHARS)}`, "javascript", colors)!;
    expect(minified[0]).toEqual([{ content: "x".repeat(HIGHLIGHT_CHUNK_CHARS + 1), color: colors.foreground }]);
    expect(coloured(minified[1])).toBe(true);
  });

  it("checks the clock before every chunk, never in the middle of one", () => {
    const grammar = Prism.languages.typescript!;
    let calls = 0;
    // The first chunk starts at t=0; the next check already reads past the budget.
    const clock = () => (calls++ < 2 ? 0 : HIGHLIGHT_BUDGET_MS + 1);
    const tokens = tokenizeInChunks(source, grammar, colors, clock);
    expect(tokens).toHaveLength(source.split("\n").length);
    const firstChunkLines = source.slice(0, HIGHLIGHT_CHUNK_CHARS).split("\n").length - 1;
    expect(tokens.slice(0, Math.floor(firstChunkLines / 2)).some(coloured)).toBe(true);
    expect(tokens.slice(firstChunkLines + 1).every((line) => line.length <= 1 && !coloured(line))).toBe(true);
  });
});

describe("bash strings next to other tokens (codex-vivid-F6)", () => {
  const colors = { foreground: "plain", foregroundMuted: "muted", accent: "keyword", statusSuccess: "string", statusWarning: "number" };
  const strings = (code: string) => highlightCodeSync(code, "bash", colors)!.flat().filter((token) => token.color === "string").map((token) => token.content);

  it("starts a string right after another one, without borrowing the character before it", () => {
    expect(strings('echo "one""two"')).toEqual(['"one"', '"two"']);
    expect(strings(`echo 'one'"two"'three'"four"`)).toEqual(["'one'", '"two"', "'three'", '"four"']);
    expect(strings(`echo A="hello" B='world'`)).toEqual(['"hello"', "'world'"]);
    expect(strings('"x" y')).toEqual(['"x"']);
    // This engine has lookbehind, so the boundary must be the assertion, not the 0.6.0 fallback.
    expect(BASH_STRING.source).toContain("(?<=");
  });

  it("looks back only from a quote, so a long run of backslashes stays linear", () => {
    // With the assertion before the quote, every position in the run scanned the run back again: 100 000 took about 5 s.
    for (const input of ["\\".repeat(100_000) + "a\na", "\\".repeat(100_000) + "\"", "x\\".repeat(100_000)]) {
      const started = performance.now();
      BASH_STRING.exec(input);
      expect(performance.now() - started).toBeLessThan(100);
    }
    // Even run: the quote opens a string. Odd run: it is escaped, and the next quote opens one.
    expect(BASH_STRING.exec("\\".repeat(100_000) + '"x"')?.[0]).toBe('"x"');
    expect(BASH_STRING.exec("\\".repeat(100_001) + '"x"')).toBeNull();
    expect(BASH_STRING.exec("\\".repeat(100_001) + '"x" "y"')?.[0]).toBe('" "');
  });

  it("takes a quote after an even run of backslashes as a quote, after an odd one as escaped", () => {
    expect(strings(String.raw`echo \\"hello"`)).toEqual(['"hello"']);
    expect(strings(String.raw`echo \\\\"x"`)).toEqual(['"x"']);
    expect(strings(String.raw`echo \\\"x"`)).toEqual([]);
    expect(strings(String.raw`echo \"hello`)).toEqual([]);
    expect(strings(String.raw`echo "a \"b\" c" done`)).toEqual([String.raw`"a \"b\" c"`]);
    expect(strings(String.raw`echo "a\\" b`)).toEqual([String.raw`"a\\"`]);
  });
});
