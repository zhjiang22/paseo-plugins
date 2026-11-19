import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Display-only switches of the observatory, saved as the host setting `display`
 * (`$PASEO_HOME/plugin-settings/agent-observatory/display.json`) so every device shows the same thing.
 * `runningBar`: the thin bar that sweeps across the top of a running session's detail. On unless turned off, so an update
 * never hides it by surprise; the status pill and timer stay either way.
 */
export const displaySettings = defineSettings({
  id: "display",
  scope: "host",
  version: 1,
  schema: z.object({ runningBar: z.boolean().default(true) }),
});
export type DisplaySettings = z.output<typeof displaySettings.schema>;
export const DISPLAY_DEFAULTS: DisplaySettings = { runningBar: true };
