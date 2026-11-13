# Ferry

A [Paseo](https://paseo.sh) plugin that moves a conversation to another provider, and back again.

Paseo keeps one provider session per agent, so a conversation cannot simply change providers when a quota runs out, a
route goes down or another model would suit the next step better. Ferry keeps a record of each conversation as it
passes from agent to agent and picks the best way across for every move:

| Route | When | What the next agent gets |
| --- | --- | --- |
| **Same session** (native) | Both providers run the same CLI on the same session store, e.g. two Claude Code providers that both use `~/.claude` | The very same session, imported into the target: every message, tool result and thought. Nothing is sent unless you write a message. |
| **Switch back** | An agent on the target already had this conversation earlier | Only what happened while it was away. Its own context is still there. |
| **Same session, back** | An earlier stretch ran on a provider that shares the target's session store | That session, imported on the target, plus what it missed. |
| **Handoff** | Anything else | A new agent with the conversation's history as text, chosen to fit a budget. |

A failed route falls back to a handoff and says why. The previous agent is archived (or kept, if you prefer); a row in
each chat records the move, with a link back.

## Using it

- **`/ferry [provider[/model]] [next message]`** in the composer. With a provider it goes straight there; without one
  it opens the picker, or goes to the partner you configured. Without a message the next agent is told to carry on
  where the last one stopped.
- **Command Center (⌘K)**: "Ferry: continue with another agent…" opens the picker.
- **The button by the composer.** Every agent's composer has "⇄ Ferry". With a partner configured it offers "Continue
  on partner" and "Pick another…"; without one it opens the picker. After a failed turn (out of quota, a route that
  does not connect, a full context, a crash) the same button says so: "Out of quota → partner" goes there in one
  press, "Failed · switch…" opens the picker. A turn that ends with the provider's limit notice or error as its reply
  gets a row with the same choices.
- **The rows** Ferry adds to both chats: "Switch back to …", "Show what was sent", and "Retry" or "Pick another agent"
  when a handoff did not get through.
- **From a terminal**: `bin/ferry.mjs` (see below).

The picker groups providers by route, shows the model, permission mode and thinking level the next agent will use,
how much history fits, and a preview of exactly what will be sent. On the agent's own provider it offers only other
models, as a new agent: useful when a gateway does not serve the model a session started with.

### What the next agent is told

A handoff sends your message with the history as a Paseo `chat_history` attachment, the same kind Paseo's own Fork
uses: providers put it before your words, and the message bubble shows only what you wrote. The history is an
English block the model reads as context, not instructions:

```text
<ferry-handoff v="1" id="…" chain="…" mode="full" items="42/57">
You are taking over a conversation that other coding agents had in this same workspace (/path/to/repo). …
Agents so far: 1) provider-a (model), 2) provider-b (model).
Included: 42 of 57 items; left out: 1–9, 15–20.
The full record of every item is in /…/records/<chain>/<delivery>.md.
If a tool named ferry_read_history is available …, use it to read omitted or shortened items.
<ferry-item n="10" role="user" kind="message" visit="1" provider="provider-a">…</ferry-item>
…
</ferry-handoff>
```

- **What goes in:** user and assistant messages, plans, the latest to-do list, commands with their exit codes and the
  start and end of their output, one line per turn for edited and written files and for what was read or searched,
  errors and notices. Hidden reasoning, raw tool results and Ferry's own rows stay out.
- **Budget:** 16k tokens by default (1k to 64k), less when the target's context is small or already full. The last
  request, the last reply, the first request and the to-do list always go in; then the newest items, skipping any
  that do not fit rather than stopping; then minor items in the space left. Tokens are estimated at three bytes each,
  which errs high for English and Chinese alike.
- **Redaction:** API keys (`sk-…`, GitHub, AWS, Google, Slack tokens), bearer tokens, private key blocks and passwords
  in URLs are replaced before anything is shortened, so a cut never leaves half a key.
- **The full record:** every handoff also writes the whole history (redacted, less shortened) to a file and names it
  in the block, for agents that can read files.
- **The history tool:** where Paseo gives agents its MCP tools (`mcp.injectIntoAgents` in the daemon config), agents
  in a chain also get `ferry_read_history`: pages, single items and search over the whole chain, numbered as in the
  block. It is read-only and can be switched off.

Coming back to an agent sends only the items it missed, numbered in the same sequence. If its context has too little
room left for even that, Ferry starts a new agent instead.

### Settings

Settings → Plugins → Ferry. They live on the host and apply to every device.

- **Partners:** pairs such as `provider-a → provider-b` (optionally `provider/model`). `/ferry` without a target and
  the composer button go straight to the partner. Add the reverse too with one switch.
- **Handoff:** budget, whether command output goes in and how much, the default message, archive or keep the previous
  agent, the history tool, the full record file.
- **Native continuation:** on or off, and per provider whether its session store is detected or treated as not shared.
  Ferry reads the store from `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the provider's own environment (following
  `extends`), then the daemon's, then the default under your home directory. A wrapper script that sets the directory
  itself is invisible from there: mark such a provider "not shared".
- **Buttons and commands:** the button by every composer (or only after a failed turn), what it says after one, a
  row when a turn "completes" with a quota notice ("You've hit your limit · resets 3pm") or a provider error ("API
  Error: …") as its reply, which leaves no failed turn for the button to catch, and a second name for `/ferry`, such
  as `/switch`.
- **Delivery:** per provider, history as an attachment (the default) or inside the message, for providers that drop
  attachments.
- **Data:** how many days chains are kept (30 by default), and forgetting them all.
- **Language:** English and Simplified Chinese built in, following the device by default.

### Permission modes, models and thinking

Ferry never makes the next agent more permissive. It keeps the same mode where the target has it, else maps by tier
(plan, ask, edit or auto, full access) and takes the most permissive mode that is no more permissive than the
current one. If the target has nothing that careful, it takes its most careful mode and warns you. The model is the
one you named, else the partner's, else the same model under the target's naming, else the target's default; the
thinking level carries over where the model offers it. A returning agent keeps its own settings.

## Command line

```text
bin/ferry.mjs <agent> [provider[/model]] [message…] [--stop] [--fresh] [--json]
bin/ferry.mjs providers [<agent>] [--json]
bin/ferry.mjs plan <agent> <provider[/model]> [--preview] [--json]
bin/ferry.mjs chain <agent> [--json]
bin/ferry.mjs sent <chain> <delivery>
bin/ferry.mjs retry <chain> <delivery>
```

`<agent>` is an id, a unique id prefix or an exact title. The CLI finds the daemon the way `paseo` does
(`$PASEO_HOME`, default `~/.paseo`) and uses the `@getpaseo/client` that ships with the `paseo` command on your
`PATH`. `--stop` stops a running turn first; `--fresh` starts a new agent where one could be switched back to.

## Data and privacy

- Ferry stores its records under `$PASEO_HOME/plugin-data/ferry/`: `chains/` (which agents a conversation passed
  through, and what each handoff sent), `transcripts/` (the items of each finished stretch), `records/` (the full
  record files) and `sent/` (the exact text of each handoff, for "Show what was sent"). Directories are created
  `0700` and files `0600`, written atomically. Chains untouched for the retention period are deleted with all their
  files; Settings → Ferry → Data deletes everything at once. The conversations themselves are Paseo's and are not
  touched.
- Ferry makes no network requests and starts no processes. History goes only to the agent you move the conversation
  to, through Paseo.
- Ferry reads the timelines of the agents you move. When a turn ends it reads that turn's rows (at most 120) to spot
  a reply that is a quota notice or a provider error; switching those rows off in the settings stops the reading too.
  Before continuing a session natively it checks that the session's file is in the store (`<store>/projects/*/` for
  Claude Code, `<store>/sessions/` for Codex), and for an agent the daemon cannot load (its provider switched off) it
  reads Paseo's own record of that agent under `$PASEO_HOME/agents/`.
- Native continuation imports a session through a second connection to the same local daemon, using Paseo's own
  client and the daemon's local credential (Paseo's plugin API has no import or stop call yet); stopping a running
  turn when you ask for it uses the same connection. With native continuation off, Ferry opens it only for that.
- Neither provider configuration nor environment is logged. Ferry reads only the session store variables named above;
  the app sees the resulting store directory, in the picker and the settings.
- The `locales/` folder beside the records holds the language templates and your own translations; it is not
  conversation data.

## Known limits

- After a daemon restart (or in an imported session) some providers replay a handoff joined to the user's words, so
  that message bubble shows the history block, collapsed under "Show more". Paseo's own Fork summary does the same.
  Ferry recognises its blocks there and never nests them.
- Whether an agent gets the history tool depends on the provider: Claude Code and Codex do when Paseo injects its MCP
  tools; ACP agents, OpenCode and Pi vary. The block mentions the tool only as "if available", and the record file
  covers the rest.
- Native continuation across different backends behind the same CLI (for example a Claude Code provider routed to
  another vendor's models) depends on that backend accepting the other's history. If one refuses, mark its store
  "not shared" and Ferry hands over instead.
- Installing, reloading or removing Ferry reopens every open agent session once before its next message, because the
  history tool is attached when a session opens.
- Requires Paseo 0.14.0 or later.

## How it compares

- **Switch provider** converts sessions between a few built-in providers (Claude Code, Codex, Pi, OpenCode) and
  falls back to a Markdown transcript for everything else, custom providers included. Every switch makes a new agent.
- **Continuity** moves along a fallback chain when a quota or rate limit hits (or by hand), with a bounded copy of
  the recent conversation and an optional summary. Every switch makes a new agent.
- **Ferry** is manual (one press after a failure), returns to agents that already had the conversation with only what
  they missed, continues the same session wherever two providers share a store (custom providers included), and keeps
  a numbered, searchable record of the whole conversation for the agent that takes over.

## Development

```text
npm install
npm run typecheck
npm test
```

The live end-to-end scripts drive a running daemon (`$PASEO_HOME`) and spend a little quota on the providers you give
them; each asks for `--yes` first:

- `tests/e2e/matrix.mjs --yes --hops <provider/model>,<provider>,…  [--budget-test <provider>]`: one conversation
  relayed across providers, each agent listing every code word so far.
- `tests/e2e/ui.mjs --yes --from <provider/model> --to <provider> [--native <provider>]`: the web app in a headless
  Chromium: `/ferry`, the composer button, rows, picker, preview, phone layout, failure button, settings and language.

## Credits

The idea of keeping the conversation outside the provider sessions, budgeting a text handoff and sending only the
missed part when switching back comes from [T3 Code](https://github.com/pingdotgg/t3code) (MIT, © 2026 T3 Tools Inc.).
Ferry shares no code with it. Ferry is not affiliated with Paseo, T3 Tools or any provider.

## License

MIT
