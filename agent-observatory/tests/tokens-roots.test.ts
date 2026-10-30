import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { PaseoApi } from "@getpaseo/client";
import { defaultRoots, inlineScript, launcherAssignment, launcherCandidates, literalPath, providerRoots, providerSource, readLauncherText, shellCommands, shellWord } from "../server/tokens/roots";
import { MAX_TOKEN_ROOTS, TOKEN_SOURCES, TOKEN_UNMATCHED } from "../shared/tokens";
import { StatsDirectory } from "../server/stats-directory";
import { TokenIngester } from "../server/tokens/ingester";
import { TokenStore } from "../server/tokens/store";
import { DAY, iso } from "../server/tokens/types";

const HOME = "/home/user";
const NOW = Date.parse("2026-10-09T12:00:00Z");
const line = (row: unknown) => JSON.stringify(row) + "\n";
const response = (id: string, at: number) => ({ type: "assistant", timestamp: iso(at), sessionId: `session-${id}`, cwd: "/work/demo-project", requestId: `request-${id}`,
  message: { id, model: "claude-opus-5-5", content: "PRIVATE_OUTPUT", usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } } });

test("default roots follow the daemon's environment, then the standard locations, without duplicates; Codex's archive, Grok, Pi and oh-my-pi are read too", () => {
  assert.deepEqual(defaultRoots({ home: HOME, env: {} }), [
    { source: "claude", path: "/home/user/.claude/projects" }, { source: "claude", path: "/home/user/.config/claude/projects" },
    { source: "codex", path: "/home/user/.codex/sessions" }, { source: "codex", path: "/home/user/.codex/archived_sessions" },
    { source: "grok", path: "/home/user/.grok/sessions" }, { source: "pi", path: "/home/user/.pi/agent/sessions" },
    { source: "omp", path: "/home/user/.omp/agent/sessions" }, { source: "opencode", path: "/home/user/.local/share/opencode" },
    { source: "codebuddy", path: "/home/user/.codebuddy/projects" }, { source: "qoder", path: "/home/user/.qoder/projects" },
    { source: "qoder", path: "/home/user/.qoder-cn/projects" },
    { source: "gemini", path: "/home/user/.gemini/tmp" }, { source: "qwen", path: "/home/user/.qwen/projects" },
    { source: "cline", path: "/home/user/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks" },
    { source: "cline", path: "/home/user/.config/Code - Insiders/User/globalStorage/saoudrizwan.claude-dev/tasks" },
    { source: "cline", path: "/home/user/.config/VSCodium/User/globalStorage/saoudrizwan.claude-dev/tasks" },
    { source: "cline", path: "/home/user/.config/Cursor/User/globalStorage/saoudrizwan.claude-dev/tasks" },
    { source: "cline", path: "/home/user/.config/Windsurf/User/globalStorage/saoudrizwan.claude-dev/tasks" },
    { source: "cline", path: "/home/user/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks" },
    { source: "cline", path: "/home/user/.vscode-server-insiders/data/User/globalStorage/saoudrizwan.claude-dev/tasks" },
    { source: "roo", path: "/home/user/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks" },
    { source: "roo", path: "/home/user/.config/Code - Insiders/User/globalStorage/rooveterinaryinc.roo-cline/tasks" },
    { source: "roo", path: "/home/user/.config/VSCodium/User/globalStorage/rooveterinaryinc.roo-cline/tasks" },
    { source: "roo", path: "/home/user/.config/Cursor/User/globalStorage/rooveterinaryinc.roo-cline/tasks" },
    { source: "roo", path: "/home/user/.config/Windsurf/User/globalStorage/rooveterinaryinc.roo-cline/tasks" },
    { source: "roo", path: "/home/user/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks" },
    { source: "roo", path: "/home/user/.vscode-server-insiders/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks" },
    { source: "kilo", path: "/home/user/.config/Code/User/globalStorage/kilocode.kilo-code/tasks" },
    { source: "kilo", path: "/home/user/.config/Code - Insiders/User/globalStorage/kilocode.kilo-code/tasks" },
    { source: "kilo", path: "/home/user/.config/VSCodium/User/globalStorage/kilocode.kilo-code/tasks" },
    { source: "kilo", path: "/home/user/.config/Cursor/User/globalStorage/kilocode.kilo-code/tasks" },
    { source: "kilo", path: "/home/user/.config/Windsurf/User/globalStorage/kilocode.kilo-code/tasks" },
    { source: "kilo", path: "/home/user/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks" },
    { source: "kilo", path: "/home/user/.vscode-server-insiders/data/User/globalStorage/kilocode.kilo-code/tasks" },
    { source: "hermes", path: "/home/user/.hermes" }, { source: "mimo", path: "/home/user/.local/share/mimocode" },
    { source: "dsh", path: "/home/user/.dsh/storages/cost-meter" },
    { source: "kimi", path: "/home/user/.kimi-code/sessions" }, { source: "zcode", path: "/home/user/.zcode/cli/db" }]);
  assert.deepEqual(defaultRoots({ home: HOME, env: { CLAUDE_CONFIG_DIR: "/srv/claude", CODEX_HOME: "/srv/codex", GROK_HOME: "/srv/grok", PI_CODING_AGENT_DIR: "/srv/pi" } }).map(root => root.path),
    ["/srv/claude/projects", "/home/user/.claude/projects", "/home/user/.config/claude/projects", "/srv/codex/sessions", "/srv/codex/archived_sessions",
      "/srv/grok/sessions", "/home/user/.grok/sessions", "/srv/pi/sessions", "/home/user/.pi/agent/sessions", "/home/user/.omp/agent/sessions",
      "/home/user/.local/share/opencode", "/home/user/.codebuddy/projects", "/home/user/.qoder/projects", "/home/user/.qoder-cn/projects",
      "/home/user/.gemini/tmp", "/home/user/.qwen/projects",
      "/home/user/.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks",
      "/home/user/.config/Code - Insiders/User/globalStorage/saoudrizwan.claude-dev/tasks",
      "/home/user/.config/VSCodium/User/globalStorage/saoudrizwan.claude-dev/tasks",
      "/home/user/.config/Cursor/User/globalStorage/saoudrizwan.claude-dev/tasks",
      "/home/user/.config/Windsurf/User/globalStorage/saoudrizwan.claude-dev/tasks",
      "/home/user/.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks",
      "/home/user/.vscode-server-insiders/data/User/globalStorage/saoudrizwan.claude-dev/tasks",
      "/home/user/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "/home/user/.config/Code - Insiders/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "/home/user/.config/VSCodium/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "/home/user/.config/Cursor/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "/home/user/.config/Windsurf/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "/home/user/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "/home/user/.vscode-server-insiders/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "/home/user/.config/Code/User/globalStorage/kilocode.kilo-code/tasks",
      "/home/user/.config/Code - Insiders/User/globalStorage/kilocode.kilo-code/tasks",
      "/home/user/.config/VSCodium/User/globalStorage/kilocode.kilo-code/tasks",
      "/home/user/.config/Cursor/User/globalStorage/kilocode.kilo-code/tasks",
      "/home/user/.config/Windsurf/User/globalStorage/kilocode.kilo-code/tasks",
      "/home/user/.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks",
      "/home/user/.vscode-server-insiders/data/User/globalStorage/kilocode.kilo-code/tasks",
      "/home/user/.hermes", "/home/user/.local/share/mimocode", "/home/user/.dsh/storages/cost-meter", "/home/user/.kimi-code/sessions", "/home/user/.zcode/cli/db"],
    "a PI_CODING_AGENT_DIR set for Pi is where oh-my-pi writes too: one root, counted as Pi");
  // Pi's session directory can be named itself; it wins over the agent directory.
  assert.deepEqual(defaultRoots({ home: HOME, env: { PI_CODING_AGENT_DIR: "/srv/pi", PI_CODING_AGENT_SESSION_DIR: "/srv/pi-sessions" } }).filter(root => root.source === "pi").map(root => root.path),
    ["/srv/pi-sessions", "/home/user/.pi/agent/sessions"]);
  // oh-my-pi: the same variables, under its own home (PI_CONFIG_DIR names it), before its standard location.
  assert.deepEqual(defaultRoots({ home: HOME, env: { PI_CONFIG_DIR: ".omp-work" } }).filter(root => root.source === "omp").map(root => root.path),
    ["/home/user/.omp-work/agent/sessions", "/home/user/.omp/agent/sessions"]);
  assert.deepEqual(defaultRoots({ home: HOME, env: { PI_CODING_AGENT_DIR: "/srv/omp", PI_CONFIG_DIR: ".omp-work" } }).filter(root => root.source === "omp").map(root => root.path),
    ["/home/user/.omp/agent/sessions"], "the directory PI_CODING_AGENT_DIR names is Pi's root too, so it counts once, as Pi; PI_CONFIG_DIR is not followed when the agent directory is set");
  assert.deepEqual(defaultRoots({ home: HOME, env: { PI_CODING_AGENT_SESSION_DIR: "/srv/pi-sessions" } }).filter(root => root.source === "omp").map(root => root.path),
    ["/home/user/.omp/agent/sessions"], "a session directory shared with Pi counts once, as Pi");
  // OpenCode: its data directory follows XDG_DATA_HOME, then the standard location.
  assert.deepEqual(defaultRoots({ home: HOME, env: { XDG_DATA_HOME: "/srv/xdg" } }).filter(root => root.source === "opencode").map(root => root.path),
    ["/srv/xdg/opencode", "/home/user/.local/share/opencode"]);
  // Gemini CLI and Qwen Code move with their variables, then fall back to their own directory (the log folders stay).
  assert.deepEqual(defaultRoots({ home: HOME, env: { GEMINI_CLI_HOME: "/srv/gem", QWEN_RUNTIME_DIR: "/srv/qw" } }).filter(root => root.source === "gemini" || root.source === "qwen").map(root => root.path),
    ["/srv/gem/tmp", "/home/user/.gemini/tmp", "/srv/qw/projects", "/home/user/.qwen/projects"]);
});

test("only literal absolute paths are accepted; ~ and $HOME expand at the start", () => {
  assert.equal(literalPath("~/.claude-work", HOME), "/home/user/.claude-work");
  assert.equal(literalPath("\"$HOME/.codex-team\"", HOME), "/home/user/.codex-team");
  assert.equal(literalPath("'${HOME}/x/../y'", HOME), "/home/user/y");
  assert.equal(literalPath("~", HOME), HOME);
  for (const value of ["relative/dir", "$XDG_CONFIG_HOME/claude", "/opt/$USER/claude", "`pwd`/x", "", "\"\""]) assert.equal(literalPath(value, HOME), null, value);
});

test("all token sources and their environment roots fit the root budget with room for custom providers", () => {
  const roots = defaultRoots({ home: HOME, env: {
    CLAUDE_CONFIG_DIR: "/srv/claude", CODEX_HOME: "/srv/codex", GROK_HOME: "/srv/grok",
    PI_CODING_AGENT_SESSION_DIR: "/srv/pi-sessions", PI_CONFIG_DIR: ".omp-work", XDG_DATA_HOME: "/srv/xdg",
    CODEBUDDY_CONFIG_DIR: "/srv/codebuddy", QODER_CONFIG_DIR: "/srv/qoder", GEMINI_CLI_HOME: "/srv/gemini",
    QWEN_RUNTIME_DIR: "/srv/qwen", KIMI_CODE_HOME: "/srv/kimi", ZCODE_HOME: "/srv/zcode",
  } });
  assert.deepEqual(new Set(roots.map(root => root.source)), new Set(TOKEN_SOURCES));
  assert.equal(new Set(roots.map(root => root.path)).size, roots.length);
  assert.ok(roots.length <= 50, `the largest standard discovery has ${roots.length} roots`);
  assert.equal(MAX_TOKEN_ROOTS, 64);
  assert.ok(MAX_TOKEN_ROOTS - roots.length >= 14, "custom providers retain discovery capacity");
});

test("a provider writes Claude Code, Codex, Pi or Grok CLI logs when it is one of them, extends one or (over ACP) runs one", () => {
  assert.equal(providerSource("claude", {}), "claude");
  assert.equal(providerSource("codex", { enabled: false } as never), "codex");
  assert.equal(providerSource("claude-team", { extends: "claude" }), "claude");
  assert.equal(providerSource("codex-proxy", { extends: "codex" }), "codex");
  assert.equal(providerSource("kimi", { extends: "acp" }), null);
  // 2.18: a provider id or extends of opencode is OpenCode itself.
  assert.equal(providerSource("opencode", {}), "opencode");
  assert.equal(providerSource("oc-team", { extends: "opencode" }), "opencode");
  // 2.14: Pi (built in or extended), and an ACP provider by the CLI its command runs.
  assert.equal(providerSource("pi", {}), "pi");
  assert.equal(providerSource("pi-work", { extends: "pi" }), "pi");
  // 2.18: oh-my-pi, built in (provider id omp), extended, or run over ACP.
  assert.equal(providerSource("omp", {}), "omp");
  assert.equal(providerSource("omp-work", { extends: "omp" }), "omp");
  assert.equal(providerSource("my-omp", { extends: "acp", command: ["omp", "agent", "stdio"] }), "omp");
  assert.equal(providerSource("omp-team", { extends: "acp", command: ["/opt/bin/omp-acp"] }), "omp");
  assert.equal(providerSource("my-grok", { extends: "acp", command: ["/opt/bin/grok", "agent", "stdio"] }), "grok");
  assert.equal(providerSource("grok-team", { extends: "acp", command: ["grok-cli", "agent", "stdio"] }), "grok");
  assert.equal(providerSource("xai", { extends: "acp", command: ["/home/me/bin/grok-wrapper", "agent", "stdio"] }), "grok");
  assert.equal(providerSource("kimi", { extends: "acp", command: ["kimi", "acp"] }), "kimi");
  assert.equal(providerSource("pipx-tool", { extends: "acp", command: ["pipx", "run", "x"] }), null, "a command merely starting with pi is not Pi");
  assert.equal(providerSource("grok", { extends: "acp" }), null, "an ACP provider is known by its command, not its id");
});

test("launcher text: the last literal assignment wins, in shell, dict and environment-update forms", () => {
  const shell = ["#!/bin/sh", "# export CLAUDE_CONFIG_DIR=/commented/out", "export CLAUDE_CONFIG_DIR=/home/user/.claude", "exec claude \"$@\""].join("\n");
  assert.equal(launcherAssignment(shell, "CLAUDE_CONFIG_DIR", HOME), "/home/user/.claude");
  assert.equal(launcherAssignment("CODEX_HOME=\"$HOME/.codex-proxy\" exec codex", "CODEX_HOME", HOME), "/home/user/.codex-proxy");
  assert.equal(launcherAssignment("export CLAUDE_CONFIG_DIR=/a\nexport CLAUDE_CONFIG_DIR='/b'\n", "CLAUDE_CONFIG_DIR", HOME), "/b");
  assert.equal(launcherAssignment("env = {'CLAUDE_CONFIG_DIR': '/srv/team/claude'}", "CLAUDE_CONFIG_DIR", HOME), "/srv/team/claude");
  assert.equal(launcherAssignment("os.environ[\"CODEX_HOME\"] = \"~/.codex-b\"", "CODEX_HOME", HOME), "/home/user/.codex-b");
  assert.equal(launcherAssignment("process.env.CLAUDE_CONFIG_DIR = '/opt/claude'", "CLAUDE_CONFIG_DIR", HOME), "/opt/claude");
  // Computed values are never evaluated.
  assert.equal(launcherAssignment("env['CLAUDE_CONFIG_DIR'] = str(ROOT / '.claude')", "CLAUDE_CONFIG_DIR", HOME), null);
  assert.equal(launcherAssignment("export CLAUDE_CONFIG_DIR=$(mktemp -d)", "CLAUDE_CONFIG_DIR", HOME), null);
  assert.equal(launcherAssignment("export OTHER_DIR=/x", "CLAUDE_CONFIG_DIR", HOME), null);
});

test("the launcher is the command itself, or the script after an interpreter; -c scripts are read inline", () => {
  assert.deepEqual(launcherCandidates(["/home/user/bin/claude-team", "--verbose"], HOME), ["/home/user/bin/claude-team"]);
  assert.deepEqual(launcherCandidates(["~/bin/codex-proxy"], HOME), ["/home/user/bin/codex-proxy"]);
  assert.deepEqual(launcherCandidates(["/usr/bin/python3", "-u", "/opt/launch.py", "team"], HOME), ["/opt/launch.py"]);
  assert.deepEqual(launcherCandidates(["claude"], HOME), [], "a bare name on PATH is a binary, not a launcher");
  assert.deepEqual(launcherCandidates(["bash", "-c", "export CLAUDE_CONFIG_DIR=/x; exec claude"], HOME), []);
  assert.equal(inlineScript(["bash", "-c", "export CLAUDE_CONFIG_DIR=/x; exec claude"]), "export CLAUDE_CONFIG_DIR=/x; exec claude");
  assert.equal(inlineScript(["claude", "-c"]), null);
});

test("custom providers that move their config directory add roots; the launcher's export overrides env (it runs later); others add none", async () => {
  const reads: string[] = [];
  const texts: Record<string, string> = {
    "/home/user/bin/claude-team": "#!/bin/sh\nexport CLAUDE_CONFIG_DIR=/home/user/.claude-team\nexec claude \"$@\"\n",
    "/home/user/bin/codex-proxy": "#!/bin/sh\nexport CODEX_HOME=/home/user/.codex\nexec codex \"$@\"\n",
    "/home/user/bin/launch.py": "import os\nenv = dict(os.environ)\nenv['CLAUDE_CONFIG_DIR'] = str(ROOT / '.claude')\n",
  };
  const roots = await providerRoots({
    claude: { enabled: false },
    "claude-team": { extends: "claude", command: ["/home/user/bin/claude-team"] },
    "claude-env": { extends: "claude", command: ["/home/user/bin/claude-team"], env: { CLAUDE_CONFIG_DIR: "~/.claude-env", ANTHROPIC_API_KEY: "never-read" } },
    "codex-proxy": { extends: "codex", command: ["/home/user/bin/codex-proxy"] },
    "codex-inline": { extends: "codex", command: ["env", "CODEX_HOME=/srv/codex", "codex"] },
    "claude-python": { extends: "claude", command: ["/usr/bin/python3", "/home/user/bin/launch.py"] },
    kimi: { extends: "acp", command: ["/home/user/bin/claude-team"], env: { CLAUDE_CONFIG_DIR: "/never" } },
    broken: null,
  }, { home: HOME, env: {}, readText: async path => { reads.push(path); return texts[path] ?? null; } });
  assert.deepEqual(roots, [
    { source: "claude", path: "/home/user/.claude-team/projects", provider: "claude-team", via: "launcher" },
    // codex-obs-roots-F1: env is where the spawn starts; the launcher's `export` replaces it, so its directory is the one used.
    { source: "claude", path: "/home/user/.claude-team/projects", provider: "claude-env", via: "launcher" },
    { source: "codex", path: "/home/user/.codex/sessions", provider: "codex-proxy", via: "launcher" },
    { source: "codex", path: "/home/user/.codex/archived_sessions", provider: "codex-proxy", via: "launcher" },
    { source: "codex", path: "/srv/codex/sessions", provider: "codex-inline", via: "command" },
    { source: "codex", path: "/srv/codex/archived_sessions", provider: "codex-inline", via: "command" },
  ]);
  assert.deepEqual(reads, ["/home/user/bin/claude-team", "/home/user/bin/codex-proxy", "/home/user/bin/launch.py"], "only launchers of Claude / Codex providers are read, each once");
});

// codex-obs-roots-F1 (review/scratch/codex-obs/provider-precedence.ts): the daemon spawns the command with the provider's env as
// its starting environment; `env NAME=…` in the command and the launcher's `export` replace it. A synthetic launcher and node
// print the CODEX_HOME they really get; discovery must name that directory.
test("env, then the command line, then the launcher: discovery names the directory the started process really gets (codex-obs-roots-F1)", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-precedence-"));
  try {
    const inherited = join(root, "inherited"), command = join(root, "command"), launched = join(root, "launched"), script = join(root, "launch.sh");
    const print = [process.execPath, "-e", "process.stdout.write(process.env.CODEX_HOME ?? '')"];
    await writeFile(script, `#!/bin/sh\nexport CODEX_HOME='${launched}'\nexec "$@"\n`);
    // How the daemon starts it (utils/spawn.js): the provider's env over its own, then the argv as given.
    const started = async (argv: string[]) => (await promisify(execFile)(argv[0]!, argv.slice(1), { env: { PATH: "/usr/bin:/bin", CODEX_HOME: inherited }, cwd: root })).stdout;
    const discovered = async (argv: string[]) => (await providerRoots({ test: { extends: "codex", env: { CODEX_HOME: inherited }, command: argv } },
      { home: root, env: {}, readText: path => readLauncherText(path) })).map(found => [found.path, found.via]);
    const direct = ["/usr/bin/env", `CODEX_HOME=${command}`, ...print];
    assert.equal(await started(direct), command);
    assert.deepEqual(await discovered(direct), [[join(command, "sessions"), "command"], [join(command, "archived_sessions"), "command"]]);
    const viaLauncher = ["/bin/sh", script, ...print];
    assert.equal(await started(viaLauncher), launched);
    assert.deepEqual(await discovered(viaLauncher), [[join(launched, "sessions"), "launcher"], [join(launched, "archived_sessions"), "launcher"]]);
    // All three name a directory: the launcher runs last.
    const all = ["/usr/bin/env", `CODEX_HOME=${command}`, script, ...print];
    await chmod(script, 0o755);
    assert.equal(await started(all), launched);
    assert.deepEqual(await discovered(all), [[join(launched, "sessions"), "launcher"], [join(launched, "archived_sessions"), "launcher"]]);
    // Only env: it stands.
    assert.deepEqual(await discovered(print), [[join(inherited, "sessions"), "env"], [join(inherited, "archived_sessions"), "env"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("what a launcher may or may not do keeps every literal directory it could use, a few at most (codex-obs-roots-F1)", async () => {
  const roots = async (env: Record<string, string> | undefined, text: string, command: string[] = ["/home/me/bin/codex-launch"]) =>
    (await providerRoots({ p: { extends: "codex", ...(env ? { env } : {}), command } }, { home: "/home/me", env: {}, readText: async path => path === "/home/me/bin/codex-launch" ? text : null }))
      .filter(found => found.path.endsWith("/sessions")).map(found => `${found.via}:${found.path.slice(0, -"/sessions".length)}`);
  const env = { CODEX_HOME: "/srv/env" };
  // A branch: either directory, and env's too (an `if` without `else` keeps it).
  assert.deepEqual(await roots(env, "#!/bin/sh\nif [ -d /srv/a ]; then\n  export CODEX_HOME=/srv/a\nelse\n  export CODEX_HOME=/srv/b\nfi\nexec codex \"$@\"\n"),
    ["launcher:/srv/b", "launcher:/srv/a", "env:/srv/env"]);
  assert.deepEqual(await roots(env, "[ -d /srv/a ] && export CODEX_HOME=/srv/a\nexec codex\n"), ["launcher:/srv/a", "env:/srv/env"]);
  assert.deepEqual(await roots(env, "export CODEX_HOME=/srv/a || exit 1\nexec codex\n"), ["launcher:/srv/a"], "the command before || always runs");
  // Only while unset: env's directory wins over a `${…:-…}` default, which applies without it.
  const fallback = "export CODEX_HOME=\"${CODEX_HOME:-$HOME/.codex-team}\"\nexec codex\n";
  assert.deepEqual(await roots(env, fallback), ["env:/srv/env"]);
  assert.deepEqual(await roots(undefined, fallback), ["launcher:/home/me/.codex-team"]);
  // Computed: what was known stands rather than nothing; quoted pieces of a literal path are one path.
  assert.deepEqual(await roots(env, "export CODEX_HOME=\"$(cat /etc/codex-home)\"\nexec codex\n"), ["env:/srv/env"]);
  assert.deepEqual(await roots(undefined, "export CODEX_HOME=\"$HOME\"/'.codex work'\nexec codex\n"), ["launcher:/home/me/.codex work"]);
  // Unset in the launcher or by `env -u` / `env -i` on the command line: Codex's own directory.
  assert.deepEqual(await roots(env, "unset CODEX_HOME\nexec codex\n"), ["launcher:/home/me/.codex"]);
  assert.deepEqual(await roots(env, "", ["env", "-u", "CODEX_HOME", "codex"]), ["command:/home/me/.codex"]);
  assert.deepEqual(await roots(env, "", ["env", "-i", "PATH=/usr/bin", "codex"]), ["command:/home/me/.codex"]);
  // `env -u NAME` before a launcher: the launcher is still found and read.
  assert.deepEqual(await roots(env, "export CODEX_HOME=/srv/l\nexec codex\n", ["/usr/bin/env", "-u", "CODEX_HOME", "/home/me/bin/codex-launch"]), ["launcher:/srv/l"]);
  // Comments, quoted text and here-documents are not assignments.
  assert.deepEqual(await roots(env, "# export CODEX_HOME=/srv/comment\necho \"export CODEX_HOME=/srv/quoted\"\ncat <<EOF\nexport CODEX_HOME=/srv/heredoc\nEOF\nexec codex\n"), ["env:/srv/env"]);
  // A prefix assignment reaches its own command only: surely the provider when exec'd, maybe otherwise.
  assert.deepEqual(await roots(env, "CODEX_HOME=/srv/x exec codex \"$@\"\n"), ["launcher:/srv/x"]);
  assert.deepEqual(await roots(env, "CODEX_HOME=/srv/x codex-setup\nexec codex\n"), ["launcher:/srv/x", "env:/srv/env"]);
  assert.deepEqual(await roots(env, "exec env CODEX_HOME=/srv/y codex 2>&1\n"), ["launcher:/srv/y"], "a redirection does not send it to the background");
  // A function body may never run; many branches keep the latest three.
  assert.deepEqual(await roots(undefined, "setup() {\n  export CODEX_HOME=/srv/f\n}\nsetup\nexec codex\n"), ["launcher:/srv/f"]);
  const branches = ["case \"$1\" in", ...["a", "b", "c", "d", "e"].map(name => `  ${name}) export CODEX_HOME=/srv/${name} ;;`), "esac", "exec codex"].join("\n");
  assert.deepEqual(await roots(env, branches), ["launcher:/srv/e", "launcher:/srv/d", "launcher:/srv/c"]);
  // An inline `-lc` script is the command's own; a Python launcher's indented or conditional assignment may not run, setdefault only while unset.
  assert.deepEqual(await roots(env, "", ["bash", "-lc", "export CODEX_HOME=/srv/inline; exec codex"]), ["command:/srv/inline"]);
  const python = "import os\nif os.path.isdir('/srv/p'):\n    os.environ['CODEX_HOME'] = '/srv/p'\nos.environ.setdefault('CODEX_HOME', '/srv/default')\nos.execvp('codex', ['codex'])\n";
  assert.deepEqual(await roots(env, python, ["/usr/bin/python3", "/home/me/bin/codex-launch"]), ["launcher:/srv/p", "env:/srv/env"]);
  assert.deepEqual(await roots(undefined, python, ["/usr/bin/python3", "/home/me/bin/codex-launch"]), ["launcher:/srv/p", "launcher:/srv/default"]);
});

test("the shell reader: simple commands with whether they surely run", () => {
  const commands = shellCommands("#!/bin/sh\nexport A=1 # note\nif [ -n \"$X\" ]; then B=2; fi\nC=\"$(printf '%s;%s' a b)\" D='x y'\ntrue && E=5 | cat\nF=6 &\nwhile read -r line; do G=7; done\n( H=8 )\nexec run 2>&1\n");
  assert.deepEqual(commands.map(command => [command.words.join(" "), command.sure]), [
    ["export A=1", true], ["[ -n \"$X\" ]", false], ["B=2", false], ["C=\"$(printf '%s;%s' a b)\" D='x y'", true], ["true", true], ["E=5", false], ["cat", false],
    ["F=6", false], ["read -r line", false], ["G=7", false], ["H=8", false], ["exec run 2>&1", true]]);
  assert.equal(shellWord("\"$HOME/a b\"/c", "/home/me"), "/home/me/a b/c");
  assert.equal(shellWord("~/x", "/home/me"), "/home/me/x");
  for (const raw of ["$OTHER/x", "/srv/*", "`pwd`/x", "relative", "\"unclosed"]) assert.equal(shellWord(raw, "/home/me"), null, raw);
});

test("launcher reads are bounded: small text files only", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-"));
  try {
    await writeFile(join(root, "small.sh"), "export CODEX_HOME=/x\n");
    await writeFile(join(root, "big.sh"), "#".repeat(70 * 1024));
    await writeFile(join(root, "binary"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 1, 2]));
    assert.equal(await readLauncherText(join(root, "small.sh")), "export CODEX_HOME=/x\n");
    assert.equal(await readLauncherText(join(root, "big.sh")), null);
    assert.equal(await readLauncherText(join(root, "binary")), null);
    assert.equal(await readLauncherText(join(root, "missing")), null);
    assert.equal(await readLauncherText(root), null, "a directory is not a launcher");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a custom provider's log root found after the first import counts its whole history once, and is remembered", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-store-"));
  const standard = join(root, "standard"), custom = join(root, "custom-config"), directory = join(root, "data"), launcher = join(root, "claude-team");
  await mkdir(standard, { recursive: true }); await mkdir(join(custom, "projects", "-work-demo-project"), { recursive: true });
  await writeFile(join(standard, "s.jsonl"), line(response("recent", NOW - 60_000)));
  // One call from 90 days ago: past the 60-day dedupe window, so it would be taken for copied history in a known root.
  await writeFile(join(custom, "projects", "-work-demo-project", "old.jsonl"), line(response("old", NOW - 90 * DAY)) + line(response("new", NOW - 30_000)));
  await writeFile(launcher, `#!/bin/sh\nexport CLAUDE_CONFIG_DIR="${custom}"\nexec claude "$@"\n`);
  let configReads = 0;
  const paseo = { config: { get: async () => { configReads++; return { requestId: "r", config: { providers: { "claude-team": { extends: "claude", command: [launcher] } } } }; } } } as unknown as PaseoApi;
  let now = NOW;
  const options = { directory, roots: [{ source: "claude" as const, path: standard }], now: () => now, poll: false, rootContext: { home: root, env: {} } };
  let store = new TokenStore(options);
  try {
    await store.ready;
    await store.poll(true); // the first rescan sets the dedupe floor
    assert.ok(store.ingester.seenFloor !== null);
    await store.discover(paseo); await store.poll(true);
    assert.deepEqual(store.ingester.roots.map(item => item.path), [standard, join(custom, "projects")]);
    const first = await store.read({ range: "90d", utcOffsetMinutes: 0 });
    if (first.mode !== "full") throw new Error("full expected");
    assert.equal(first.allTime.calls, 3, "the 90-day-old call of the late root is counted");
    await store.discover(paseo);
    assert.equal(configReads, 1, "the provider config is read at most every 5 minutes");
    await store.close();
    // Restart: the remembered root keeps its read positions, so nothing is imported again.
    store = new TokenStore(options); await store.ready; await store.poll(true);
    assert.deepEqual(store.ingester.roots.map(item => item.path), [standard, join(custom, "projects")]);
    assert.equal(store.ingester.diagnostics.calls, 0);
    now += 6 * 60_000; await store.discover(paseo); await store.poll(true);
    assert.equal(configReads, 2); assert.equal(store.ingester.roots.length, 2, "an already watched root is not added twice");
    const restored = await store.read({ range: "90d", utcOffsetMinutes: 0 });
    if (restored.mode !== "full") throw new Error("full expected");
    assert.equal(restored.allTime.calls, 3);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("discovery failures leave the default roots working", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-fail-"));
  let now = NOW;
  const store = new TokenStore({ directory: join(root, "data"), roots: [{ source: "claude", path: join(root, "logs") }], now: () => now, poll: false, rootContext: { home: root, env: {} } });
  try {
    await store.ready;
    await store.discover({ config: { get: async () => { throw new Error("denied"); } } } as unknown as PaseoApi);
    now += 6 * 60_000;
    await store.discover({} as PaseoApi);
    assert.equal(store.ingester.roots.length, 1);
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("Grok and Pi providers that move their logs add roots: GROK_HOME, Pi's session directory over its agent directory, Pi's settings, and oh-my-pi like Pi", async () => {
  const texts: Record<string, string> = {
    "/home/user/bin/grok-team": "#!/bin/sh\nexport GROK_HOME=/home/user/.grok-team\nexec grok \"$@\"\n",
    "/home/user/.pi-work/settings.json": JSON.stringify({ theme: "dark", sessionDir: "~/pi-sessions" }),
    "/home/user/.pi/agent/settings.json": JSON.stringify({ sessionDir: "relative/dir" }),
  };
  const reads: string[] = [];
  const roots = await providerRoots({
    "grok-team": { extends: "acp", command: ["/home/user/bin/grok-team", "agent", "stdio"] },
    "grok-env": { extends: "acp", command: ["grok", "agent", "stdio"], env: { GROK_HOME: "/srv/grok" } },
    "grok-plain": { extends: "acp", command: ["grok", "agent", "stdio"] },
    "pi-sessions": { extends: "pi", env: { PI_CODING_AGENT_DIR: "/srv/pi-agent", PI_CODING_AGENT_SESSION_DIR: "/srv/pi-sessions" } },
    "pi-agent": { extends: "pi", env: { PI_CODING_AGENT_DIR: "/srv/pi-agent" } },
    "pi-work": { extends: "pi", command: ["env", "PI_CODING_AGENT_DIR=~/.pi-work", "pi"] },
    pi: {},
    "omp-sessions": { extends: "omp", env: { PI_CODING_AGENT_SESSION_DIR: "/srv/omp-sessions" } },
    "omp-team": { extends: "omp", env: { PI_CODING_AGENT_DIR: "/srv/omp-agent" } },
    "omp-acp": { extends: "acp", command: ["omp", "agent", "stdio"] },
    "gem-unset": { extends: "gemini", env: { GEMINI_CLI_HOME: "" } },
    "qw-team": { extends: "qwen", env: { QWEN_RUNTIME_DIR: "/srv/qw-rt" } },
    kimi: { extends: "acp", command: ["kimi", "acp"], env: { GROK_HOME: "/never" } },
  }, { home: HOME, env: {}, readText: async path => { reads.push(path); return texts[path] ?? null; } });
  assert.deepEqual(roots, [
    { source: "grok", path: "/home/user/.grok-team/sessions", provider: "grok-team", via: "launcher" },
    { source: "grok", path: "/srv/grok/sessions", provider: "grok-env", via: "env" },
    { source: "pi", path: "/srv/pi-sessions", provider: "pi-sessions", via: "env" },
    { source: "pi", path: "/srv/pi-agent/sessions", provider: "pi-agent", via: "env" },
    { source: "pi", path: "/home/user/pi-sessions", provider: "pi-work", via: "settings" },
    { source: "omp", path: "/srv/omp-sessions", provider: "omp-sessions", via: "env" },
    { source: "omp", path: "/srv/omp-agent/sessions", provider: "omp-team", via: "env" },
    { source: "gemini", path: "/home/user/.gemini/tmp", provider: "gem-unset", via: "env" },
    { source: "qwen", path: "/srv/qw-rt/projects", provider: "qw-team", via: "env" },
  ]);
  assert.ok(!reads.some(path => path.includes("kimi")), "a bare Kimi command does not cause arbitrary metadata reads");
  assert.ok(reads.every(path => !/auth|credential/i.test(path)), "no credentials are ever opened");
});

test("a root only one custom provider uses counts its unmatched sessions for that provider; shared and standard roots do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-owner-"));
  const standard = join(root, "standard"), team = join(root, "team"), shared = join(root, "shared");
  for (const [dir, id] of [[standard, "terminal"], [join(team, "projects", "-home-me-app"), "team-terminal"], [join(team, "projects", "-home-me-app"), "team-paseo"], [join(shared, "projects", "-home-me-app"), "shared-terminal"]] as const) {
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, `${id}.jsonl`), line({ ...response(id, NOW - 60_000), sessionId: id }));
  }
  let providers: Record<string, unknown> = {
    "claude-team": { extends: "claude", env: { CLAUDE_CONFIG_DIR: team } },
    "claude-a": { extends: "claude", env: { CLAUDE_CONFIG_DIR: shared } }, "claude-b": { extends: "claude", env: { CLAUDE_CONFIG_DIR: shared } },
    "claude-std": { extends: "claude", env: { CLAUDE_CONFIG_DIR: join(root, "standard-config") } },
  };
  // The standard root is one the daemon watches anyway (here: the root given at construction).
  await mkdir(join(root, "standard-config"), { recursive: true });
  const paseo = { config: { get: async () => ({ requestId: "r", config: { providers } }) } } as unknown as PaseoApi;
  let now = NOW;
  const agents = new StatsDirectory(); agents.loaded = true;
  agents.agents = [{ id: "paseo-agent", createdAt: "2026-10-01T00:00:00Z", provider: "claude-team", model: null, parentAgentId: null, projectKey: "app", projectName: "app",
    status: "idle", archivedAt: null, title: null, requiresAttention: false, attentionReason: null, pendingPermissions: 0, activeTurn: false, contextUsed: null, contextMax: null, sessionId: "team-paseo", cwd: "/home/me/app" }];
  const store = new TokenStore({ directory: join(root, "data"), agents, roots: [{ source: "claude", path: standard }, { source: "claude", path: join(root, "standard-config", "projects") }], now: () => now, poll: false, rootContext: { home: root, env: {} } });
  const rows = async () => {
    const result = await store.read({ range: "7d", utcOffsetMinutes: 0 });
    if (result.mode !== "full") throw new Error("full expected");
    return Object.fromEntries(result.providers!.map(row => [row.key, [row.calls, row.sessions]]));
  };
  try {
    await store.ready;
    await store.discover(paseo); await store.poll(true);
    assert.deepEqual(store.ingester.roots.map(item => [item.path, item.provider ?? null]), [[standard, null], [join(root, "standard-config", "projects"), null],
      [join(team, "projects"), "claude-team"], [join(shared, "projects"), null]]);
    assert.deepEqual(await rows(), { "claude-team": [2, 2], [TOKEN_UNMATCHED]: [2, 2] }, "the team root's terminal session counts for claude-team; the shared and standard ones stay unmatched");
    // The provider gives its directory up: the terminal session is unmatched again, the Paseo one still the agent's.
    providers = { "claude-a": providers["claude-a"]!, "claude-b": providers["claude-b"]! };
    now += 6 * 60_000; await store.discover(paseo);
    assert.equal(store.ingester.roots[2]!.provider, undefined);
    assert.deepEqual(await rows(), { "claude-team": [1, 1], [TOKEN_UNMATCHED]: [3, 3] });
  } finally { await store.close(); await rm(root, { recursive: true, force: true }); }
});

test("an ACP provider is known by the CLI it runs past env, assignments, interpreters and inline scripts, and its log directory is found (r3-F6)", async () => {
  const home = "/home/me";
  assert.equal(providerSource("grok-work", { extends: "acp", command: ["env", "GROK_HOME=/home/me/.grok-work", "grok", "--acp"] }), "grok");
  assert.equal(providerSource("grok-script", { extends: "acp", command: ["bash", "/home/me/bin/grok-acp.sh"] }), "grok");
  assert.equal(providerSource("grok-login", { extends: "acp", command: ["/usr/bin/env", "bash", "-l", "/home/me/bin/grok-acp.sh"] }), "grok");
  assert.equal(providerSource("grok-inline", { extends: "acp", command: ["bash", "-c", "export GROK_HOME=/home/me/.grok-x; cd /home/me && exec \"grok\" --acp"] }), "grok");
  assert.equal(providerSource("pi-env", { extends: "acp", command: ["env", "-i", "PI_CODING_AGENT_DIR=/home/me/.pi-x", "pi", "--mode", "acp"] }), "pi");
  for (const command of [["env", "FOO=1", "unsupported-agent", "acp"], ["bash", "/home/me/bin/agent.sh"], ["env", "pipx", "run", "x"], ["env", "GROK_HOME=/x"], ["bash", "-c", "echo grok; exec unsupported-agent acp"]]) {
    assert.equal(providerSource("other", { extends: "acp", command }), null, command.join(" "));
  }
  const texts: Record<string, string> = { "/home/me/bin/grok-acp.sh": "#!/bin/sh\nexport GROK_HOME=/home/me/.grok-alt\nexec grok --acp \"$@\"\n" };
  const roots = await providerRoots({
    "grok-work": { extends: "acp", command: ["env", "GROK_HOME=/home/me/.grok-work", "grok", "--acp"] },
    "grok-script": { extends: "acp", command: ["bash", "/home/me/bin/grok-acp.sh"] },
    "grok-login": { extends: "acp", command: ["/usr/bin/env", "bash", "-l", "~/bin/grok-acp.sh"] },
    "grok-inline": { extends: "acp", command: ["bash", "-c", "export GROK_HOME=/home/me/.grok-x; exec grok --acp"] },
  }, { home, env: {}, readText: async path => texts[path] ?? null });
  assert.deepEqual(roots, [
    { source: "grok", path: "/home/me/.grok-work/sessions", provider: "grok-work", via: "command" },
    { source: "grok", path: "/home/me/.grok-alt/sessions", provider: "grok-script", via: "launcher" },
    { source: "grok", path: "/home/me/.grok-alt/sessions", provider: "grok-login", via: "launcher" },
    { source: "grok", path: "/home/me/.grok-x/sessions", provider: "grok-inline", via: "command" },
  ]);
  // The launcher is the script past chained launchers too; an inline script has none.
  assert.deepEqual(launcherCandidates(["/usr/bin/env", "bash", "-l", "~/bin/grok-acp.sh"], home), ["/home/me/bin/grok-acp.sh"]);
  assert.deepEqual(launcherCandidates(["env", "GROK_HOME=/x", "/home/me/bin/grok"], home), ["/home/me/bin/grok"]);
  assert.deepEqual(launcherCandidates(["env", "bash", "-c", "exec grok"], home), []);
});

test("a custom provider's late root: a session resumed later from its old history counts only its new calls (r3-F2)", async () => {
  const root = await mkdtemp(join(tmpdir(), "observatory-roots-late-")), standard = join(root, "standard"), custom = join(root, "custom", "projects"), got: string[] = [];
  let now = NOW;
  const ingester = new TokenIngester({ roots: [{ source: "claude", path: standard }], now: () => now, onCall: (call, previous) => { if (!previous) got.push(call.sessionId); } });
  try {
    await mkdir(standard, { recursive: true }); await mkdir(join(custom, "-work-demo-project"), { recursive: true });
    await writeFile(join(standard, "s.jsonl"), line(response("recent", NOW - 60_000)));
    await ingester.backfillAll(); await ingester.poll(true);
    assert.equal(ingester.seenFloor, NOW - 60 * DAY);
    // Found in a provider's config after the first import: its 90-day-old call is counted once…
    await writeFile(join(custom, "-work-demo-project", "old.jsonl"), line({ ...response("old", NOW - 90 * DAY), sessionId: "old" }));
    assert.equal(ingester.addRoots([{ source: "claude", path: custom }]), 1);
    await ingester.poll(true); await ingester.poll(true);
    assert.deepEqual(got, ["session-recent", "old"]);
    // …and `claude --resume` later writes it again into a new log, next to a new call: only that one is new.
    now = NOW + DAY;
    await writeFile(join(custom, "-work-demo-project", "resumed.jsonl"), line({ ...response("old", NOW - 90 * DAY), sessionId: "resumed" }) + line({ ...response("new", now - 1000), sessionId: "resumed" }));
    await ingester.poll(true);
    assert.deepEqual(got, ["session-recent", "old", "resumed"]);
  } finally { await ingester.close(); await rm(root, { recursive: true, force: true }); }
});
