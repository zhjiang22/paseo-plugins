import { outgoingMessage, ledgerInput } from "../client/send-check";
import { deferredSendContracts } from "../shared/deferred-rpc";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import zh from "../shared/locales/zh-CN.json";
import en from "../shared/locales/en.json";
import ko from "../shared/locales/ko.json";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";
import { auditCatalogs, findMessageIds, findUntranslated } from "../server/i18n-audit";
import { assembleCatalog, bindTranslator, catalogIds, createTranslator, currentLanguage, type Catalog } from "../shared/i18n";
import { t } from "../shared/text";
import { BUILTIN_CATALOGS } from "../server/locales";
import { createLocaleService } from "../server/i18n-server";
import { quotaNotice } from "../shared/stop-reason";

const root = join(__dirname, "..");
const useChinese = () => bindTranslator(createTranslator("zh-CN", [zh, kitZh]));
// All runtime lookups currently name concrete IDs; list any future computed prefix here.
const dynamicPrefixes: readonly string[] = [];

test("all built-in messages have matching IDs and placeholders and English has no CJK", () => {
  assert.deepEqual(auditCatalogs({ zh, en }), []);
  assert.deepEqual(auditCatalogs({ zh: assembleCatalog([zh, kitZh]), en: assembleCatalog([en, kitEn]), others: { ko } }), []);
  assert.deepEqual(catalogIds(ko).sort(), catalogIds(assembleCatalog([en, kitEn])).sort());
});

test("all remaining CJK source literals document their data role", () => {
  assert.deepEqual(findUntranslated(root), []);
});

test("catalog messages are used and named source IDs exist", () => {
  const ids = catalogIds(zh), named = findMessageIds(root, zh);
  assert.deepEqual([...named].filter(id => !ids.includes(id)), []);
  assert.deepEqual(ids.filter(id => !named.has(id) && !dynamicPrefixes.some(prefix => id.startsWith(prefix))), []);
});

test("English registration, language screen and kit controls render together", () => {
  bindTranslator(createTranslator("en", [en, kitEn]));
  try {
    assert.equal(t("boot.screenTitle"), "Agent Observatory");
    assert.equal(t("boot.archivesTitle"), "Archived sessions");
    assert.equal(t("boot.schedulesTitle"), "Scheduled runs");
    assert.equal(t("boot.openAttention"), "View sessions that need attention");
    assert.equal(t("language.description"), "Track progress, results, usage, and scheduled runs for all agents.");
    assert.equal(createTranslator("en", [en, kitEn]).t("kitLanguage.title"), "Language");
  } finally { useChinese(); }
});

test("Chinese quota parsing is data and still works in an English interface", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  useChinese();
  const expected = quotaNotice("额度已用尽，请稍后重试", "error", now, "UTC");
  assert.ok(expected, "Chinese quota notices must still be recognized");
  bindTranslator(createTranslator("en", [en, kitEn]));
  try { assert.deepEqual(quotaNotice("额度已用尽，请稍后重试", "error", now, "UTC"), expected); }
  finally { useChinese(); }
});

test("the plugin locale service supports custom coverage, invalid placeholders, English fallback and restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "obs-i18n-"));
  const handlers = new Map<string, (input: any) => Promise<any>>();
  let values = { language: "auto" };
  const listeners = new Set<(state: unknown) => void>();
  const host = {
    registerSettings: () => ({ read: async () => ({ status: "ready", values }), subscribe(listener: (state: unknown) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } }),
    handle(contract: { name: string }, callback: (input: any) => Promise<any>) { handlers.set(contract.name, callback); },
  } as unknown as PluginServerContext;
  let service = createLocaleService(host, { pluginId: "agent-observatory", builtins: BUILTIN_CATALOGS, home });
  const call = (name: string, input: unknown) => handlers.get(name)!(input);
  try {
    await service.ready;
    assert.equal(currentLanguage(), "en");
    const folder = join(home, "plugin-data", "agent-observatory", "locales");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "ja.json"), JSON.stringify({ $meta: { name: "日本語" }, boot: { screenTitle: "エージェント観測台", archivesTitle: "{invalid}" } }));
    const list = await call("i18n.languages", { device: "en-US" });
    const builtInKorean = list.languages.find((language: { code: string }) => language.code === "ko");
    assert.equal(builtInKorean.builtIn, true);
    assert.equal(builtInKorean.coverage, 1);
    assert.deepEqual(builtInKorean.issues, []);
    const japanese = list.languages.find((language: { code: string }) => language.code === "ja");
    assert.ok(japanese.coverage > 0 && japanese.coverage < 1);
    assert.ok(japanese.issues.some((issue: { code: string; detail?: string }) => issue.code === "badPlaceholder" && issue.detail?.includes("invalid")));
    values = { language: "ja" };
    for (const listener of listeners) listener({ status: "ready", values });
    const first = await call("i18n.catalog", { device: "en-US", part: 0 });
    let text = first.text;
    for (let part = 1; part < first.parts; part++) text += (await call("i18n.catalog", { device: "en-US", hash: first.hash, part })).text;
    const translated = createTranslator("ja", [JSON.parse(text) as Catalog]);
    assert.equal(translated.t("boot.screenTitle"), "エージェント観測台");
    assert.equal(translated.t("boot.archivesTitle"), "Archived sessions");
    service.dispose();
    service = createLocaleService(host, { pluginId: "agent-observatory", builtins: BUILTIN_CATALOGS, home });
    await service.ready;
    assert.equal(service.language(), "ja");
    assert.equal((await call("i18n.catalog", { device: "en-US", part: 0 })).language, "ja");
    values = { language: "auto" };
    for (const listener of listeners) listener({ status: "ready", values });
    assert.equal((await call("i18n.catalog", { device: "ko-KR", part: 0 })).language, "ko");
  } finally { service.dispose(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); useChinese(); }
});

test("Korean registration, language screen and kit controls render together", () => {
  bindTranslator(createTranslator("ko", [ko]));
  try {
    assert.equal(t("boot.screenTitle"), "Agent Observatory");
    assert.equal(t("boot.archivesTitle"), "보관된 세션");
    assert.equal(t("boot.schedulesTitle"), "예약 실행");
    assert.equal(createTranslator("ko", [ko]).t("kitLanguage.title"), "언어");
  } finally { useChinese(); }
});


test("user language message nouns longer than ten characters reach the send contract unchanged", () => {
  bindTranslator(createTranslator("de", [{ secondarySendCheck: { message: "Eingabeaufforderung" } }, en, kitEn]));
  try {
    const message = outgoingMessage("test-agent", "Continue");
    const input = deferredSendContracts("observatory").send.input.parse({ agentId: message.agentId, ...ledgerInput(message), what: message.what, consent: null });
    assert.equal(input.what, "Eingabeaufforderung");
  } finally { useChinese(); }
});
