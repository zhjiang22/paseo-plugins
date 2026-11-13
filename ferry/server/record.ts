// The full record of a chain's history as of a handoff: every item, as kept (redacted, generously capped), for an agent
// to read with its own file tools when the history tool is not there. Written in English like the envelope.

import type { Chain, NumberedItem } from "../shared/model";

export function renderRecord(chain: Chain, items: readonly NumberedItem[], at: Date): string {
  const visits = chain.visits
    .filter((visit) => visit.closedAt)
    .map((visit) => `${visit.n}) ${visit.provider}${visit.model ? ` (${visit.model})` : ""}`)
    .join(", ");
  const lines = [
    "# Conversation record",
    "",
    `Workspace: ${chain.cwd}`,
    `Written: ${at.toISOString()}`,
    `Agents: ${visits || "none"}`,
    `Items: ${items.length}. Item numbers match the handoff and the history tool.`,
    "",
  ];
  for (const item of items) {
    const details = [item.role, item.kind, `agent ${item.visit} (${item.provider})`];
    if (item.status && item.status !== "completed") details.push(item.status);
    if (typeof item.exitCode === "number") details.push(`exit ${item.exitCode}`);
    if (item.from) details.push(`from ${item.from}`);
    lines.push(`## ${item.n} · ${details.join(" · ")}`, "", item.text, "");
  }
  return lines.join("\n");
}
