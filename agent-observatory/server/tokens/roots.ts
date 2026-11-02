import { realpathSync } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { MAX_TOKEN_ROOTS, type TokenSource } from "../../shared/tokens";
import type { LogRoot } from "./types";

/**
 * Where provider session logs live. The defaults cover Claude Code, Codex, Grok CLI, Pi and oh-my-pi as installed; custom Paseo
 * providers built on them (`extends: "claude" | "codex" | "pi" | "omp"`, or `extends: "acp"` running the `grok` CLI) can move
 * their logs with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GROK_HOME` / `PI_CODING_AGENT_SESSION_DIR` /
 * `PI_CODING_AGENT_DIR` / `PI_CONFIG_DIR`, set in the provider's `env`, on its command line or in its launcher script. All are read here
 * without running anything, in the order the provider's process gets them (codex-obs-roots-F1): the daemon's own
 * environment, the provider's `env` over it (the spawn's starting environment), then `env NAME=…` or an inline script on
 * the command line, then the launcher's assignments, each replacing what came before. Values count only as literal paths;
 * a launcher is read as text (at most 64 KB, no binaries). No other variable or value is ever read from provider env or
 * launchers. Where the text cannot tell which value wins (an `if`, a computed value), every literal directory it may use is
 * kept, a few at most, rather than one picked silently. A launcher that only computes the directory (a Python script building
 * a path) cannot be read this way; its logs are found when they are in a standard location.
 */
export const MAX_ROOTS = MAX_TOKEN_ROOTS;
/**
 * The variables that move a provider's logs, strongest first, with the log folders under the directory each names and the
 * CLI's own directory when the variable is unset. Codex moves an archived session's rollout from `sessions/YYYY/MM/DD/` to
 * `archived_sessions/` (2.13 reads both). Pi's session directory may be named itself; unset, it follows Pi's agent directory.
 */
const CONFIG_ENV: Record<TokenSource, ReadonlyArray<{ name: string; folders: readonly string[]; standard: ((home: string) => string) | null }>> = {
  claude: [{ name: "CLAUDE_CONFIG_DIR", folders: ["projects"], standard: home => join(home, ".claude") }],
  codex: [{ name: "CODEX_HOME", folders: ["sessions", "archived_sessions"], standard: home => join(home, ".codex") }],
  grok: [{ name: "GROK_HOME", folders: ["sessions"], standard: home => join(home, ".grok") }],
  kimi: [{ name: "KIMI_CODE_HOME", folders: ["sessions"], standard: home => join(home, ".kimi-code") }],
  zcode: [{ name: "ZCODE_HOME", folders: ["cli/db"], standard: home => join(home, ".zcode") }],
  pi: [{ name: "PI_CODING_AGENT_SESSION_DIR", folders: [""], standard: null }, { name: "PI_CODING_AGENT_DIR", folders: ["sessions"], standard: home => join(home, ".pi", "agent") }],
  // oh-my-pi honours Pi's variables; PI_CONFIG_DIR (its home, `.omp` unless set) moves the default roots in
  // `defaultRoots` only — providerRoots reads the first two entries, the session directory and the agent directory, as for Pi.
  omp: [{ name: "PI_CODING_AGENT_SESSION_DIR", folders: [""], standard: null }, { name: "PI_CODING_AGENT_DIR", folders: ["sessions"], standard: home => join(home, ".omp", "agent") }],
  // OpenCode moves with XDG_DATA_HOME (there is no dedicated variable in OpenCode itself).
  opencode: [{ name: "XDG_DATA_HOME", folders: ["opencode"], standard: home => join(home, ".local", "share", "opencode") }],
  codebuddy: [{ name: "CODEBUDDY_CONFIG_DIR", folders: ["projects"], standard: home => join(home, ".codebuddy") }],
  qoder: [{ name: "QODER_CONFIG_DIR", folders: ["projects"], standard: home => join(home, ".qoder") }],
  gemini: [{ name: "GEMINI_CLI_HOME", folders: ["tmp"], standard: home => join(home, ".gemini") }],
  qwen: [{ name: "QWEN_RUNTIME_DIR", folders: ["projects"], standard: home => join(home, ".qwen") }],
  // Cline / Roo / Kilo live in VS Code family globalStorage directories, which no variable moves; the platform
  // host directories are standard roots (defaultRoots), and provider discovery has nothing to add for them.
  cline: [],
  roo: [],
  kilo: [],
  // Hermes / MiMoCode / dsh keep their databases at fixed paths with no moving variable.
  hermes: [],
  mimo: [],
  dsh: [],
};
/** Directories one variable may name when the text cannot tell which assignment wins (the latest ones are kept). */
const MAX_CANDIDATES = 3;
const LAUNCHER_MAX_BYTES = 64 * 1024;
/** Interpreters in front of a launcher (`["/usr/bin/python3", "/opt/launch.py"]`): the script is the next argument. */
const INTERPRETER = /^(?:sh|bash|zsh|dash|env|node|bun|deno|python[0-9.]*|perl|ruby)$/;
/** Interpreters that run their script as a shell script. */
const SHELLS = /^(?:sh|bash|zsh|dash|ksh|ash|mksh)$/;
/** Shell words that only start the command after them (`exec grok --acp` in a `-c` script). */
const SHELL_PREFIX = /^(?:exec|command|nohup|export)$/;
/** `NAME=value`: an assignment for the program that follows (after `env`, or before a command in a shell script). */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** Options of `env` that take the next word as theirs (`env -u NAME`, `env -C DIR`). */
const ENV_ARGUMENT = /^(?:-u|--unset|-C|--chdir|-S|--split-string)$/;
/** An interpreter's `-c`, alone or among other short flags (`bash -lc …`): the next word is the script itself. */
const INLINE_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/;

export interface RootContext {
  home: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Text of a small launcher or settings file, or null (missing, too large, binary, unreadable). */
  readText?: (path: string) => Promise<string | null>;
}

const piAgentDir = (home: string, env: RootContext["env"]): string => env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");

/** VS Code family hosts whose globalStorage may hold task transcripts, in the usual install names. */
const VSCODE_HOSTS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"] as const;
/** The Cline / Roo / Kilo extension ids under those hosts' globalStorage. */
const CLINE_FAMILY_EXT_IDS = ["saoudrizwan.claude-dev", "rooveterinaryinc.roo-cline", "kilocode.kilo-code"] as const;
const CLINE_FAMILY_SOURCES = ["cline", "roo", "kilo"] as const;
/** globalStorage bases for the running platform: the desktop hosts, plus the remote servers on Linux. */
function vscodeGlobalStorageBases(home: string): string[] {
  if (process.platform === "darwin") return VSCODE_HOSTS.map(host => join(home, "Library", "Application Support", host, "User", "globalStorage"));
  if (process.platform === "win32") return VSCODE_HOSTS.map(host => join(home, "AppData", "Roaming", host, "User", "globalStorage"));
  const desktop = VSCODE_HOSTS.map(host => join(home, ".config", host, "User", "globalStorage"));
  return [...desktop, join(home, ".vscode-server", "data", "User", "globalStorage"), join(home, ".vscode-server-insiders", "data", "User", "globalStorage")];
}
/** One root per Cline family extension per globalStorage base. */
function clineFamilyRoots(home: string): LogRoot[] {
  const roots: LogRoot[] = [];
  for (const [index, extId] of CLINE_FAMILY_EXT_IDS.entries()) {
    for (const base of vscodeGlobalStorageBases(home)) {
      roots.push({ source: CLINE_FAMILY_SOURCES[index], path: join(base, extId, "tasks") });
    }
  }
  return roots;
}
const ompAgentDir = (home: string, env: RootContext["env"]): string => env.PI_CODING_AGENT_DIR || join(home, env.PI_CONFIG_DIR || ".omp", "agent");

/** The roots checked on every host: the daemon's own environment, then the standard locations. */
export function defaultRoots(context: Pick<RootContext, "home" | "env"> = { home: homedir(), env: process.env }): LogRoot[] {
  const { home, env } = context;
  const roots: LogRoot[] = [
    { source: "claude", path: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects") },
    { source: "claude", path: join(home, ".claude", "projects") },
    { source: "claude", path: join(home, ".config", "claude", "projects") },
    ...CONFIG_ENV.codex[0]!.folders.map(folder => ({ source: "codex" as const, path: join(env.CODEX_HOME || join(home, ".codex"), folder) })),
    // 2.14: Grok CLI and Pi. The daemon's environment first, then the standard directory.
    { source: "grok", path: join(env.GROK_HOME || join(home, ".grok"), "sessions") },
    { source: "grok", path: join(home, ".grok", "sessions") },
    { source: "pi", path: env.PI_CODING_AGENT_SESSION_DIR || join(piAgentDir(home, env), "sessions") },
    { source: "pi", path: join(home, ".pi", "agent", "sessions") },
    // 2.18: oh-my-pi. A PI_CODING_AGENT_DIR or PI_CODING_AGENT_SESSION_DIR set for Pi is where it writes too: the
    // duplicates above are dropped, and those sessions count once, as Pi.
    { source: "omp", path: env.PI_CODING_AGENT_SESSION_DIR || join(ompAgentDir(home, env), "sessions") },
    { source: "omp", path: join(home, ".omp", "agent", "sessions") },
    // 2.18: OpenCode. Its data directory holds the database and the legacy storage tree beside each other.
    { source: "opencode", path: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode") },
    { source: "opencode", path: join(home, ".local", "share", "opencode") },
    // 2.18: CodeBuddy Code and Qoder keep one `.jsonl` per session under their projects directory.
    { source: "codebuddy", path: join(env.CODEBUDDY_CONFIG_DIR || join(home, ".codebuddy"), "projects") },
    { source: "codebuddy", path: join(home, ".codebuddy", "projects") },
    { source: "qoder", path: join(env.QODER_CONFIG_DIR || join(home, ".qoder"), "projects") },
    { source: "qoder", path: join(home, ".qoder", "projects") },
    // The Chinese edition keeps its own home when no variable moves it.
    { source: "qoder", path: join(home, ".qoder-cn", "projects") },
    // 2.18: Gemini CLI's chat records and Qwen Code's transcripts.
    { source: "gemini", path: join(env.GEMINI_CLI_HOME || join(home, ".gemini"), "tmp") },
    { source: "gemini", path: join(home, ".gemini", "tmp") },
    { source: "qwen", path: join(env.QWEN_RUNTIME_DIR || join(home, ".qwen"), "projects") },
    { source: "qwen", path: join(home, ".qwen", "projects") },
    // 2.18: Cline / Roo Code / Kilo Code task transcripts in every VS Code family host's globalStorage.
    ...clineFamilyRoots(home),
    // 2.18: Hermes's state database, MiMoCode's OpenCode-shaped database, dsh's cost ledger.
    { source: "hermes", path: join(home, ".hermes") },
    { source: "mimo", path: join(home, ".local", "share", "mimocode") },
    { source: "dsh", path: join(home, ".dsh", "storages", "cost-meter") },
    { source: "kimi", path: join(env.KIMI_CODE_HOME || join(home, ".kimi-code"), "sessions") },
    { source: "kimi", path: join(home, ".kimi-code", "sessions") },
    { source: "zcode", path: join(env.ZCODE_HOME || join(home, ".zcode"), "cli", "db") },
    { source: "zcode", path: join(home, ".zcode", "cli", "db") },
  ];
  return roots.filter((root, index) => roots.findIndex(other => resolve(other.path) === resolve(root.path)) === index);
}

/** The system temporary directories, as given and resolved (macOS: /var/folders/… → /private/var/folders/…). */
let temporaryRoots: string[] | null = null;
function temporaryDirectories(): string[] {
  if (temporaryRoots) return temporaryRoots;
  const roots = new Set([resolve(tmpdir()), "/tmp", "/private/tmp"]);
  try { roots.add(realpathSync(tmpdir())); } catch { /* no temporary directory */ }
  return temporaryRoots = [...roots];
}
/**
 * The observatory's own Grok analyses run in a fresh `paseo-insight-XXXXXX` directory under the system temporary
 * directory (server/grok-runner), deleted afterwards; their sessions are not the user's work and are not counted.
 */
export function isInsightDirectory(cwd: string): boolean {
  return /^paseo-insight-[A-Za-z0-9]{6}$/.test(basename(cwd)) && temporaryDirectories().includes(resolve(dirname(cwd)));
}
/** A working directory inside a system temporary directory (scripts' throwaway runs): one 临时目录 project, not one each. */
export function isTemporaryDirectory(cwd: string): boolean {
  if (!isAbsolute(cwd)) return false;
  const path = resolve(cwd);
  return temporaryDirectories().some(root => path.startsWith(root.endsWith(sep) ? root : root + sep));
}

/** A literal absolute path: `~`, `$HOME` and `${HOME}` expand at the start; any other `$`, backtick or relative path is not literal. */
export function literalPath(value: string, home: string): string | null {
  let text = value.trim();
  if (text.length >= 2 && (text[0] === "\"" || text[0] === "'") && text.at(-1) === text[0]) text = text.slice(1, -1);
  if (text === "~" || text === "$HOME" || text === "${HOME}") return home;
  for (const prefix of ["~/", "$HOME/", "${HOME}/"]) if (text.startsWith(prefix)) { text = join(home, text.slice(prefix.length)); break; }
  if (!text || /[$`\n]/.test(text) || !isAbsolute(text)) return null;
  return resolve(text);
}

/**
 * A shell word's value when it is a literal path, as the shell would make it: quotes removed, `~` at the start and `$HOME` /
 * `${HOME}` expanded. Null when it computes anything else (another variable, `$(…)`, a glob) or is not absolute.
 */
export function shellWord(raw: string, home: string): string | null {
  let out = "", index = 0;
  if (raw === "~" || raw.startsWith("~/")) { out = home; index = 1; }
  const expand = (at: number) => { const match = /^\$(?:HOME(?![A-Za-z0-9_])|\{HOME\})/.exec(raw.slice(at, at + 8)); if (match) out += home; return match ? at + match[0].length : -1; };
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "'") { const end = raw.indexOf("'", index + 1); if (end < 0) return null; out += raw.slice(index + 1, end); index = end + 1; }
    else if (char === "\"") {
      for (index++; ; ) {
        const inner = raw[index];
        if (inner === undefined || inner === "`") return null;
        if (inner === "\"") { index++; break; }
        if (inner === "\\" && /["\\$`]/.test(raw[index + 1] ?? "")) { out += raw[index + 1]; index += 2; }
        else if (inner === "$") { index = expand(index); if (index < 0) return null; }
        else { out += inner; index++; }
      }
    }
    else if (char === "\\") { if (index + 1 >= raw.length) return null; out += raw[index + 1]; index += 2; }
    else if (char === "$") { index = expand(index); if (index < 0) return null; }
    else if (/[`*?[\]{}]/.test(char)) return null;
    else { out += char; index++; }
  }
  return out && !out.includes("\n") && isAbsolute(out) ? resolve(out) : null;
}

const commandParts = (command: unknown): string[] => Array.isArray(command) ? command.filter((part): part is string => typeof part === "string").slice(0, 16) : [];
/**
 * How `words` start a program, past what only launches it: `NAME=value` assignments, `env` (and its options), the
 * interpreters (with the flags before their script) and shell prefixes such as `exec`. `program` is the word naming it,
 * `interpreter` the last interpreter on the way (the launcher's language), `script` an interpreter's inline `-c` script.
 */
function launchOf(words: readonly string[]): { program: string | null; interpreter: string | null; script: string | null } {
  let launched = false, env = false, skip = false, interpreter: string | null = null;
  for (const [index, word] of words.entries()) {
    if (skip) { skip = false; continue; }
    if (ASSIGNMENT.test(word)) continue;
    if (launched && word.startsWith("-")) {
      if (!env && interpreter && INLINE_FLAG.test(word)) return { program: null, interpreter, script: words[index + 1] ?? null };
      skip = env && ENV_ARGUMENT.test(word);
      continue;
    }
    const name = basename(word);
    if (INTERPRETER.test(name) || SHELL_PREFIX.test(name)) { launched = true; env = name === "env"; if (!env && INTERPRETER.test(name)) interpreter = name; continue; }
    return { program: word, interpreter, script: null };
  }
  return { program: null, interpreter, script: null };
}
/** The word naming the program `words` start (see launchOf). Null when nothing is left. */
const programWord = (words: readonly string[]) => launchOf(words).program;
/**
 * The programs a provider command starts, by the words naming them: `["env", "GROK_HOME=…", "grok", "--acp"]` starts `grok`,
 * `["bash", "/home/me/bin/grok-acp.sh"]` the script, and an inline `-c` script each command in it.
 */
function commandPrograms(command: unknown): string[] {
  const script = inlineScript(command);
  const words = script === null ? [programWord(commandParts(command))]
    : script.split(/[;&|\n()]+/).map(simple => programWord(simple.trim().split(/\s+/).map(word => word.replace(/^(["'])(.*)\1$/, "$2"))));
  return words.filter((word): word is string => !!word);
}
/** An ACP provider's CLI by its command's name: `grok`, `grok-cli`, a renamed `grok-…` binary or script. */
const ACP_COMMANDS: ReadonlyArray<[RegExp, TokenSource]> = [[/^kimi(?:$|[-_.])/i, "kimi"], [/^zcode(?:$|[-_.])/i, "zcode"], [/^grok(?:$|[-_.])/i, "grok"], [/^pi(?:$|[-_.])/, "pi"], [/^omp(?:$|[-_.])/, "omp"]];
/**
 * The log format a provider writes: its own id or the built-in it extends (`claude`, `codex`, `pi`, `omp`); for an ACP
 * provider (`extends: "acp"`) the CLI its command runs (2.14), past `env`, assignments and interpreters (`commandPrograms`).
 * Null for the others (their logs are not read).
 */
export function providerSource(id: string, entry: { extends?: unknown; command?: unknown }): TokenSource | null {
  const base = typeof entry.extends === "string" && entry.extends.trim() ? entry.extends.trim() : id;
  if (base === "claude" || base === "codex" || base === "pi" || base === "omp" || base === "opencode" || base === "codebuddy" || base === "qoder" || base === "gemini" || base === "qwen" || base === "cline" || base === "roo" || base === "kilo" || base === "hermes" || base === "mimo" || base === "dsh" || base === "kimi" || base === "zcode") return base;
  if (base !== "acp") return null;
  for (const word of commandPrograms(entry.command)) {
    const name = basename(word), source = ACP_COMMANDS.find(([pattern]) => pattern.test(name))?.[1];
    if (source) return source;
  }
  return null;
}

const escapeName = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Literal assignments of `name` in a launcher's text, in order: `export NAME=…` / `NAME=…` (shell, unless `shell` is false),
 * `"NAME": "…"` (a dict or object literal), `["NAME"] = "…"` / `.NAME = "…"` (an environment update), and the forms that
 * only apply while it is unset (`fallback`): `setdefault("NAME", "…")`, `.NAME ??= "…"`, `.NAME ||= "…"`.
 */
function literalAssignments(text: string, name: string, home: string, shell = true): Array<{ at: number; path: string; fallback: boolean }> {
  const key = escapeName(name), quoted = `("[^"\\n]*"|'[^'\\n]*')`, target = `(?:\\[[ \\t]*["']${key}["'][ \\t]*\\]|\\.${key})`;
  const patterns: Array<[RegExp, boolean]> = [
    ...(shell ? [[new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}=("[^"\\n]*"|'[^'\\n]*'|[^\\s;&|#]+)`, "gm"), false] as [RegExp, boolean]] : []),
    [new RegExp(`["']${key}["'][ \\t]*:[ \\t]*${quoted}`, "g"), false],
    [new RegExp(`${target}[ \\t]*=[ \\t]*${quoted}`, "g"), false],
    [new RegExp(`${target}[ \\t]*(?:\\?\\?|\\|\\|)=[ \\t]*${quoted}`, "g"), true],
    [new RegExp(`setdefault\\([ \\t]*["']${key}["'][ \\t]*,[ \\t]*${quoted}`, "g"), true],
  ];
  const found: Array<{ at: number; path: string; fallback: boolean }> = [];
  for (const [pattern, fallback] of patterns) for (const match of text.matchAll(pattern)) {
    const path = literalPath(match[1]!, home);
    if (path) found.push({ at: match.index! + Math.max(0, match[0].search(/\S/)), path, fallback });
  }
  return found.sort((a, b) => a.at - b.at);
}
/**
 * The last literal assignment of `name` in a launcher's text, as when it runs: `export NAME=…` / `NAME=…` (shell),
 * `"NAME": "…"` (a dict or object literal) and `["NAME"] = "…"` / `.NAME = "…"` (an environment update).
 */
export function launcherAssignment(text: string, name: string, home: string): string | null {
  return literalAssignments(text, name, home).filter(found => !found.fallback).at(-1)?.path ?? null;
}

/** The launcher file a provider command names: the command itself, or the script after `env`, an interpreter and their flags. */
export function launcherCandidates(command: unknown, home: string): string[] {
  const word = programWord(commandParts(command)), path = word ? literalPath(word, home) : null;
  return path ? [path] : [];
}
/** The script of `["bash", "-c", "export CLAUDE_CONFIG_DIR=…; exec claude"]` (also `bash -lc …`, and behind `env`). */
export function inlineScript(command: unknown): string | null {
  return launchOf(commandParts(command)).script;
}

/** Bounded text read: regular files up to 64 KB with no NUL byte in them. */
export async function readLauncherText(path: string): Promise<string | null> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > LAUNCHER_MAX_BYTES) return null;
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(details.size);
      const { bytesRead } = await handle.read(buffer, 0, details.size, 0);
      const content = buffer.subarray(0, bytesRead);
      return content.includes(0) ? null : content.toString("utf8");
    } finally { await handle.close(); }
  } catch { return null; }
}

/**
 * Pi's `sessionDir` setting in its agent directory's `settings.json`, as the daemon reads it when no variable names the
 * session directory. Only that key is taken, and only a literal absolute (or `~`) path.
 */
export async function piSettingsSessionDir(agentDir: string, context: RootContext): Promise<string | null> {
  const text = await (context.readText ?? readLauncherText)(join(agentDir, "settings.json"));
  if (!text) return null;
  try {
    const value = (JSON.parse(text) as { sessionDir?: unknown } | null)?.sessionDir;
    return typeof value === "string" ? literalPath(value, context.home) : null;
  } catch { return null; }
}

/**
 * A shell script cut into simple commands, in order, each with whether it surely runs when the script does: not inside an
 * `if`, `case`, loop, function, `{ … }` or subshell, not after `&&` / `||`, not in a pipeline or sent to the background.
 * Quotes, `$(…)`, `${…}`, backticks, escapes, comments and here-documents are respected; words keep their quotes.
 */
export function shellCommands(script: string): Array<{ words: string[]; sure: boolean }> {
  const commands: Array<{ words: string[]; sure: boolean }> = [], open: string[] = [], heredocs: Array<{ name: string; tabs: boolean }> = [];
  let words: string[] = [], word = "", started = false, quoted = false, keyword = false, depth = 0, subshell = 0, after = false;
  // A command ends: kept with whether it surely runs; `after` carries a pending `&&` / `||` / `|` to the next one.
  const end = (separator: string) => {
    endWord();
    if (words.length) commands.push({ words, sure: !after && depth === 0 && subshell === 0 && separator !== "|" && separator !== "&" });
    if (separator === "&&" || separator === "||" || separator === "|") after = true;
    else if (words.length || keyword) after = false;
    words = []; keyword = false;
  };
  // A word ends: reserved words open or close blocks where a command starts, `{` anywhere (a function body follows its name).
  function endWord() {
    if (!started) return;
    const done = word, plain = !quoted;
    word = ""; started = false; quoted = false;
    if (plain && done === "{") { if (words.length) end(";"); depth++; keyword = true; return; }
    if (plain && !words.length) {
      if (/^(?:if|case|for|select|while|until)$/.test(done)) { depth++; keyword = true; return; }
      if (/^(?:fi|esac|done|\})$/.test(done)) { depth = Math.max(0, depth - 1); keyword = true; return; }
      if (/^(?:then|else|elif|do|!|function)$/.test(done)) { keyword = true; return; }
    }
    words.push(done);
  }
  for (let index = 0; index < script.length; index++) {
    const char = script[index]!, next = script[index + 1] ?? "", top = open.at(-1);
    if (top === "'") { word += char; if (char === "'") open.pop(); continue; }
    if (char === "\\") { if (next !== "\n") { word += char + next; started = true; } index++; continue; }
    if (top) {
      word += char;
      if (char === "\"") { if (top === "\"") open.pop(); else open.push("\""); }
      else if (char === "'" && top !== "\"") open.push("'");
      else if (char === "`") { if (top === "`") open.pop(); else open.push("`"); }
      else if (char === "$" && (next === "(" || next === "{")) { word += next; index++; open.push(next === "(" ? ")" : "}"); }
      else if (char === "(" && top === ")") open.push(")");
      else if ((char === ")" || char === "}") && top === char) open.pop();
      continue;
    }
    if (char === "'" || char === "\"" || char === "`") { word += char; started = quoted = true; open.push(char); continue; }
    if (char === "$" && (next === "(" || next === "{")) { word += char + next; started = quoted = true; index++; open.push(next === "(" ? ")" : "}"); continue; }
    if (char === "#" && !started) { const stop = script.indexOf("\n", index); index = (stop < 0 ? script.length : stop) - 1; continue; }
    if (char === "\n") {
      end(";");
      // Here-documents start on the next line and run to their delimiter: their lines are text, not commands.
      for (const heredoc of heredocs.splice(0)) {
        for (let start = index + 1; ; ) {
          const stop = script.indexOf("\n", start), line = script.slice(start, stop < 0 ? script.length : stop);
          index = stop < 0 ? script.length : stop;
          if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.name || stop < 0) break;
          start = stop + 1;
        }
      }
      continue;
    }
    if (char === " " || char === "\t" || char === "\r") { endWord(); continue; }
    if (char === "<" && next === "<" && script[index + 2] !== "<") {
      const heredoc = /^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()]+))/.exec(script.slice(index, index + 256));
      if (heredoc) { heredocs.push({ name: heredoc[2] ?? heredoc[3] ?? heredoc[4]!, tabs: heredoc[1] === "-" }); word += heredoc[0]; started = true; index += heredoc[0].length - 1; continue; }
    }
    // Redirections (`2>&1`, `&>log`, `>|`) belong to their word; otherwise these end a command.
    if (char === "&" && (word.endsWith(">") || word.endsWith("<") || next === ">")) { word += char; started = true; continue; }
    if (char === "|" && word.endsWith(">")) { word += char; started = true; continue; }
    if (char === ";") { end(";"); if (next === ";") index++; continue; }
    if (char === "&") { if (next === "&") { end("&&"); index++; } else end("&"); continue; }
    if (char === "|") { if (next === "|") { end("||"); index++; } else end("|"); continue; }
    if (char === "(") { end(";"); subshell++; continue; }
    if (char === ")") { end(";"); subshell = Math.max(0, subshell - 1); continue; }
    word += char; started = true;
  }
  end(";");
  return commands;
}

export interface DiscoveredRoot extends LogRoot { provider: string; via: "env" | "command" | "launcher" | "settings" }
/** Where a value came from; `daemon`: the daemon's own environment, whose directories the default roots cover already. */
type Via = Exclude<DiscoveredRoot["via"], "settings"> | "daemon";
/** One directory a variable may name when the provider starts; null: unset, so the CLI's own directory. */
interface Candidate { path: string | null; via: Via }
/**
 * One assignment, in the order the provider's start runs them: `set` a literal path, `unset` it, a `default` that applies only
 * while it is unset (`${NAME:-…}`, `setdefault`), or `unknown` (computed: the candidates so far stand, nothing better being known).
 * A `sure` one always runs; one that may not (in an `if`, after `&&`, in a function) adds to the candidates instead.
 */
interface Step { kind: "set" | "unset" | "default" | "unknown"; path: string | null; via: Via; sure: boolean }

function apply(values: readonly Candidate[], step: Step): Candidate[] {
  const next: Candidate[] = step.kind === "set" ? [{ path: step.path, via: step.via }] : step.kind === "unset" ? [{ path: null, via: step.via }]
    : step.kind === "default" ? values.map(value => value.path === null ? { path: step.path, via: step.via } : value) : [...values];
  const merged = step.sure ? next : [...values, ...next], kept: Candidate[] = [];
  // Each directory once (its latest source), the latest few.
  for (const value of merged.reverse()) if (!kept.some(other => other.path === value.path)) kept.push(value);
  return kept.slice(0, MAX_CANDIDATES).reverse();
}
/** A value given as is (provider `env`, a command-line word: no shell expands it): empty unsets, a literal path sets. */
function plainValue(raw: string, via: Via, home: string): Step {
  const path = raw === "" ? null : literalPath(raw, home);
  return { kind: raw === "" ? "unset" : path ? "set" : "unknown", path, via, sure: true };
}
/** A shell assignment's value: empty unsets, `${NAME:-…}` / `${NAME:=…}` is a default while unset, a literal path sets; anything else is computed. */
function shellValue(raw: string, name: string, home: string, via: Via, sure: boolean): Step {
  if (raw === "" || raw === "\"\"" || raw === "''") return { kind: "unset", path: null, via, sure };
  const fallback = new RegExp(`^("?)\\$\\{${escapeName(name)}:?[-=](.*)\\}\\1$`, "s").exec(raw);
  const path = shellWord(fallback ? fallback[2]! : raw, home);
  return { kind: !path ? "unknown" : fallback ? "default" : "set", path, via, sure };
}
/**
 * Steps for `name` from the words that set up a program's environment, from `start`: `NAME=value` (in a shell also before
 * any `env`), then each `env` with its `-i` / `-u NAME` / `NAME=value`. Returns them and where the program's word is.
 */
function environmentWords(words: readonly string[], start: number, name: string, bare: boolean, value: (raw: string) => Step): { steps: Step[]; next: number } {
  const steps: Step[] = [], unset = () => ({ ...value(""), kind: "unset" as const, path: null });
  let env = false, at = start;
  for (; at < words.length; at++) {
    const word = words[at]!;
    if (env && word.startsWith("-")) {
      if (word === "-i" || word === "--ignore-environment" || word === "-") steps.push(unset());
      else if (word === "-u" || word === "--unset") { if (words[++at] === name) steps.push(unset()); }
      else if (/^(?:-u|--unset=)./.test(word)) { if (word.replace(/^-u|^--unset=/, "") === name) steps.push(unset()); }
      else if (ENV_ARGUMENT.test(word)) at++;
      continue;
    }
    if (ASSIGNMENT.test(word)) { if ((env || bare) && word.startsWith(`${name}=`)) steps.push(value(word.slice(name.length + 1))); continue; }
    if (basename(word) !== "env") break;
    env = true;
  }
  return { steps, next: at };
}
/** Words in front of a shell command that do not change what it assigns; `exec` also makes it the program the script becomes. */
const LEADERS = /^(?:exec|command|builtin|nohup|time|noglob)$/;
const DECLARE = /^(?:export|declare|typeset|readonly|local)$/;
/** What one shell command does to `name`: `export` / `declare` / plain assignments, `unset`, and assignments for the command it runs. */
function commandSteps(words: readonly string[], name: string, home: string, sure: boolean, via: Via): Step[] {
  let index = 0, exec = false;
  for (; index < words.length && LEADERS.test(words[index]!); index++) if (words[index] === "exec") exec = true;
  const first = words[index], value = (raw: string) => shellValue(raw, name, home, via, sure);
  if (first === undefined) return [];
  if (DECLARE.test(first)) return words.slice(index + 1).filter(word => word.startsWith(`${name}=`)).map(word => value(word.slice(name.length + 1)));
  if (first === "unset") return words.slice(index + 1).includes(name) ? [{ kind: "unset", path: null, via, sure }] : [];
  const { steps, next } = environmentWords(words, index, name, true, value);
  // Alone, they set the script's variables; before a command, that command's only: surely the provider when the script `exec`s it.
  return next < words.length && !exec && words[next] !== "exec" ? steps.map(step => ({ ...step, sure: false })) : steps;
}
const shellSteps = (script: string, name: string, home: string, via: Via) => shellCommands(script).flatMap(({ words, sure }) => commandSteps(words, name, home, sure, via));
/** Words before an assignment on its line that make it conditional in Python, Node or Ruby. */
const CONDITIONAL = /\b(?:if|elif|else|unless|when|case|for|while|try|except|catch|lambda)\b|&&|\|\||\?/;
/** Another launcher (Python, Node, Ruby…): its literal assignments in order; an indented one, or one behind a condition on its line, may not run. */
function scriptSteps(text: string, name: string, home: string, via: Via): Step[] {
  return literalAssignments(text, name, home, false).map(({ at, path, fallback }) => {
    const before = text.slice(text.lastIndexOf("\n", at - 1) + 1, at);
    return { kind: fallback ? "default" : "set", path, via, sure: !/^[ \t]/.test(before) && !CONDITIONAL.test(before) };
  });
}
/** Whether a launcher runs as a shell script: as the interpreter in its command says, else its `#!` line, else its extension. */
function runsInShell(text: string, interpreter: string | null, path: string): boolean {
  if (interpreter) return SHELLS.test(interpreter);
  const shebang = /^#![ \t]*(\S+)([^\n]*)/.exec(text);
  if (!shebang) return !/\.(?:py|js|mjs|cjs|ts|rb|pl)$/i.test(path);
  const words = [shebang[1]!, ...shebang[2]!.trim().split(/\s+/)].filter(Boolean).map(word => basename(word));
  return SHELLS.test((words[0] === "env" ? words.slice(1).find(word => !word.startsWith("-")) : words[0]) ?? "");
}

type ProviderEntry = { extends?: unknown; command?: unknown; env?: unknown };
/**
 * The directories one variable may name when the provider's process starts, latest last: the daemon's environment, then the
 * provider's `env`, the command line (`env NAME=…`, `env -u NAME`, an inline `-c` script) and the launcher, in that order,
 * each overriding what came before as the spawn does (codex-obs-roots-F1).
 */
async function candidates(entry: ProviderEntry, name: string, context: RootContext, read: (path: string) => Promise<string | null>): Promise<Candidate[]> {
  const { home } = context;
  let values: Candidate[] = [{ path: literalPath(context.env[name] ?? "", home), via: "daemon" }];
  const run = (steps: readonly Step[]) => { for (const step of steps) values = apply(values, step); };
  const env = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env as Record<string, unknown> : {};
  if (typeof env[name] === "string") run([plainValue(env[name] as string, "env", home)]);
  const parts = commandParts(entry.command), launch = launchOf(parts);
  run(environmentWords(parts, 0, name, false, raw => plainValue(raw, "command", home)).steps);
  if (launch.script !== null) run(SHELLS.test(launch.interpreter ?? "") ? shellSteps(launch.script, name, home, "command") : scriptSteps(launch.script, name, home, "command"));
  for (const path of launcherCandidates(entry.command, home)) {
    const text = await read(path);
    if (text) run(runsInShell(text, launch.interpreter, path) ? shellSteps(text, name, home, "launcher") : scriptSteps(text, name, home, "launcher"));
  }
  return values;
}

/**
 * Log roots of the daemon's custom providers that moved their logs: for each the directories its variable may name as it
 * starts (see `candidates`), the most likely first; a value only the daemon's own environment gives is a default root
 * already. A Pi provider whose session directory may be unset follows its agent directory, whose `settings.json` may name the
 * sessions. Each launcher or settings file is read once per call, however many providers name it.
 */
export async function providerRoots(providers: Readonly<Record<string, unknown>> | undefined, context: RootContext): Promise<DiscoveredRoot[]> {
  const found: DiscoveredRoot[] = [], texts = new Map<string, Promise<string | null>>(), readText = context.readText ?? readLauncherText;
  const read = (path: string) => { let text = texts.get(path); if (!text) texts.set(path, text = readText(path)); return text; };
  for (const [id, raw] of Object.entries(providers ?? {})) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as ProviderEntry, source = providerSource(id, entry);
    if (!source) continue;
    const add = (path: string, via: DiscoveredRoot["via"]) => { if (!found.some(root => root.provider === id && root.path === path)) found.push({ source, path, provider: id, via }); };
    const [first, agent] = CONFIG_ENV[source], unset: Candidate[] = [];
    if (!first) continue;
    for (const value of (await candidates(entry, first!.name, context, read)).reverse()) {
      const directory = value.path ?? first!.standard?.(context.home) ?? null;
      if (!directory) unset.push(value);
      else if (value.via !== "daemon") for (const folder of first!.folders) add(folder ? join(directory, folder) : directory, value.via);
    }
    if (!agent || !unset.length) continue;
    for (const value of (await candidates(entry, agent.name, context, read)).reverse()) {
      const directory = value.path ?? agent.standard!(context.home);
      const sessions = await piSettingsSessionDir(directory, { ...context, readText: read });
      if (sessions) add(sessions, "settings");
      else if (value.via !== "daemon") add(join(directory, agent.folders[0]!), value.via);
    }
  }
  return found;
}

/** Canonical form for comparing roots: the real path when it exists, else the resolved one. */
export async function rootIdentity(path: string): Promise<string> {
  try { return await realpath(path); } catch { return resolve(path); }
}
