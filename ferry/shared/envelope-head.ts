import { ENVELOPE_TAG } from "./plugin-id";

// The opening tag of a Ferry envelope and its attributes: how a handoff message is recognised once a provider has
// replayed it joined to the user's words (the client message id is gone by then; the envelope id is not).

export interface EnvelopeHead {
  id: string | null;
  chain: string | null;
  mode: "full" | "delta";
  selected: number | null;
  total: number | null;
}

const OPEN = new RegExp(`^\\s*<${ENVELOPE_TAG}\\b([^>]*)>`);

function attribute(attributes: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(attributes);
  return match ? match[1]! : null;
}

/** The envelope's attributes when `text` starts with one, else null. */
export function envelopeHead(text: string): EnvelopeHead | null {
  const match = OPEN.exec(text);
  if (!match) return null;
  const attributes = match[1] ?? "";
  const items = /^(\d+)\/(\d+)$/.exec(attribute(attributes, "items") ?? "");
  return {
    id: attribute(attributes, "id"),
    chain: attribute(attributes, "chain"),
    mode: attribute(attributes, "mode") === "delta" ? "delta" : "full",
    selected: items ? Number(items[1]) : null,
    total: items ? Number(items[2]) : null,
  };
}
