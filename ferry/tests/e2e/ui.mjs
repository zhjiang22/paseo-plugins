#!/usr/bin/env node
// Live UI test of Ferry in the daemon-served web app, driven by a headless Chromium: the button by the composer and
// its partner menu, /ferry in the composer, the handoff row and its switch-back link, the Command Center picker and
// its preview (wide and dark, then phone-sized and light), a native move and the replayed conversation (with
// --native), the failure button without and with a partner, the settings screen, the language setting, and the
// plugin's console. It spends a few short turns.
//
//   node tests/e2e/ui.mjs --yes --from <provider/model> --to <provider[/model]> [--native <provider>]
//        [--dir /tmp/ferry-ui-e2e] [--shots /tmp/ferry-ui] [--keep] [--playwright <dir>] [--chrome <file>]
//
// --from must be a Claude Code provider (the failure step kills its session process by its --resume argument);
// --native another Claude Code provider on the same session store. The daemon needs its web app enabled. Ferry's
// settings and language are restored at the end.

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  LABEL_CHAIN,
  PLUGIN_ID,
  catalog,
  cleanUp,
  clip,
  code,
  connect,
  createReport,
  daemonInfo,
  finished,
  killSession,
  launchBrowser,
  movedFrom,
  parseArgs,
  patchSettings,
  readAgent,
  readSettings,
  requireYes,
  restoreSettings,
  sleep,
  waitFor,
} from "./common.mjs";

const args = parseArgs(process.argv.slice(2));
requireYes(args, "This test sends a few short messages to the providers you name (a little quota).");
const FROM = args.get("--from");
const TO = args.get("--to");
const NATIVE = args.get("--native", null);
if (!FROM || !TO) {
  console.error("Give --from <provider/model> and --to <provider[/model]>.");
  process.exit(1);
}
const DIR = args.get("--dir", "/tmp/ferry-ui-e2e");
const SHOTS = args.get("--shots", "/tmp/ferry-ui");
const fromProvider = FROM.split("/")[0];
const toProvider = TO.split("/")[0];

const report = createReport();
const { check } = report;
const words = await catalog();
/** The text of a message before its first parameter: enough to find it on screen whatever the numbers. */
const lead = (id) => words(id, new Proxy({}, { get: () => "\u0000" })).split("\u0000")[0].trim();
const { base, serverId } = await daemonInfo();
const link = await connect();
const { client, api } = link;
const labels = Object.fromEntries((await api.providers.snapshot()).entries.map((entry) => [entry.provider, entry.label ?? entry.provider]));
const CODE = code("FERRY-UI");
await mkdir(DIR, { recursive: true });
await mkdir(SHOTS, { recursive: true });

const made = { agents: [], workspaceIds: [], dir: DIR, chains: [] };
const before = await readSettings(client);
const savedSettings = before.status === "ready" ? before.values : null;
const savedLanguage = await client.invokePluginRpc(PLUGIN_ID, "settings.language.read", {}).catch(() => null);
const browser = await launchBrowser(args);

try {
  // 1. A conversation to move.
  const source = await api.agents.create({
    config: { provider: FROM },
    cwd: DIR,
    title: `Ferry UI test ${CODE}`,
    prompt: `This is a UI test of Ferry. Remember the code word ${CODE}. Do not call any tools; reply with one word: OK.`,
  });
  made.agents.push(source.id);
  const first = await finished(api, source.id);
  check(`the test agent replies on ${fromProvider}`, first.status === "idle", `${first.status} · ${clip(first.reply)}${first.error ? ` · ${first.error}` : ""}`);
  const sourceAgent = await readAgent(api, source.id);
  made.workspaceIds.push(sourceAgent.workspaceId);

  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, colorScheme: "dark" });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /ferry|plugin/i.test(message.text())) consoleErrors.push(clip(message.text(), 200));
  });
  page.on("pageerror", (error) => consoleErrors.push(clip(String(error), 200)));
  const openAgent = async (agentId) => {
    await page.goto(`${base}/`, { waitUntil: "domcontentloaded" });
    await page.getByTestId(`sidebar-workspace-row-${serverId}:${sourceAgent.workspaceId}`).click({ timeout: 60_000 });
    await page.waitForTimeout(2000);
    const tab = page.getByTestId(`workspace-tab-agent_${agentId}`);
    if (await tab.count()) await tab.click();
    await page.waitForTimeout(1500);
  };
  const composer = () => page.locator('textarea[placeholder^="Message the agent"]').first();
  const visible = async (text, timeout = 30_000, on = page) => {
    await on.getByText(text, { exact: false }).first().waitFor({ timeout }).catch(() => {});
    return (await on.getByText(text, { exact: false }).count()) > 0;
  };
  const envelopeShown = async () => (await page.getByText("<ferry-handoff", { exact: false }).count()) > 0;
  const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

  // 2. The button by the composer: with a partner a menu (the partner, or the picker); /ferry in the composer.
  await patchSettings(client, { partners: [{ from: fromProvider, to: TO }] });
  await openAgent(source.id);
  const button = page.getByText(words("boot.pillIdle"), { exact: true });
  await button.last().waitFor({ timeout: 30_000 }).catch(() => {});
  check("every composer has Ferry's button", (await button.count()) > 0);
  if (await button.count()) {
    await button.last().click();
    await page.waitForTimeout(800);
    const partnerItem = await visible(words("boot.pillMenuTo", { target: toProvider }), 5000);
    check("its menu offers the partner and the picker", partnerItem && (await visible(words("boot.pillMenuPick"), 2000)));
    await page.screenshot({ path: join(SHOTS, "0-composer-button.png") });
    await page.keyboard.press("Escape");
  }
  // Without a partner again: the failure step below expects the picker.
  await patchSettings(client, { partners: [] });
  await openAgent(source.id);
  await composer().click();
  await composer().fill("/fer");
  await page.waitForTimeout(1200);
  check("typing /fer offers /ferry", await visible(words("boot.slashDescription"), 5000));
  await shot("1-slash");
  await page.keyboard.press("Escape");
  await composer().fill("");
  const question = "What is the code word? Do not call any tools; reply with the code word only.";
  await composer().fill(`/ferry ${TO} ${question}`);
  await page.waitForTimeout(800);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  if ((await composer().inputValue().catch(() => "")).trim()) await page.keyboard.press("Enter");
  const handedTo = await waitFor(() => movedFrom(api, source.id), (list) => list.some((agent) => agent.provider === toProvider), 90_000);
  const moved = handedTo.find((agent) => agent.provider === toProvider) ?? null;
  check(`/ferry ${TO} hands the conversation over`, !!moved, moved ? `${moved.id} on ${moved.provider}` : "no new agent");
  if (!moved) throw new Error("nothing was handed over; the remaining steps need it");
  made.agents.push(moved.id);
  made.chains.push(moved.labels?.[LABEL_CHAIN]);
  // With warnings the result stays on screen instead of opening the new agent.
  if (await page.getByTestId("ferry-open").count()) await page.getByTestId("ferry-open").click();
  const answer = await finished(api, moved.id);
  check(`the ${toProvider} agent knows the code word`, answer.reply.includes(CODE), clip(answer.reply));
  check("the source agent is archived", !!(await readAgent(api, source.id))?.archivedAt);
  check("the new agent opens, with the handoff row", await visible(words("rows.handoff", { from: labels[fromProvider], to: labels[toProvider] })), page.url());
  check("the message bubble shows only the typed words", (await visible(question, 5000)) && !(await envelopeShown()));
  await shot("2-handoff-row");

  // 3. The row's switch-back link.
  await page.getByTestId("ferry-row-switch-back").first().click();
  const back = await waitFor(
    async () => ({ source: await readAgent(api, source.id), moved: await readAgent(api, moved.id) }),
    (state) => state.source && !state.source.archivedAt && state.moved?.archivedAt,
    90_000,
  );
  check("Switch back returns to the first agent and archives the other", back.source && !back.source.archivedAt && back.moved?.archivedAt, `${back.source?.archivedAt ?? "open"} / ${back.moved?.archivedAt ?? "open"}`);
  await finished(api, source.id);
  check("the first agent shows the row for its return", await visible(`${lead("rows.back")} ${labels[toProvider]}`), page.url());
  await shot("3-switched-back");

  // 4. The Command Center opens the picker; the preview shows what would be sent.
  await openAgent(source.id);
  await composer().click();
  await page.keyboard.press("Control+K");
  await page.waitForTimeout(800);
  await page.keyboard.type("Ferry");
  await page.waitForTimeout(800);
  const item = page.getByText(words("boot.commandTitle"), { exact: false });
  check("the Command Center offers Ferry", (await item.count()) > 0);
  if (await item.count()) await item.first().click();
  check("the picker offers the earlier agent to go back to", await visible(words("picker.groupBack")));
  if (NATIVE) check("the picker offers to continue the same session", await visible(words("picker.groupNative"), 5000));
  await page.getByTestId(`ferry-provider-${toProvider}`).click();
  check("choosing it explains the switch-back", await visible(lead("picker.explainBack")));
  await page.getByTestId("ferry-preview-toggle").click();
  const preview = page.getByTestId("ferry-preview");
  await preview.waitFor({ timeout: 30_000 }).catch(() => {});
  check("the preview shows the history that would be sent", (await preview.innerText().catch(() => "")).includes("<ferry-handoff"));
  const pickerUrl = page.url();
  await shot("4-picker-dark");

  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "light", isMobile: true, hasTouch: true });
  const phonePage = await phone.newPage();
  await phonePage.goto(`${base}/`, { waitUntil: "domcontentloaded" });
  await phonePage.waitForTimeout(6000);
  await phonePage.goto(pickerUrl, { waitUntil: "domcontentloaded" });
  check("the picker works at phone width", await visible(words("picker.groupBack"), 30_000, phonePage), pickerUrl);
  await phonePage.screenshot({ path: join(SHOTS, "5-picker-phone-light.png") });
  await phone.close();

  // 5. Native: the same session on another provider; the handoff it received earlier is replayed, folded.
  let current = { id: source.id, provider: fromProvider, sessionId: back.source?.persistence?.sessionId ?? null };
  if (NATIVE) {
    await page.getByTestId(`ferry-provider-${NATIVE}`).click();
    await page.waitForTimeout(2000);
    await page.getByTestId("ferry-start").click();
    const natives = await waitFor(() => movedFrom(api, source.id), (list) => list.some((agent) => agent.provider === NATIVE && !agent.archivedAt), 90_000);
    const imported = natives.find((agent) => agent.provider === NATIVE && !agent.archivedAt) ?? null;
    check(`the conversation continues natively on ${NATIVE}`, !!imported && imported.persistence?.sessionId === current.sessionId, imported ? `${imported.id} · same session: ${imported.persistence?.sessionId === current.sessionId}` : "no agent");
    if (imported) {
      made.agents.push(imported.id);
      current = { id: imported.id, provider: NATIVE, sessionId: imported.persistence?.sessionId ?? null };
      await openAgent(imported.id);
      // The provider replays the switch-back's history joined to its message (Paseo's own fork summary fares the same).
      // It stays a user message, so the turns keep their shape: the first reply is still its own turn's answer.
      check("the replayed conversation keeps its turns", (await page.getByText(first.reply.trim(), { exact: true }).count()) > 0, clip(first.reply, 40));
      await shot("6-native-replay");
    }
  }

  // 6. The failure button: a killed provider process, first without a partner (opens the picker), then with one.
  if (current.sessionId) {
    await api.agents.ref(current.id).send("Count from 1 to 400, one number per line. Do not call any tools.");
    await waitFor(() => readAgent(api, current.id), (agent) => agent?.status === "running", 60_000);
    await sleep(2000);
    const killed = killSession(current.sessionId);
    const failed = await waitFor(() => readAgent(api, current.id), (agent) => agent?.status === "error", 60_000);
    check("a killed provider process leaves the agent failed", failed?.status === "error", `${killed.length} processes · ${clip(failed?.lastError, 120)}`);
    await openAgent(current.id);
    const pickText = words("boot.pillPick", { reason: "\u0000" }).split("\u0000")[1].trim();
    check("the failed agent gets a button", await visible(pickText));
    await shot("7-failure-button");
    if (await page.getByText(pickText, { exact: false }).count()) {
      await page.getByText(pickText, { exact: false }).first().click();
      await page.getByTestId("ferry-screen").waitFor({ timeout: 30_000 }).catch(() => {});
      check("without a partner the button opens the picker", (await page.getByTestId("ferry-screen").count()) > 0, page.url());
    }
    await patchSettings(client, { partners: [{ from: current.provider, to: toProvider }] });
    await openAgent(current.id);
    const partnerText = `→ ${toProvider}`;
    check(`with a partner, the button names ${toProvider}`, await visible(partnerText));
    if (await page.getByText(partnerText, { exact: false }).count()) {
      await page.getByText(partnerText, { exact: false }).first().click();
      const after = await waitFor(
        async () => ({ moved: await readAgent(api, moved.id), left: await readAgent(api, current.id) }),
        (state) => state.moved && !state.moved.archivedAt && state.left?.archivedAt,
        90_000,
      );
      check(`one press continues on ${toProvider}, where the earlier agent comes back`, after.moved && !after.moved.archivedAt && after.left?.archivedAt, `${after.moved?.archivedAt ?? "open"} / ${after.left?.archivedAt ?? "open"}`);
      await finished(api, moved.id);
      await page.waitForTimeout(2000);
      await shot("8-after-button");
    }
  } else check("the agent has a session to fail", false, "no session id");

  // 7. The settings screen shows the partner just set.
  await page.goto(`${base}/settings/hosts/${serverId}/plugins/${PLUGIN_ID}/settings`, { waitUntil: "domcontentloaded" });
  check("the settings screen opens", await visible(words("settings.partnersTitle")));
  const partnerRow = page.getByTestId("ferry-partner-0");
  await partnerRow.waitFor({ timeout: 10_000 }).catch(() => {});
  check("it lists the partner", (await partnerRow.innerText().catch(() => "")).includes(labels[toProvider] ?? toProvider), clip(await partnerRow.innerText().catch(() => "missing")));
  await shot("9-settings");

  // 8. The language setting changes the plugin's words.
  if (savedLanguage?.status === "ready") {
    const zh = JSON.parse(await readFile(new URL("../../shared/locales/zh-CN.json", import.meta.url), "utf8"));
    await client.invokePluginRpc(PLUGIN_ID, "settings.language.write", { revision: savedLanguage.revision, values: { ...savedLanguage.values, language: "zh-CN" } });
    await page.goto(pickerUrl, { waitUntil: "domcontentloaded" });
    // "现在在 {label} 上": the picker's header, whatever providers this host has.
    check("with the language set to Chinese the picker speaks Chinese", await visible(zh.picker.currentOn.split("{")[0].trim()));
    await shot("10-picker-zh");
  }
  check("no plugin errors in the console", consoleErrors.length === 0, consoleErrors.join(" | "));
  await context.close();
} catch (error) {
  check("the test ran to the end", false, error instanceof Error ? error.message : String(error));
} finally {
  await browser.close().catch(() => {});
  if (savedSettings) await restoreSettings(client, savedSettings).catch(() => {});
  if (savedLanguage?.status === "ready") {
    const now = await client.invokePluginRpc(PLUGIN_ID, "settings.language.read", {}).catch(() => null);
    if (now?.status === "ready") await client.invokePluginRpc(PLUGIN_ID, "settings.language.write", { revision: now.revision, values: savedLanguage.values }).catch(() => {});
  }
  if (!args.flags.has("--keep")) await cleanUp(link, made);
  await client.close().catch(() => {});
}

process.exit(report.finish(` · screenshots in ${SHOTS}`));
