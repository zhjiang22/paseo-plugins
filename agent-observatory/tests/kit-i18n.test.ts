import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  assembleCatalog,
  bindTranslator,
  checkCatalog,
  createTranslator,
  currentLanguage,
  format,
  formatParts,
  joinList,
  matchLanguage,
  normalizeLanguage,
  onTextChange,
  placeholdersOf,
  pluralCategory,
  resolveLanguage,
  t,
  type Catalog,
  type Message,
} from "../shared/i18n";
import { createLocaleService } from "../server/i18n-server";
import { createClientI18n } from "../client/i18n-client";
import { splitReply } from "../server/client-chunks";
import { sendPlan } from "../client/send-plan";
import kitZh from "../shared/locales/kit/zh-CN.json";
import kitEn from "../shared/locales/kit/en.json";

const zhPlugin: Catalog = { $meta: { name: "简体中文" }, boot: { title: "观测台" }, fold: { steps: "{count} 步", before: "前面 {count} 步，用时 {time}" } };
const enPlugin: Catalog = { $meta: { name: "English" }, boot: { title: "Observatory" }, fold: { steps: { one: "{count} step", other: "{count} steps" }, before: "{count} earlier steps, {time}" } };

test("format fills placeholders, keeps a missing one visible and picks plural forms", () => {
  assert.equal(format("前面 {count} 步", { count: 3 }), "前面 3 步");
  assert.equal(format("{a} and {b}", { a: "x" }), "x and {b}");
  assert.equal(format("[{a}]", { a: null }), "[]");
  assert.equal(format({ one: "{count} step", other: "{count} steps" }, { count: 1 }, "en"), "1 step");
  assert.equal(format({ one: "{count} step", other: "{count} steps" }, { count: 2 }, "en"), "2 steps");
  assert.equal(format({ one: "{count} step", other: "{count} steps" }, undefined, "en"), "{count} steps");
  assert.equal(pluralCategory("zh-CN", 1), "other");
  assert.deepEqual(formatParts("按 {key} 重试", { key: "R" }), [{ text: "按 " }, { text: "R", param: "key" }, { text: " 重试" }]);
  assert.deepEqual(formatParts("没有占位符"), [{ text: "没有占位符" }]);
  assert.deepEqual(placeholdersOf({ one: "{count} step", other: "{count} steps of {total}" }), ["count", "total"]);
});

test("language tags normalize and match the closest catalog", () => {
  assert.equal(normalizeLanguage("zh_hans_cn"), "zh-Hans-CN");
  assert.equal(normalizeLanguage("en-US-u-hc-h12"), "en-US");
  assert.equal(normalizeLanguage("en_US.UTF-8"), "en-US");
  assert.equal(normalizeLanguage("C"), "");
  assert.equal(normalizeLanguage(undefined), "");
  const builtIn = ["zh-CN", "en"];
  assert.equal(matchLanguage("zh-Hans-US", builtIn), "zh-CN");
  assert.equal(matchLanguage("zh-TW", builtIn), "zh-CN");
  assert.equal(matchLanguage("zh-TW", [...builtIn, "zh-TW"]), "zh-TW");
  assert.equal(matchLanguage("zh-Hant-HK", [...builtIn, "zh-TW"]), "zh-TW");
  assert.equal(matchLanguage("en-GB", builtIn), "en");
  assert.equal(matchLanguage("pt-BR", ["pt-PT", "pt-BR"]), "pt-BR");
  assert.equal(matchLanguage("ko-KR", builtIn), null);
  assert.equal(resolveLanguage("auto", "ko-KR", builtIn), "en");
  assert.equal(resolveLanguage("auto", "ko-KR", [...builtIn, "ko"]), "ko");
  assert.equal(resolveLanguage("zh-CN", "en-US", builtIn), "zh-CN");
  assert.equal(resolveLanguage("fr", "zh-Hans-CN", builtIn), "zh-CN");
  assert.equal(resolveLanguage(undefined, undefined, builtIn), "en");
});

test("translators search their layers in order and say what is missing", () => {
  const english = createTranslator("en", [enPlugin, kitEn as Catalog]);
  assert.equal(english.t("fold.steps", { count: 1 }), "1 step");
  assert.equal(english.t("kitUi.search"), "Search");
  assert.equal(english.t("fold.nothing"), "fold.nothing");
  assert.equal(createTranslator("en", [enPlugin], { missing: "empty" }).t("fold.nothing"), "");
  assert.equal(english.t("$meta.name"), "$meta.name");
  assert.equal(english.t("constructor.name"), "constructor.name");
  const assembled = assembleCatalog([{ fold: { steps: "custom {count}" } }, enPlugin], ["fold.steps", "fold.before", "boot.title"]);
  assert.deepEqual(assembled, { fold: { steps: "custom {count}", before: "{count} earlier steps, {time}" }, boot: { title: "Observatory" } });
  // Plural forms that fall back to English keep English counting inside a Korean catalog.
  const korean = assembleCatalog([{ boot: { title: "관측소" } }, enPlugin], ["boot.title", "fold.steps"], { language: "ko", languages: ["ko", "en"] });
  assert.deepEqual(korean.fold, { steps: { one: "{count} step", other: "{count} steps", $language: "en" } });
  const speaker = createTranslator("ko", [korean]);
  assert.equal(speaker.t("fold.steps", { count: 1 }), "1 step");
  assert.equal(speaker.t("fold.steps", { count: 4 }), "4 steps");
  assert.deepEqual(placeholdersOf((korean.fold as Record<string, Message>).steps!), ["count"]);
});

test("a user's catalog keeps only known, well-formed messages and explains the rest", () => {
  const reference = assembleCatalog([enPlugin]);
  const check = checkCatalog(JSON.parse(`{
    "$meta": { "name": "한국어" },
    "fold": { "steps": "{count}단계", "before": "앞의 {count}단계, {elapsed}", "extra": "x" },
    "boot": { "title": { "few": "x" } },
    "__proto__": { "polluted": "yes" },
    "bad": "not a section"
  }`), reference);
  assert.equal(check.name, "한국어");
  assert.deepEqual(check.catalog, { fold: { steps: "{count}단계" } });
  assert.equal(check.translated, 1);
  assert.equal(check.total, 3);
  assert.ok(check.unknown >= 2);
  assert.deepEqual(check.issues.find((issue) => issue.id === "fold.before"), { code: "badPlaceholder", id: "fold.before", detail: "{elapsed}" });
  assert.deepEqual(check.issues.find((issue) => issue.id === "boot.title"), { code: "badShape", id: "boot.title" });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.deepEqual(checkCatalog([], reference).issues, [{ code: "notObject" }]);
  // `$language` belongs to served catalogs only.
  assert.equal(checkCatalog({ fold: { steps: { one: "a", other: "b", $language: "en" } } }, reference).translated, 0);
  assert.equal(checkCatalog({ fold: { steps: "a\u0001b" } }, reference).translated, 0);
});

test("an unbound bundle speaks the Chinese kit modules were written with", () => {
  bindTranslator(null);
  assert.equal(currentLanguage(), "zh-CN");
  assert.equal(joinList(["a", "b"]), "a、b");
  assert.equal(sendPlan(null).note, "这个 Agent 已不可用");
  let changes = 0;
  const stop = onTextChange(() => { changes += 1; });
  bindTranslator(createTranslator("en", [kitEn as Catalog]));
  assert.equal(changes, 1);
  assert.equal(joinList(["a", "b"]), "a, b");
  assert.equal(sendPlan(null).note, "This agent is no longer available");
  stop();
  bindTranslator(null);
});

test("catalogs split under the reply budget and join back exactly", () => {
  const text = JSON.stringify(kitZh).repeat(40);
  const parts = splitReply(text, 4096);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(""), text);
  for (const part of parts) assert.ok(Buffer.byteLength(JSON.stringify(part)) - 2 <= 4096);
});

interface FakeServer { context: PluginServerContext; call(name: string, input: unknown): Promise<any>; setLanguage(language: string): Promise<void> }

function fakeServer(initial = "auto"): FakeServer {
  const handlers = new Map<string, (input: unknown, context: unknown) => unknown>();
  let values = { language: initial };
  const listeners: ((state: unknown) => void)[] = [];
  const context = {
    registerSettings: () => ({
      read: async () => ({ status: "ready", revision: "r1", values }),
      subscribe: (listener: (state: unknown) => void) => { listeners.push(listener); return () => undefined; },
    }),
    handle: (contract: { name: string }, handler: (input: unknown, context: unknown) => unknown) => { handlers.set(contract.name, handler); },
  } as unknown as PluginServerContext;
  return {
    context,
    call: async (name, input) => handlers.get(name)!(input, {}),
    async setLanguage(language) {
      values = { language };
      for (const listener of listeners) listener({ status: "ready", revision: "r2", values });
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  };
}

async function readCatalog(server: FakeServer, device: string): Promise<{ language: string; hash: string; catalog: any }> {
  const first = await server.call("i18n.catalog", { device, part: 0 });
  let text = first.text;
  for (let part = 1; part < first.parts; part++) text += (await server.call("i18n.catalog", { device, hash: first.hash, part })).text;
  return { language: first.language, hash: first.hash, catalog: JSON.parse(text) };
}

test("the locale service serves the chosen language, the user's files and keeps the folder ready", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "kit-i18n-"));
  context.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const server = fakeServer();
  const service = createLocaleService(server.context, { pluginId: "demo", home, builtins: { "zh-CN": [zhPlugin, kitZh as Catalog], en: [enPlugin, kitEn as Catalog] } });
  await service.ready;
  const folder = join(home, "plugin-data", "demo", "locales");
  assert.equal(service.folder, folder);
  const template = JSON.parse(await readFile(join(folder, "templates", "en.json"), "utf8"));
  assert.equal(template.$meta.name, "English");
  assert.deepEqual(template.fold.steps, { one: "{count} step", other: "{count} steps" });
  assert.equal(template.kitUi.search, "Search");
  assert.equal(JSON.parse(await readFile(join(folder, "templates", "zh-CN.json"), "utf8")).fold.steps, "{count} 步");
  assert.match(await readFile(join(folder, "README.md"), "utf8"), /ko\.json/);

  const chinese = await readCatalog(server, "zh-Hans-US");
  assert.equal(chinese.language, "zh-CN");
  assert.equal(chinese.catalog.fold.steps, "{count} 步");
  assert.equal(chinese.catalog.kitUi.search, "搜索");
  assert.deepEqual(await server.call("i18n.catalog", { device: "zh-Hans-US", have: chinese.hash, part: 0 }), { status: "unchanged", language: "zh-CN", hash: chinese.hash });
  assert.equal((await readCatalog(server, "de-DE")).language, "en");

  // A Korean file: partly translated, one bad placeholder. Untranslated entries come from English.
  await writeFile(join(folder, "ko.json"), JSON.stringify({ $meta: { name: "한국어" }, boot: { title: "관측소" }, fold: { steps: "{count}단계", before: "{bogus}" } }));
  // Served catalogs mark English plural forms that a translation leaves out.
  await writeFile(join(folder, "ja.json"), JSON.stringify({ $meta: { name: "日本語" }, boot: { title: "観測台" } }));
  const japanese = await readCatalog(server, "ja-JP");
  assert.deepEqual(japanese.catalog.fold.steps, { one: "{count} step", other: "{count} steps", $language: "en" });
  const korean = await readCatalog(server, "ko-KR");
  assert.equal(korean.language, "ko");
  assert.equal(korean.catalog.boot.title, "관측소");
  assert.equal(korean.catalog.fold.before, "{count} earlier steps, {time}");
  assert.equal(korean.catalog.kitUi.search, "Search");
  const listing = await server.call("i18n.languages", { device: "ko-KR" });
  assert.equal(listing.resolved, "ko");
  assert.equal(listing.folder, folder);
  const ko = listing.languages.find((language: { code: string }) => language.code === "ko");
  assert.equal(ko.name, "한국어");
  assert.equal(ko.builtIn, false);
  assert.ok(ko.coverage > 0 && ko.coverage < 1);
  assert.deepEqual(ko.issues.find((issue: { code: string }) => issue.code === "badPlaceholder"), { code: "badPlaceholder", id: "fold.before", detail: "{bogus}" });
  assert.equal(listing.system, "ko");
  assert.equal(korean.catalog.fold.steps, "{count}단계");
  assert.deepEqual(listing.languages.filter((language: { builtIn: boolean }) => language.builtIn).map((language: { code: string; name: string }) => [language.code, language.name]), [["zh-CN", "简体中文"], ["en", "English"]]);

  // The setting wins over the device, and the server's own text follows it.
  await server.setLanguage("zh-CN");
  assert.equal((await readCatalog(server, "ko-KR")).language, "zh-CN");
  const chosen = await server.call("i18n.languages", { device: "ko-KR" });
  assert.deepEqual([chosen.resolved, chosen.system], ["zh-CN", "ko"]);
  assert.equal(service.language(), "zh-CN");
  assert.equal(t("kitUi.search"), "搜索");
  await server.setLanguage("en");
  assert.equal(service.language(), "en");
  assert.equal(t("kitUi.search"), "Search");
  const state = JSON.parse(await readFile(join(home, "plugin-data", "demo", "i18n-state.json"), "utf8"));
  assert.deepEqual(state, { device: "ko-KR", setting: "en" });

  // A link in the folder is never followed, a broken file is listed with its problem.
  await writeFile(join(home, "outside.json"), JSON.stringify({ boot: { title: "secret" } }));
  await symlink(join(home, "outside.json"), join(folder, "fr.json"));
  await writeFile(join(folder, "de.json"), "{ not json");
  const after = await server.call("i18n.languages", { device: "fr-FR" });
  const fr = after.languages.find((language: { code: string }) => language.code === "fr");
  assert.equal(fr.coverage, 0);
  assert.deepEqual(fr.issues, [{ code: "link" }]);
  assert.equal(after.languages.find((language: { code: string }) => language.code === "de").issues[0].code, "badJson");
  assert.equal((await readCatalog(server, "fr-FR")).language, "en");
  service.dispose();
  bindTranslator(null);
});

test("a large catalog travels in several parts", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "kit-i18n-"));
  context.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const many: Record<string, string> = {};
  for (let index = 0; index < 4000; index++) many[`m${index}`] = `第 ${index} 条消息，用来把目录撑到超过一个分片的大小：{count}`;
  const manyEn: Record<string, string> = {};
  for (let index = 0; index < 4000; index++) manyEn[`m${index}`] = `Message ${index}, long enough to need more than one part: {count}`;
  const server = fakeServer("zh-CN");
  const service = createLocaleService(server.context, { pluginId: "big", home, builtins: { "zh-CN": [{ big: many }, kitZh as Catalog], en: [{ big: manyEn }, kitEn as Catalog] } });
  await service.ready;
  const first = await server.call("i18n.catalog", { device: "", part: 0 });
  assert.ok(first.parts > 1);
  const whole = await readCatalog(server, "");
  assert.equal(whole.catalog.big.m3999, "第 3999 条消息，用来把目录撑到超过一个分片的大小：{count}");
  await assert.rejects(server.call("i18n.catalog", { device: "", hash: "0123456789abcdef", part: 1 }));
  service.dispose();
  bindTranslator(null);
});

test("a boot-only request gets the boot text alone, in the chosen language", async (context) => {
  const home = await mkdtemp(join(tmpdir(), "kit-i18n-"));
  context.after(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const server = fakeServer("zh-CN");
  const service = createLocaleService(server.context, { pluginId: "demo", home, builtins: { "zh-CN": [zhPlugin, kitZh as Catalog], en: [enPlugin, kitEn as Catalog] } });
  await service.ready;
  const full = await readCatalog(server, "en-US");
  const boot = await server.call("i18n.catalog", { device: "en-US", part: 0, scope: "boot" });
  assert.deepEqual([boot.status, boot.language, boot.part, boot.parts], ["ok", "zh-CN", 0, 1]);
  assert.notEqual(boot.hash, full.hash);
  const text = JSON.parse(boot.text);
  assert.deepEqual(Object.keys(text).sort(), ["boot", "kitLazy", "kitText"]);
  assert.deepEqual(text.boot, { title: "观测台" });
  assert.deepEqual(text.kitLazy, full.catalog.kitLazy);
  // A client that holds the current full catalog only hears that it is current.
  assert.deepEqual(await server.call("i18n.catalog", { device: "en-US", have: full.hash, part: 0, scope: "boot" }), { status: "unchanged", language: "zh-CN", hash: full.hash });
  await server.setLanguage("en");
  const english = await server.call("i18n.catalog", { device: "en-US", have: full.hash, part: 0, scope: "boot" });
  assert.deepEqual([english.status, english.language, JSON.parse(english.text).boot.title], ["ok", "en", "Observatory"]);
  service.dispose();
  bindTranslator(null);
});

test("a lazy client asks for boot text at start and for the catalog only when a view waits for it", async () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  const full = { language: "zh-CN", hash: "cccccccccccccccc", text: JSON.stringify({ boot: { title: "观测台" }, kitUi: { search: "搜索" } }) };
  const boot = { language: "zh-CN", hash: "dddddddddddddddd", text: JSON.stringify({ boot: { title: "观测台" } }) };
  const calls: { device: string; have?: string; part: number; scope?: string }[] = [];
  let snapshot: (() => void) | undefined, update: ((message: unknown) => void) | undefined;
  const client = {
    rpc: async (_contract: unknown, input: { device: string; have?: string; part: number; scope?: string }) => {
      calls.push(input);
      if (input.have === full.hash) return { status: "unchanged", language: full.language, hash: full.hash };
      const reply = input.scope === "boot" ? boot : full;
      return { status: "ok", language: reply.language, hash: reply.hash, part: 0, parts: 1, text: reply.text };
    },
    paseo: {
      observeEvents: () => ({
        subscribe: (observer: { snapshot(): void; update(message: unknown): void }) => { snapshot = observer.snapshot; update = observer.update; return () => undefined; },
        release: async () => undefined,
      }),
    },
  };
  const scopes = () => calls.map((call) => call.scope ?? "full");
  delete (globalThis as Record<string, unknown>).__paseoI18nCatalogsV1;
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (name: string) => store.get(name) ?? null,
    setItem: (name: string, value: string) => { store.set(name, value); },
    removeItem: (name: string) => { store.delete(name); },
  };
  const options = { pluginId: "lazy-plugin", boot: { en: { boot: { title: "Observatory (boot)" } } }, load: "lazy" as const };
  const i18n = createClientI18n(client as never, options);
  await settle();
  // Boot text in the chosen language (the device's own boot text is English); nothing else yet.
  assert.deepEqual(scopes(), ["boot"]);
  assert.equal(t("boot.title"), "观测台");
  assert.equal(t("kitUi.search"), "");
  assert.equal(i18n.isReady(), false);
  // The first snapshot comes with the start; a language change before any view opens fetches boot text again.
  snapshot?.();
  await settle();
  assert.deepEqual(scopes(), ["boot"]);
  update?.({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "x", settingsId: "language" } });
  await settle();
  assert.deepEqual(scopes(), ["boot", "boot"]);
  // A view opens and waits: now the full catalog, kept for the next start.
  await i18n.ready();
  assert.deepEqual(scopes(), ["boot", "boot", "full"]);
  assert.equal(t("kitUi.search"), "搜索");
  assert.match(store.get("paseo-i18n-v1:lazy-plugin") ?? "", /搜索/);
  // A later snapshot (a reconnect) only checks the full catalog.
  snapshot?.();
  await settle();
  assert.deepEqual(calls.at(-1), { device: calls[0]!.device, have: full.hash, part: 0 });
  i18n.dispose();

  // The next start speaks the kept catalog at once; the boot check hears "unchanged" and nothing more is fetched.
  delete (globalThis as Record<string, unknown>).__paseoI18nCatalogsV1;
  let before = calls.length;
  const again = createClientI18n(client as never, options);
  assert.equal(again.isReady(), true);
  assert.equal(t("kitUi.search"), "搜索");
  await settle();
  assert.deepEqual(calls.slice(before).map((call) => [call.scope ?? "full", call.have]), [["boot", full.hash]]);
  again.dispose();

  // The language changed on another device meanwhile: the kept catalog goes, boot text shows, the rest waits for a view.
  Object.assign(full, { language: "en", hash: "eeeeeeeeeeeeeeee", text: JSON.stringify({ boot: { title: "Observatory" }, kitUi: { search: "Search" } }) });
  Object.assign(boot, { language: "en", hash: "ffffffffffffffff", text: JSON.stringify({ boot: { title: "Observatory" } }) });
  delete (globalThis as Record<string, unknown>).__paseoI18nCatalogsV1;
  before = calls.length;
  const stale = createClientI18n(client as never, options);
  assert.equal(stale.isReady(), true);
  await settle();
  assert.equal(stale.isReady(), false);
  assert.equal(t("boot.title"), "Observatory");
  assert.equal(t("kitUi.search"), "");
  assert.equal(store.has("paseo-i18n-v1:lazy-plugin"), false);
  await stale.ready();
  assert.equal(t("kitUi.search"), "Search");
  assert.deepEqual(calls.slice(before).map((call) => call.scope ?? "full"), ["boot", "full"]);
  stale.dispose();
  delete (globalThis as Record<string, unknown>).localStorage;
  bindTranslator(null);
});

test("the client speaks boot text at once, swaps in the catalog, caches it and follows setting changes", async () => {
  const replies: { language: string; text: string; hash: string }[] = [
    { language: "en", hash: "aaaaaaaaaaaaaaaa", text: JSON.stringify({ boot: { title: "Observatory" }, kitUi: { search: "Search" } }) },
    { language: "zh-CN", hash: "bbbbbbbbbbbbbbbb", text: JSON.stringify({ boot: { title: "观测台" }, kitUi: { search: "搜索" } }) },
  ];
  let served = 0;
  const calls: unknown[] = [];
  let changed: ((message: unknown) => void) | undefined;
  const client = {
    rpc: async (_contract: unknown, input: { have?: string }) => {
      calls.push(input);
      const reply = replies[served]!;
      if (input.have === reply.hash) return { status: "unchanged", language: reply.language, hash: reply.hash };
      return { status: "ok", language: reply.language, hash: reply.hash, part: 0, parts: 1, text: reply.text };
    },
    paseo: {
      observeEvents: () => ({
        subscribe: (observer: { update(message: unknown): void }) => { changed = observer.update; return () => undefined; },
        release: async () => undefined,
      }),
    },
  };
  delete (globalThis as Record<string, unknown>).__paseoI18nCatalogsV1;
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = { getItem: (name: string) => store.get(name) ?? null, setItem: (name: string, value: string) => { store.set(name, value); } };
  const i18n = createClientI18n(client as never, { pluginId: "test-plugin", boot: { "zh-CN": { boot: { title: "观测台（启动）" } }, en: { boot: { title: "Observatory (boot)" } } } });
  assert.equal(i18n.isReady(), false);
  assert.match(t("boot.title"), /\((boot)\)|（启动）/);
  assert.equal(t("kitLazy.retry") === "Retry" || t("kitLazy.retry") === "重试", true);
  await i18n.ready();
  assert.equal(t("boot.title"), "Observatory");
  const titles: string[] = [];
  const stop = i18n.localized(() => { titles.push(t("boot.title")); return () => undefined; });
  served = 1;
  changed?.({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "x", settingsId: "language" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(t("boot.title"), "观测台");
  assert.deepEqual(titles, ["Observatory", "观测台"]);
  changed?.({ type: "status", payload: { status: "plugin_settings_changed", pluginId: "x", settingsId: "display" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 2);
  stop();
  i18n.dispose();

  // The catalog is also kept in localStorage (web, desktop): a reload starts in the chosen language.
  assert.match(store.get("paseo-i18n-v1:test-plugin") ?? "", /观测台/);
  // A reconnect (new stub) speaks the cached catalog at once and only checks it.
  const again = createClientI18n(client as never, { pluginId: "test-plugin", boot: { en: { boot: { title: "boot" } } } });
  assert.equal(again.isReady(), true);
  assert.equal(t("boot.title"), "观测台");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(calls.at(-1), { device: (calls.at(-1) as { device: string }).device, have: "bbbbbbbbbbbbbbbb", part: 0 });
  again.dispose();

  // A fresh app session (no memory cache) starts from localStorage; an id the kept catalog lacks reads as nothing.
  delete (globalThis as Record<string, unknown>).__paseoI18nCatalogsV1;
  const reloaded = createClientI18n({ ...client, rpc: () => new Promise(() => undefined) } as never, { pluginId: "test-plugin", boot: { en: { boot: { title: "boot" } } } });
  assert.equal(reloaded.isReady(), true);
  assert.equal(t("boot.title"), "观测台");
  assert.equal(t("boot.addedLater"), "");
  reloaded.dispose();
  delete (globalThis as Record<string, unknown>).localStorage;
  bindTranslator(null);
});

test("kit catalogs agree", async () => {
  const { auditCatalogs } = await import("../server/i18n-audit");
  assert.deepEqual(auditCatalogs({ zh: kitZh as Catalog, en: kitEn as Catalog }), []);
});
