import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import type { Catalog } from "../shared/i18n";

/**
 * Kit's catalogs cover every plugin of the collection. Ferry shows the lazy-loading words, the list separator and the
 * Language setting, so those are all its translators get.
 */
const KIT_SECTIONS = ["kitText", "kitLazy", "kitLanguage"] as const;
const kitPart = (catalog: Catalog): Catalog => Object.fromEntries(KIT_SECTIONS.map((section) => [section, catalog[section]]));

export const BUILTIN_CATALOGS = { "zh-CN": [zh, kitPart(kitZh)], en: [en, kitPart(kitEn)] };
