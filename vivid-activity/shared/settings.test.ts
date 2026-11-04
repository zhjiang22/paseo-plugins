import { describe, expect, it } from "vitest";
import { activitySettings, DEFAULT_EXPANSION, DEFAULT_STRENGTH, EXPANSION_TARGETS, foldFromValues, visibleExpansionTargets } from "./settings";

describe("activity settings", () => {
  it("stays on version 1 so stored settings need no migration", () => {
    expect(activitySettings.version).toBe(1);
  });

  it("backfills expansion defaults and the takeover scope for older stored values", () => {
    const parsed = activitySettings.schema.parse({ palette: "vivid" });
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
    expect(parsed.takeover).toBe("all");
  });

  it("defaults every value when nothing is stored", () => {
    const parsed = activitySettings.schema.parse({});
    expect(parsed.palette).toBe("vivid");
    expect(parsed.takeover).toBe("all");
    expect(parsed.expansion).toEqual(DEFAULT_EXPANSION);
  });

  it("keeps an explicit expansion choice and fills the rest", () => {
    const parsed = activitySettings.schema.parse({ expansion: { shell: "always" } });
    expect(parsed.expansion.shell).toBe("always");
    expect(parsed.expansion.read).toBe("never");
    expect(parsed.expansion.search).toBe("latest");
  });

  it("collapses edit, write and shell rows by default (local default)", () => {
    expect(DEFAULT_EXPANSION.edit).toBe("never");
    expect(DEFAULT_EXPANSION.write).toBe("never");
    expect(DEFAULT_EXPANSION.shell).toBe("never");
    expect(DEFAULT_EXPANSION.read).toBe("never");
    expect(DEFAULT_EXPANSION.thinking).toBe("latest");
  });

  it("covers every target with a default", () => {
    for (const target of EXPANSION_TARGETS) {
      expect(DEFAULT_EXPANSION[target.key]).toBe(target.default);
    }
  });

  it("defaults task-list tool rows to the latest row", () => {
    expect(DEFAULT_EXPANSION.todo).toBe("latest");
    expect(activitySettings.schema.parse({}).expansion.todo).toBe("latest");
  });

  it("lists only the rows the current takeover scope draws", () => {
    const all = visibleExpansionTargets("all").map((target) => target.key);
    expect(all).toContain("shell");
    expect(all).not.toContain("plan");
    expect(visibleExpansionTargets("reasoning").map((target) => target.key)).toEqual(["thinking"]);
    expect(visibleExpansionTargets("off").map((target) => target.key)).toEqual(["thinking"]);
  });

  it("labels every listed target in Chinese", () => {
    for (const target of EXPANSION_TARGETS) expect(target.label).toMatch(/[一-鿿]/);
  });

  it("folds finished runs and uses the compact density by default, also for settings stored before 0.3.0-local.2", () => {
    const stored = activitySettings.schema.parse({ takeover: "reasoning", palette: "soft", expansion: { shell: "always" } });
    expect(stored.fold).toBe(true);
    expect(stored.density).toBe("compact");
    expect(activitySettings.schema.parse({ fold: false, density: "standard" })).toMatchObject({ fold: false, density: "standard" });
    expect(activitySettings.schema.safeParse({ density: "huge" }).success).toBe(false);
  });

  it("hands the folding switch and the scope to the fold runtime", () => {
    expect(foldFromValues({})).toEqual({ enabled: true, scope: "all" });
    expect(foldFromValues({ fold: false, takeover: "reasoning" })).toEqual({ enabled: false, scope: "reasoning" });
    expect(foldFromValues({ fold: "yes" })).toBeNull();
  });

  it("keeps finished rows at full strength by default, also for settings stored before 0.11.0", () => {
    expect(DEFAULT_STRENGTH).toBe("full");
    expect(activitySettings.schema.parse({}).strength).toBe("full");
    expect(activitySettings.schema.parse({ fold: false }).strength).toBe("full");
    expect(activitySettings.schema.parse({ strength: "soft" }).strength).toBe("soft");
    expect(activitySettings.schema.safeParse({ strength: "half" }).success).toBe(false);
  });

  it("keeps diff lines scrolling by default and accepts the wrap choice for settings stored before 0.11.0", () => {
    expect(activitySettings.schema.parse({}).diffWrap).toBe("off");
    expect(activitySettings.schema.parse({ strength: "dim" }).diffWrap).toBe("off");
    expect(activitySettings.schema.parse({ diffWrap: "on" }).diffWrap).toBe("on");
    expect(activitySettings.schema.safeParse({ diffWrap: "maybe" }).success).toBe(false);
  });

  it("colors the row command only while open by default, and accepts always", () => {
    expect(activitySettings.schema.parse({}).commandColors).toBe("expanded");
    expect(activitySettings.schema.parse({ commandColors: "always" }).commandColors).toBe("always");
    expect(activitySettings.schema.safeParse({ commandColors: "never" }).success).toBe(false);
  });

  it("keeps the thought tail window off at 20 lines by default, clamped to 5–500", () => {
    const parsed = activitySettings.schema.parse({});
    expect(parsed.thoughtTailFollow).toBe(false);
    expect(parsed.thoughtTailLines).toBe(20);
    expect(activitySettings.schema.parse({ thoughtTailFollow: true, thoughtTailLines: 5 }).thoughtTailLines).toBe(5);
    expect(activitySettings.schema.parse({ thoughtTailLines: 500 }).thoughtTailLines).toBe(500);
    expect(activitySettings.schema.safeParse({ thoughtTailLines: 4 }).success).toBe(false);
    expect(activitySettings.schema.safeParse({ thoughtTailLines: 501 }).success).toBe(false);
    expect(activitySettings.schema.safeParse({ thoughtTailLines: 20.5 }).success).toBe(false);
  });
});
