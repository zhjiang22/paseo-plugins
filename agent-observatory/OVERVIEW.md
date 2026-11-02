Agent Observatory is a dashboard for every Paseo agent and subagent on a host. Each session opens on its result, timeline, subtasks, diagnostics and an execution review. It adds a sidebar count of what needs you with a reason per agent, approvals and quick replies in place, an unread queue, usage statistics, token counts from local Claude Code, Codex, Grok CLI, Pi, Kimi Code and ZCode logs, every scheduled run, and optional AI reviews and turn summaries. Optional alerts: a chime, workspace labels for what needs you, a prompt-cache countdown and scheduled sends.

It adds the sidebar pages Agent Observatory, Archived sessions and Scheduled runs, workspace and agent panels, Command Center items and `/observe`. On connect the app gets only a small stub; the rest loads when first opened.

## Setup

Requires Paseo 0.11.1 or later. AI reviews and turn summaries need the Grok CLI (signed in on the daemon host) or an enabled Paseo provider.

## Languages

English and Simplified Chinese are built in. The device language is used unless Settings → Plugins → Agent Observatory → Language picks one; English fills gaps. A translated copy of the template in `~/.paseo/plugin-data/agent-observatory/locales/` adds a language. Reviews and summaries answer in the chosen language.

## What it reads

- From the daemon: agent events, attention notifications, the agent list (archived included), pending permissions of an agent you open, profiles and providers, usage windows (`providers.listUsage()`, only while shown), and timelines of what you open. In the background it reads only loaded agents.
- Token logs: `$CLAUDE_CONFIG_DIR/projects` (default `~/.claude/projects`), `~/.config/claude/projects`, `$CODEX_HOME/sessions` and `archived_sessions` (default `~/.codex`), each Grok CLI session's `usage.json` only and Pi's sessions (default `~/.pi/agent/sessions`), plus Kimi Code wire logs under `$KIMI_CODE_HOME/sessions` (default `~/.kimi-code/sessions`) and the read-only ZCode SQLite database and WAL under `$ZCODE_HOME/cli/db` (default `~/.zcode/cli/db`), without following symlinks. ZCode ACP ids are resolved through `v2/acp-lazy-sessions.json`. Only counters, model names, working directories and session ids are kept, never prompts or output.
- For custom providers based on these: a literal `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`, `KIMI_CODE_HOME`, `ZCODE_HOME`, `PI_CODING_AGENT_SESSION_DIR` or `PI_CODING_AGENT_DIR` in the provider's `env`, command line or launcher script (read as text, at most 64 KB, never run), and Pi's `sessionDir` setting.
- To confirm a resume, the agent's own Claude Code, Codex or Pi session log is searched for that run's ids (compared, not kept). The cache countdown reads a Claude-based session's last cache write and TTL from its own log.
- Scheduled runs: `$PASEO_HOME/schedules/*.json`, `projects/workspaces.json`, and the records of agents the daemon no longer lists. It never writes them.
- The daemon config's provider list, to tell which providers take a message mid-turn and which share a usage limit.

The plugin makes no network requests of its own.

## What it writes

Everything goes to `$PASEO_HOME/plugin-data/agent-observatory` (folder 0700; files 0600, bounded, replaced atomically): telemetry, statistics, token counts, usage-limit history, read receipts, preferences, review settings, reports and suggestions, turn summaries, the schedule and resume ledgers, the device's time zone name, the send ledger (messages on their way, with any scheduled time, then a week of short previews), its own workspace labels and pins, the language state and translation templates.

The schedule ledger keeps run times, status, ids, host errors (300 characters), links without credentials, schedule names and cadences, never replies or prompts. Usage-limit history hashes account names. Telemetry keeps why a turn stopped, never the reply. Reports and summaries can quote sessions.

## Actions

The plugin acts on the daemon only when you ask:

- marking a result, question or error read; archiving agents (bulk archiving needs a second tap); restoring a workspace or an archived session;
- answering one permission request with the provider's own options, never in bulk or automatically;
- sending a quick reply (the button's words), an AI suggestion or a review finding to an agent: steered into the running turn where supported, otherwise after you confirm the interruption, or queued until the turn ends; a retry is delivered at most once;
- scheduling a one-off heartbeat, at a time you confirm, that resumes an agent after its usage limit resets; it is never resent when delivery cannot be proven, and only the plugin's own resume heartbeats are deleted;
- handing a stopped agent to another profile, or starting one from a suggestion;
- sending a scheduled message at the time you picked;
- with Sidebar labels on (off by default), adding and removing its own workspace labels and pins.

Some use daemon messages the plugin API lacks, over its own daemon connection. It can open http(s) links.

## AI reviews and turn summaries

Nothing is reviewed until you start one; automatic reviews are off by default. A review sends a bounded session excerpt (prompts, replies, tool calls and output; at most 180 entries, about 120,000 characters) with project and agent metadata to the chosen model. Common credential formats are masked, not exhaustively. Suggestions send recent report summaries the same way.

- Grok CLI: `grok` runs in a fresh temporary directory with every built-in tool removed, tool calls denied, web search, memory and session search off and no other providers' keys; the excerpt passes through a temporary file. Its directory, saved session and session-search record are deleted afterwards. It is the only subprocess the plugin starts.
- A Paseo profile or provider: a temporary sub-agent of the reviewed agent in its workspace, in a read-only mode or Claude Code's Always Ask, where approvals are denied but actions needing none (reading files) still run, unmasked. It is archived afterwards; its conversation stays in the host's and provider's logs and uses that provider's quota.
- Choose automatically (the default) uses the Grok CLI when found, otherwise an enabled Claude Code or Codex provider.

Turn summaries are off by default too. When on, 10 seconds after a top-level agent's turn ends, the runner (default: Grok CLI, low effort) gets that turn's and up to 8 earlier turns' messages (no tool output, masked, at most 32 KB) and writes a one-line goal, progress and next step, optionally with a one-tap suggested reply. Turning them off deletes them.

## Limits

- Imports and scans are capped (for example 20,000 token logs).

The scheduled runs page is modeled on the schedule-runs plugin by panrafal.
