import assert from "node:assert/strict";
import test from "node:test";
import { DISPLAY_DEFAULTS, displaySettings } from "../shared/display-settings";

test("the running detail progress bar is on unless it was turned off", () => {
  assert.deepEqual(displaySettings.schema.parse({}), { runningBar: true });
  assert.deepEqual(displaySettings.schema.parse({ runningBar: false }), { runningBar: false });
  assert.deepEqual(DISPLAY_DEFAULTS, { runningBar: true });
});
