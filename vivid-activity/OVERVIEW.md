Vivid Activity redraws an agent's thinking and tool-call rows as compact activity rows with a color and icon per kind of step, from violet thinking and blue reads to green edits and orange commands. Each row shows its state: a running animation (a blue spinner by default), an amber pulse while it waits for your approval or answer, red when it fails (with a command's exit code), and a short green flash when it finishes.

A finished run of steps folds into one summary row (step count, count per kind, failures, total time and what changed, such as `3 files +12 −4` with a five-block diffstat); tap it to list each file and failed command, then the steps. While the agent works, only running, waiting and failed steps and the two latest stay visible. Rows show each step's time, counting up while it runs. A watched turn's last summary adds its input, cached and output tokens, and in a long turn your question stays pinned above the newest activity.

Based on Colorful Agent Activity by Matt Cowger; the change summary adapts code from paseo-chat-polish by Hieu Le.

## What the rows show

Expanded rows show highlighted commands with output (escape codes hidden, colors kept) and exit code, numbered file reads, colored diffs, previews of images the agent read, and views for Paseo's tools and GitHub and Exa results. Claude Code background-task and Pi extension notices become short localized rows colored by outcome. Schedule details use your device's time zone. Plan cards, task lists, permission prompts, Paseo's messages to the agent (from other agents, heartbeats and watched pull requests) and other plugins' cards (such as Bots proposals) are left alone and end a fold.

## Settings

No setup needed; requires Paseo 0.11.1 or later. The settings page (Settings → Plugins, the Vivid Activity row in the sidebar, or the Command Center) previews sample rows live. Settings live on the daemon, apply to every device and carry over from earlier versions.

- Language: device language (default), English, Simplified Chinese or your own translation in `~/.paseo/plugin-data/vivid-activity/locales/`. Agent output, prompts and paths keep their original text.
- Takeover: all rows (default), thinking rows only, or off. Folding finished steps and pinning the turn's question are on by default.
- Look: row density, palette, running animation and code font.
- Strength: full (default), 65%, 45% or 30%. Finished rows and fold summaries dim to it until hovered or expanded (rows also on focus), unless there is nothing to expand.
- Command colors on a row title's shell command: when open (default) or always. Long diff lines scroll sideways unless line wrapping is on (off by default).
- Thinking rows can follow the output live (off by default) in a 5–500 line window (default 20); Expand all still shows everything.
- Follow new output (on by default, per area: command output, worktree and sub-agent logs, task lists, browser) keeps a running row's open details at the newest output, showing the latest 20 lines; finished rows open at the top.
- Expansion per kind of row: always, newest only, failed only or collapsed. A fold summary with failures starts expanded.

## Data and permissions

To fold and time rows, the server part reads the viewed agent's timeline inside the daemon and sends the app a compact index: each row's position, end time, kind, status and category, tool call and turn ids, text lengths, a short hash of thinking text, lines added and removed with a short hash of each file path, failed commands' exit codes, and watched turns' token figures. It holds no text, path, command or tool output; the pinned question's text is sent separately.

Token figures come from Paseo's agent record, read per provider using only each custom provider's `extends` from the daemon's `config.json`; during a Codex-based turn it subscribes inside the daemon to running agents' updates to add up every request.

Image previews read only regular files of at most 3 MB, links resolved, in the agent's working directory, the system temp directory or the Paseo worktree root (`$PASEO_HOME/worktrees`, otherwise `~/.paseo/worktrees`; ignored if it contains the home directory). A file that is not an image is not read past its first 32 bytes.

Paseo's create agent row, on screen with the app in front, shows three short rows from the new agent's last 8 timeline entries, asking another connected host for an agent running there; a closed or archived agent is read only on Show activity, since reading loads it. A running row on screen with the app in front subscribes to running agents' updates, turning amber when approval is requested.

It makes no network requests of its own, starts no processes, reads no credentials and writes only language templates and state in its plugin data folder. Environment: PASEO_HOME and HOME (that folder, the daemon config, the worktree root), TMPDIR and HOME (the temp-directory check). A Git install's preparation step installs two lockfile-pinned packages from the public npm registry: Paseo's protocol package and Prism for highlighting.

## Known limits

- Paseo gives each timeline row to the first plugin, in id order, that returns a result, so plugins that also redraw these rows, such as Beautiful Chat or Colorful Agent Activity, take them: use only one.
- While tool rows are taken over, Paseo's summary mode stops grouping tool calls, file paths cannot be tapped open, and phones expand tool details in the row; take over thinking rows only, or nothing, to restore these.
- A row's time starts at the previous step's end, as Paseo records only when steps end.
- Only exact line counts are shown; writes, deletions, cut-short diffs and Codex patches (Paseo keeps only their first file) count without them.
- Turn tokens show only for Claude-, Codex- and ACP-based providers and turns watched while running, and not after a plugin reload or daemon restart.
- Folded and expanded rows are remembered for this session only; a sub-agent's own chat view is not folded or timed.
