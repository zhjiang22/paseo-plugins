import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import ru from "../shared/locales/ru.json";
import ko from "../shared/locales/ko.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import { catalogName, currentLanguage, normalizeLanguage, type Catalog } from "../shared/i18n";
import { paseoHome } from "./i18n-server";

export const BUILTIN_CATALOGS = { "zh-CN": [zh, kitZh], en: [en, kitEn], ru: [ru], ko: [ko] };

/** The language requested for a new analysis. Stored reports are never translated again. */
export function languageName(): string {
  const language = normalizeLanguage(currentLanguage());
  let descriptor: number | undefined;
  try {
    descriptor = openSync(join(paseoHome(), "plugin-data", "agent-observatory", "locales", `${language}.json`), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = fstatSync(descriptor);
    if (info.isFile() && info.size <= 2 * 1024 * 1024) {
      const name = catalogName(JSON.parse(readFileSync(descriptor, "utf8")) as Catalog);
      if (name) return name;
    }
  } catch { /* A missing or invalid override uses the language's standard name. */ }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
  const builtin = BUILTIN_CATALOGS[language as keyof typeof BUILTIN_CATALOGS];
  const name = builtin?.map(catalogName).find(Boolean);
  if (name) return name;
  try { return new Intl.DisplayNames([language || "en"], { type: "language" }).of(language) ?? language; }
  catch { return language; }
}
