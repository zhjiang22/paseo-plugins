import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROW_ALERT, ROW_HANDOFF, ROW_MOVED } from "../shared/plugin-id";

// The app refuses a client contribution whose id or kind is anything but lower-case letters, digits and dashes, and
// then loads none of the plugin's client. The daemon accepts such rows, so only a test catches it.
const VALID = /^[a-z][a-z0-9-]*$/;

describe("client contributions", () => {
  it("use ids and kinds the app accepts", () => {
    for (const kind of [ROW_HANDOFF, ROW_MOVED, ROW_ALERT]) expect(kind).toMatch(VALID);
    for (const file of ["index.client.tsx", "client/pills.ts"]) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      const ids = [...source.matchAll(/\bid: "([^"]*)"/g)].map((match) => match[1]!);
      expect(ids.length, file).toBeGreaterThan(0);
      for (const id of ids) expect(id, `${file}: ${id}`).toMatch(VALID);
    }
  });
});
