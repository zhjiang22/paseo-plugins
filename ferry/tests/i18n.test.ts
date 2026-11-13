import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { auditCatalogs, findMessageIds, findUntranslated } from "../server/i18n-audit";
import { BUILTIN_CATALOGS } from "../server/locales";
import { bindTranslator, catalogIds, createTranslator } from "../shared/i18n";
import { t } from "../shared/text";
import en from "../shared/locales/en.json";
import zh from "../shared/locales/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("catalogs", () => {
  it("have the same messages and placeholders in Chinese and English", () => {
    expect(auditCatalogs({ zh, en })).toEqual([]);
  });

  it("leave no interface text untranslated in the source", () => {
    expect(findUntranslated(root)).toEqual([]);
  });

  it("are all used, and every id the source names exists", () => {
    const ids = catalogIds(zh);
    const named = findMessageIds(root, zh);
    expect([...named].filter((id) => !ids.includes(id))).toEqual([]);
    expect(ids.filter((id) => !named.has(id))).toEqual([]);
  });

  it("have no section named after the plugin, so labels such as ferry.chain are never taken for message ids", () => {
    expect(Object.keys(zh)).not.toContain("ferry");
  });

  it("keep em dashes out of English", () => {
    expect(JSON.stringify(en)).not.toContain("—");
  });

  it("give translators this plugin's words and only the kit sections it shows", () => {
    for (const language of ["zh-CN", "en"] as const) {
      const [own, kit] = BUILTIN_CATALOGS[language];
      expect(own).toBe(language === "en" ? en : zh);
      expect(Object.keys(kit!).sort()).toEqual(["kitLanguage", "kitLazy", "kitText"]);
    }
  });
});

describe("wording", () => {
  it("speaks English and Chinese, plurals included", () => {
    try {
      bindTranslator(createTranslator("en", [en, kitEn]));
      expect(t("boot.pillTo", { reason: t("boot.pillLimit"), target: "partner" })).toBe("Out of quota → partner");
      expect(t("settings.days", { count: 1 })).toBe("1 day");
      expect(t("settings.days", { count: 30 })).toBe("30 days");
      expect(t("picker.selection", { selected: 42, total: 57, size: "14 KB", tokens: "14k" })).toBe("Sends 42 of 57 items · 14 KB · about 14k tokens");
      bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
      expect(t("boot.pillTo", { reason: t("boot.pillLimit"), target: "partner" })).toBe("额度用完 → partner");
      expect(t("settings.days", { count: 30 })).toBe("30 天");
    } finally {
      bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
    }
  });
});
