import { describe, expect, it } from "vitest";
import { renderEnvelope } from "../shared/envelope";
import { diffStat, normalizeRows, type RawRow } from "../shared/normalize";

const TOOL = "ferry_read_history";
const rows = (...items: RawRow["item"][]): RawRow[] => items.map((item, index) => ({ item, timestamp: `2026-11-09T00:00:${String(index).padStart(2, "0")}Z` }));
const normalize = (...items: RawRow["item"][]) => normalizeRows(rows(...items), { toolName: TOOL });
const user = (text: string, extra = {}) => ({ type: "user_message", text, ...extra });
const assistant = (text: string) => ({ type: "assistant_message", text });
const tool = (name: string, detail: Record<string, unknown>, status = "completed", extra = {}) => ({ type: "tool_call", callId: `call-${name}-${Math.random()}`, name, status, error: null, detail, ...extra });

describe("normalizeRows", () => {
  it("keeps messages word for word and drops reasoning and plugin rows", () => {
    const items = normalize(user("Fix the login bug"), { type: "reasoning", text: "thinking…" }, assistant("Done: the token now refreshes."), {
      type: "plugin",
      kind: "turn-docs",
      data: {},
    });
    expect(items.map((item) => [item.role, item.kind, item.text, item.priority])).toEqual([
      ["user", "message", "Fix the login bug", 1],
      ["assistant", "message", "Done: the token now refreshes.", 1],
    ]);
    expect(items[0]!.at).toBe("2026-11-09T00:00:00Z");
  });

  it("takes its own envelope off a replayed message and keeps the user's words", () => {
    const envelope = renderEnvelope({
      id: "d1",
      chainId: "c1",
      mode: "full",
      cwd: "/w",
      visits: [],
      rendered: [],
      selected: 0,
      total: 0,
      omitted: [],
      recordPath: null,
      tool: null,
    });
    expect(normalize(user(`${envelope}\n\nCarry on`)).map((item) => item.text)).toEqual(["Carry on"]);
    expect(normalize(user(envelope))).toEqual([]);
  });

  it("keeps Paseo's fork summary as low-priority prior context", () => {
    const [prior, message] = normalize(user("<chat-history-summary>\nearlier talk\n</chat-history-summary>\n\nNow this"));
    expect(prior).toMatchObject({ role: "system", kind: "prior_context", text: "earlier talk", priority: 3 });
    expect(message).toMatchObject({ role: "user", text: "Now this" });
  });

  it("turns system errors, warnings and errors into system items and drops info notices", () => {
    const items = normalize(
      assistant("[System Error] Claude Code process terminated by signal SIGKILL"),
      { type: "error", message: "rate limited" },
      { type: "notification", level: "warning", message: "slow provider" },
      { type: "notification", level: "info", message: "fyi" },
      { type: "compaction", status: "loading" },
      { type: "compaction", status: "completed" },
    );
    expect(items.map((item) => [item.kind, item.priority])).toEqual([
      ["error", 2],
      ["error", 2],
      ["notice", 3],
      ["compaction", 3],
    ]);
  });

  it("keeps a command, its exit code and the start and end of its output", () => {
    const output = `${"start ".repeat(2000)}\n${"end ".repeat(5000)}\nFAILED test_login`;
    const [item] = normalize(tool("Bash", { type: "shell", command: "npm test", output, exitCode: 1 }));
    expect(item).toMatchObject({ role: "tool", kind: "command", exitCode: 1, priority: 2 });
    expect(item!.text.startsWith("$ npm test\nstart start")).toBe(true);
    expect(item!.text.endsWith("FAILED test_login")).toBe(true);
    expect(item!.text).toMatch(/bytes omitted/);
  });

  it("ranks a quiet successful look-around command below real work", () => {
    const [ls, test] = normalize(tool("Bash", { type: "shell", command: "ls -la", output: "a\nb", exitCode: 0 }), tool("Bash", { type: "shell", command: "pytest", output: "ok", exitCode: 0 }));
    expect(ls!.priority).toBe(3);
    expect(test!.priority).toBe(2);
    const [failing] = normalize(tool("Bash", { type: "shell", command: "cat missing", output: "No such file", exitCode: 1 }));
    expect(failing!.priority).toBe(2);
  });

  it("folds a turn's reads and searches into one line and its edits into another", () => {
    const items = normalize(
      user("look around"),
      tool("Read", { type: "read", filePath: "src/a.ts" }),
      tool("Grep", { type: "search", query: "login", numFiles: 3 }),
      tool("Read", { type: "read", filePath: "src/a.ts" }),
      tool("Edit", { type: "edit", filePath: "src/a.ts", unifiedDiff: "--- a\n+++ b\n@@\n-old\n+new\n+more" }),
      tool("WebFetch", { type: "fetch", url: "https://example.com/doc" }),
      tool("Write", { type: "write", filePath: "README.md", content: "one\ntwo" }),
      tool("Edit", { type: "edit", filePath: "src/a.ts", unifiedDiff: "+x" }),
      user("next turn"),
      tool("Read", { type: "read", filePath: "src/b.ts" }),
    );
    expect(items.map((item) => [item.kind, item.text])).toEqual([
      ["message", "look around"],
      ["explored", 'read src/a.ts (×2)\nsearched "login" (3 files)\nfetched https://example.com/doc'],
      ["file_change", "edited src/a.ts (+3 −1) ×2\nwrote README.md (+2 −0)"],
      ["message", "next turn"],
      ["explored", "read src/b.ts"],
    ]);
  });

  it("keeps only the latest task list, where it stood", () => {
    const items = normalize(
      { type: "todo", items: [{ text: "one", completed: false }] },
      user("go"),
      { type: "todo", items: [{ text: "one", completed: true }, { text: "two", completed: false, status: "in_progress" }, { text: "three", completed: false }] },
    );
    expect(items.map((item) => [item.kind, item.text])).toEqual([
      ["message", "go"],
      ["todo", "- [x] one\n- [~] two\n- [ ] three"],
    ]);
  });

  it("names messages from other agents and keeps schedule prompts as notices", () => {
    const items = normalize(
      tool("send_message", { type: "plain_text", text: "x" }, "completed", { agentMessage: { event: "message", sender: { id: "a-1", title: "Planner" }, text: "Please review PR 7" } }),
      tool("heartbeat", { type: "plain_text", text: "Daily check: run the report" }, "completed", { callId: "paseo-system:heartbeat:1" }),
    );
    expect(items).toMatchObject([
      { role: "agent", kind: "message", from: "Planner", text: "Please review PR 7", priority: 1 },
      { role: "system", kind: "notice", text: "Daily check: run the report" },
    ]);
  });

  it("leaves out Ferry's own history tool and marks an interrupted turn once", () => {
    const items = normalize(
      tool(`mcp__paseo__${TOOL}`, { type: "unknown", input: { from: 1 }, output: "…" }),
      tool("Bash", { type: "shell", command: "sleep 100" }, "canceled"),
      tool("Bash", { type: "shell", command: "sleep 200" }, "canceled"),
    );
    expect(items.map((item) => item.kind)).toEqual(["interrupt", "command", "command"]);
    expect(items[1]).toMatchObject({ status: "canceled" });
  });

  it("describes other tools briefly and adds the error of a failed one", () => {
    const [mcp, plain, sub] = normalize(
      tool("mcp__linear__get_issue", { type: "unknown", input: { id: "ENG-1" }, output: { title: "Bug" } }, "failed", { error: { message: "403 forbidden" } }),
      tool("task_notification", { type: "plain_text", label: "Background task", text: "finished" }),
      tool("Task", { type: "sub_agent", subAgentType: "explore", description: "find callers", log: "found 3 callers" }),
    );
    expect(mcp).toMatchObject({ kind: "tool", status: "failed", priority: 3 });
    expect(mcp!.text).toBe('mcp__linear__get_issue {"id":"ENG-1"}\n→ {"title":"Bug"}\nerror: 403 forbidden');
    expect(plain!.text).toBe("task_notification: Background task\nfinished");
    expect(sub).toMatchObject({ kind: "subagent", text: "explore: find callers\nfound 3 callers", priority: 2 });
  });

  it("redacts before anything is cut", () => {
    const secret = `sk-${"z".repeat(40)}`;
    const [message, command] = normalize(user(`my key is ${secret}`), tool("Bash", { type: "shell", command: `export KEY=${secret}`, output: `${"x".repeat(20000)}\nkey: ${secret}`, exitCode: 0 }));
    expect(message!.text).toBe("my key is [REDACTED]");
    expect(command!.text).not.toContain(secret);
    expect(command!.text).not.toMatch(/sk-z{4,}/);
  });
});

describe("redaction of tool lines", () => {
  it("covers searches, fetches, error text and tool input and output, before any cut", () => {
    const github = `ghp_${"C".repeat(36)}`;
    const google = `AIza${"g".repeat(35)}`;
    const anthropic = `sk-ant-${"b".repeat(40)}`;
    const items = normalize(
      tool("Grep", { type: "search", query: `${github} in config` }),
      tool("WebFetch", { type: "fetch", url: `https://admin:${"hunter2".repeat(2)}@db.example.com/x?key=${google}` }),
      tool("Bash", { type: "shell", command: "curl -fsS https://api.example.com", output: "", exitCode: 22 }, "failed", { error: { message: `401 for Bearer ${"t".repeat(30)} and ${anthropic}` } }),
      tool("mcp__vault__read", { type: "unknown", input: { note: `${"x".repeat(280)} ${github}` }, output: `${"y".repeat(290)} ${anthropic}` }),
    );
    const text = items.map((item) => item.text).join("\n");
    for (const secret of [github, google, anthropic, "hunter2hunter2", "t".repeat(30)]) expect(text, secret).not.toContain(secret);
    // Nothing is cut halfway through a key either.
    expect(text).not.toMatch(/ghp_C{4,}|sk-ant-b{4,}|AIzag{4,}/);
  });
});

describe("diffStat", () => {
  it("counts added and removed lines without the file headers", () => {
    expect(diffStat("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n+c\n context")).toEqual({ added: 2, removed: 1 });
  });
});
