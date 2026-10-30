# Changelog

## Unreleased

- Shared database execution reviews isolate requested sessions, follow WAL updates, and find sessions beyond the checkpoint index. Gemini reads native message rows and includes thinking/tool-use tokens; Hermes aggregates every billing route and task with complete pagination; modern OpenCode/MiMo reasoning contributes to output totals.

**The event stream names Agents from the directory**
- The 并行泳道 and the event list now show each Agent's current directory name instead of the title frozen into the recorded event. Interactive Agents record their first events before the host has generated their title, so those events kept the 「未命名 Agent」 placeholder forever even after the name existed; the swimlane lanes, the feed rows and their accessibility labels resolve the name from the Agent directory first and fall back to the stored title, which also renames past events retroactively. Agents no longer in the directory keep their stored title.

**The event page says what the filters hide**
- The event stream inherits the session list's scope filters, and when they hid events the page simply looked empty — indistinguishable from a broken capture. When the current filters hide retained events inside the selected time range, the page now shows a count ("当前筛选隐藏了 N 条事件") with a one-tap 清除筛选 that resets all optional scope filters, including provider, project and checkout. Events outside the current page's Agent directory are not counted as hidden by filters.

**dsh: the ledger's last day is no longer skipped**
- The cost ledger's newest day was treated as still in progress by position, so with intermittent use — no day after it ever arriving — its usage was skipped forever: the unchanged file never re-parsed. A day now counts unless it is today by the local or the UTC calendar, and a calendar rollover re-reads the unchanged ledger once (deduplicated by the seen index as before). Found in review by Chengxin-Xu; the v4 session-log enhancement spec this review also laid out is recorded in `docs/harness-token-source-research.md` §9.

**The Token page counts eighteen harness sources**

**oh-my-pi (omp) in the Token page**
- Token statistics now count oh-my-pi's session logs as a fifth source, shown as "oh-my-pi" and coloured sky in the source rows, beside Claude Code, Codex, Grok CLI and Pi. The log shape is Pi's, so every assistant reply, a tool result carrying the usage of the LLM work it did, compaction and branch summaries count as before; oh-my-pi's `model_usage` entries (calls outside the transcript, say a generated title) count too, under the model they name. The 256-byte title slot at the head of each log is never read as a call.
- Where the logs are: the same variables as Pi's, under oh-my-pi's own home — `$PI_CODING_AGENT_SESSION_DIR`, else `$PI_CODING_AGENT_DIR/sessions`, else `$PI_CONFIG_DIR/agent/sessions`, by default `~/.omp/agent/sessions`. Named profiles (`omp --profile …`) keep their own agent directory, which none of these variables move; those sessions are not counted. A `PI_CODING_AGENT_SESSION_DIR` or `PI_CODING_AGENT_DIR` set for Pi names the directory oh-my-pi writes to as well; it counts once, as Pi, never twice.
- Custom providers built on `omp` (a provider id or `extends: "omp"`, or an ACP provider whose command runs the `omp` CLI) are recognised like the other bases, and the directories their environment names are watched the same way.
- A saved ledger never changes shape: readers older than this release quarantine it once it holds omp entries and import their logs again, so the ledger version stays 2.

**OpenCode in the Token page**
- Token statistics now count OpenCode too, shown as "OpenCode" and coloured cyan. Since 1.2 OpenCode keeps every session in one database (`opencode.db` under its data directory); it is opened read-only and read incrementally by row, so a message still streaming is counted once it completes. Each assistant message's `tokens` (fresh input, cache read and write, reasoning as its own counter), model, working directory and response time count per message, keyed by the message id; OpenCode's own per-message cost estimate is not shown, the page counts tokens.
- The pre-1.2 storage tree (`storage/message/<session>/<message>.json`) is read beside the database, and what a migration left behind counts once: both backends carry the same message ids, and the ledger deduplicates by them.
- Sub-agents are recognised from the session's parent (`session.parent_id`), and a replaced database (a reinstall) is read from its first row again, still without counting anything twice.
- Where the data lives: `$XDG_DATA_HOME/opencode`, by default `~/.local/share/opencode`. OpenCode has no dedicated data-directory variable (the `OPENCODE_DATA_DIR` some tools read is not OpenCode's), and a provider id or `extends: "opencode"` is recognised like the other bases.
- A saved ledger never changes shape: readers older than this release quarantine it once it holds OpenCode entries and import their logs again, so the ledger version stays 2.

**CodeBuddy Code and Qoder in the Token page**
- Token statistics now count CodeBuddy Code ("CodeBuddy", blue) and Qoder ("Qoder", green) as well. Each session is one `.jsonl` under their projects directory (`$CODEBUDDY_CONFIG_DIR/projects`, by default `~/.codebuddy/projects`; `$QODER_CONFIG_DIR/projects`, by default `~/.qoder/projects`), and a provider id or `extends` of either is recognised like the other bases.
- CodeBuddy counts one call per `function_call` row: its `providerData` carries the usage of the model response the step belongs to, as a summary with the input cache-inclusive (the cached part comes out of `inputTokensDetails`), or, when that is missing, the provider's raw OpenAI-shaped usage; the model is `requestModelId`. Rows of one step — parallel tool calls of one response — share the usage and count once. Sub-agent transcripts under the session's directory count for that session; the aggregate rows (`credit-usage`, `model-usage`) and the reasoning drafts are never calls. A row carries only its end time, so these calls have no response time and stay out of the live speed and the fastest list, like Grok's turns.
- Qoder's transcript is Claude Code's shape one source over: one call per assistant row with the usage on it, the model from the session's `runtime-config` row, `isSidechain` rows as a sub-agent's, and gateway refusal rows (no usage) not counted.
- Watching ten sources needs more roots than the sixteen a ledger could name: the cap is now sixty-four, and readers older than this release quarantine a ledger past their cap and import their logs again.
- Both log only what they show above; Qoder's own accounting is Credits and OpenCode's an estimate, and the page counts tokens, never money.

**Gemini CLI and Qwen Code in the Token page**
- Token statistics now count Gemini CLI ("Gemini CLI", fuchsia) and Qwen Code ("Qwen Code", lime).
- Gemini CLI: the JSONL chat records of the windowed generation (`$GEMINI_CLI_HOME/tmp/<project>/chats/session-*.jsonl`, by default `~/.gemini/tmp/…`). Each `gemini` message counts the tokens its response used — the cached part comes out of the prompt, `thoughts` are their own counter — and the message id deduplicates the windows that re-emit it. A message has no response time, so these calls stay out of the live speed and the fastest list. The older single-JSON records carry no per-message tokens and are not counted; project directories (a readable slug or a SHA-256 hash) are not traced back to a working directory, so Gemini sessions show no project for now.
- Qwen Code: one call per assistant row of its Claude-shaped transcripts (`$QWEN_RUNTIME_DIR/projects`, by default `~/.qwen/projects`), the cached part out of `promptTokenCount`, thoughts their own counter, the model on the row, the user row before it as the request start.
- A saved ledger never changes shape: readers older than this release quarantine it once it holds these entries and import their logs again, so the ledger version stays 2. The root cap is now sixty-four.

**Hermes, MiMoCode and dsh in the Token page**
- Three more sources: Hermes ("Hermes", indigo) from `~/.hermes/state.db`, MiMoCode ("MiMoCode", teal) from `~/.local/share/mimocode/mimocode.db`, and DeepSeek Harness ("DeepSeek Harness", violet) from `~/.dsh/storages/cost-meter/ledger.json` — all opened read-only.
- Hermes: one call per ended session per model — the five token counters, the call count, and the session's working directory; a sub-agent session (one with a parent) is the sub-agent's call. Sessions still running wait for their end. A provider id or `extends` of `hermes` is recognised like the other bases.
- MiMoCode: OpenCode's database layout one directory over — every assistant message counts its tokens (cache out of the prompt, reasoning as its own counter) with the response time, keyed by the message id; `<synthetic>` zero rows are not calls. A provider id or `extends: "mimo"` is recognised.
- dsh: one call per session per provider-model of every closed day in the cost ledger — the five counters plus reasoning and the call count; the running day waits for midnight. No per-call timestamps and no working directory, so these calls stay out of the live speed, and sessions show no project.
- A saved ledger never changes shape: readers older than this release quarantine it once it holds these entries and import their logs again, so the ledger version stays 2. The root cap is now sixty-four.

**Cline, Roo Code and Kilo Code in the Token page**
- Token statistics now count the VS Code extensions Cline ("Cline", amber), Roo Code ("Roo Code", red) and Kilo Code ("Kilo Code", gray): one call per `api_req_started` row of a task's `ui_messages.json` — `tokensIn` is the fresh prompt (the cache rides beside it as `cacheWrites`/`cacheReads`), `tokensOut` the output. Rows of one step are keyed by their timestamp, so an atomically rewritten file counts once. `subagent_usage` rows are a sub-agent's aggregated batch. The model id is not persisted per request, so these calls show no model. No response time either: whole-task records stay out of the live speed and the fastest list.
- Where the tasks live: every VS Code family host's globalStorage — Code, Code - Insiders, VSCodium, Cursor, Windsurf and the remote `~/.vscode-server(-insiders)` — under the extension ids `saoudrizwan.claude-dev`, `rooveterinaryinc.roo-cline` and `kilocode.kilo-code`. The Cline CLI's own session store (`~/.cline/data/sessions`) is a different, younger format and is not counted yet.
- A saved ledger never changes shape: readers older than this release quarantine it once it holds these entries and import their logs again, so the ledger version stays 2.

**Kimi Code and ZCode in the Token page**
- Token board and execution review: add Kimi Code wire logs (including subagents) and read-only ZCode SQLite/WAL completed-step usage, with cache normalization, incremental cursors and ACP session attribution. Provider history is never modified; unavailable sources report coverage errors.
- ZCode session lookup also covers custom provider definitions and sessions beyond the checkpoint index; an identity check detects reused SQLite rowids after history deletion. The standalone UI build preserves Hermes compatibility and has reproducibility and mobile-compiler checks.

## 2.18.0 · 2026-10-28

**Looping and stuck turns (new, after Cindy's loop guard)**
- While an agent runs, the read that fetches its todo progress also looks at the last 80 rows of the turn (it used to read 20): the same call with the same arguments and result 4 times in a row; only 2 distinct calls in the last 12, or at most 4 in rotation over 16; the same tool hitting the same kind of argument error 3 times in a row (text to replace not found, several matches, old and new text the same, a required parameter missing). Only calls less than 30 seconds apart count, and polling (waiting on a background task, `sleep`, tailing a log) never does; however slow, 30 identical calls in a row or the same result for over an hour is a loop; a newer call still running that isn't part of the pattern (moving on to run the tests, say) ends it. ACP tool calls (all named other) compare by kind and title.
- Stuck: the turn's latest rows unchanged for 10 minutes (45 while a tool call still runs; a sub-agent tool's growing log is change) in a turn at least that old. An agent whose sub-agents or background agents are still working is waiting on them, not stuck; its clock starts when they stop.
- The row gets a one-line reason and counts in Needs you and the sidebar badge (looping orange, stuck amber; the chime uses the failure sound, sidebar labels match), and a card at the top of the detail lists the latest calls (credentials masked) with Open session and Got it. After Got it it stays shown but no longer counts, until the pattern changes or the next turn. Memory only, no model, no provider logs; only agents this process has seen running are read; the sidebar badge's reads trigger it too, not only an open page. New RPC `observatory.live.issue.seen`; live extras carry an `issue` field (older clients ignore it).

**A parent's result waits for its sub-agents (new)**
- When a parent agent's turn has ended but a Paseo sub-agent it started (or one further down, up to 8 levels) still runs (its own provider background agents count), waits for an approval or asks a question, the parent stays running with "N subtasks in the background", as for provider background agents, and its finished alert is held until they are all done; the agent panel shows the same (from the sub-agents it started directly). The sub-agents' own approvals, questions and errors still count as before.

**Fixes**
- Reviews and turn summaries run with a profile or another model now start their temporary read-only helper in the analysed agent's workspace, labelled as its sub-agent. Created with `parent`, Paseo 0.13 wraps such a helper's first message as another agent's message with XML entities, so the helper read `&lt;` and the like.
- Right after the daemon starts, providers are still being discovered and list no approval modes; analysis took them for unusable and cached that for a minute. It now waits up to 8 seconds for discovery.

## 2.17.1 · 2026-10-25

**Paseo 0.13 support (0.12 keeps working)**
- From 0.13 the turn-ended hook no longer carries the conversation (getpaseo/paseo#7477). Replies awaited, quick replies, the merge or pull request a reply links, stop reasons, the dashboard's message, tool and code metrics, automatic analysis and turn summaries all relied on it and would silently go blank. The plugin's lifecycle hub now reads the end of the conversation once when a turn ends (back to the latest user message, at most 600 rows and 6 seconds) and every module shares that read; while it runs the agent's later events wait in order, so a turn that starts right away (a queued message, say) is never handled before the end of the turn before it. On 0.12 the hook's own timeline is used as before.
- Stats place rows by their sequence numbers, so two reads agree; a turn longer than the read counts what was read instead of nothing. Automatic analysis reads further back (up to 1000 rows) only when it is on and the window falls short of its thresholds. Turn summaries use the same read and never read a session of their own.
- Shared send ledger: on 0.13 a request whose frame went out before the connection dropped is an unknown outcome (held for you; cancelling it or its expiry says it may have been delivered), not a failure to retry; a send while the connection is down is described in your language instead of the host's English.
- Motion overlays spell out absolute positioning: the 0.13 phone app's React Native 0.86 removed `StyleSheet.absoluteFillObject`, and spreading it left the overlays unpositioned on phones.
- Connected hosts (Paseo 0.13): an agent delegated from another host says "From <host>" on its row, its diagnostics name the parent's host, and View parent agent opens the parent on its own host in Paseo (it used to look for an agent this host does not have). Alerts follow Paseo's rules unchanged: Paseo raises no notification for a delegated agent and tells its parent instead, so the observatory still treats it as a subagent.
- Chinese listing for the plugin registry (Paseo 0.13): the manifest carries `translations.zh-CN` (name and description) and the package ships `OVERVIEW.zh-CN.md`; older daemons ignore the field.

## 2.17.0 · 2026-10-15

**Turn summaries and AI-suggested replies (new, off by default)**
- About 10 seconds after a top-level agent's turn ends normally, the analysis runner writes a one-line summary: the goal and progress, and the next step (about 25 characters and 12 for the next step in Chinese, about 20 and 8 words in English), in the plugin's language. Subagents, failed or cancelled turns, turns that ended on a tool call or an error, a compaction under way and a request waiting for you get none, nor does a turn followed by another within those 10 seconds; just before writing, the host's fetch of the agent (which never loads it) confirms it still rests.
- Shown under each session's title in the list (a ✦ line: summary → next step), as a Turn summary card at the top of the detail (in full, with who wrote it and when) and under each entry of the sidebar's needs-you popover. Once a new turn starts the old summary turns grey and says Old; while a new one is written it says Updating, the ✦ breathes and the card's edge sweeps. A failure shows nothing on the session.
- Only the text of your messages and the agent's from that turn and up to 8 before it is sent (no tool output, reasoning, errors or notices), each message masked whole for common credentials first, then fitted to about 32 KB (oldest turns dropped first, then the start and end of each message kept), with the session title; a message over about 256 KB (a pasted log, say) is not sent, only a placeholder. The summary uses the timeline the `agent.turn_ended` hook carries and never reads a session for it.
- The runner defaults to the built-in Grok CLI at `low` reasoning effort (model and effort can be changed), isolated as for reviews: no tools, every call denied, an allowlisted environment, `GROK_MEMORY=0`, `GROK_SESSION_SEARCH=0`, and the temp directory, session and search-index record deleted afterwards. A profile or another model can be chosen instead; each summary then runs as a temporary read-only sub-agent in the agent's workspace, archived when done.
- At most 2 are written at once host-wide, the rest queue (the newest turn per agent); each turn gets at most one try; after a failure new summaries pause 1, 2, 4… minutes (at most 30) until one succeeds; without the Grok CLI, or with a profile that cannot run, they are skipped quietly and checked again after 5 minutes.
- Also suggest a reply: the same call guesses the next message you would send (2 to 12 words, your language and tone). None when unsure, when the agent failed, or for credentials, deletions, force pushes or production; questions, the agent's voice, praise, slash commands and masked text are dropped. It shows as a button marked ✦ AI suggestion in the detail's quick replies under the latest reply, and under replies-awaited and unread entries of the popover. It is sent only on a tap, word for word, through the plugin's send ledger with the quick replies' group and turn check: nothing goes once a reply for that turn went out or a new turn started. It is not shown when it says what a quick-reply button says.
- Settings: a Turn summaries section in Observation settings and Analysis settings, stored as the host setting `recap` (`plugin-settings/agent-observatory/recap.json`): two switches, both off on a new install, the runner and its status (ready, or why paused). It says the conversation text goes to the chosen model.
- Storage: `plugin-data/agent-observatory/recaps.json` (0600, replaced atomically, never read through a symlink), up to 300 agents for 30 days; removed when an agent is archived or leaves the host's directory, all deleted when summaries are turned off, stored suggestions deleted when suggestions are turned off. New RPCs `observatory.recap.list` (revisioned) and `observatory.recap.status`.
- Traffic: the list, detail and popover read only while shown in the foreground, every 20 seconds (5 while one is being written), a few bytes when unchanged, once a minute while off. All new views are in the lazy UI chunk; summaries add nothing to the resident stub.
- Based on ideas and code from kingsleydon/paseo-recap (the excerpt budget and recap instructions) and the prompt-suggestions plugin in 961853266hyt/paseo-plugins (the suggested-reply rules and filter), both MIT; see NOTICE.
- Review fixes before release: turning summaries off deletes `recaps.json`, its `.backup` and temp files left by an interrupted write, even when no summary is in memory; records dropped on load (expired, over the limit, malformed) are written out at once, and a backup or temp file older than 30 days is deleted on load. A suggested reply that masking would change is dropped whole. With a profile or another model an agent gets at most one summary every 30 minutes, for its latest turn, and shows the old one as Old meanwhile; the settings say the archived sub-agents and their session records stay in the workspace and add up. A message over about 256 KB is not sent at all, only a placeholder (masking just its start and end could cut a key off from the name that marks it), so a turn's end masks about 4 MB at most (up to 64 MB before, which could stall for about a second).

**Chime, sidebar labels, prompt cache countdown and scheduled send (new)**
Four alerts, all in Observation settings and the plugin's Paseo settings. The two that write into Paseo are off on a new install.
- **Chime** (after Herald's idea): a short sound when Needs attention gets a new entry, with its own tone for questions, approvals and plans, used-up quota, and failures (a small WAV made in code, played with the host's `playAudio`). Only in the foreground, once per event per device, at most once per turn in 15 seconds; subagents are quiet by default. Per-kind switches, quiet hours in each device's time zone, Mute this device, and a sample of each sound. Off by default.
- **Sidebar labels** (after sidebar-organizer's idea): each workspace's Needs attention reason becomes one of Paseo's own workspace labels, in the Observatory's colours, and comes off when the reason clears. Optionally, a workspace waiting for you is pinned until it is handled. Only labels and pins the Observatory added are ever removed; your labels stay as they are, in front. Turning it off removes the Observatory's labels and pins. Writes happen only when a reason changes, batched. Hosts without workspace labels are named as such. Off by default.
- **Prompt cache countdown** (adapted from cache-clock, MIT): Claude-based sessions (by `extends`) show "Cache 4 min", from the cache TTL (5 minutes or 1 hour) of the last request in the session's own log. Amber and breathing near the end; grey "Cache cold" after a compaction or a model change. The server sends the expiry time and the device counts down.
- **Scheduled send** (after Defer's idea): quick replies and Send to this agent offer "Send later…": in 30 minutes, 1 hour, 3 hours, or a day and time on the device's clock, up to 7 days ahead. Nothing is sent before then; afterwards it goes out like "Send after this turn". Scheduled messages are listed in the session detail and the Needs attention popover, with Send now and Cancel.
- The shared send ledger (kit) has an optional `notBefore` (UTC milliseconds) and Send now; plugins that do not pass it behave as before.

**Review fixes**
- Send now on a message scheduled long ago no longer expires it as "queued for over a day" while the agent is busy: its time becomes the moment of the tap, it can wait a day from then, and its id and checks stay the same (kit).
- Sidebar labels: when Paseo does not answer a write (the session reconnected or timed out), the label still counts as the Observatory's, is checked on the next pass, and comes off when the reason clears or the sync is turned off. A pin counts as the Observatory's only once the host confirms it: a pin that failed or got no answer is never claimed or guessed by its time, so a pin you make yourself is never undone; such an unconfirmed pin may stay and is yours to unpin. "No answer" is told by the bridge's error code, not its text, and the settings no longer show its subtask wording.
- Sidebar labels: while the record file cannot be written (full or read-only disk), no labels or pins are added, and the settings status names the error code.
- The prompt cache countdown reads at most the last 4 MB of each log (was up to 32 MB) and cuts model names to 200 characters before comparing them.
- Send later: the time picker says that talking to the agent before then means you are asked first, and that after Paseo restarts the message goes out once a device opens Paseo; a scheduled message held because the session moved on says it is scheduled; the kit docs state the restart condition.

## 2.16.1 · 2026-10-15

Connecting no longer downloads the full language catalog (about 160 KB). The app gets a few hundred bytes of boot text (sidebar titles, in the chosen language) and the rest when an Observatory view first opens, together with its code. Web and desktop still start from their cached copy.

## 2.16.0 · 2026-10-15

Added English, Simplified Chinese, and user language files, with Follow system as the default. Language can be changed in Observation settings or Paseo plugin settings. Interface text, accessibility labels, feedback, and server messages use shared catalogs. New analyses request the selected language; stored reports keep their original text.


## 2.15.2 — 2026-10-14

Privacy fixes for what the observatory writes, sends and shows. Saved data carries over; what older versions kept that is no longer kept is cleaned when it is read.

**AI reviews**
- Grok CLI also records each review's prompt, with the session excerpt, in its own session-search index (`~/.grok/sessions/session_search.sqlite`), and the record stayed after the session was deleted, searchable from your other Grok sessions. Reviews now run with session search off (`GROK_SESSION_SEARCH=0`), and the run's record is deleted afterwards: freed pages are overwritten, the full-text index is merged and the write-ahead log emptied, with a second look a minute later. The startup sweep, and a second sweep an hour after start, remove records of interrupted reviews too. Only a record's directory, id and time are read, never its content. Two limits: while another program is reading the database the write-ahead log cannot be emptied, and the deleted text can stay in the log file until later writes overwrite it (search no longer finds it); leftovers are recognised by name, so any directory in the temp folder whose name starts with `paseo-insight-` counts as the observatory's, including one you named that way and the Grok sessions run in it.
- The Grok CLI gets only the environment it needs (`PATH` with absolute entries only, `HOME`, user, locale, time zone, temp directory, proxy and certificate settings, `GROK_*` and `XAI_*`), not other providers' keys from the daemon's environment. A relative `PATH` entry is no longer searched for `grok`.
- Masking covers more formats: npm, temporary AWS keys, Slack app and refresh tokens, Google OAuth tokens and client secrets, more GitLab tokens, Hugging Face, SendGrid, Stripe (`rk_`, `whsec_`), Groq, Composio (`ak_`), passwords in URLs of any scheme, Slack and Discord webhooks, and `key` / `sig` / `signature` URL parameters. Values in JSON that was stringified twice, and prefixes right after a `\n` escape, are recognised.
- Text is masked before it is cut or turned into JSON: a cut could drop a private key's header or a token's prefix and send the rest as it was. In structured tool input and output, every string under a field whose name says it is a credential (`password`, `AWS_SESSION_TOKEN`, `api_key`, `Authorization`, `credentials`…) is masked whole, whatever it looks like, and the JSON is masked once more before it is cut (a cut could drop the field name and keep the whole value). Session details and the previous review are masked before they are cut too. The report and suggestions a model writes are masked again before they are stored (a provider reviewer can quote files it read on its own).
- Analysis settings and the first review say that the session excerpt goes to the chosen model's provider and that masking is not exhaustive.

**Scheduled runs**
- For a failed turn the host records the Agent's last reply as the run's error, and the ledger kept its first 300 characters after the schedule was deleted. The ledger now keeps only the host's own error messages, or the `[System Error]` part the host adds after the reply (masked); anything else becomes a note that the error text was the Agent's reply and was not saved. Older ledgers are cleaned when read.
- Merge and pull request links lose any `user:password@` (a push URL can carry a token), including links already stored in the ledger and the event history.
- A damaged ledger, usage-limit history or suggestions file keeps a single backup, replaced the next time, instead of a new copy each time; log lines name the error instead of quoting the file.

**Other**
- 交给另一个 Provider and 交给 Agent get the profile list from the plugin server: id, name, provider, model, mode, thinking option, feature values and notes only. The device no longer receives the whole daemon config (provider environments, commands, plugin sources). Like the host, the list sets no length limits: the name and notes, which are only shown, are shortened when long (400 / 4,000 characters), the fields passed on to the new Agent are given as they are, and no profile is left out for a long value.
- Send ledger: at most 3 copies of an unreadable ledger, for a week; temp files of interrupted writes are removed at the next start; log lines name the error only. The shared lock folder is tightened to 0700 and lock files are created 0600.

## 2.15.1 — 2026-10-14

- The server splits the lazily loaded interface chunk on its first request instead of at startup, and slices the source text instead of building strings character by character. This cuts startup CPU and resident memory; the RPC part budget and the interface stay the same.

## 2.15.0 — 2026-10-13

Lighter loading on phones and a fix for the Android app. Saved data carries over unchanged.

- On connect the app receives only a small registration stub (`index.client.tsx`, compiled by Paseo, at most 32 KiB) and the sidebar needs-attention badge. The pages, panels and the badge popover, with its in-place approvals and quick replies, are fetched from the daemon in parts the first time one opens (each reply under 128 KiB), cached by content hash for the app session and evaluated afresh on every connection. A load shows a placeholder and can be retried; a version mismatch asks you to reconnect.
- The badge stays resident: it refreshes every 20 seconds in the foreground, hides failed or stale counts and reports the device's time zone. The badge, the failed-run count, the popover and the dashboard share one needs-attention reading, so 知道了, 标记已读, an approval or a quick reply updates the badge at once.
- Android: the sidebar status module failed to load under Hermes's default evaluator; it now uses a closure-based store. Client code no longer uses `class`, and a repository-wide check guards the Hermes build, the entry export and Paseo's interop patch.

## 2.14.0 — 2026-10-12

Fixes from a second review and a batch of features for handling things from your phone. Saved settings, receipts, snoozes, reports, statistics, token records and the schedule ledger carry over; new fields are optional. Downgrading to 2.13: token statistics can be re-imported only from the session logs that still exist (Claude Code keeps 30 days by default) and the old file is kept as `tokens.json.corrupt`; the 明细 → 观测 history is reset.

**Needs attention**
- One rule for the list, the sidebar badge, the popover and the detail: a turn that hit a usage limit, produced nothing or stopped half-way counts until you look at it, sub-agents included, and 稍后处理 (snooze) does not apply to it. Its button is 知道了 (got it), which clears the alert without a completion receipt. A turn still running when the host closed the session shows as 可能未收尾 and counts until you press 知道了 (kept across restarts).
- 标记已读 (mark read) records the latest turn's completion time, verified by the server against the end time the plugin observed, so a result stays read after archiving, restarting or restoring, also when heartbeats run several turns in a row; a result can be marked read only while the page shows that very turn. Snoozes and quick replies follow turns the same way.
- For agents the host has not loaded (all of them after a daemon restart), 标记已读 and 知道了 check the host's alert token and keep the receipt in the plugin instead of loading the agent; Paseo clears its own alert the next time the agent loads.
- Screen-reader labels match each row's state, the popover fits the host's 440 px desktop limit, and storage warnings are full sentences.

**In-place approvals and quick replies**
- A pending tool approval can be answered from the popover (在这里审批) and the result page. It shows the full command or arguments (up to 64 KB per item, with a note when cut), files and working directory, and offers the provider's own options, answered exactly as chosen (lasting ones take a second tap), or 批准 / 拒绝 / 拒绝并中断. Never in bulk and never automatically; questions and plans stay in the chat.
- Quick replies: when the latest reply asks whether to go on, or announces a next step and stops, the detail offers 继续，按你说的做 or 继续做完, and 先别动. The button's words are what is sent. A quick reply answers only its own turn: one per turn from any device, none once another turn has begun or when the plugin cannot verify the turn. Sentence patterns only; no model call, no stored reply text.
- Quick replies and 发给这个 Agent (send to this agent) go through a send ledger on the plugin's server (`deferred-send.json`, the same code as Project Notes), which plans again from the agent's state under a per-agent lock: it steers into the running turn where the provider supports it, otherwise asks you to confirm the interruption for that turn or offers 等这一轮结束再发 (send when this turn ends), which queues the message until the turn ends and no approval is pending, even with the app closed. One message id per message, so a retry after a lost reply never sends twice.

**Why a turn stopped**
- Replies that only describe rate-limit or quota handling are no longer read as a usage limit; every Claude Code 2.1 limit notice is recognized; a reset time without a zone (resets 5am) is read in the device's time zone and marked as a guess; daylight-saving days are handled.

**Resume after the limit resets**
- The one-off resume heartbeat is written at a UTC time on a minute no other schedule uses and checked against the host's wake time. It counts as done only on proof tied to that run: the host's run record, or the resume prompt with the run's ids in the agent's own Claude Code, Codex or Pi session log (Grok sessions are never opened). When that cannot be told, the card says 未能确认续跑 (could not confirm) and nothing is resent automatically. A busy agent or a missed minute is retried for up to 6 hours; messaging the agent yourself cancels the resume; the stop card shows the real state and can cancel or reschedule.
- The plugin deletes only its own one-off resume heartbeats, once a resume is done or canceled, and follows one whose time you moved in Paseo; one you changed otherwise is left to you.
- New choices: 按额度窗口 (by usage window) when the reply gives no reset time, and 交给另一个 Provider… (hand over to another provider): a new agent in the same workspace whose editable first message points it at the original session.
- Known limits of Paseo 0.11.1, which has no idempotent create and no conditional delete: a heartbeat the host writes more than two minutes late can still wake the agent after it was marked unconfirmed, and a heartbeat you edit in Paseo after the plugin last read it can still be deleted.

**Time zones, usage limits and tokens**
- The Token page, 今日 Token, the live rate, 明细 → 观测 and the analysis overview split days in the device's time zone, daylight-saving days included; hourly data is kept for 29 days.
- Usage-limit capsules warn only on current readings (an old one shows 读数 08:30), and usage is sampled only while a page shows it.
- New token sources: Grok CLI (each session's `usage.json` only) and Pi, also behind custom providers. Custom providers' log directories are taken from their env, command line and launcher script in the order their process gets them (read as text, never run). Long sessions with many sub-agents no longer re-read every log on each poll.

**AI reviews (Grok CLI)**
- The session Grok CLI saves for an analysis, which holds the whole prompt, is deleted when the analysis ends; leftovers of an interrupted run are removed at the next start (only the plugin's own `paseo-insight-*` groups). Built-in tools are removed with `--disallowed-tools` and cross-session memory is off.

**Sessions, schedules and archiving**
- Restoring a session runs as a server task with step-by-step progress; the timeline has find-in-page; 归档已读完成 (archive read results) leaves agents a heartbeat or an unfinished sub-agent still needs, and is unavailable while the schedules cannot all be read. The plugin's `agent.turn_ended` handlers are one host registration.

## 2.13.0 — 2026-10-11

Fixes from the review of 2.12 and features that show at a glance who is waiting for you and why. Saved data carries over; 2.12 ignores the new fields.

- A needs-attention count beside Agent 观测台 in the sidebar, with a popover of up to 8 agents, oldest first, each with a one-line reason; the count is computed on the server with the page's rules and hidden whenever it cannot be trusted. The scheduled runs page shows failures of the last 24 hours.
- One-line reasons without a model call: a question, a plan, a command awaiting approval, an error, a usage limit and its reset. Host alert text is kept in memory only (at most 160 characters, credentials masked).
- Questions and plans no longer show as approvals. Turns that hit a usage limit, produced nothing or stopped after a tool call are labelled instead of 已完成 or 空闲, from the failure reason and the closing sentences only; nothing is stored. A one-off heartbeat you confirm can resume the agent after the limit resets.
- Rows show todo progress, context use, links to merge and pull requests (only the link is stored) and heartbeat wake times; 归档已读完成 takes a second tap; 发给这个 Agent steers into the running turn where supported instead of interrupting it.
- Statistics no longer drop late-evening turns in time zones west of UTC. The Token page adds usage per Paseo provider and the host's usage-limit windows (`providers.listUsage()`; account names stored only as hashes), and reads Codex's archived sessions.
- Scheduled runs are recorded in the background (the schedules folder is watched), and cadences read as Chinese sentences.
- Performance: one shared agent directory per host, rows updated in place, incremental timeline reads (a five-minute session went from 108 to 57 requests and from about 74 MB to 4 MB).
- Uses Paseo 0.11's screen and sidebar APIs, with fallbacks for older hosts.

## 2.12.0 — 2026-10-10

Security hardening after two external reviews of the published plugin. Saved settings, reports and statistics carry over unchanged; a saved built-in Grok choice keeps running grok-4.7 · xhigh.

- 智能分析 only starts a Paseo analysis agent in an explicitly chosen mode whose restriction is known: a read-only mode (Codex and providers that extend it in Codex's read-only sandbox, Cursor's Ask, plan modes) or Claude Code's Always Ask. A provider that lists no modes used to start one with no mode, which made the daemon copy the analysed Agent's mode (often unattended); it is now unavailable. Modes that may act without asking (an ACP agent's Default or Agent mode, OpenCode's Build) are no longer used: such providers analyse in their plan mode, or are unavailable without one. The runner also refuses to create an agent without a verified mode. Codex's sandbox options are sent only to Codex and providers that extend it, not to any provider whose mode ids happen to match.
- Profile feature switches are an allowlist (speed and reasoning effort); auto-accept, plan, agent and other access switches no longer reach an analysis agent, and ACP and OpenCode analyses switch auto-accept off explicitly (their daemon clients turn it on for children of unattended Agents otherwise).
- The ask-first caution now says what happens: approval requests are denied, but actions the provider allows without approval (reading files) can still run. The badge reads 需审批时拒绝 instead of 工具会被拒绝.
- 分析设置 has Grok 模型 and 推理档 (xhigh / high / medium / low) for the built-in Grok CLI. Unset values are grok-4.7 and xhigh, so a saved `{ kind: "grok" }` is read and written as before; a model id must start with a letter or digit and use only letters, digits and `._:/-`, so it can never become a CLI option.
- Credential masking before a trajectory leaves the host also covers PEM private keys (including JSON-escaped and cut-off blocks), JWTs, bare `Bearer` tokens, Google `AIza`, Slack `xox[abprs]-`, GitLab `glpat-` and GitHub `ghs_/ghu_/ghr_` keys, `token=` / `GITHUB_TOKEN:` style assignments (only values that look generated) and prefixed key names such as `DB_PASSWORD` or `AWS_SECRET_ACCESS_KEY`. Counters such as `max_tokens` and ordinary prose stay unchanged.
- Reply previews and the reply renderer stay linear on hostile Markdown: a preview reads only the first 4000 characters with bounded patterns, link text can no longer contain `[`, and headings, list items and quotes are parsed without overlapping quantifiers (60,000 unclosed `[` took 3 s, a padded heading 8 s; now a few milliseconds). Headings keep a `#` that has no space before it (`## C#`), and CRLF line ends are dropped.
- Budgets with an explicit cut notice: the Token import tracks at most 20,000 logs totalling 64 GB (newest first), keeps at most 750,000 dedupe keys and visits at most 250,000 directory entries per scan; a scan cut short keeps the logs it did not reach. A heavy host is about 600 logs, 4.7 GB and 61,000 keys. Logs are opened with `O_NOFOLLOW`, so a tracked log replaced by a symlink is not read. 定时运行 reads at most 2,000 schedule files and 50,000 Agent records (256 MB each) per scan and says when it skipped some.
- `PASEO_HOME` is resolved by one function for reading schedules and writing plugin data: an absolute path or `~/…`; anything else falls back to `~/.paseo` and is logged once. Before, a `~/` value was honoured for schedules but not for plugin data.
- The plugin data directory is created 0700 and tightened when it already exists with wider permissions; the schedule ledger's temporary file has a random name and is created exclusively with mode 0600.
- A schedule without a name or title is stored in the ledger as 未命名定时任务 plus its short id instead of the start of its prompt; the live list still shows the prompt's start.
- Requests to the host held while its session is closed leave the queue when they time out, and the queue has its own cap of 16.
- Development preview: a malformed request target gets 400 instead of an unhandled rejection; the Playwright config and the preview server read the same `OBSERVATORY_PREVIEW_PORT`; the optional fontconfig directory is created with `mkdtemp`.

## 2.11.0 — 2026-10-09

Open-source preparation. Existing installs keep what they show and store.

- Token 页 also finds the logs of custom providers that keep them elsewhere. A provider that extends Claude Code or Codex and sets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in its `env`, on its command line (`NAME=…`) or in its launcher script adds that directory's `projects` / `sessions` folder. The daemon's provider config is read through the plugin API at most every 5 minutes; a launcher is read as text (at most 64 KB, no binaries, never run) for literal assignments only, and no other env value is read. A directory found after the first import counts its whole history once instead of taking older calls for copied history, and it is remembered across restarts. Providers that use the standard directories behave as before.
- 智能分析 has a new default for new installs, 自动选择: the Grok CLI when it is installed, otherwise an enabled Claude Code or Codex provider (then a custom provider that extends one) with its default model, run like a provider chosen by hand; other providers are never picked automatically. A saved choice, the Grok CLI included, is kept. Errors that suggested 改用内置 Grok 4.7 now point to 分析设置, and a queued job names the runner it waits for instead of Grok.
- Copy no longer names one particular setup's providers; the Token page's ⓘ explains which directories it reads.
- Manifest: display name, icon and screenshots; requires Paseo `>=0.11.1`, with the SDK packages pinned to 0.11.1. The `build` step is gone: the plugin has no runtime dependencies and Paseo compiles it, so a Git install no longer installs the development tools.
- New `OVERVIEW.md` (the registry listing page) and `NOTICE` (the MIT notice for the link-opening code 定时运行 adapts from panrafal's schedule-runs). The preview, its fixtures and the tests use invented projects, providers and models only.

## 2.10.0 — 2026-10-09

- 执行中 now includes sessions whose own turn has ended while their subagents keep working (后台执行中). Claude Code runs Task subagents in the background: the lead hands the work over, ends its turn and the subagent keeps going for many minutes. Paseo shows this as "1 working" and counts the workspace as running, but the observatory only knew the session's own status, so such a session was listed as 已完成 / 未读 / 空闲 and 执行中 showed one session too few. It is now 执行中 with a 后台 mark: a blue 「后台 · <task>」 chip on its row, 「后台 1:35」 where the turn timer would be (when the subagent's start is known), and a note in the detail header (这一轮已结束，后台还有 N 个子任务在执行) with 查看子任务. It no longer counts as 未读 / 待回复 / 需要处理 while the work goes on. Approvals, errors and sessions still starting keep their own state.
- Server: a tracker follows the host's `agent.provider_subagents.update` session events (`observeEvents`). It reads the per-Agent subagent list only after the stream opens or reconnects, every 10 minutes, and once a minute for Agents with running subagents (to catch an end it missed). That list makes the host load an Agent that is not loaded (ACP providers then replay the whole session and it looks freshly updated), so only Agents the directory shows as loaded — anything but 已关闭 — are ever asked. New `observatory.background.get` (revisioned; unchanged polls are a few bytes); the page reads it every 10 s while in the foreground and at once on directory activity (a turn that just ended). The page does not subscribe to subagent events itself: that stream carries every subagent's output rows, too much to relay to a phone.
- 看板's 执行中 / 未读 / 待回复 are current between directory walks (once a minute): a turn that started or ended since the walk counts from its lifecycle hook, a new Agent counts as soon as its turn starts, and an Agent still working in the background is 执行中 (not 未读 / 待回复). A hook-only turn older than the walk, whose Agent the walk no longer lists, is no longer counted. The board also refreshes on directory activity instead of only every 30 s.
- 执行中 (chip and status filter) also counts sessions still starting (启动中), as its list section already did.
- Detail: 结果 re-reads every 5 s only while the session's own turn runs; a session working only in the background labels its last reply 本轮结果.

## 2.9.1 — 2026-10-09

- Fix: 定时运行 showed no runs on a host whose schedule Agents belong to removed projects. Paseo 0.11's agent list (`paseo.agents.list`, the daemon's `fetch_agents`) leaves out every Agent whose workspace's project no longer exists, and every scheduled run gets a workspace of its own, so all runs of a schedule whose project was removed were invisible (the 2.9.0 checks read the records directly and missed it). The index now also reads Paseo's Agent records (`$PASEO_HOME/agents/<folder>/<id>.json`, read-only; the folders are listed at most once a minute and a record is parsed again only when it changes) for the Agents the host does not list that a schedule created, or that a schedule, a run or the ledger points at (a heartbeat's target). Their runs are listed and rebuilt again. The host cannot open those sessions or workspaces any more (it shows "Workspace 不可用"), so 运行详情 says so instead of offering 打开会话 / 打开工作区; 读取会话记录 stays.
- Fix: the ledger's temporary file is unique per write (two indexes sharing a directory overwrote each other's file and one rename failed with ENOENT), and stopping the plugin saves pending changes once and then stops the write timer. Tests close every index before removing their directories and collect warnings instead of printing them.

## 2.9.0 — 2026-10-09

- 定时运行 (new sidebar page, also 打开定时运行 in the Command Center): every run of every Paseo schedule on this host, newest first and grouped by day — 执行中 (blue, spinning, with a live timer), 成功, 失败 (red, with the error in Chinese: 工作目录已不存在 / Agent 在等你审批 / daemon 重启 / Provider 启动超时 / 会话无法恢复 …, the original text one tap away) and 结果未知. The header sums the last 7 days (runs, failures, success rate); 失败 / 执行中 / 成功 chips filter; schedule cards (last 10 runs as a health strip, cadence, next run, failures) filter to one schedule, and the header then names that schedule and sums its own week. Phones scroll the cards sideways, wider screens show one row and fold the rest behind 另外 N 个任务.
- A run's detail shows the reply the schedule recorded (headings, lists, quotes, code, bold and tappable links), the merge or pull request it mentions (GitLab-style merge requests as `!42`, GitHub PRs as `#128`, merged ones in violet), 打开会话 / 打开工作区, the schedule's prompt and the run facts. Runs without a recorded reply offer 读取会话记录, which loads the session only when tapped.
- Heartbeats (schedules that prompt an existing Agent) are hidden by default; the 心跳 chip or 更多 → 显示心跳 shows them, with the Agent they prompted (a failed heartbeat records no Agent, so its target is used).
- Cadences read 每天 09:30 / 工作日 09:00 / 每周五 18:00 / 每 30 分钟; a cron that runs in another time zone than the device's says so (每天 02:00（UTC）— Paseo runs zone-less crons in UTC).
- 30 days or 200 runs (plus 100 heartbeat runs) load first; the footer counts what is left out and 加载更早 reads up to 500 + 250. 查看全部运行 on a run older than the window loads the longer list by itself.
- Deleting a schedule deletes its run history in Paseo. The observatory now keeps a small ledger of each run's times, status, Agent and workspace ids, the first 300 characters of its error and its link, plus each schedule's name and cadence (never the reply or the prompt), so deleted schedules' runs stay listed (任务已删除). Runs from schedules deleted before 2.9 are rebuilt from the Agents Paseo labelled (`paseo.schedule-id` / `paseo.schedule-run`). The ledger keeps the newest 3000 runs within 400 days; a corrupt or oversized ledger is set aside as `schedule-ledger.corrupt-<time>.json` and rebuilt, and one that cannot be read is never overwritten.
- 会话 and 已归档会话 mark sessions a schedule created with a violet 定时 badge (they stay where they are). Their 结果 tab starts with a 定时任务 card (schedule, cadence, this run, duration, 查看全部运行 opens 定时运行 on that schedule). For archived ones the recorded reply is shown first without loading the session; 读取完整结果 loads it on demand (when nothing was recorded, e.g. the schedule was deleted before 2.9, the session is read as before). When a schedule Agent's session cannot be read (an ACP session that cannot be resumed, a missing log), its 结果 tab shows the recorded reply under a short notice instead of an error, and stops re-reading the session every 30 s until you tap 重试读取会话.
- A run that has just started can open its Agent right away, before the host directory (walked once a minute) names it.
- Results render Markdown lists (nested, numbered), quotes and links, and links open in the browser (http(s) only).
- 结果 shows known host errors in Chinese (e.g. 会话无法恢复：这个 ACP Agent 不支持重新载入 instead of "acp does not support ACP session resume"); other errors are shown as they are.
- Fix: on Paseo 0.11, pages opened from inside the plugin (查看全部运行, the 已归档会话 / 返回观测台 menu items) were titled with their ids (schedule-runs, archives, observatory). They now register with titles (`addScreen`, falling back to `addSurface` on older hosts).
- Server: `observatory.schedules.list` (revisioned; the window edge moves in 10-minute steps, so unchanged polls are a few bytes) and `observatory.schedules.run` (one run's recorded reply, prompt and row, read on demand). Schedules are read from `$PASEO_HOME/schedules/*.json` and workspace names from `projects/workspaces.json`, read-only and cached by modification time; Agents come from the shared one-minute directory walk. The page polls only while it is on screen and the app is in the foreground: every 10 s while a run is going, otherwise every 45 s.

## 2.8.0 — 2026-09-23

- 待回复 now means the Agent is asking you something: the final reply of its last turn hands the next step to you (要不要继续, which option, confirm, send the output …) and you have not answered yet. Before, 待回复 was the fallback for any stopped Agent whose turn end the plugin had missed, so finished sessions showed up there while real questions were shown as 已完成. An unopened question also counts as 需要处理; once you reply it clears.
- New 空闲 state (grey): stopped, and no result is known for its last turn.
- The server decides from the final reply when a turn ends and keeps only the yes/no, never the reply text. A turn whose end the hooks missed (a queued follow-up, a plugin reload) is read from the timeline tail within a minute if the session is loaded in the host, otherwise when you open it; it counts as completed when a final reply follows your last message. Sessions that are not loaded are never read in the background (the host would load and replay them).
- Fix: a turn end whose start was never delivered no longer leaves the session stuck on an older turn.
- 看板's 待回复 count uses the same rule as the session list (it used to count every stopped session you had read).

## 2.7.1 — 2026-09-23

- Fix: in the phone / foldable app the 会话 search box no longer overlaps the filter chips. The shared kit's search field used `flex: 1`, which on native layout collapses the row it sits in, so the chips were drawn over it (web was unaffected).
- Search text is no longer saved to the server or synced between devices. A search typed on one device (or left by an older version) emptied the list on the others; it now lasts for the current app session only. Named saved views still keep their search.

## 2.7.0 — 2026-09-23

- 智能分析 opens on a new 总览: for the last 7 / 30 days, a gradient hero with the headline, report / open-problem / resolved / blocked tiles, a daily health chart, problem types by severity, open problems and the Agents that need a look — all counted with your 仍存在 / 已解决 / 误判 marks.
- 建议: the analysing model reads the recent reports and writes cross-Agent themes (new / recurring / improving) and actionable suggestions with impact, effort, scope and the reports they rest on (tap to open). 复制指令 copies a rule for AGENTS.md / CLAUDE.md; 交给 Agent starts a new Agent in the chosen project's workspace with the chosen profile and an editable task; each suggestion can be adopted, done or dismissed. With automatic analysis on, suggestions refresh after 3 new reports (at most every 20 hours).
- Who analyses is your choice (分析设置): the built-in Grok 4.7 · xhigh stays the default; any Paseo profile, or a provider + model + thinking level, runs as a temporary sub-agent of the analysed Agent in its workspace, in the provider's safest mode (Codex read-only sandbox, Cursor Ask …) with every tool permission prompt denied, and is archived as soon as the report is written ("打开分析会话" shows it). 更多 → 换个模型分析 overrides it for one run.
- Automatic analysis is off by default; 2.7 switches earlier saved settings off once. Turn it back on in 分析设置.
- 发给这个 Agent: send one finding back to the analysed Agent as an editable follow-up message.
- Fix: Grok analyses no longer fail with "max turns reached" (10 of the last 74 reports did): the CLI gets up to 3 tool-less turns to repair output that misses the schema, and when a model writes its answer twice the last one that fits the schema is used. Chinese characters split between two output chunks no longer turn into "���".
- Server: `observatory.insights.overview` (revisioned roll-up, ~15 KB, unchanged polls ~100 B), `observatory.insights.suggest / suggestions / suggest-cancel / action-feedback` (suggestion jobs share the analysis queue and runner), `observatory.insights.runners / models` (profiles from the daemon config, providers from the cached provider snapshot — no provider probes); settings file version 2.

## 2.6.0 — 2026-09-23

- Token 页 (new tab): personal token statistics for 7 / 30 / 90 days from the local Claude Code and Codex session logs (custom providers that extend them included) — today's total with a live speed badge, a 实时流速 chart (10 s buckets over 30 or 60 minutes, output spread over each call's response time, sessions writing right now with their tok/s), KPI tiles (total, output, cache reads / writes, fresh input, cache hit rate, output speed, calls), daily stacked trend (总量 / 非缓存 / 输出 / 速率), composition donut, model / harness / project breakdowns, the sessions that used the most tokens, hour-of-day distribution and records. Calls are deduplicated across resumed and forked sessions; only counters, model names, working directories and session ids are kept.
- 复盘 (new agent-detail tab): the agent's whole execution folded server-side into key numbers, an 执行时间轴 Gantt (one row per kind of work — thinking, reading, searching, editing, commands, web, sub-agents, plans, approval waits — turns side by side with long idle gaps folded, tap a turn to zoom and a block for its details), 重点 (failed and then fixed tests, failure streaks, slowest commands, long thinking, approval waits, big edits, commits and pushes, sub-agents, compactions, the turn that used most tokens), 时间都去哪了, 按轮回顾 cards with a per-turn barcode, 命令与检查, 动过的文件 and per-call tokens. Every block, highlight and check jumps to its raw row in 时间线.
- Server: `observatory.tokens.get` / `observatory.tokens.live` read the provider logs incrementally in the background (hot files every 2 s, discovery every 30 s) into `tokens.json` (hourly buckets for 92 days, daily for 400); `observatory.digest.get` folds the host's projected timeline (tool start times are estimated from the preceding entry) into a revisioned payload under 59 KB.
- Running session rows show their live output speed (tok/s); 看板's hero links to today's tokens.
- Detail tabs scroll sideways on phones instead of clipping.

## 2.5.0 — 2026-09-23

- Six views in a colourful tab bar: 会话 · 看板 · 明细 · 横评 · 事件 · 分析. The selected view is a gradient pill; on phones the others are coloured icons (their names stay in the accessibility labels).
- 看板 (personal statistics for 7 / 30 / 90 days in your time zone): a gradient hero with today's turns and work time, streak, level and live counts (执行中 / 待审批 / 未读 / 待回复 open the matching sessions); eight KPI tiles with change against the previous period and sparklines; a year calendar heatmap; 18 growth badges and levels; a daily trend with a 7-day average and a weekday-baseline forecast; records (longest turn, busiest day, peak parallel Agents, busiest session, peak hour); a weekday × hour punchcard; the model mix as a donut.
- 明细: models, vendors, harnesses and projects ranked by turns, sessions, time, tool calls or code, with a top-three podium, a composition bar and per-row success rate, average turn, tools per turn, lines added/removed and context use; tools by kind and the most used tools; a time-and-output summary. 观测 keeps the earlier observation charts (activity heatmap, daily results, usage snapshots).
- 横评: two models, harnesses or vendors head to head — a score, a six-axis radar (产出 / 速度 / 稳定 / 自主 / 省心 / 活跃), earned titles (更稳 / 更快 / 更高产 …) and paired bars for 产出 / 效率 / 质量 / 投入; swap sides or pick either side.
- 事件: a 并行泳道 swimlane of the last 1 / 6 / 24 hours — one lane per Agent, turns as bars (green done, red failed, blue still running with a pulse), approval waits as amber strips, and the peak number of Agents working at once.
- 已完成 and 待回复 no longer look alike: every state has its own colour, glyph and label (待回复 violet speech bubble, 已完成 green check, 未读 pink, 待审批 amber, 异常 red, 执行中 blue), every waiting row carries a tag, a 待回复 quick scope was added, and 图例 explains the marks. `statusNames.idle` is now 待回复.
- Kit v3 palette: brighter neon-like shades on dark themes, new sky / lime / fuchsia hues, gradient and glow helpers; text colours keep ≥ 4.5:1.
- Server: `observatory.stats.get` returns a compact, revisioned statistics snapshot (unchanged polls cost a few bytes). Sessions come from Paseo's directory including archives; turns, time and parallelism from the plugin's own observation; messages, tool calls and edited lines from each turn's new timeline items. Persisted in `stats.json` with bounded history.

## 2.4.0 — 2026-09-23

- Vivid colours on the shared kit v2 palette instead of Paseo's muted status colours: running blue, waiting amber, failed red, done green, in dark and light themes (text variants keep ≥ 4.5:1).
- Every view has its own colour: 会话 blue, 数据洞察 violet, 事件流 orange, 智能分析 pink; detail tabs 结果 green, 时间线 blue, 子任务 violet, 诊断 orange, 分析 pink.
- Projects get a stable colour (`hueFor`, the same in every plugin): a dot in each session row, a coloured initial in the detail header, project sheets and project rankings; selected project chips take the project's colour.
- Section labels in results and diagnostics carry coloured icons; filter chips for states use the state colours; git parts (worktree, branch) are violet.
- Analytics: green activity heatmap (violet for output, red for failures), coloured headline numbers, vivid daily bars, project bars in project colours; the events pulse is orange.

## 2.3.0 — 2026-09-23

- Distinct status marks instead of same-looking dots: running is a turning blue ring with a per-second timer, approvals a filled amber mark that radiates, errors red, unread results a filled green check; idle, read, closed and canceled sessions are grey outlines with lighter titles. Running gets its own blue because Paseo's accent is the same green as success.
- Rows that need you or are running carry a coloured edge and a tinted pill (待审批 2, 异常, 未读, 失败 N 次, 久无更新). Group headers, quick-scope chips, sub-agent toggles, subtasks and the detail header's status pill use the same marks.
- Motion only where something happens: a row flashes in its new colour when its state changes, new events slide into the feed, running details show a sweeping progress bar, the 实时 dot radiates while live, analytics bars grow in when shown.
- Web animations are CSS keyframes (no JavaScript per frame); native uses the native driver. Loops pause in the background and stop entirely under the system's reduced-motion setting.

## 2.2.0 — 2026-09-23

- UI redesign on the shared plugin kit (`client/kit.tsx`): no hero, harvest banner or stat cards; the first session row now starts about 125 px below the top of the surface on phones and desktop, down from 650–700 px.
- One toolbar row: 会话 / 数据洞察 / 事件流 / 智能分析, search, and a “···” menu for archives, list/tree, sort order, expand all, snapshot export and refresh.
- Quick scopes 需要处理 / 执行中 / 未读 (plus 稍后处理 while anything is snoozed), project and time-range chips, a 筛选 sheet with saved views, and removable chips for applied filters.
- Sessions are grouped 需要处理 → 执行中 → 最近 by whole thread. Each row shows one badge (approval, repeated failure, error, unread/snoozed, quiet); unread descendants show on the sub-agent toggle.
- Detail: split view from 760 px, a pushed page with a bottom action bar on phones. 打开会话 (处理审批 / 恢复会话) is the one primary action, 已读并看下一个 sits next to it, the rest is in “···”. Only the runtime line re-renders on the clock.
- Explanations moved to ⓘ sheets, menu hints and the README; confirmations are toasts, errors are one-line banners with retry.
- Analytics restyled: single-hue heatmap with a 少→多 legend and 未采集 cells, thin daily bars in status colours with a legend, neutral project bars, two-column stats on phones.
- Additive preference field `focus` (`"all" | "attention"`), optional so views stored by older versions load unchanged and older servers ignore it.
- Preview uses the exact host themes, real Lucide icons, and host-like sheets and toasts; `lucide-react` added as a dev dependency.

## 2.1.0 — 2026-09-22

- Require Paseo `>=0.9.0`; SDK packages pinned to 0.9.0.
- Agent directory follows an owned 0.9 observation (`agents.list({ subscribe: {} })`, one-entry snapshot) instead of re-listing every agent every 5 s; full reads only on open, foreground, reconnect, a 10-minute safety interval, or 15 s fallback polling while no observation is available. Hidden views release it.
- Revisioned telemetry (unchanged or delta replies), analytics (unchanged replies carry the open coverage interval; only rendered usage samples are sent), read receipts, insight lists (content revision) and agent results.
- Analytics loads only while its tab is visible; `inactive` app state pauses polling like `background`; dashboard filters recompute only at range/snooze boundaries and rows are memoized.
- Timeline subscriptions follow 0.9 semantics: re-read after `subscription_restored`, re-subscribe with backoff after `error`, never stitch a non-contiguous tail.
- Raw IPC bridge: skip parsing unrelated host frames, fail in-flight requests immediately when the host closes the plugin session, hold new ones until it re-attaches.
- Persistence: idle heartbeats no longer rewrite and fsync `telemetry.json` every 30 s; unchanged usage samples and identical payloads are not written; the insight index is rewritten only when its content changes.

## 2.0.1 — 2026-09-17

- Keep Open Paseo conversation in the fixed detail header for every session state and tab, including unread result pages.
- Show navigation failures in the same visible header and remove duplicate navigation actions from scrolling content.

## 2.0.0 — 2026-09-17

- Results-first session and native subagent views: pinned initial input, latest reply, result evidence.
- Version-aware read-and-next queue, one-hour snooze, archive-read flow.
- Saved views and reading positions; independent scrollable filters.
- Shared bounded timeline cache, virtualized history/subtasks, attention-first directory paging.
- Archive/read provenance and background pagination correctness.
- Separate insight settings/index/reports, large-history migration, independent cooldown and skip retention.
- Lazy report loading, source freshness, incremental follow-ups and finding feedback.
- Online coverage intervals and project-attributed analytics.

## 1.2.0 — 2026-09-17

- Completed-unread harvest queue, native read acknowledgement and versioned receipts.

## 1.1.0 — 2026-09-17

- Separate archives, worktree/branch identity and responsive visual redesign.

## 1.0.0 — 2026-09-16

- Initial agent dashboard, lifecycle telemetry, nested subagents and AI trajectory review.
