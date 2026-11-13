import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { SETTINGS_ID } from "./settings-id";

// Ferry's settings, kept by the host in `$PASEO_HOME/plugin-settings/<plugin id>/general.json`, so every device of the
// host acts the same. Reading never fails on a hand-edited file: a value out of range or of the wrong kind takes its
// default (each field catches on its own).

const int = (min: number, max: number, fallback: number) => z.number().int().min(min).max(max).catch(fallback);
const bool = (fallback: boolean) => z.boolean().catch(fallback);
const providerId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);

export const settingsSchema = z.object({
  /** Ceiling of the history sent with a handoff, in tokens (estimated at three bytes each, see bytes.ts). */
  budgetTokens: int(1000, 64_000, 16_000),
  includeToolOutput: bool(true),
  /** Bytes of one command's output, start and end. */
  toolOutputBytes: int(500, 16_000, 6000),
  /** Sent when the user writes nothing; empty means the built-in wording in the user's language. */
  defaultMessage: z.string().max(2000).catch(""),
  /** What happens to the agent a conversation leaves. */
  afterHandoff: z.enum(["archive", "keep"]).catch("archive"),
  /** Continue natively between providers that share a session store. */
  native: bool(true),
  /** Per provider: "auto", "isolated" (never native), or the name of a store the user knows is shared. */
  stores: z.record(providerId, z.string().max(200)).catch({}),
  /** Where `/ferry` alone and the failure button go, in order: `to` is a provider or `provider/model`. */
  partners: z.array(z.object({ from: providerId, to: z.string().min(1).max(200) })).max(50).catch([]),
  /** Per provider: send the history as a hidden attachment, or inline in the message. */
  delivery: z.record(providerId, z.enum(["attachment", "inline"])).catch({}),
  /** Ferry's button by every agent's composer; off, it shows only after a failed turn (with failurePill). */
  composerButton: bool(true),
  failurePill: bool(true),
  alertRows: bool(true),
  historyTool: bool(true),
  transcriptFile: bool(true),
  retentionDays: int(1, 365, 30),
  /** A second slash command for Ferry, e.g. "switch"; empty for none. */
  slashAlias: z.string().regex(/^(?:|[a-z][a-z0-9-]{0,30})$/).catch(""),
});

export type FerrySettings = z.output<typeof settingsSchema>;

export { SETTINGS_ID } from "./settings-id";

export const ferrySettings = defineSettings({ id: SETTINGS_ID, scope: "host", version: 1, schema: settingsSchema });

export const DEFAULT_SETTINGS: FerrySettings = settingsSchema.parse({});

/** The partner for a conversation on `provider`: the first entry whose target is usable, as `provider[/model]`. */
export function partnerFor(settings: Pick<FerrySettings, "partners">, provider: string, usable: (target: string) => boolean): string | null {
  for (const entry of settings.partners) {
    if (entry.from === provider && usable(entry.to)) return entry.to;
  }
  return null;
}
