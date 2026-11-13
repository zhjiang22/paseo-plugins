# Changelog

## 0.1.0

First release.

- Four routes, chosen per move and shown before anything happens: the same session on a provider that shares the
  session store, back to an earlier agent with only what it missed (natively too, where a store is shared), and a
  budgeted handoff to a new agent everywhere else. A route that fails part-way falls back to a handoff.
- The history travels as Paseo's chat history attachment: redacted, chosen to fit the target's context, with the full
  record in a file and a read-only `ferry_read_history` tool for agents that get Paseo's MCP tools.
- `/ferry [provider[/model]] [message]`, a Command Center entry, a "⇄ Ferry" button by every composer that says
  what went wrong after a failed turn, a picker with a preview of what will be sent, rows in both chats with Switch
  back, Show what was sent and Retry, and a row when a reply is itself a quota notice or a provider error.
- Partners for one-step moves, permission modes that never become more permissive, models and thinking levels carried
  across where the target has them.
- Settings for the budget, command output, archiving, native continuation and each provider's session store,
  delivery, retention and a slash alias. English and Simplified Chinese.
- `bin/ferry.mjs`, a command-line tool for the same moves; live end-to-end scripts for a relay across providers and
  for the web app.
