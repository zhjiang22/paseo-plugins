import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page, type TestInfo } from "@playwright/test";

type Fixture = typeof globalThis & {
  __previewOpenedAgent?: string; __previewClipboard?: string; __previewAgentOperations: Array<{ type: string; agentId?: string; workspaceId?: string; input?: unknown }>;
  __previewRpcCalls: Array<{ name: string; input: { agentId?: string; attentionTimestamp?: string } }>; __previewTimelineCalls: unknown[];
  __previewTimelineActive(id: string): number; __previewGetAgent(id: string): { attentionTimestamp: string; pendingPermissions: unknown[] };
  __previewCompleteAgent(id: string): { attentionTimestamp: string; previewReply: { text: string } }; __previewNativeReadAgent(id: string): boolean;
  __previewUpdateAgent(id: string, changes: object): void; __previewSetResume(entry: { agentId: string; status: string; reason: string | null }): void;
  __previewRestoreAudit?: { before: { agentId: string; agentCount: number; userMessages: number }; after: { agentId: string; agentCount: number; userMessages: number } };
};
const ranges = /^(24 小时|最近 7 天|最近 30 天|全部时间)$/;
const projects = /^(全部项目|Commerce Platform|Delivery Systems|Mobile Experience|Growth Studio)$/;

function query(testInfo: TestInfo, scenario = "all") {
  return `/?theme=${testInfo.project.name === "desktop-light" ? "light" : "dark"}&scenario=${scenario === "archives" ? "all&archives=1" : scenario}`;
}
const compact = (page: Page) => page.viewportSize()!.width < 760;
async function open(page: Page, testInfo: TestInfo, scenario = "all") {
  await page.goto(query(testInfo, scenario));
  // The host owns the surface title; the plugin's own toolbar is the readiness signal.
  await expect(page.getByRole("button", { name: "更多操作", exact: true }).first()).toBeVisible();
}
async function menu(page: Page, action: string) {
  await page.getByRole("button", { name: "更多操作", exact: true }).first().click();
  await page.getByRole("dialog", { name: "更多操作", exact: true }).getByRole("button", { name: action, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "更多操作", exact: true })).toHaveCount(0);
}
async function detailMenu(page: Page, action: string) {
  await page.getByTestId("agent-detail").getByRole("button", { name: "更多操作", exact: true }).click();
  await page.getByRole("dialog", { name: "更多操作", exact: true }).getByRole("button", { name: action, exact: true }).click();
}
async function openFilters(page: Page) {
  const dialog = page.getByRole("dialog", { name: "筛选", exact: true });
  if (await dialog.count() === 0) await page.getByRole("button", { name: /^筛选( \d+)?$/ }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "全部状态", exact: true })).toBeVisible();
  return dialog;
}
async function closeFilters(page: Page) {
  const dialog = page.getByRole("dialog", { name: "筛选", exact: true });
  if (await dialog.count()) await dialog.getByRole("button", { name: "完成", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
async function selectProject(page: Page, project: string) {
  await page.getByRole("button", { name: projects }).first().click();
  await page.getByRole("dialog", { name: "项目", exact: true }).getByRole("button", { name: project, exact: true }).click();
  await expect(page.getByRole("dialog", { name: "项目", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: project, exact: true }).first()).toBeVisible();
}
async function selectRange(page: Page, range: string) {
  await page.getByRole("button", { name: ranges }).first().click();
  await page.getByRole("dialog", { name: "时间范围", exact: true }).getByRole("button", { name: range, exact: true }).click();
  await expect(page.getByRole("button", { name: range, exact: true })).toBeVisible();
}
async function search(page: Page, text: string) {
  const box = page.getByRole("textbox", { name: "搜索会话", exact: true });
  if (await box.count() === 0) await page.getByRole("button", { name: "搜索", exact: true }).click();
  await box.fill(text);
}
async function markRead(page: Page) {
  const detail = page.getByTestId("agent-detail");
  const direct = detail.getByRole("button", { name: "标记已读", exact: true });
  if (await direct.count()) await direct.click(); else await detailMenu(page, "标记已读");
}
async function snooze(page: Page) {
  if (compact(page)) await detailMenu(page, "稍后处理"); else await page.getByTestId("agent-detail").getByRole("button", { name: "稍后处理", exact: true }).click();
}
const toast = (page: Page, text: string) => page.getByRole("status").getByText(text, { exact: true });
/** 智能分析 opens on 总览 (2.7); reports and 新建分析 are one tab away. */
async function reportsView(page: Page) { await page.getByRole("tablist", { name: "智能分析视图", exact: true }).getByRole("tab", { name: /^报告/ }).click(); }
const rpcCalls = (page: Page, name: string) => page.evaluate(target => (globalThis as Fixture).__previewRpcCalls.filter(call => call.name === target).map(call => call.input as Record<string, unknown>), name);
async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await mkdir(resolve("docs/screenshots"), { recursive: true });
  await page.screenshot({ path: resolve(`docs/screenshots/fixture-${testInfo.project.name}-${name}.png`), fullPage: true });
}
async function noHorizontalOverflow(page: Page) {
  const dimensions = await page.locator("html").evaluate((root) => ({ width: root.clientWidth, contentWidth: root.scrollWidth }));
  expect(dimensions.contentWidth).toBeLessThanOrEqual(dimensions.width + 1);
}
async function closeDetail(page: Page) {
  await page.getByRole("button", { name: /^(返回列表|关闭详情)$/ }).click();
  await expect(page.getByTestId("agent-detail")).toHaveCount(0);
}
async function touchScrollUp(page: Page) {
  const viewport = page.viewportSize();
  if (!viewport || viewport.width >= 700) return;
  const session = await page.context().newCDPSession(page);
  const x = Math.round(viewport.width / 2);
  const startY = Math.round(viewport.height * 0.8);
  const endY = Math.round(viewport.height * 0.3);
  try {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: startY }] });
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: Math.round(startY + (endY - startY) * step / 8) }] });
    }
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally { await session.detach(); }
}
/** 明细 → 观测: the observation charts (heatmap, daily results, usage) that used to be the 数据 tab. */
async function openObserved(page: Page) {
  await page.getByRole("tab", { name: /^明细/ }).click();
  await page.getByRole("tablist", { name: "明细维度" }).getByRole("tab", { name: "观测", exact: true }).click();
}
const statsCalls = (page: Page) => page.evaluate(() => (globalThis as Fixture).__previewRpcCalls.filter(call => call.name === "observatory.stats.get").map(call => call.input as { range?: string; utcOffsetMinutes?: number; revision?: string }));
const marks = (page: Page) => page.evaluate(() => (globalThis as Fixture).__previewRpcCalls.filter(call => call.name === "observatory.read-state.mark"));

test("overview quick scopes, status filtering, search, and fixture screenshot", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await open(page, testInfo);
  // A child Agent's unread result (验证重复请求) no longer counts: its parent has it (2.13, opus-F15).
  await expect(page.getByRole("button", { name: "需要处理 3", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "执行中 3", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "未读 2", exact: true })).toBeVisible();
  // The first session is on screen right under the toolbar and chips.
  const first = await page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true }).boundingBox();
  expect(first!.y).toBeLessThan(40 + 160);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "overview");
  await page.getByRole("button", { name: "需要处理 3", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 规划下一轮迭代，待回复", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "执行中 3", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "执行中 3", exact: true }).click();
  const filters = await openFilters(page);
  await filters.getByRole("button", { name: "待审批", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /^事件/ }).click();
  await expect(page.getByRole("button", { name: "查看 审查数据库迁移，等待审批或回答", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /^会话/ }).click();
  await page.getByRole("button", { name: "移除 待审批", exact: true }).click();
  await search(page, "整理性能基线");
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  await search(page, "no-such-agent-fixture");
  await expect(page.getByText("没有匹配的会话", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除筛选", exact: true }).click();
  await expect(page.getByRole("button", { name: /^查看 审查数据库迁移，/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("nested execution tree expands and collapses", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await touchScrollUp(page);
  await page.getByRole("button", { name: "展开 重构支付服务 的子 agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 实现幂等请求，执行中", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "展开 实现幂等请求 的子 agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 验证重复请求，已完成", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "tree");
  await page.getByRole("button", { name: "收起 重构支付服务 的子 agent", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 验证重复请求，已完成", exact: true })).toHaveCount(0);
});

test("后台执行中: a finished session whose subagent still works is 执行中 with a 后台 mark, not an unread result", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "background");
  await expect(page.getByRole("button", { name: "执行中 4", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "未读 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "需要处理 2", exact: true })).toBeVisible();
  const row = page.getByRole("button", { name: "查看 整理性能基线，执行中", exact: true });
  await expect(row.getByText("后台 · 整理压测脚本", { exact: true })).toBeVisible();
  await expect(row.getByText(/^后台 \d+:\d{2}$/)).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "background-running");
  await page.getByRole("button", { name: "执行中 4", exact: true }).click();
  await expect(row).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 准备移动端测试，启动中", exact: true })).toBeVisible();
  await row.click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail.getByText("这一轮已结束，后台还有 1 个子任务在执行：整理压测脚本", { exact: true })).toBeVisible();
  await expect(detail.getByText(/^后台子任务已运行 \d+:\d{2}$/)).toBeVisible();
  await screenshot(page, testInfo, "background-detail");
  await detail.getByRole("button", { name: "查看子任务", exact: true }).click();
  await expect(detail.getByText("没有子任务", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("inspector timeline, tool details, history, diagnostics, and back", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByText("幂等校验已经接入，18 项接口测试通过。正在等待子任务返回并发写入验证结果。", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "inspector");
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await detail.getByRole("tab", { name: "工具", exact: true }).click();
  await detail.getByRole("button", { name: "展开exec_command", exact: true }).first().click();
  await expect(detail.getByText("PASS payments/idempotency.test.ts", { exact: false })).toBeVisible();
  await detail.getByRole("tab", { name: "全部", exact: true }).click();
  await detail.getByRole("button", { name: "读取更早的记录", exact: true }).click();
  await expect(detail.getByText("历史上下文：已完成需求拆解，接下来验证支付服务的幂等性。", { exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "诊断", exact: true }).click();
  await expect(detail.getByText("执行上下文", { exact: true })).toBeVisible();
  await expect(detail.getByText("payment-root", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await closeDetail(page);
  expect(errors).toEqual([]);
});

test("查找 in the timeline counts hits among the loaded rows, steps through them and opens a collapsed tool", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await detail.getByRole("button", { name: "查找", exact: true }).click();
  const box = detail.getByRole("textbox", { name: "在时间线里查找", exact: true });
  await box.fill("幂等");
  // Only the loaded rows are searched, and the bar says how many (codex-B1).
  await expect(detail.getByLabel(/^第 1 处，共 \d+ 处$/)).toBeVisible();
  await expect(detail.getByText(/^已加载 \d+ 条/).first()).toBeVisible();
  await detail.getByRole("button", { name: "下一处", exact: true }).click();
  await expect(detail.getByLabel(/^第 2 处，共 \d+ 处$/)).toBeVisible();
  await detail.getByRole("button", { name: "上一处", exact: true }).click();
  await expect(detail.getByLabel(/^第 1 处，共 \d+ 处$/)).toBeVisible();
  // Case does not matter, every word must appear, and a hit inside a collapsed tool output opens that row.
  await box.fill("pass PAYMENTS");
  await expect(detail.getByLabel(/^第 1 处，共 \d+ 处$/)).toBeVisible();
  await expect(detail.getByText("PASS payments/idempotency.test.ts", { exact: false }).first()).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "timeline-find");
  await box.fill("没有这个词");
  await expect(detail.getByLabel("没有找到", { exact: true })).toBeVisible();
  await expect(detail.getByText(/^已加载的 \d+ 条里没有找到/).first()).toBeVisible();
  await detail.getByRole("button", { name: "关闭查找", exact: true }).click();
  await expect(box).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("查找's 下一处 inside one long tool output scrolls to that hit itself, 211 lines further down (codex-obs-send-ui-F2)", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await detail.getByRole("button", { name: "查找", exact: true }).click();
  await detail.getByRole("textbox", { name: "在时间线里查找", exact: true }).fill("ECONNRESET");
  // Both hits are in the verbose rerun's output, which the first one opens.
  await expect(detail.getByLabel("第 1 处，共 2 处", { exact: true })).toBeVisible();
  const current = detail.getByTestId("find-current");
  await expect(current).toHaveText("ECONNRESET");
  await expect(current).toBeInViewport();
  await detail.getByRole("button", { name: "下一处", exact: true }).click();
  await expect(detail.getByLabel("第 2 处，共 2 处", { exact: true })).toBeVisible();
  // The same row, 211 lines down: the list scrolls to the hit's line, not just to the row.
  await expect(current.locator("xpath=..")).toContainText("(retry 3/3), giving up");
  await expect(current).toBeInViewport();
  const box = (await current.boundingBox())!, viewport = page.viewportSize()!;
  expect(box.y).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  // 上一处 goes back up to the first one, inside the same output.
  await detail.getByRole("button", { name: "上一处", exact: true }).click();
  await expect(detail.getByLabel("第 1 处，共 2 处", { exact: true })).toBeVisible();
  await expect(current.locator("xpath=..")).toContainText("(retry 1/3)");
  await expect(current).toBeInViewport();
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test("real worktree labels and branch search stay distinct from main-workspace metadata", async ({ page }, testInfo) => {
  await open(page, testInfo);
  const payment = page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true });
  const main = page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true });
  await expect(payment.getByText(/^Commerce Platform · feature\/payments-v2 · /)).toBeVisible();
  await expect(main.getByText(/^Delivery Systems · main · /)).toBeVisible();
  await expect(main.getByText(/payments-v2/)).toHaveCount(0);
  await search(page, "feature/payments-v2");
  await expect(payment).toBeVisible();
  await expect(main).toHaveCount(0);
  await payment.click();
  let detail = page.getByTestId("agent-detail");
  // Phones keep project · branch in the header; the worktree name stays in diagnostics.
  await expect(detail.getByLabel("Worktree payments-v2", { exact: true })).toHaveCount(compact(page) ? 0 : 1);
  await expect(detail.getByLabel("分支 feature/payments-v2", { exact: true })).toBeVisible();
  await expect(detail.getByLabel("项目 Commerce Platform", { exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "诊断", exact: true }).click();
  await expect(detail.getByText("Worktree 名称", { exact: true })).toBeVisible();
  await expect(detail.getByText("payments-v2", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("/workspace/worktrees/commerce-platform/payments-v2", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("feature/payments-v2", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("Checkout v2", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "worktree-inspector");
  await closeDetail(page);
  await search(page, "");
  await main.click();
  detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "诊断", exact: true }).click();
  await expect(detail.getByText("主工作区", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("Worktree 名称", { exact: true })).toHaveCount(0);
  await expect(detail.getByLabel(/^Worktree /)).toHaveCount(0);
  await closeDetail(page);
});

test("filter sheet selects worktree and status without leaking other checkouts", async ({ page }, testInfo) => {
  await open(page, testInfo);
  let filters = await openFilters(page);
  await filters.getByRole("button", { name: "payments-v2", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "筛选 1", exact: true })).toBeVisible();
  filters = await openFilters(page);
  await filters.getByRole("button", { name: "主工作区", exact: true }).click();
  await filters.getByRole("button", { name: "异常", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看 规划下一轮迭代，待回复", exact: true })).toHaveCount(0);
  filters = await openFilters(page);
  await filters.getByRole("button", { name: "全部状态", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "查看 规划下一轮迭代，待回复", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("managed and native nested subagents have inspectable timelines", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "子任务", exact: true }).click();
  await expect(detail.getByRole("button", { name: "查看子 Agent 实现幂等请求", exact: true })).toBeVisible();
  await expect(detail.getByRole("button", { name: "查看原生子任务 检查并发重试边界", exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "折叠 1 个子任务", exact: true }).click();
  await expect(detail.getByRole("button", { name: "查看原生子任务 检查并发重试边界", exact: true })).toHaveCount(0);
  await detail.getByRole("button", { name: "展开 1 个子任务", exact: true }).click();
  await detail.getByRole("button", { name: "查看原生子任务 检查并发重试边界", exact: true }).click();
  await expect(detail.getByText("子任务验证已通过：重复请求只产生一条订单记录。", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "subagent");
  await detail.getByRole("button", { name: "返回子任务树", exact: true }).click();
  await detail.getByRole("button", { name: "查看子 Agent 实现幂等请求", exact: true }).click();
  await expect(page.getByTestId("agent-detail").getByText("实现幂等请求", { exact: true })).toBeVisible();
  await closeDetail(page);
});

test("waiting and error agents retain actionable diagnostic context", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true }).click();
  let detail = page.getByTestId("agent-detail");
  await expect(detail.getByRole("button", { name: "处理审批", exact: true })).toBeVisible();
  await expect(detail.getByText("等待你批准 2 项请求", { exact: true })).toBeVisible();
  await expect(detail.getByText("执行数据库迁移检查", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await closeDetail(page);
  await page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true }).click();
  detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await detail.getByRole("tab", { name: "异常", exact: true }).click();
  await expect(detail.getByText("集成测试未通过：数据库连接超时。", { exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "诊断", exact: true }).click();
  await expect(detail.getByText("测试数据库连接超时。已保留失败上下文，可在时间线查看。", { exact: true })).toBeVisible();
  await closeDetail(page);
});

test("activity, empty, disconnected, loading, stale and retained error states", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^事件/ }).click();
  await expect(page.getByText(/^近 60 分钟 \d+ 次$/)).toBeVisible();
  await noHorizontalOverflow(page);
  await open(page, testInfo, "empty");
  await expect(page.getByText("还没有会话", { exact: true })).toBeVisible();
  await open(page, testInfo, "error");
  await expect(page.getByText("暂时无法读取会话", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试", exact: true })).toBeVisible();
  // Counts are hidden until a snapshot exists instead of claiming zero.
  await expect(page.getByRole("button", { name: "需要处理", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await open(page, testInfo, "loading");
  await expect(page.getByRole("progressbar", { name: "加载中" })).toBeVisible();
  await expect(page.getByLabel("连接中", { exact: true }).first()).toBeVisible();
  await open(page, testInfo, "stale");
  await expect(page.getByLabel("等待同步", { exact: true }).first()).toBeVisible();
  await menu(page, "刷新");
  await expect(page.getByLabel("已同步", { exact: true }).first()).toBeVisible();
  await open(page, testInfo, "retained-error");
  await expect(page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true })).toBeVisible();
  await expect(page.getByText("同步失败：模拟连接中断，请稍后重试。显示的是上次结果。", { exact: true })).toBeVisible();
  await expect(page.getByLabel("同步失败", { exact: true }).first()).toBeVisible();
});

const heatCell = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2}，/;
const dailyBar = /^\d{4}-\d{2}-\d{2}，完成 \d+，失败 \d+，取消 \d+/;
test("analytics heatmap, daily results and project usage remain interactive on narrow screens", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  let filters = await openFilters(page);
  await filters.getByRole("button", { name: "历史会话", exact: true }).click();
  await closeFilters(page);
  await selectRange(page, "24 小时");
  await selectProject(page, "Delivery Systems");
  filters = await openFilters(page);
  await filters.getByRole("button", { name: "claude", exact: true }).click();
  await filters.getByRole("button", { name: "Release checks", exact: true }).click();
  await closeFilters(page);
  await search(page, "not-the-ranked-project");
  await openObserved(page);
  // Session scopes do not leak into analytics, which has its own project and period controls.
  await expect(page.getByRole("button", { name: /^需要处理/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "24 小时", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^筛选/ })).toHaveCount(0);
  await expect(page.getByText("活跃时段", { exact: true })).toBeVisible();
  // Cells are local days and hours of the browser's zone (the fixture sends its offset), not UTC.
  await expect(page.getByRole("button", { name: heatCell })).toHaveCount(168);
  await expect(page.getByRole("button", { name: /，执行事件 [1-9][0-9]*$/ }).first()).toBeVisible();
  await page.getByRole("button", { name: /^\d{4}-\d{2}-\d{2} 00:\d{2}–01:\d{2}，执行事件/ }).first().click();
  await expect(page.getByText(/^\d{4}-\d{2}-\d{2} · 00:\d{2}–01:\d{2}$/)).toBeVisible();
  // The fixture's coverage gap starts at 03:00 UTC two days ago: find that hour on the browser's clock.
  const gapCell = await page.evaluate(() => {
    const offset = -new Date().getTimezoneOffset() * 60_000, at = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 2 * 86_400_000 + 3 * 3_600_000 + offset);
    const pad = (value: number) => String(value).padStart(2, "0"), minute = pad(at.getUTCMinutes());
    return `${at.toISOString().slice(0, 10)} ${pad(at.getUTCHours())}:${minute}–${pad((at.getUTCHours() + 1) % 24)}:${minute}，执行事件 无观测数据`;
  });
  await page.getByRole("button", { name: gapCell, exact: true }).click();
  await expect(page.getByText("这个时间段没有在线采集覆盖，不能视为没有执行。", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "输出快照", exact: true }).click();
  await expect(page.getByText("颜色表示提供方报告的输出 tokens 快照峰值，非该小时累计消耗。", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "analytics");
  await page.getByRole("button", { name: dailyBar }).first().click();
  await expect(page.getByText("每日结果", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "7 天", exact: true }).click();
  await expect(page.getByRole("button", { name: dailyBar })).toHaveCount(7);
  await page.getByRole("tab", { name: "28 天", exact: true }).click();
  await expect(page.getByRole("button", { name: dailyBar })).toHaveCount(28);
  await selectProject(page, "Delivery Systems");
  await expect(page.getByRole("button", { name: "查看项目 Delivery Systems", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看项目 Commerce Platform", exact: true })).toHaveCount(0);
  await selectProject(page, "全部项目");
  await page.getByRole("button", { name: "查看项目 Commerce Platform", exact: true }).click();
  await expect(page.getByRole("button", { name: "全部时间", exact: true })).toBeVisible();
  await openObserved(page);
  await expect(page.getByRole("button", { name: /^执行中/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /^会话/ }).click();
  const box = page.getByRole("textbox", { name: "搜索会话", exact: true });
  if (await box.count()) await expect(box).toHaveValue("");
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 检查发布流水线，/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("persisted usage records outside the directory open native navigation or show its error", async ({ page }, testInfo) => {
  await open(page, testInfo, "empty");
  await openObserved(page);
  await page.getByRole("button", { name: "查看用量 Agent payment-root", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewOpenedAgent)).toBe("payment-root");
  await expect(page.getByTestId("agent-detail")).toHaveCount(0);
  await open(page, testInfo, "navigation-error");
  await openObserved(page);
  await page.getByRole("button", { name: "查看用量 Agent payment-root", exact: true }).click();
  await expect(toast(page, "会话打开失败：模拟宿主导航失败")).toBeVisible();
});

test("AI insight hub can configure automatic analysis and inspect evidence-backed reports", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await selectProject(page, "Delivery Systems");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await expect(page.getByRole("button", { name: /^需要处理/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "最近 7 天", exact: true })).toHaveCount(0);
  // 2.7: automatic analysis is off by default and lives in 分析设置.
  await page.getByRole("button", { name: "分析设置", exact: true }).first().click();
  const settings = page.getByRole("dialog", { name: "分析设置", exact: true });
  const auto = settings.getByRole("switch", { name: "任务结束后自动分析", exact: true });
  await expect(auto).toHaveAttribute("aria-checked", "false");
  await auto.click();
  await expect(auto).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await reportsView(page);
  await page.getByRole("button", { name: "新建分析", exact: true }).first().click();
  await page.getByRole("textbox", { name: "搜索可分析的 Agent", exact: true }).fill("重构支付服务");
  await page.getByRole("button", { name: "选择分析 重构支付服务", exact: true }).click();
  const panel = page.getByTestId("insights-panel");
  await panel.getByRole("button", { name: "分析当前 Agent", exact: true }).click();
  await expect(panel.getByText("模拟报告：任务拆分清晰，核心接口验证已经完成；测试环境稳定性仍需要关注。", { exact: true })).toBeVisible();
  await expect(panel.getByText("payment-root:fixture-payment-root:5-5", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "展开完整证据 exec_command", exact: true }).click();
  await expect(panel.getByText(/原始执行输出：本轮接口测试通过/)).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "insights");
  await panel.getByRole("button", { name: "复制分析报告", exact: true }).click();
  await expect(toast(page, "分析报告已复制")).toBeVisible();
  const copied = await page.evaluate(() => (globalThis as Fixture).__previewClipboard);
  expect(JSON.parse(copied ?? "{}").report.findings[0].evidence[0]).toBe("payment-root:fixture-payment-root:5-5");
  expect(JSON.parse(copied ?? "{}").evidence[0].toolName).toBe("exec_command");
  expect(errors).toEqual([]);
});

test("AI analysis exposes cancellation and insufficient-trajectory states without forced overrides", async ({ page }, testInfo) => {
  await open(page, testInfo, "insights-progress");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await reportsView(page);
  await page.getByRole("button", { name: "新建分析", exact: true }).first().click();
  await page.getByRole("button", { name: "选择分析 重构支付服务", exact: true }).click();
  let panel = page.getByTestId("insights-panel");
  await panel.getByRole("button", { name: "分析当前 Agent", exact: true }).click();
  await expect(panel.getByText("正在结合工具结果分析执行轨迹", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: "取消分析", exact: true }).click();
  await expect(panel.getByText("分析已取消", { exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "重试分析", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await reportsView(page);
  await page.getByRole("button", { name: "新建分析", exact: true }).first().click();
  await page.getByRole("textbox", { name: "搜索可分析的 Agent", exact: true }).fill("准备移动端测试");
  await page.getByRole("button", { name: "选择分析 准备移动端测试", exact: true }).click();
  panel = page.getByTestId("insights-panel");
  await panel.getByRole("button", { name: "分析当前 Agent", exact: true }).click();
  await expect(panel.getByText("暂不符合条件", { exact: true })).toBeVisible();
  await expect(panel.getByText("手动分析至少需要 2 轮对话和 2 次工具调用，当前轨迹尚不足。", { exact: true })).toBeVisible();
  await expect(panel.getByText("本次检测到 1 轮对话 · 1 次工具调用", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("normal history excludes archives even in all-time view and opens the separate archive page", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await expect(page.getByRole("button", { name: "含已归档", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true })).toHaveCount(0);
  let filters = await openFilters(page);
  await filters.getByRole("button", { name: "当前会话", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true })).toHaveCount(0);
  filters = await openFilters(page);
  await filters.getByRole("button", { name: "历史会话", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "移除 历史会话", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  await selectRange(page, "全部时间");
  await expect(page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看 十二天前的归档迭代，已完成", exact: true })).toHaveCount(0);
  await menu(page, "已归档会话");
  await expect(page.getByText(/^1 个会话 · 1 个项目$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toHaveCount(0);
  await menu(page, "返回观测台");
  await expect(page.getByRole("button", { name: /^需要处理/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true })).toHaveCount(0);
});

test("search text stays on this device: an old synced query is ignored, typing is never saved, and the archive round trip keeps it", async ({ page }, testInfo) => {
  await open(page, testInfo, `all&storedQuery=${encodeURIComponent("检查发布流水线")}`);
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toBeVisible();
  const box = page.getByRole("textbox", { name: "搜索会话", exact: true });
  if (await box.count()) await expect(box).toHaveValue("");
  await search(page, "重构支付服务");
  await expect(page.getByRole("button", { name: /^查看 检查发布流水线，/ })).toHaveCount(0);
  await menu(page, "已归档会话");
  await menu(page, "返回观测台");
  await expect(page.getByRole("textbox", { name: "搜索会话", exact: true })).toHaveValue("重构支付服务");
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toBeVisible();
  const saves = await rpcCalls(page, "observatory.preferences.update");
  expect(saves.length).toBeGreaterThan(0);
  expect(saves.filter(call => (call.view as { query?: string } | undefined)?.query)).toEqual([]);
});

test("待回复 lists only Agents whose last reply asks you; a stopped Agent without a known result is 空闲", async ({ page }, testInfo) => {
  await open(page, testInfo);
  const chip = page.getByRole("button", { name: /^待回复 \d+$/ });
  await expect(chip).toHaveAccessibleName("待回复 1");
  await expect(page.getByRole("button", { name: "查看 核对项目名称与工作区，空闲", exact: true })).toBeVisible();
  await chip.click();
  await expect(page.getByRole("button", { name: "查看 规划下一轮迭代，待回复", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 核对项目名称与工作区，空闲", exact: true })).toHaveCount(0);
  await chip.click();
  await expect(page.getByRole("button", { name: "查看 核对项目名称与工作区，空闲", exact: true })).toBeVisible();
  await menu(page, "状态图例");
  await expect(page.getByText("Agent 的最后一条回复在问你：要不要继续、选哪个、需要你提供什么", { exact: true })).toBeVisible();
  await expect(page.getByText("Agent 已停下，这一轮没有记录到结果", { exact: true })).toBeVisible();
});

test("separate archive history uses execution dates for seven-day and longer ranges", async ({ page }, testInfo) => {
  await open(page, testInfo, "archives");
  await search(page, "上周版本报告");
  await expect(page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true })).toBeVisible();
  await search(page, "十二天前的归档迭代");
  await expect(page.getByRole("button", { name: "查看 十二天前的归档迭代，已完成", exact: true })).toHaveCount(0);
  await selectRange(page, "最近 30 天");
  const archived = page.getByRole("button", { name: "查看 十二天前的归档迭代，已完成", exact: true });
  await expect(archived).toBeVisible();
  await expect(archived.getByText(/^Growth Studio · /)).toBeVisible();
  await selectRange(page, "全部时间");
  await expect(archived).toBeVisible();
  await selectRange(page, "最近 7 天");
  await expect(archived).toHaveCount(0);
  await selectRange(page, "最近 30 天");
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "history-list");
});

test("renamed project badges and historical restoration preserve the original Agent and user messages", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await selectProject(page, "Growth Studio");
  const current = page.getByRole("button", { name: "查看 核对项目名称与工作区，空闲", exact: true });
  await expect(current).toBeVisible();
  await expect(current.getByText(/^Growth Studio · main · /)).toBeVisible();
  await expect(current.getByText(/legacy-growth-engine/)).toHaveCount(0);
  await menu(page, "已归档会话");
  await selectRange(page, "最近 30 天");
  await selectProject(page, "Growth Studio");
  await expect(page.getByText(/^1 个会话 · 1 个项目$/)).toBeVisible();
  await page.getByRole("button", { name: "查看 十二天前的归档迭代，已完成", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail.getByLabel("项目 Growth Studio", { exact: true })).toBeVisible();
  await expect(detail.getByText("历史迭代已完成，原会话保留两轮交互与测试证据。", { exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "诊断", exact: true }).click();
  await expect(detail.getByText("Experiment 14", { exact: true })).toBeVisible();
  await expect(detail.getByText("/workspace/legacy-growth-engine", { exact: true }).first()).toBeVisible();
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await screenshot(page, testInfo, "history-inspector");
  await detail.getByRole("button", { name: "恢复会话", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看 十二天前的归档迭代，已完成", exact: true })).toHaveCount(0);
  const audit = await page.evaluate(() => {
    const state = globalThis as Fixture;
    return { opened: state.__previewOpenedAgent, operations: state.__previewAgentOperations, restores: state.__previewRpcCalls.filter(call => call.name === "observatory.history.restore"), restore: state.__previewRestoreAudit };
  });
  expect(audit.opened).toBe("archived-cycle");
  expect(audit.operations).toEqual([]);
  expect(audit.restores).toEqual([{ name: "observatory.history.restore", input: { agentId: "archived-cycle" } }]);
  expect(audit.restore?.before).toEqual(audit.restore?.after);
  expect(audit.restore?.after.userMessages).toBe(2);
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test("unread completion harvest preserves ancestors and excludes completed read siblings", async ({ page }, testInfo) => {
  await open(page, testInfo);
  const unread = page.getByRole("button", { name: "未读 2", exact: true });
  await expect(unread).toBeVisible();
  await unread.click();
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 实现幂等请求，执行中", exact: true })).toBeVisible();
  const nested = page.getByRole("button", { name: "查看 验证重复请求，已完成", exact: true });
  await expect(nested).toBeVisible();
  await expect(nested.getByLabel("已完成，未读结果", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 补充接口测试，已完成", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "harvest");
  await nested.scrollIntoViewIfNeeded();
  await screenshot(page, testInfo, "harvest-results");
  await unread.click();
  await page.getByRole("button", { name: "展开 重构支付服务 的子 agent", exact: true }).click();
  const read = page.getByRole("button", { name: "查看 补充接口测试，已完成", exact: true });
  await expect(read.getByLabel("已完成，已读", { exact: true })).toBeVisible();
});

test("viewing results keeps them unread until an explicit acknowledgement and a new completion returns", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  let detail = page.getByTestId("agent-detail");
  await expect(detail.getByRole("button", { name: "已读并看下一个", exact: true })).toBeVisible();
  await detail.getByRole("tab", { name: "诊断", exact: true }).click();
  await closeDetail(page);
  await expect(page.getByRole("button", { name: "未读 2", exact: true })).toBeVisible();
  expect(await marks(page)).toEqual([]);

  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  detail = page.getByTestId("agent-detail");
  await markRead(page);
  await expect(detail.getByRole("button", { name: "已读并看下一个", exact: true })).toHaveCount(0);
  await expect(detail.getByLabel("已完成，已读", { exact: true })).toBeVisible();
  await closeDetail(page);
  await expect(page.getByRole("button", { name: "未读 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  const recorded = await marks(page);
  expect(recorded).toHaveLength(1);
  expect(recorded[0]!.input.agentId).toBe("performance-baseline");

  await page.evaluate(() => (globalThis as Fixture).__previewCompleteAgent("performance-baseline"));
  await expect(page.getByRole("button", { name: "未读 2", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).getByLabel("已完成，未读结果", { exact: true })).toBeVisible();
});

test("需要处理 says why in one line, and rows show questions, plans, limits, todo progress, context, merge requests and heartbeats", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "attention-states");
  // A question is 待回复, a plan is its own state; each says what it wants without asking a model (opus-B3, opus-F12).
  const question = page.getByRole("button", { name: "查看 审查数据库迁移，提问", exact: true });
  await expect(question.getByText("问你：迁移先在哪个环境执行？（预发布 / 生产 / 两边都跑）", { exact: true })).toBeVisible();
  const plan = page.getByRole("button", { name: "查看 拆分订单服务，计划待批", exact: true });
  await expect(plan.getByText("计划待批：订单服务拆成读写两层", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "待回复 2", exact: true })).toBeVisible();
  // Why a turn stopped (opus-B2 / F13), in the device's clock.
  const limit = page.getByRole("button", { name: "查看 整理性能基线，额度用尽", exact: true });
  await expect(limit.getByText(/^额度用尽 · (明天 )?\d{2}:\d{2} 恢复$/)).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 核对项目名称与工作区，/ }).getByText("可能未收尾：停在工具调用之后，没有收尾回复", { exact: true })).toBeVisible();
  // A running turn's todo progress and a context window close to full (opus-B12, opus-B13).
  const running = page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true });
  await expect(running.getByText("3/7", { exact: true })).toBeVisible();
  await expect(running.getByText("上下文 88%", { exact: true })).toBeVisible();
  // The merge request a reply linked (opus-B16) sits beside the row, not inside it; a heartbeat will wake 规划下一轮迭代 (opus-B8).
  await expect(page.getByRole("link", { name: "打开合并请求 !128", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 规划下一轮迭代，/ }).getByText(/09:00 唤醒$/)).toBeVisible();
  expect(await page.locator("button button, [role=button] [role=button]").count()).toBe(0);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "attention-states");
  // 恢复后续跑 (opus-B9): a tap, a confirmation that states the wake time, then one schedule request.
  await limit.click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail.getByTestId("stop-card")).toBeVisible();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "resume").length)).toBe(0);
  await detail.getByRole("button", { name: /^恢复后续跑 · .*唤醒$/ }).click();
  const confirm = page.getByRole("dialog", { name: "恢复后续跑", exact: true });
  await expect(confirm.getByText(/额度已经恢复/)).toBeVisible();
  await screenshot(page, testInfo, "resume-confirm");
  await confirm.getByRole("button", { name: /^确认 .* 续跑$/ }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "resume").map(operation => (operation.input as { agentId: string }).agentId))).toEqual(["performance-baseline"]);
  // The card reads the ledger: the scheduled resume can be canceled right there, with one more tap (opus-B37).
  await detail.getByRole("button", { name: "取消续跑", exact: true }).click();
  await detail.getByRole("button", { name: "确认取消续跑", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.resume.cancel")).map(call => call.agentId)).toEqual(["performance-baseline"]);
  await expect(toast(page, "已取消续跑")).toBeVisible();
  // 交给另一个 Provider (opus-B23): a profile on another base is picked, the first message points at the original, one create.
  await detail.getByRole("button", { name: "交给另一个 Provider…", exact: true }).click();
  const handover = page.getByRole("dialog", { name: "交给另一个 Provider", exact: true });
  await expect(handover.getByRole("radio", { name: /^Profile 日常 · Opus 5\.5/ })).toHaveAttribute("aria-checked", "true");
  await expect(handover.getByRole("radio", { name: /^Profile 实现 · 长程执行与交付，同一额度来源/ })).toBeVisible();
  await expect(handover.getByRole("textbox").first()).toHaveValue(/paseo inspect performance-baseline/);
  await screenshot(page, testInfo, "handover");
  await handover.getByRole("button", { name: "新建并交接", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "create" && operation.workspaceId)
    .map(operation => ({ provider: (operation.input as { config: { provider: string } }).config.provider, labels: (operation.input as { labels: unknown }).labels })))).toEqual([{ provider: "claude/claude-opus-5-5", labels: { "observatory.handover-from": "performance-baseline" } }]);
  await expect(handover).toHaveCount(0);
  // 知道了 on a stop clears it from 需要处理 without calling the turn complete: no completion receipt, the stop stays visible.
  await closeDetail(page);
  await page.getByRole("button", { name: /^查看 核对项目名称与工作区，/ }).click();
  await page.getByTestId("agent-detail").getByRole("button", { name: "知道了", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.read-state.mark")).map(call => [call.agentId, call.kind])).toEqual([["renamed-project-check", "error"]]);
  await closeDetail(page);
  await expect(page.getByRole("button", { name: /^查看 核对项目名称与工作区，/ }).getByText("未收尾", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 核对项目名称与工作区，已完成/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("恢复后续跑 the ledger could not settle: a restart that may have prompted it is never sent again, an edited heartbeat is the user's (codex-obs-resume-F2, F4)", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "attention-states");
  await page.evaluate(() => (globalThis as Fixture).__previewSetResume({ agentId: "performance-baseline", status: "failed", reason: "restart-unsure" }));
  await page.getByRole("button", { name: "查看 整理性能基线，额度用尽", exact: true }).click();
  const card = page.getByTestId("agent-detail").getByTestId("stop-card");
  await expect(card.getByText("未能确认续跑", { exact: true })).toBeVisible();
  await expect(card.getByText(/宿主重启打断了这次续跑，没能确认续跑是否送达。为免重复，观测台不会自动重发/)).toBeVisible();
  // Nothing is sent again on its own: the user looks at the session, then can schedule it again.
  await expect(card.getByRole("button", { name: "重新安排…", exact: true })).toBeVisible();
  await expect(card.getByRole("button", { name: "取消续跑", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.waitForTimeout(500); // the state's entrance has played
  await screenshot(page, testInfo, "resume-restart-unsure");
  // The card keeps the ledger's answer for a while: a fresh page reads the next state.
  await open(page, testInfo, "attention-states");
  await page.evaluate(() => (globalThis as Fixture).__previewSetResume({ agentId: "performance-baseline", status: "canceled", reason: "edited" }));
  await page.getByRole("button", { name: "查看 整理性能基线，额度用尽", exact: true }).click();
  await expect(card.getByText("心跳被改过", { exact: true })).toBeVisible();
  await expect(card.getByText(/续跑的心跳在 Paseo 里被改过，观测台不再管理它/)).toBeVisible();
  await expect(card.getByRole("button", { name: "取消续跑", exact: true })).toHaveCount(0);
  await expect(card.getByRole("button", { name: /^恢复后续跑/ })).toBeVisible();
  await page.waitForTimeout(500); // the state's entrance has played
  await screenshot(page, testInfo, "resume-edited");
  expect(await page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "resume" || operation.type === "resume-cancel").length)).toBe(0);
  expect(errors).toEqual([]);
});

test("就地审批 answers one tool request with the provider's own choices, and 快捷回复 sends the button's words", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "approvals");
  const operations = () => page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "permission" || operation.type === "send").map(operation => structuredClone(operation)));
  // Claude's shell request: the whole command and where it runs; without provider actions the choices are ours (opus-B12).
  await page.getByRole("button", { name: /^查看 审查数据库迁移，/ }).click();
  const detail = page.getByTestId("agent-detail");
  const shell = detail.getByTestId("permission-panel").first();
  await expect(shell.getByText("$ npm run migrate:check -- --dry-run --env staging", { exact: true })).toBeVisible();
  await expect(shell.getByText(/^工作目录 /)).toBeVisible();
  await expect(shell.getByRole("button", { name: "拒绝并中断：执行数据库迁移检查", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "approval-inline");
  await shell.getByRole("button", { name: "批准：执行数据库迁移检查", exact: true }).click();
  await expect.poll(operations).toEqual([{ type: "permission", agentId: "migration-review", requestId: "permission-1", response: { behavior: "allow" } }]);
  await expect(detail.getByText("已批准", { exact: true })).toBeVisible();
  await closeDetail(page);
  // An ACP edit offers the agent's own choices, answered by id; one that lasts (Always Allow) takes a second tap.
  await page.getByRole("button", { name: /^查看 同步订单表结构，/ }).click();
  const edit = page.getByTestId("agent-detail").getByTestId("permission-panel").first();
  await expect(edit.getByRole("button", { name: "Allow：Edit db/migrations/0042_orders.sql", exact: true })).toBeVisible();
  await expect(edit.getByRole("button", { name: "Reject：Edit db/migrations/0042_orders.sql", exact: true })).toBeVisible();
  await edit.getByRole("button", { name: "Always Allow：Edit db/migrations/0042_orders.sql", exact: true }).click();
  await expect(edit.getByRole("alert")).toContainText("不只这一次");
  expect(await operations()).toHaveLength(1);
  await edit.getByRole("button", { name: "确定Always Allow：Edit db/migrations/0042_orders.sql", exact: true }).click();
  await expect.poll(async () => (await operations()).at(-1)).toEqual({ type: "permission", agentId: "schema-sync", requestId: "permission-acp-1", response: { behavior: "allow", selectedActionId: "allow_always" } });
  await closeDetail(page);
  // 快捷回复 (opus-B26): the reply asked whether to go on; one tap sends the button's words as a sentence, with one message id.
  await page.getByRole("button", { name: /^查看 规划下一轮迭代，/ }).click();
  const replies = page.getByTestId("agent-detail").getByTestId("quick-replies");
  await expect(replies.getByRole("button", { name: "给「规划下一轮迭代」发送「先别动」", exact: true })).toBeVisible();
  await screenshot(page, testInfo, "quick-replies");
  await replies.getByRole("button", { name: "给「规划下一轮迭代」发送「继续，按你说的做」", exact: true }).click();
  await expect.poll(async () => (await operations()).filter(operation => operation.type === "send")).toEqual([expect.objectContaining({ agentId: "iteration-plan", input: "继续，按你说的做。", options: expect.objectContaining({ messageId: expect.any(String) }) })]);
  // The new turn takes the reply (and its buttons) away; the toast says what went.
  await expect(toast(page, "已回复「规划下一轮迭代」：继续，按你说的做")).toBeVisible();
  expect(errors).toEqual([]);
});

test("每轮小结 is off on a new install: no recap lines, and the settings say what turning it on sends", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  await expect(page.getByTestId("recap-line")).toHaveCount(0);
  await menu(page, "观测设置");
  const settings = page.getByRole("dialog", { name: "观测设置", exact: true }).getByTestId("recap-settings");
  await expect(settings.getByRole("switch", { name: "每轮小结", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByRole("switch", { name: "顺带生成建议回复", exact: true })).toHaveAttribute("aria-disabled", "true");
  await expect(settings.getByText(/把这一轮和之前最多 8 轮的对话文字/)).toBeVisible();
  // Turned on here, the list asks again at once and shows the recaps.
  await settings.getByRole("switch", { name: "每轮小结", exact: true }).click();
  await expect(settings.getByRole("switch", { name: "每轮小结", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByText("由谁写", { exact: true })).toBeVisible();
  await page.getByRole("dialog", { name: "观测设置", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByTestId("recap-line").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("每轮小结 with a profile: the settings say what it leaves in the workspace and how often it runs, also once the choice is folded", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "recaps");
  await menu(page, "观测设置");
  const settings = page.getByRole("dialog", { name: "观测设置", exact: true }).getByTestId("recap-settings");
  await expect(settings.getByRole("switch", { name: "每轮小结", exact: true })).toHaveAttribute("aria-checked", "true");
  const note = settings.getByTestId("recap-provider-note");
  // The Grok CLI leaves nothing behind: no note until the choices open.
  await expect(note).toHaveCount(0);
  await settings.getByRole("button", { name: "更换", exact: true }).click();
  await expect(note).toContainText("同一个 Agent 30 分钟内最多这样写一次，只写最新一轮");
  await settings.getByRole("radio", { name: /^实现 · 长程执行与交付/ }).click();
  await expect(settings.getByRole("radio", { name: /^实现 · 长程执行与交付/ })).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("button", { name: "收起", exact: true }).click();
  await expect(note).toBeVisible();
  await expect(note).toContainText("这些归档的子 Agent 和它们在宿主、Provider 里的会话记录会留在工作区里，越积越多，插件删不掉");
  expect(errors).toEqual([]);
});

test("每轮小结 under each title, whole in the detail, and its AI 建议 sent word for word through the ledger", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "recaps");
  const operations = () => page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "send").map(operation => structuredClone(operation)));
  // The second line of a row: ✦, the goal and progress, 下一步. A working Agent's is out of date; one is being written.
  const row = page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true });
  await expect(row.getByTestId("recap-line")).toContainText("整理性能基线：脚本和首页基线已跑完，报告待合入");
  await expect(row.getByTestId("recap-line")).toContainText(/→\s把基线脚本加进 CI$/);
  await expect(row.getByTestId("recap-line")).toHaveAttribute("aria-label", "每轮小结：整理性能基线：脚本和首页基线已跑完，报告待合入 下一步：把基线脚本加进 CI");
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ }).first().getByTestId("recap-line")).toContainText("过时 · 重构支付服务：幂等校验已上");
  await expect(page.getByRole("button", { name: /^查看 准备移动端测试，/ }).getByTestId("recap-line")).toContainText("正在写小结…");
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "recap-list");
  // The detail: the whole recap at the top, and the suggested reply under the latest reply, marked AI 建议.
  await row.click();
  const detail = page.getByTestId("agent-detail");
  const card = detail.getByTestId("recap-card");
  await expect(card.getByText("整理性能基线：脚本和首页基线已跑完，报告待合入", { exact: true })).toBeVisible();
  await expect(card.getByText("把基线脚本加进 CI", { exact: true })).toBeVisible();
  await expect(card.getByText("由 Grok 4.7 · low 写", { exact: true })).toBeVisible();
  const suggestion = detail.getByTestId("quick-reply-ai-block");
  await expect(suggestion.getByText("AI 建议", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "recap-detail");
  await suggestion.getByRole("button", { name: "把 AI 建议「先把基线脚本加进 CI」发给 整理性能基线", exact: true }).click();
  await expect.poll(operations).toEqual([expect.objectContaining({ agentId: "performance-baseline", input: "先把基线脚本加进 CI", options: expect.objectContaining({ messageId: expect.any(String) }) })]);
  await expect(toast(page, "已回复「整理性能基线」：先把基线脚本加进 CI")).toBeVisible();
  expect(errors).toEqual([]);
});

test("每轮小结 in English reads naturally in the list, the detail and the settings", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${query(testInfo, "recaps")}&language=en`);
  await expect(page.getByRole("button", { name: "More actions", exact: true }).first()).toBeVisible();
  await expect(page.getByTestId("recap-line").filter({ hasText: "Performance baseline" })).toHaveAttribute("aria-label", "Turn summary: Performance baseline: scripts and home page runs done, report not merged Next: Add the baseline script to CI");
  await page.getByTestId("recap-line").filter({ hasText: "Performance baseline" }).click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail.getByTestId("recap-card").getByText("Written by Grok 4.7 · low", { exact: true })).toBeVisible();
  await expect(detail.getByTestId("quick-reply-ai-block").getByText("AI suggestion", { exact: true })).toBeVisible();
  await screenshot(page, testInfo, "recap-detail-en");
  expect(errors).toEqual([]);
});

test("就地审批 shows a long request to its end once expanded, and a Grep's pattern with its path (codex-obs-send-ui-F1)", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "approvals");
  await page.getByRole("button", { name: /^查看 审查数据库迁移，/ }).click();
  const detail = page.getByTestId("agent-detail");
  // A 5,000-character command (2.14.0 kept only 4,000): collapsed, only its first lines are drawn; expanded, all of it, to its last words.
  const long = detail.getByLabel("审批请求：检查全部订单分表", { exact: true });
  await expect(long.getByText(/^\$ npm run migrate:check -- --dry-run --tables orders_000,/)).toBeVisible();
  await expect(long.getByText(/&& echo 检查结束$/)).toHaveCount(0);
  await long.getByRole("button", { name: "展开完整请求内容", exact: true }).click();
  await expect(long.getByText(/orders_449 && echo 检查结束$/)).toBeVisible();
  await expect(long.getByText("description: 逐个分表只读检查", { exact: true })).toBeVisible();
  await long.getByRole("button", { name: "收起请求内容", exact: true }).click();
  await expect(long.getByText(/&& echo 检查结束$/)).toHaveCount(0);
  // The Grep: its pattern on the target line, and the path and mode it searches with, which used to be dropped.
  const grep = detail.getByLabel("审批请求：Grep", { exact: true });
  await expect(grep.getByText("TODO", { exact: true })).toBeVisible();
  await expect(grep.getByText("path: db/migrations\noutput_mode: content", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

// ---------- 发送账本 (observatory.deferred.*) ----------
const sends = (page: Page) => page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "send").map(operation => structuredClone(operation)));

test("快捷回复 whose outcome the host cannot tell is held in its row: 仍然发送 / 取消, and the replies stay locked until it is settled", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "send-unknown");
  await page.getByRole("button", { name: /^查看 规划下一轮迭代，/ }).click();
  const replies = page.getByTestId("agent-detail").getByTestId("quick-replies");
  await replies.getByRole("button", { name: "给「规划下一轮迭代」发送「继续，按你说的做」", exact: true }).click();
  // The ledger sent it once; the host never said whether it arrived: 待确认, with the reason, and nothing goes out again on its own.
  const row = replies.getByLabel("待确认：快捷回复「继续，按你说的做」", { exact: true });
  await expect(row).toBeVisible();
  await expect(row.getByText(/没收到发送结果，可能已经送达/)).toBeVisible();
  await expect(row.getByRole("button", { name: "仍然发送：快捷回复「继续，按你说的做」", exact: true })).toBeVisible();
  await expect(replies.getByRole("button", { name: "给「规划下一轮迭代」发送「先别动」", exact: true })).toBeDisabled();
  expect(await sends(page)).toHaveLength(1);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "quick-reply-held");
  // 取消: it is settled as not sent again; the replies are free once more.
  await row.getByRole("button", { name: "取消：快捷回复「继续，按你说的做」", exact: true }).click();
  await expect(replies.getByLabel("已取消：快捷回复「继续，按你说的做」", { exact: true })).toBeVisible();
  await expect(replies.getByRole("button", { name: "给「规划下一轮迭代」发送「先别动」", exact: true })).toBeEnabled();
  expect(await sends(page)).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("发给这个 Agent whose answer was lost after the ledger sent it settles from the list: shown as delivered, never sent twice", async ({ page }, testInfo) => {
  await open(page, testInfo, "send-lost-reply");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await reportsView(page);
  await page.getByRole("button", { name: "新建分析", exact: true }).first().click();
  await page.getByRole("button", { name: "选择分析 重构支付服务", exact: true }).click();
  const panel = page.getByTestId("insights-panel");
  await panel.getByRole("button", { name: "分析当前 Agent", exact: true }).click();
  await panel.getByRole("button", { name: "发给这个 Agent", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "发给这个 Agent", exact: true });
  await sheet.getByRole("button", { name: "插入这一轮", exact: true }).click();
  // The sheet never got the answer; the ledger's list shows the message went out, under the id it was sent with.
  await expect(sheet.getByText("这条消息已经送达。改一下内容就是一条新消息。", { exact: true })).toBeVisible();
  await expect(sheet.getByLabel("已送达：分析建议「复用已通过的测试结果」", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "插入这一轮", exact: true })).toBeDisabled();
  await noHorizontalOverflow(page);
  const sent = await sends(page);
  expect(sent).toEqual([expect.objectContaining({ agentId: "payment-root", input: expect.stringContaining("复用已通过的测试结果") })]);
  expect((await rpcCalls(page, "observatory.deferred.send")).map(call => call.messageId)).toEqual([(sent[0] as { options: { messageId: string } }).options.messageId]);
});

test("发给这个 Agent: a turn that cannot take it offers 等这一轮结束再发; queued beside the analysis, it goes out once the turn ends", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "deferred");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await reportsView(page);
  await page.getByRole("button", { name: "新建分析", exact: true }).first().click();
  await page.getByRole("button", { name: "选择分析 重构支付服务", exact: true }).click();
  const panel = page.getByTestId("insights-panel");
  await panel.getByRole("button", { name: "分析当前 Agent", exact: true }).click();
  await panel.getByRole("button", { name: "发给这个 Agent", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "发给这个 Agent", exact: true });
  await expect(sheet.getByText(/运行中，这个 Agent 不支持插话/)).toBeVisible();
  await sheet.getByRole("button", { name: "发送", exact: true }).click();
  // Three choices: interrupt it, wait for the turn, or not now. Nothing went out yet.
  await expect(sheet.getByText(/发送消息会中断它当前的回合/)).toBeVisible();
  await expect(sheet.getByText("「等这一轮结束再发」：不打断当前回合，等它这一轮结束后自动发送。", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "中断并发送", exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: "取消", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "send-three-choices");
  await sheet.getByRole("button", { name: "等这一轮结束再发", exact: true }).click();
  await expect(sheet).toHaveCount(0);
  await expect(toast(page, "已排队：等「重构支付服务」这一轮结束后自动发送")).toBeVisible();
  // Its row stays beside the analysis, breathing amber, with 取消排队; nothing was sent.
  const row = panel.getByLabel("排队中：分析建议「复用已通过的测试结果」", { exact: true });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: "取消排队：分析建议「复用已通过的测试结果」", exact: true })).toBeVisible();
  expect(await sends(page)).toEqual([]);
  await screenshot(page, testInfo, "send-queued");
  // The turn ends: the ledger sends it, once, with the queued id, and the row turns to 已送达.
  await page.evaluate(() => (globalThis as Fixture).__previewUpdateAgent("payment-root", { status: "idle", activeTurn: null }));
  const queued = (await rpcCalls(page, "observatory.deferred.enqueue"))[0]!.messageId;
  await expect.poll(() => sends(page)).toEqual([expect.objectContaining({ agentId: "payment-root", input: expect.stringContaining("复用已通过的测试结果"), options: { activeTurnBehavior: "steer", messageId: queued } })]);
  await expect(panel.getByLabel("已送达：分析建议「复用已通过的测试结果」", { exact: true })).toBeVisible({ timeout: 12_000 });
  expect(errors).toEqual([]);
});

test("发给这个 Agent: 等这一轮结束再发 answered with a held message keeps the sheet open with its reason and 仍然发送, not 已排队 (codex-obs-send-ui-R2)", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "deferred-held");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await reportsView(page);
  await page.getByRole("button", { name: "新建分析", exact: true }).first().click();
  await page.getByRole("button", { name: "选择分析 重构支付服务", exact: true }).click();
  const panel = page.getByTestId("insights-panel");
  await panel.getByRole("button", { name: "分析当前 Agent", exact: true }).click();
  await panel.getByRole("button", { name: "发给这个 Agent", exact: true }).first().click();
  const sheet = page.getByRole("dialog", { name: "发给这个 Agent", exact: true });
  await sheet.getByRole("button", { name: "发送", exact: true }).click();
  await expect(sheet.getByRole("button", { name: "等这一轮结束再发", exact: true })).toBeVisible();
  // The turn ends before the tap: the ledger sends it at once, and the host never says whether it arrived.
  await page.evaluate(() => (globalThis as Fixture).__previewUpdateAgent("payment-root", { status: "idle", activeTurn: null }));
  await sheet.getByRole("button", { name: "等这一轮结束再发", exact: true }).click();
  // Held for the user: the sheet stays, its row says why and offers 仍然发送; nothing claims it will go out on its own.
  await expect(toast(page, "这条消息在等你确认，见下方。")).toBeVisible();
  const row = sheet.getByLabel("待确认：分析建议「复用已通过的测试结果」", { exact: true });
  await expect(row.getByText(/^没收到发送结果，可能已经送达。点「仍然发送」会先查会话记录/)).toBeVisible();
  await expect(row.getByRole("button", { name: "仍然发送：分析建议「复用已通过的测试结果」", exact: true })).toBeVisible();
  await expect(toast(page, "已排队：等「重构支付服务」这一轮结束后自动发送")).toHaveCount(0);
  expect(await sends(page)).toHaveLength(1);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "send-held-on-queue");
  expect(errors).toEqual([]);
});

test("快捷回复 answered on another device first: the tap here is answered with that reply, which locks them; nothing else goes out (codex-obs-attn-R3)", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "send-unknown");
  await page.getByRole("button", { name: /^查看 规划下一轮迭代，/ }).click();
  const replies = page.getByTestId("agent-detail").getByTestId("quick-replies");
  await expect(replies.getByRole("button", { name: "给「规划下一轮迭代」发送「继续，按你说的做」", exact: true })).toBeEnabled();
  // Another device taps 先别动 for the same turn; the host never says whether it arrived, so it waits for the user there.
  expect(await page.evaluate(() => (globalThis as Fixture & { __previewOtherDeviceReply(id: string, text: string): Promise<{ status: string }> }).__previewOtherDeviceReply("iteration-plan", "先别动").then(answer => answer.status))).toBe("held");
  // This device, not yet told, taps the other button: the ledger answers with 先别动, for the same turn.
  await replies.getByRole("button", { name: "给「规划下一轮迭代」发送「继续，按你说的做」", exact: true }).click();
  await expect(toast(page, "这一轮的回复「先别动」在等你确认，见下方。")).toBeVisible();
  await expect(replies.getByLabel("待确认：快捷回复「先别动」", { exact: true })).toBeVisible();
  await expect(replies.getByRole("button", { name: "给「规划下一轮迭代」发送「继续，按你说的做」", exact: true })).toBeDisabled();
  await expect(replies.getByTestId("quick-reply-sent")).toHaveCount(0);
  expect((await sends(page)).map(operation => (operation as { input?: string }).input)).toEqual(["先别动。"]);
  await noHorizontalOverflow(page);
  expect(errors).toEqual([]);
});

test("快捷回复 whose round the plugin's own record cannot vouch for is not sent: the server answers busy, saying why, and 重试 checks again (codex-obs-attn-R3-remaining)", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "approvals");
  await page.getByRole("button", { name: /^查看 规划下一轮迭代，/ }).click();
  const replies = page.getByTestId("agent-detail").getByTestId("quick-replies");
  const go = replies.getByRole("button", { name: "给「规划下一轮迭代」发送「继续，按你说的做」", exact: true });
  await expect(go).toBeEnabled();
  // The plugin's store could not read its saved history: its record cannot vouch for the round this reply answers.
  const storeError = (message: string | null) => page.evaluate(text => (globalThis as Fixture & { __previewTelemetryError(message: string | null): void }).__previewTelemetryError(text), message);
  await storeError("已保存的事件历史无法读取，已重新开始记录；原文件另存了一份备份。");
  await go.click();
  await expect(replies.getByText("没能确认这条消息还适用（观测台的记录暂时有问题，核实不了「规划下一轮迭代」最近一轮），没有发送。请稍后再试。", { exact: true })).toBeVisible();
  expect(await sends(page)).toEqual([]);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "quick-reply-unverified");
  // Saved again: 重试 checks once more, and it goes out.
  await storeError(null);
  await replies.getByRole("button", { name: "重试", exact: true }).click();
  await expect.poll(() => sends(page)).toEqual([expect.objectContaining({ agentId: "iteration-plan", input: "继续，按你说的做。" })]);
  await expect(toast(page, "已回复「规划下一轮迭代」：继续，按你说的做")).toBeVisible();
  expect(errors).toEqual([]);
});

test("观测设置 counts child Agents' results in 需要处理 only when asked, and 归档已读完成 takes two taps", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await expect(page.getByRole("button", { name: "需要处理 3", exact: true })).toBeVisible();
  await menu(page, "观测设置");
  const settings = page.getByRole("dialog", { name: "观测设置", exact: true });
  await settings.getByRole("switch", { name: "子 Agent 完成也计入需要处理", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.preferences.update")).some(call => (call.settings as { childCompletions?: boolean } | undefined)?.childCompletions === true)).toBe(true);
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(page.getByRole("button", { name: "需要处理 4", exact: true })).toBeVisible();
  // Read one result, then archive the read ones: the first tap only marks them.
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail.getByText("最新回复", { exact: true })).toBeVisible();
  const read = detail.getByRole("button", { name: /^(标记已读|已读并看下一个)$/ });
  if (await read.count()) await read.first().click(); else await detailMenu(page, "标记已读");
  await expect.poll(() => marks(page).then(calls => calls.length)).toBe(1);
  if (await page.getByTestId("agent-detail").count()) await closeDetail(page);
  await expect(page.getByRole("button", { name: "未读 1", exact: true })).toBeVisible();
  // A read child whose parent still runs stays: only 整理性能基线 is offered.
  await menu(page, "归档已读完成（1）");
  await expect(page.getByRole("alert").getByText(/将归档列表里标红的 1 个已读完成会话/)).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成，待归档", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "archive").length)).toBe(0);
  await screenshot(page, testInfo, "archive-marked");
  await page.getByRole("button", { name: "确认归档 1 个", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "archive").map(operation => operation.agentId))).toEqual(["performance-baseline"]);
});

test("归档已读完成 stays off, saying why, while the heartbeats cannot all be read", async ({ page }, testInfo) => {
  await open(page, testInfo, "heartbeats-error");
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail.getByText("最新回复", { exact: true })).toBeVisible();
  const read = detail.getByRole("button", { name: /^(标记已读|已读并看下一个)$/ });
  if (await read.count()) await read.first().click(); else await detailMenu(page, "标记已读");
  await expect.poll(() => marks(page).then(calls => calls.length)).toBe(1);
  if (await page.getByTestId("agent-detail").count()) await closeDetail(page);
  // A read result would be offered, but a heartbeat might still point at it: the entry is disabled with the reason (opus-B18).
  await page.getByRole("button", { name: "更多操作", exact: true }).first().click();
  const more = page.getByRole("dialog", { name: "更多操作", exact: true });
  await expect(more.getByRole("button", { name: "归档已读完成", exact: true })).toBeDisabled();
  await expect(more.getByText(/^暂不可用：定时任务目录读不出来/)).toBeVisible();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "archive").length)).toBe(0);
});

test("native conversation read state synchronizes without clearing unrelated approvals", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await detail.getByRole("button", { name: "打开会话", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewOpenedAgent)).toBe("performance-baseline");
  await expect(detail.getByLabel("已完成，已读", { exact: true })).toBeVisible();
  await closeDetail(page);
  await expect(page.getByRole("button", { name: "未读 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).getByLabel("已完成，已读", { exact: true })).toBeVisible();
  const alteredApproval = await page.evaluate(() => (globalThis as Fixture).__previewNativeReadAgent("migration-review"));
  expect(alteredApproval).toBe(false);
  const waiting = page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true });
  await expect(waiting.getByText("待审批 2", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "需要处理 2", exact: true })).toBeVisible();
  await page.evaluate(() => (globalThis as Fixture).__previewNativeReadAgent("payment-validation"));
  await expect(page.getByRole("button", { name: "未读 0", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  await page.evaluate(() => (globalThis as Fixture).__previewUpdateAgent("performance-baseline", { requiresAttention: undefined }));
  const unknown = page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true });
  await expect(unknown.getByLabel("已完成，已读", { exact: true })).toHaveCount(0);
  await expect(unknown.getByLabel("已完成，未读结果", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "未读 0", exact: true })).toBeVisible();
});

test("default result header always exposes one native conversation action without a separate read mutation", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  let detail = page.getByTestId("agent-detail");
  let openConversation = detail.getByRole("button", { name: "打开会话", exact: true });
  await expect(detail.getByText("最新回复", { exact: true })).toBeVisible();
  await expect(detail.getByText(/执行中$/).last()).toBeVisible();
  await expect(openConversation).toHaveCount(1);
  await expect(openConversation).toBeInViewport();
  await openConversation.click();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewOpenedAgent)).toBe("payment-root");
  await closeDetail(page);

  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  detail = page.getByTestId("agent-detail");
  openConversation = detail.getByRole("button", { name: "打开会话", exact: true });
  await expect(detail.getByLabel("已完成，未读结果", { exact: true })).toBeVisible();
  await expect(detail.getByText("最初输入", { exact: true })).toBeInViewport();
  await expect(detail.getByText("幂等校验已经接入，18 项接口测试通过。正在等待子任务返回并发写入验证结果。", { exact: true })).toBeVisible();
  await expect(openConversation).toHaveCount(1);
  await expect(openConversation).toBeInViewport();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "result-open-conversation");
  await openConversation.click();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewOpenedAgent)).toBe("performance-baseline");
  await expect(detail.getByLabel("已完成，已读", { exact: true })).toBeVisible();
  await expect(openConversation).toHaveCount(1);
  await closeDetail(page);

  await page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true }).click();
  detail = page.getByTestId("agent-detail");
  const pendingConversation = detail.getByRole("button", { name: "处理审批", exact: true });
  await expect(pendingConversation).toHaveCount(1);
  await expect(pendingConversation).toBeInViewport();
  await expect(detail.getByRole("button", { name: "打开会话", exact: true })).toHaveCount(0);
  await pendingConversation.click();
  const pendingAudit = await page.evaluate(() => {
    const fixture = globalThis as Fixture;
    return { opened: fixture.__previewOpenedAgent, pending: fixture.__previewGetAgent("migration-review").pendingPermissions.length,
      marks: fixture.__previewRpcCalls.filter(call => call.name === "observatory.read-state.mark").length };
  });
  expect(pendingAudit).toEqual({ opened: "migration-review", pending: 2, marks: 0 });

  await open(page, testInfo, "long-history");
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  detail = page.getByTestId("agent-detail");
  await detail.getByText("结果末尾：长内容完整可读。", { exact: true }).scrollIntoViewIfNeeded();
  openConversation = detail.getByRole("button", { name: "打开会话", exact: true });
  await expect(openConversation).toHaveCount(1);
  await expect(openConversation).toBeInViewport();
  await openConversation.click();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewOpenedAgent)).toBe("performance-baseline");
  expect((await marks(page)).length).toBe(0);
});

test("failed acknowledgement preserves unread highlighting and archives never enter harvest", async ({ page }, testInfo) => {
  await open(page, testInfo, "read-error");
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await markRead(page);
  await expect(toast(page, "模拟宿主确认失败，未读状态已保留。")).toBeVisible();
  await expect(detail.getByRole("button", { name: "已读并看下一个", exact: true })).toBeVisible();
  await expect(detail.getByLabel("已完成，未读结果", { exact: true })).toBeVisible();
  await closeDetail(page);
  await expect(page.getByRole("button", { name: "未读 2", exact: true })).toBeVisible();
  await page.evaluate(() => (globalThis as Fixture).__previewUpdateAgent("archived-cycle", { requiresAttention: true }));
  await expect(page.getByRole("button", { name: "未读 2", exact: true })).toBeVisible();
  await menu(page, "已归档会话");
  await expect(page.getByRole("button", { name: /^未读/ })).toHaveCount(0);
  await selectRange(page, "全部时间");
  await expect(page.getByRole("button", { name: "查看 十二天前的归档迭代，已完成", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 十二天前的归档迭代，已完成", exact: true }).getByText("未读", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^未读/ })).toHaveCount(0);
});

test("results open at the latest reply with pinned initial input even for a large conversation", async ({ page }, testInfo) => {
  await open(page, testInfo, "long-history");
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  let detail = page.getByTestId("agent-detail");
  await expect(detail.getByText("最终结果：长会话中的最新结论优先展示。", { exact: true })).toBeVisible();
  await expect(detail.getByText("最初输入", { exact: true })).toBeVisible();
  await expect(detail.getByText("起点待确认", { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (globalThis as Fixture).__previewTimelineCalls.length)).toBe(0);
  await detail.getByText("结果末尾：长内容完整可读。", { exact: true }).scrollIntoViewIfNeeded();
  await expect(detail.getByText("最初输入", { exact: true })).toBeInViewport();
  await detail.getByRole("button", { name: "展开最初输入", exact: true }).click();
  await expect(detail.getByText("最初需求：为支付链路提供可靠的幂等保障，并保留每一步验证的证据。", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "pinned-result");
  await detail.getByRole("button", { name: "复制最新回复", exact: true }).click();
  await expect(toast(page, "已复制最新回复")).toBeVisible();
  const copied = await page.evaluate(() => (globalThis as Fixture).__previewClipboard);
  expect(copied).toContain("最终结果：长会话中的最新结论优先展示。");
  expect(copied).toContain("结果末尾：长内容完整可读。");
  await open(page, testInfo, "unknown-origin");
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  detail = page.getByTestId("agent-detail");
  await expect(detail.getByText("起点待确认", { exact: true })).toBeVisible();
  await expect(detail.getByText("最初输入", { exact: true })).toBeVisible();
});

test("timeline tab changes retain filter and expanded evidence while releasing hidden subscriptions", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await detail.getByRole("tab", { name: "工具", exact: true }).click();
  await detail.getByRole("button", { name: "展开exec_command", exact: true }).first().click();
  await expect(detail.getByText("PASS payments/idempotency.test.ts", { exact: false })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewTimelineActive("payment-root"))).toBe(1);
  await detail.getByRole("tab", { name: "诊断", exact: true }).click();
  await expect(detail.getByText("执行上下文", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewTimelineActive("payment-root"))).toBe(0);
  await detail.getByRole("tab", { name: "时间线", exact: true }).click();
  await expect(detail.getByText("PASS payments/idempotency.test.ts", { exact: false })).toBeVisible();
  await expect(detail.getByRole("button", { name: "收起exec_command", exact: true }).first()).toBeVisible();
  await expect(detail.getByText("幂等校验已经接入，18 项接口测试通过。正在等待子任务返回并发写入验证结果。", { exact: true })).toHaveCount(0);
  await detail.getByRole("tab", { name: "子任务", exact: true }).click();
  await detail.getByRole("button", { name: "查看原生子任务 检查并发重试边界", exact: true }).click();
  await expect(detail.getByText("子任务验证已通过：重复请求只产生一条订单记录。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewTimelineActive("payment-root"))).toBe(0);
  await noHorizontalOverflow(page);
});

test("filter sheet keeps the page usable and named views survive archive navigation independently", async ({ page }, testInfo) => {
  await open(page, testInfo);
  let dialog = await openFilters(page);
  const box = await dialog.boundingBox();
  expect(box?.height).toBeGreaterThan(150);
  expect(box?.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await dialog.getByRole("button", { name: "Release checks", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "移除 Release checks", exact: true })).toBeVisible();
  // Choosing a project resets a workspace from another project.
  await selectProject(page, "Commerce Platform");
  await expect(page.getByRole("button", { name: "移除 Release checks", exact: true })).toHaveCount(0);
  dialog = await openFilters(page);
  await dialog.getByRole("button", { name: "payments-v2", exact: true }).click();
  await dialog.getByRole("textbox", { name: "视图名称", exact: true }).fill("支付工作树");
  await dialog.getByRole("button", { name: "保存视图", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "删除视图 支付工作树", exact: true })).toBeVisible();
  await closeFilters(page);
  await expect(toast(page, "已保存视图")).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toBeVisible();
  await expect(page.getByText("还没有会话", { exact: true })).toHaveCount(0);
  dialog = await openFilters(page);
  await dialog.getByRole("button", { name: "重置", exact: true }).click();
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "支付工作树", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true })).toHaveCount(0);
  await menu(page, "已归档会话");
  await expect(page.getByRole("button", { name: "支付工作树", exact: true })).toHaveCount(0);
  await selectRange(page, "全部时间");
  await menu(page, "返回观测台");
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "最近 7 天", exact: true })).toBeVisible();
  dialog = await openFilters(page);
  await dialog.getByRole("button", { name: "删除视图 支付工作树", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "删除视图 支付工作树", exact: true })).toHaveCount(0);
  await closeFilters(page);
  await expect(page.getByRole("button", { name: "支付工作树", exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
});

test("snooze and next-result queue target one completion version and never clear a newer result", async ({ page }, testInfo) => {
  await open(page, testInfo);
  const originalToken = await page.evaluate(() => (globalThis as Fixture).__previewGetAgent("performance-baseline").attentionTimestamp);
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  let detail = page.getByTestId("agent-detail");
  await snooze(page);
  await expect(detail.getByText("验证重复请求", { exact: true })).toBeVisible();
  await closeDetail(page);
  await expect(page.getByRole("button", { name: "未读 1", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "稍后处理 1", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "未读 1", exact: true }).click();
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toHaveCount(0);
  expect((await marks(page)).length).toBe(0);
  const next = await page.evaluate(() => (globalThis as Fixture).__previewCompleteAgent("performance-baseline"));
  expect(next.attentionTimestamp).not.toBe(originalToken);
  await expect(page.getByRole("button", { name: "未读 2", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  detail = page.getByTestId("agent-detail");
  await expect(detail.getByText(next.previewReply.text, { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "已读并看下一个", exact: true }).click();
  await expect(detail.getByText("验证重复请求", { exact: true })).toBeVisible();
  const changedChild = await page.evaluate(() => (globalThis as Fixture).__previewCompleteAgent("payment-validation"));
  await expect(detail.getByText(changedChild.previewReply.text, { exact: true })).toBeVisible();
  // A new result arriving while a prior queue is active is still explicitly read
  // as its own visible version; no background operation acknowledges it.
  const beforeMarks = await marks(page);
  expect(beforeMarks).toHaveLength(1); expect(beforeMarks[0]!.input.agentId).toBe("performance-baseline"); expect(beforeMarks[0]!.input.attentionTimestamp).toBe(next.attentionTimestamp);
  await closeDetail(page);
  await expect(page.getByRole("button", { name: "未读 1", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("acknowledged results can be archived under the original Agent identity", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await expect(detail.getByRole("button", { name: "归档", exact: true })).toHaveCount(0);
  await markRead(page);
  await expect(detail.getByLabel("已完成，已读", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "归档", exact: true }).click();
  await expect(detail).toHaveCount(0);
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toHaveCount(0);
  await menu(page, "已归档会话");
  await expect(page.getByRole("button", { name: "查看 整理性能基线，已完成", exact: true })).toBeVisible();
  const operations = await page.evaluate(() => (globalThis as Fixture).__previewAgentOperations);
  expect(operations).toEqual([{ type: "archive", agentId: "performance-baseline" }]);
});

test("overflow menu switches list and tree, sort order, and exports the filtered snapshot", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await expect(page.getByText("最近", { exact: true })).toBeVisible();
  await menu(page, "切换为列表");
  // A flat list shows every session on its own row; nothing needs expanding.
  await expect(page.getByRole("button", { name: "查看 实现幂等请求，执行中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^展开 .* 的子 agent$/ })).toHaveCount(0);
  await menu(page, "切换为树状");
  await expect(page.getByRole("button", { name: "查看 实现幂等请求，执行中", exact: true })).toHaveCount(0);
  await menu(page, "展开全部子 Agent");
  await expect(page.getByRole("button", { name: "查看 验证重复请求，已完成", exact: true })).toBeVisible();
  await menu(page, "收起全部子 Agent");
  await expect(page.getByRole("button", { name: "查看 验证重复请求，已完成", exact: true })).toHaveCount(0);
  await menu(page, "按最近活动排序");
  await expect(page.getByText("最近", { exact: true })).toHaveCount(0);
  await menu(page, "按需要处理排序");
  await expect(page.getByText("最近", { exact: true })).toBeVisible();
  await selectProject(page, "Delivery Systems");
  await menu(page, "导出快照");
  await expect(toast(page, "观测快照已复制")).toBeVisible();
  const snapshot = JSON.parse(await page.evaluate(() => (globalThis as Fixture).__previewClipboard ?? "{}"));
  expect(snapshot.agents.map((agent: { id: string }) => agent.id)).toEqual(["release-check"]);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "menu");
});

const moving = (root: import("@playwright/test").Locator) => root.evaluate(element => [element, ...element.querySelectorAll("div")].filter(node => { const name = getComputedStyle(node).animationName; return !!name && name !== "none"; }).length);
test("each state has its own mark: live work moves and ticks, a change flashes once, reduced motion keeps everything still", async ({ page }, testInfo) => {
  await open(page, testInfo);
  const running = page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true });
  const waiting = page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true });
  const failed = page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true });
  await expect(waiting.getByText("待审批 2", { exact: true })).toBeVisible();
  await expect(failed.getByText("异常", { exact: true })).toBeVisible();
  // The spinner turns and the approval mark radiates; a failure is loud but still.
  expect(await moving(running)).toBeGreaterThan(0);
  expect(await moving(waiting)).toBeGreaterThan(0);
  expect(await moving(failed)).toBe(0);
  // The running turn's elapsed time ticks every second on the client.
  const timer = running.getByText(/^\d+:\d{2}$/);
  const before = await timer.textContent();
  await expect.poll(() => timer.textContent(), { timeout: 3000 }).not.toBe(before);
  // Completing the turn flashes the row once in its new state (changes while data is still arriving right after open do not).
  await page.waitForTimeout(3100);
  await page.evaluate(() => (globalThis as Fixture).__previewCompleteAgent("payment-root"));
  const finished = page.getByRole("button", { name: "查看 重构支付服务，已完成", exact: true });
  await expect(finished.getByText("未读", { exact: true })).toBeVisible();
  expect(await moving(finished)).toBeGreaterThan(0);
  // With reduced motion nothing loops; states still differ by mark and label.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await open(page, testInfo);
  await expect.poll(() => moving(page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true }))).toBe(0);
  await expect(page.getByRole("button", { name: "查看 审查数据库迁移，待审批", exact: true }).getByText("待审批 2", { exact: true })).toBeVisible();
});

test("看板 shows the statistics board and its live counts open the matching sessions", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await open(page, testInfo);
  // Statistics are fetched only once a statistics view is open.
  expect(await statsCalls(page)).toEqual([]);
  await page.getByRole("tab", { name: /^看板/ }).click();
  await expect(page.getByRole("tab", { name: /^看板/ })).toHaveAttribute("aria-selected", "true");
  for (const title of ["连续天数", "年度活跃", "成长档案", "趋势", "高光时刻", "活跃时段", "模型阵容"]) await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/^近 30 天 /)).toBeVisible();
  const first = (await statsCalls(page))[0]!;
  expect(first.range).toBe("30d");
  expect(first.utcOffsetMinutes).toBe(await page.evaluate(() => -new Date().getTimezoneOffset()));
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "board");
  await page.getByRole("tablist", { name: "统计范围" }).getByRole("tab", { name: "7 天", exact: true }).click();
  await expect(page.getByText(/^近 7 天 /)).toBeVisible();
  expect((await statsCalls(page)).some(call => call.range === "7d")).toBe(true);
  await page.getByRole("button", { name: "查看全部徽章", exact: true }).click();
  const badges = page.getByRole("dialog", { name: "全部徽章", exact: true });
  await expect(badges.getByText("第一次点灯", { exact: true })).toBeVisible();
  await expect(badges.getByText("马拉松", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(badges).toHaveCount(0);
  await page.getByRole("button", { name: /^待回复 \d+$/ }).click();
  await expect(page.getByRole("tab", { name: /^会话/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "查看 规划下一轮迭代，待回复", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^查看 重构支付服务，/ })).toHaveCount(0);
  await page.getByRole("tab", { name: /^看板/ }).click();
  await page.getByRole("button", { name: /^执行中 \d+$/ }).click();
  await expect(page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "查看 规划下一轮迭代，待回复", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("看板's quota chip shows an old reading with its time, never as an alarm", async ({ page }, testInfo) => {
  await open(page, testInfo, "quota-stale");
  await page.getByRole("tab", { name: /^看板/ }).click();
  // The last reading forecast running out, then reads failed: the chip says when it was read instead (codex-F8).
  const chip = page.getByRole("button", { name: /已用 \d+%，读数 [^，]+，不是当前读数$/ });
  await expect(chip).toBeVisible();
  await expect(chip.getByText(/用完$/)).toHaveCount(0);
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "quota-stale");
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^看板/ }).click();
  await expect(page.getByRole("button", { name: /已用 \d+%/ }).first()).toBeVisible();
  await expect(page.getByRole("button", { name: /不是当前读数$/ })).toHaveCount(0);
});

test("明细 ranks models, harnesses, vendors, projects and tools, and 观测 keeps the observation charts", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^明细/ }).click();
  await expect(page.getByText("模型分布", { exact: true })).toBeVisible();
  await expect(page.getByText("claude-opus-5-5[1m]", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("时间与产出", { exact: true })).toBeVisible();
  await page.getByRole("tablist", { name: "排序指标" }).getByRole("tab", { name: "代码", exact: true }).click();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "breakdown");
  const dimensions = page.getByRole("tablist", { name: "明细维度" });
  for (const [dimension, title, row] of [["厂商", "厂商分布", "Anthropic"], ["Harness", "Harness分布", "opencode"], ["项目", "项目分布", "Commerce Platform"]] as const) {
    await dimensions.getByRole("tab", { name: dimension, exact: true }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    await expect(page.getByText(row, { exact: true }).first()).toBeVisible();
  }
  await dimensions.getByRole("tab", { name: "工具", exact: true }).click();
  await expect(page.getByText("工具类型", { exact: true })).toBeVisible();
  await expect(page.getByText("常用工具", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await dimensions.getByRole("tab", { name: "观测", exact: true }).click();
  await expect(page.getByRole("button", { name: heatCell })).toHaveCount(168);
  expect(errors).toEqual([]);
});

test("横评 compares two models head to head and can swap or pick either side", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^横评/ }).click();
  await expect(page.getByText("能力雷达", { exact: true })).toBeVisible();
  for (const group of ["产出", "效率", "质量", "投入"]) await expect(page.getByText(group, { exact: true }).first()).toBeVisible();
  const left = page.getByRole("button", { name: /^选择左边，当前 / }), right = page.getByRole("button", { name: /^选择右边，当前 / });
  await expect(left).toHaveAccessibleName("选择左边，当前 claude-opus-5-5[1m]");
  await expect(right).toHaveAccessibleName("选择右边，当前 gpt-5-codex");
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "compare");
  await page.getByRole("button", { name: "交换左右", exact: true }).click();
  await expect(left).toHaveAccessibleName("选择左边，当前 gpt-5-codex");
  await left.click();
  const picker = page.getByRole("dialog", { name: "选择 A", exact: true });
  await expect(picker.getByRole("button", { name: "claude-opus-5-5[1m]", exact: true })).toHaveCount(0);
  await picker.getByRole("button", { name: "grok-4.6", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(left).toHaveAccessibleName("选择左边，当前 grok-4.6");
  await expect(right).toHaveAccessibleName("选择右边，当前 claude-opus-5-5[1m]");
  await page.getByRole("tablist", { name: "横评维度" }).getByRole("tab", { name: "厂商", exact: true }).click();
  await expect(left).toHaveAccessibleName("选择左边，当前 Anthropic");
  expect(errors).toEqual([]);
});

test("statistics views show loading failures and empty history without breaking the layout", async ({ page }, testInfo) => {
  await open(page, testInfo, "stats-error");
  await page.getByRole("tab", { name: /^看板/ }).click();
  await expect(page.getByText("统计暂时读不到", { exact: true })).toBeVisible();
  await expect(page.getByText("模拟统计读取失败", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^横评/ }).click();
  await expect(page.getByText("统计暂时读不到", { exact: true })).toBeVisible();
  await open(page, testInfo, "stats-empty");
  await page.getByRole("tab", { name: /^看板/ }).click();
  await expect(page.getByText("0 轮对话", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole("tab", { name: /^横评/ }).click();
  await expect(page.getByText("至少需要两个有数据的模型才能对比", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^明细/ }).click();
  await expect(page.getByText("这个范围内还没有数据", { exact: true })).toBeVisible();
});

test("事件 swimlane shows each Agent's turns and approval waits and opens the Agent", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^事件/ }).click();
  await expect(page.getByText("并行泳道", { exact: true })).toBeVisible();
  await expect(page.getByText(/个同时执行/)).toBeVisible();
  const lane = page.getByRole("button", { name: /^泳道 实现幂等请求：执行中 / });
  await expect(lane).toBeVisible();
  await expect(page.getByRole("button", { name: /^泳道 检查发布流水线：失败 / })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "swimlane");
  await page.getByRole("tablist", { name: "泳道时间窗" }).getByRole("tab", { name: "24 小时", exact: true }).click();
  await expect(lane).toBeVisible();
  await lane.click();
  await expect(page.getByTestId("agent-detail")).toBeVisible();
  await expect(page.getByTestId("agent-detail").getByText("实现幂等请求").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("background-only swimlanes survive an empty event log and obey project filters", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "background-no-events");
  await page.getByRole("tab", { name: /^事件/ }).click();
  const lane = page.getByRole("button", { name: /^泳道 整理性能基线：执行中 / });
  await expect(lane).toBeVisible();
  await expect(page.getByText(/^0 轮 · 峰值 2 个同时执行/)).toBeVisible();
  await expect(page.getByText("这个时间窗内没有记录到对话轮次", { exact: true })).toHaveCount(0);
  await noHorizontalOverflow(page);
  await page.getByRole("tab", { name: /^会话/ }).click();
  await selectProject(page, "Mobile Experience");
  await page.getByRole("tab", { name: /^事件/ }).click();
  await expect(lane).toHaveCount(0);
  await expect(page.getByText("并行泳道", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

const tokenCalls = (page: Page) => page.evaluate(() => (globalThis as Fixture).__previewRpcCalls.filter(call => call.name === "observatory.tokens.get" || call.name === "observatory.tokens.live").map(call => ({ name: call.name, input: call.input as { range?: string; windowMinutes?: number; detail?: string; utcOffsetMinutes?: number } })));

test("Token 页 shows today's usage, the live speed chart and breakdowns from the local logs", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await open(page, testInfo);
  // The session list only asks for the running sessions' speeds (a small "agents" reply), shown on running rows.
  await expect(page.getByLabel(/^每秒输出 [\d.]+ 个 token$/).first()).toBeVisible();
  expect((await tokenCalls(page)).filter(call => call.name === "observatory.tokens.get" || call.input.detail === "full")).toEqual([]);
  expect((await tokenCalls(page)).every(call => call.input.detail === "agents")).toBe(true);
  await page.getByRole("tab", { name: /^Token/ }).click();
  await expect(page.getByText("今天已消耗", { exact: true })).toBeVisible();
  await expect(page.getByText("实时流速", { exact: true })).toBeVisible();
  await expect(page.getByLabel(/^当前每秒 [\d.,]+ 个 token$/)).toBeVisible();
  for (const title of ["总 Token", "缓存命中率", "输出速率", "Token 趋势", "Token 构成", "模型用量", "项目用量", "最耗 Token 的会话", "时段与纪录"]) await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("claude-opus-5-5", { exact: true }).first()).toBeVisible();
  const calls = await tokenCalls(page);
  expect(calls.find(call => call.name === "observatory.tokens.get")!.input.range).toBe("30d");
  // Days and hours are the device's: the request names its zone (opus-F42).
  expect(calls.find(call => call.name === "observatory.tokens.get")!.input).toMatchObject({ timeZone: await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone) });
  // Grok CLI and Pi logs are counted too (opus-F35, opus-F36).
  await expect(page.getByText(/Grok CLI \d+ 个会话/).first()).toBeVisible();
  expect(calls.find(call => call.name === "observatory.tokens.live" && call.input.detail === "full")!.input).toMatchObject({ windowMinutes: 30, detail: "full" });
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "tokens");
  // A minute of the live chart shows its speed.
  await page.getByRole("button", { name: /^\d{2}:\d{2}，每秒 [\d.,]+ 个 token$/ }).last().click();
  await expect(page.getByText(/这一分钟/)).toBeVisible();
  await page.getByRole("tablist", { name: "流速时间窗" }).getByRole("tab", { name: "60 分钟", exact: true }).click();
  await expect.poll(async () => (await tokenCalls(page)).some(call => call.input.windowMinutes === 60)).toBe(true);
  await page.getByRole("tablist", { name: "趋势指标" }).getByRole("tab", { name: "非缓存", exact: true }).click();
  await expect(page.getByText("缓存写入", { exact: true }).first()).toBeVisible();
  // Live rows and top sessions open the matching agent.
  await page.getByRole("button", { name: /^重构支付服务，每秒 [\d.,]+ 个 token$/ }).click();
  await expect(page.getByTestId("agent-detail")).toBeVisible();
  // Phones push the detail as a full page without the view tabs.
  if (!compact(page)) await expect(page.getByRole("tab", { name: /^会话/ })).toHaveAttribute("aria-selected", "true");
  expect(errors).toEqual([]);
});

test("Token 页 shows the import progress, a quiet live feed and read failures", async ({ page }, testInfo) => {
  await open(page, testInfo, "tokens-empty");
  await page.getByRole("tab", { name: /^Token/ }).click();
  await expect(page.getByText("正在导入历史日志 42%", { exact: true })).toBeVisible();
  await expect(page.getByText("最近 10 分钟没有模型在输出", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await open(page, testInfo, "tokens-error");
  await page.getByRole("tab", { name: /^Token/ }).click();
  await expect(page.getByText("Token 统计暂时读不到", { exact: true })).toBeVisible();
  await expect(page.getByText("模拟 Token 统计读取失败", { exact: true })).toBeVisible();
});

test("复盘 folds an agent's execution into a timeline, key moments and per-turn summaries", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "复盘", exact: true }).click();
  for (const title of ["执行时间轴", "重点", "时间都去哪了", "按轮回顾", "命令与检查", "动过的文件", "每次模型调用"]) await expect(detail.getByText(title, { exact: true })).toBeVisible();
  await expect(detail.getByText("测试失败 2 次后通过", { exact: true }).first()).toBeVisible();
  await expect(detail.getByText("最慢的命令", { exact: true }).first()).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "digest");
  // Zoom into turn 2 and pick its first failing test run.
  await detail.getByRole("button", { name: "第 2 轮，完成", exact: true }).click();
  await expect(detail.getByText(/^#2 按方案实现幂等键/)).toBeVisible();
  await detail.getByRole("button", { name: /^命令：Bash · npm run test:payments，.*，失败$/ }).first().click();
  await expect(detail.getByText(/^#2 · .* · 失败$/)).toBeVisible();
  await detail.getByRole("button", { name: "看全部", exact: true }).click();
  // A passing test run jumps to its raw row in 时间线.
  await detail.getByRole("button", { name: /^测试第 3 次，通过：npm run test -- --runInBand$/ }).click();
  // The kit's detail tabs carry no aria-selected on web; the 时间线 filter bar shows the switch happened.
  await expect(detail.getByRole("tablist", { name: "时间线筛选" })).toBeVisible();
  await expect(detail.getByText("npm run test -- --runInBand").first()).toBeVisible();
  await expect(detail.getByText("引用超出了当前保留的历史范围", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("复盘 explains a failed agent and shows empty and failed reads", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("button", { name: "查看 检查发布流水线，异常", exact: true }).click();
  const detail = page.getByTestId("agent-detail");
  await detail.getByRole("tab", { name: "复盘", exact: true }).click();
  for (const title of ["这一轮以失败结束", "连续 4 次失败", "测试失败 3 次"]) await expect(detail.getByText(title, { exact: true }).first()).toBeVisible();
  await open(page, testInfo, "digest-error");
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  await page.getByTestId("agent-detail").getByRole("tab", { name: "复盘", exact: true }).click();
  await expect(page.getByText("复盘暂时读不到", { exact: true })).toBeVisible();
  await open(page, testInfo, "digest-empty");
  await page.getByRole("button", { name: "查看 重构支付服务，执行中", exact: true }).click();
  await page.getByTestId("agent-detail").getByRole("tab", { name: "复盘", exact: true }).click();
  await expect(page.getByText("还没有可复盘的执行记录", { exact: true })).toBeVisible();
});

test("智能分析总览 rolls up recent reports and turns suggestions into actions", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await open(page, testInfo, "insights-rich");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await expect(page.getByText("测试失败后原样重跑是最大的时间黑洞，两个项目的验证环境不稳定", { exact: true })).toBeVisible();
  await expect(page.getByText("分析报告", { exact: true })).toBeVisible();
  await expect(page.getByText("限制同一失败命令的重跑次数", { exact: true })).toBeVisible();
  await expect(page.getByText("反复出现的问题", { exact: true })).toBeVisible();
  await expect(page.getByText("自动分析已关闭：新报告只在你手动分析时产生，建议也不会自动更新", { exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "insights-overview");
  // Long model prose folds on phones only.
  const more = page.getByRole("button", { name: "展开全文", exact: true });
  if (testInfo.project.name.startsWith("mobile")) { await more.click(); await expect(page.getByRole("button", { name: "收起", exact: true })).toBeVisible(); }
  else await expect(more).toHaveCount(0);
  // The first suggestion is open: copy its instruction, then adopt it.
  await page.getByRole("button", { name: "复制指令", exact: true }).first().click();
  await expect(toast(page, "指令已复制")).toBeVisible();
  expect(await page.evaluate(() => (globalThis as Fixture).__previewClipboard)).toContain("同一条命令连续失败两次后");
  await page.getByRole("tablist", { name: "建议 1 的处理状态", exact: true }).getByRole("tab", { name: "采纳", exact: true }).click();
  await expect.poll(() => rpcCalls(page, "observatory.insights.action-feedback")).toEqual([{ jobId: "fixture-suggestions-1", actionId: "a1", status: "adopted" }]);
  // Hand the tooling suggestion to a new Agent in its project with the implementation profile.
  await page.getByRole("button", { name: "展开建议 给集成测试准备可复用的本地测试数据库", exact: true }).click();
  await page.getByRole("button", { name: "交给 Agent", exact: true }).first().click();
  const handoff = page.getByRole("dialog", { name: "交给 Agent", exact: true });
  await expect(handoff.getByRole("radio", { name: "项目 Delivery Systems", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(handoff.getByRole("radio", { name: "Profile 实现 · 长程执行与交付", exact: true })).toHaveAttribute("aria-checked", "true");
  await handoff.getByRole("button", { name: "开始", exact: true }).click();
  await expect(handoff).toHaveCount(0);
  const created = await page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "create"));
  expect(created).toHaveLength(1);
  expect(created[0]).toMatchObject({ workspaceId: "delivery", input: { config: { provider: "codex/gpt-5-codex", modeId: "full-access", thinkingOptionId: "high" }, title: "给集成测试准备可复用的本地测试数据库" } });
  expect((created[0]!.input as { prompt: string }).prompt).toContain("可复用的本地测试数据库");
  await expect.poll(() => rpcCalls(page, "observatory.insights.action-feedback")).toContainEqual({ jobId: "fixture-suggestions-1", actionId: "a2", status: "adopted" });
  // Evidence opens the report it came from.
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await page.getByRole("button", { name: "查看问题 测试数据库连接超时，任务停在验证环节，检查发布流水线", exact: true }).click();
  const panel = page.getByTestId("insights-panel");
  await expect(panel.getByText("检查发布流水线：发现 2 个值得跟进的问题。", { exact: true })).toBeVisible();
  await expect(panel.getByText("Grok 4.7 · xhigh", { exact: false }).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("智能分析总览 writes suggestions on demand and shows progress, failures and the empty state", async ({ page }, testInfo) => {
  await open(page, testInfo, "insights-rich");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await page.getByRole("button", { name: "更新建议 · 2 份新报告", exact: true }).click();
  // The 7 days are the device's local days: the request carries its zone (opus-F40).
  const browserZone = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  await expect.poll(() => rpcCalls(page, "observatory.insights.suggest")).toEqual([{ days: 7, timeZone: browserZone, utcOffsetMinutes: expect.any(Number) }]);
  await page.getByRole("tablist", { name: "总览范围", exact: true }).getByRole("tab", { name: "30 天", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.insights.overview")).some(call => call.days === 30)).toBe(true);
  await open(page, testInfo, "insights-suggesting");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await expect(page.getByText("Grok 4.7 · xhigh 正在读 12 份报告，寻找跨 Agent 的模式", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "取消生成建议", exact: true })).toBeVisible();
  await open(page, testInfo, "insights-suggest-failed");
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await expect(page.getByText("上次生成建议失败：模拟：分析模型没有返回合法的 JSON。", { exact: true })).toBeVisible();
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await expect(page.getByText("近 7 天还没有分析报告", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "打开自动分析", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "分析设置", exact: true })).toBeVisible();
  await noHorizontalOverflow(page);
});

test("分析设置 picks a profile or another model, and the Agent's 分析 tab can run once with a different model", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await page.getByRole("button", { name: "分析设置", exact: true }).first().click();
  const settings = page.getByRole("dialog", { name: "分析设置", exact: true });
  await expect(settings.getByRole("radio", { name: "自动选择", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(settings.getByRole("radio", { name: "Grok 4.7 · xhigh", exact: true })).toHaveAttribute("aria-checked", "false");
  await expect(settings.getByRole("radio", { name: "探索 · 并行查证（不可用）", exact: true })).toBeDisabled();
  await settings.getByRole("radio", { name: "实现 · 长程执行与交付", exact: true }).click();
  await expect.poll(() => rpcCalls(page, "observatory.insights.configure")).toEqual([{ runner: { kind: "profile", profileId: "implement" } }]);
  await expect(settings.getByRole("radio", { name: "实现 · 长程执行与交付", exact: true })).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("button", { name: "选择其他模型", exact: true }).click();
  await settings.getByRole("button", { name: "Claude Code", exact: true }).click();
  await settings.getByRole("radio", { name: "Sonnet 5", exact: true }).click();
  await settings.getByRole("button", { name: "高", exact: true }).click();
  await settings.getByRole("button", { name: "使用 Sonnet 5", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.insights.configure")).at(-1)).toEqual({ runner: { kind: "provider", provider: "claude", model: "claude-sonnet-5", thinkingOptionId: "high" } });
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "insights-settings");
  await settings.getByRole("button", { name: "关闭", exact: true }).click();
  await reportsView(page);
  await expect(page.getByText("Claude Code · Sonnet 5 · high", { exact: true })).toBeVisible();
  // One analysis with a different model, then follow the report up with the Agent itself.
  await page.getByRole("button", { name: "新建分析", exact: true }).first().click();
  await page.getByRole("button", { name: "选择分析 重构支付服务", exact: true }).click();
  const panel = page.getByTestId("insights-panel");
  await panel.getByRole("button", { name: "更多分析操作", exact: true }).click();
  await page.getByRole("dialog", { name: "更多分析操作", exact: true }).getByRole("button", { name: "换个模型分析", exact: true }).click();
  await page.getByRole("dialog", { name: "换个模型分析", exact: true }).getByRole("radio", { name: "日常 · Opus 5.5", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.insights.start")).at(-1)).toMatchObject({ agentId: "payment-root", runner: { kind: "profile", profileId: "daily" } });
  await expect(panel.getByText("日常 · Opus 5.5", { exact: false }).first()).toBeVisible();
  await panel.getByRole("button", { name: "发给这个 Agent", exact: true }).first().click();
  const send = page.getByRole("dialog", { name: "发给这个 Agent", exact: true });
  await expect(send.getByRole("textbox", { name: "消息", exact: true })).toHaveValue(/复用已通过的测试结果/);
  // 重构支付服务 is running on a provider that takes a message mid-turn: it is steered in, not interrupted (opus-F10).
  await expect(send.getByText(/运行中，插进当前回合，不打断/)).toBeVisible();
  await send.getByRole("button", { name: "插入这一轮", exact: true }).click();
  await expect(send).toHaveCount(0);
  const sent = await page.evaluate(() => (globalThis as Fixture).__previewAgentOperations.filter(operation => operation.type === "send"));
  // One message id per message: a retry reuses it, so the host delivers the message at most once (kit send-plan).
  expect(sent).toEqual([expect.objectContaining({ agentId: "payment-root", input: expect.stringContaining("复用已通过的测试结果"), options: { activeTurnBehavior: "steer", messageId: expect.any(String) } })]);
});

test("分析设置 lets the built-in Grok CLI use another model and reasoning effort, and resets to grok-4.7 · xhigh", async ({ page }, testInfo) => {
  await open(page, testInfo);
  await page.getByRole("tab", { name: /^(智能分析|分析)$/ }).click();
  await page.getByRole("button", { name: "分析设置", exact: true }).first().click();
  const settings = page.getByRole("dialog", { name: "分析设置", exact: true });
  await expect(settings.getByRole("textbox", { name: "Grok 模型", exact: true })).toHaveCount(0);
  await settings.getByRole("radio", { name: "Grok 4.7 · xhigh", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.insights.configure")).at(-1)).toEqual({ runner: { kind: "grok" } });
  const model = settings.getByRole("textbox", { name: "Grok 模型", exact: true });
  await expect(model).toHaveValue("");
  await expect(settings.getByRole("button", { name: "保存 Grok 设置", exact: true })).toBeDisabled();
  // An option-like or shell-like id is refused before it reaches the CLI.
  await model.fill("--always-approve");
  await expect(settings.getByText("模型 ID 只能包含字母、数字和 . _ : / -，并以字母或数字开头", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "保存 Grok 设置", exact: true })).toBeDisabled();
  await model.fill("grok-4.6");
  await settings.getByRole("button", { name: "high", exact: true }).click();
  await noHorizontalOverflow(page);
  await screenshot(page, testInfo, "insights-settings-grok");
  await settings.getByRole("button", { name: "保存 Grok 设置", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.insights.configure")).at(-1)).toEqual({ runner: { kind: "grok", model: "grok-4.6", effort: "high" } });
  await expect(settings.getByRole("radio", { name: "Grok 4.6 · high", exact: true })).toHaveAttribute("aria-checked", "true");
  await settings.getByRole("button", { name: "恢复默认", exact: true }).click();
  await expect.poll(async () => (await rpcCalls(page, "observatory.insights.configure")).at(-1)).toEqual({ runner: { kind: "grok" } });
  await expect(settings.getByRole("radio", { name: "Grok 4.7 · xhigh", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(model).toHaveValue("");
});

// ---------- 定时运行 (2.9) ----------
// Fixture zones: 站会 / 依赖 / 周报 run in 东京时间 (the device's zone), 夜间回归 is a zone-less cron (UTC), 环境诊断 runs in New York time.
test.describe("定时运行", () => {
  test.use({ timezoneId: "Asia/Tokyo" });
  const schedulesQuery = (testInfo: TestInfo, scenario = "all") => `/?theme=${testInfo.project.name === "desktop-light" ? "light" : "dark"}&scenario=${scenario}&surface=schedules`;
  async function openSchedules(page: Page, testInfo: TestInfo, scenario = "all") {
    await page.goto(schedulesQuery(testInfo, scenario));
    await expect(page.getByRole("button", { name: "更多操作", exact: true }).first()).toBeVisible();
  }
  const runRow = (page: Page, name: string, status: string) => page.getByRole("button", { name: new RegExp(`^${name}，${status}，`) });
  async function scheduleCard(page: Page, name: string) {
    const card = page.getByRole("button", { name: new RegExp(`^${name}，\\d+ 次运行`) });
    // Wide screens fold the strip to one row.
    if (await card.count() === 0) await page.getByRole("button", { name: /^显示另外 \d+ 个定时任务$/ }).click();
    await expect(card).toHaveCount(1);
    return card;
  }
  async function openRun(page: Page, name: string, status: string) {
    await runRow(page, name, status).first().click();
    await expect(page.getByTestId("schedule-run-detail")).toBeVisible();
    return page.getByTestId("schedule-run-detail");
  }
  function collectErrors(page: Page) {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    return errors;
  }
  const nestedButtons = (page: Page) => page.locator("button button, [role=button] [role=button], a a").count();

  test("groups runs by day, hides heartbeats until asked, and sums the last 7 days", async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await openSchedules(page, testInfo);
    await expect(page.getByText("近 7 天 19 次运行", { exact: true })).toBeVisible();
    await expect(page.getByText("失败 5 次 · 成功率 74%", { exact: true })).toBeVisible();
    for (const chip of ["失败 5", "执行中 1", "成功 17", "心跳 12"]) await expect(page.getByRole("button", { name: chip, exact: true })).toBeVisible();
    await expect(page.getByText("今天", { exact: true })).toBeVisible();
    await expect(runRow(page, "依赖升级 · 每日", "执行中")).toBeVisible();
    await expect(runRow(page, "每日站会摘要", "成功").first().getByText("!42", { exact: true })).toBeVisible();
    await expect(page.getByText("2 次运行来自已删除的定时任务，只能从 Agent 还原", { exact: true })).toBeVisible();
    await expect(runRow(page, "巡检心跳", "成功")).toHaveCount(0);
    await page.getByRole("button", { name: "心跳 12", exact: true }).click();
    await expect(runRow(page, "巡检心跳", "成功").first()).toBeVisible();
    await expect(page.getByText("近 7 天 31 次运行", { exact: true })).toBeVisible();
    await expect(page.getByText("Agent 正在忙，这次心跳被跳过", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "心跳 12", exact: true }).click();
    await expect(runRow(page, "巡检心跳", "成功")).toHaveCount(0);
    // A refresh with the same revision costs a few bytes and keeps the list.
    await menu(page, "刷新");
    await expect.poll(async () => (await rpcCalls(page, "observatory.schedules.list")).at(-1)).toEqual({ window: "recent", revision: "fixture-schedules-recent" });
    await expect(runRow(page, "依赖升级 · 每日", "执行中")).toBeVisible();
    expect(await nestedButtons(page)).toBe(0);
    await noHorizontalOverflow(page);
    await screenshot(page, testInfo, "schedules-feed");
    expect(errors).toEqual([]);
  });

  test("a run shows its recorded reply with lists and links, its merge request, Agent and workspace", async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await openSchedules(page, testInfo);
    await page.evaluate(() => { window.open = ((url: string) => { (globalThis as { __previewExternal?: string }).__previewExternal = url; return null; }) as typeof window.open; });
    const detail = await openRun(page, "每日站会摘要", "成功");
    await expect(detail.getByRole("heading", { name: "昨日进展", exact: true })).toBeVisible();
    await expect(detail.getByText("checkout.retry.spec.ts", { exact: false })).toBeVisible();
    await expect(detail.getByText("流水线：主干 3 次构建全部通过。", { exact: true })).toBeVisible();
    await expect(detail.getByText("汇总昨天合并的改动、未关闭的合并请求和失败的流水线，写成站会摘要。", { exact: true })).toBeVisible();
    const url = "https://code.example.com/commerce/checkout/-/merge_requests/42";
    await detail.getByRole("link", { name: url, exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as { __previewExternal?: string }).__previewExternal)).toBe(url);
    await page.evaluate(() => { delete (globalThis as { __previewExternal?: string }).__previewExternal; });
    await detail.getByRole("button", { name: "打开 !42", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as { __previewExternal?: string }).__previewExternal)).toBe(url);
    await detail.getByRole("button", { name: "打开会话（已归档）", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewOpenedAgent)).toBe("fixture-standup-1");
    await detail.getByRole("button", { name: "打开工作区", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as { __previewOpenedWorkspace?: string }).__previewOpenedWorkspace)).toBe("ws-standup-1");
    await page.getByRole("button", { name: "复制运行 ID", exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewClipboard)).toBe("c61d0735-0752-41e1-aebd-636508cb6973");
    expect(await rpcCalls(page, "observatory.schedules.run")).toEqual([{ runId: "c61d0735-0752-41e1-aebd-636508cb6973" }]);
    if (compact(page)) await expect(page.getByText("运行详情", { exact: true })).toBeVisible();
    expect(await nestedButtons(page)).toBe(0);
    await noHorizontalOverflow(page);
    await screenshot(page, testInfo, "schedules-detail");
    await page.getByRole("button", { name: /^(返回列表|关闭详情)$/ }).click();
    await expect(page.getByTestId("schedule-run-detail")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("a run that just started can open its Agent before the directory names it", async ({ page }, testInfo) => {
    await openSchedules(page, testInfo);
    const detail = await openRun(page, "依赖升级 · 每日", "执行中");
    await expect(detail.getByText("还在运行，结束后会记录最终回复。", { exact: true })).toBeVisible();
    await expect(detail.getByText("正在同步名称…", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "打开会话", exact: true }).click();
    await expect.poll(() => page.evaluate(() => (globalThis as Fixture).__previewOpenedAgent)).toBe("fixture-deps-1");
    await expect(detail.getByText(/^已运行 /)).toBeVisible();
  });

  test("failed runs explain themselves in Chinese and read the session only on tap", async ({ page }, testInfo) => {
    await openSchedules(page, testInfo);
    await page.getByRole("button", { name: "失败 5", exact: true }).click();
    await expect(runRow(page, "每日站会摘要", "成功")).toHaveCount(0);
    for (const text of ["工作目录已不存在：/workspace/delivery-nightly（任务已自动结束）", "Provider「opencode」启动超时", "Agent 在等你审批，这次没能跑完", "daemon 重启，打断了这次运行", "会话无法恢复：这个 ACP Agent 不支持重新载入"])
      await expect(page.getByText(text, { exact: true }).first()).toBeVisible();
    await expect(runRow(page, "夜间回归测试", "失败").getByText("未启动 Agent", { exact: true })).toBeVisible();
    const detail = await openRun(page, "每日站会摘要", "失败");
    await expect(detail.getByText("原始错误：Agent fixture-standup-4 is waiting for permission: exec_command", { exact: true })).toBeVisible();
    await expect(detail.getByText("这次运行没有记录最终回复，可以读取会话记录。", { exact: true })).toBeVisible();
    expect(await rpcCalls(page, "observatory.results.get")).toEqual([]);
    await detail.getByRole("button", { name: "读取会话记录", exact: true }).click();
    await expect.poll(() => rpcCalls(page, "observatory.results.get")).toEqual([{ agentId: "fixture-standup-4" }]);
    await expect(detail.getByText("幂等校验已经接入，18 项接口测试通过。正在等待子任务返回并发写入验证结果。", { exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
  });

  test("schedule cards filter the feed, show other time zones, and 加载更早 reaches past 30 days", async ({ page }, testInfo) => {
    await openSchedules(page, testInfo);
    await expect(page.getByText("每天 02:00（UTC）", { exact: true })).toBeVisible();
    await expect(page.getByText("工作日 09:00", { exact: true })).toBeVisible();
    await scheduleCard(page, "每日环境诊断");
    await expect(page.getByText("每天 07:00（美东时间）", { exact: true })).toBeVisible();
    const weekly = await scheduleCard(page, "每周版本报告");
    await weekly.click();
    await expect(weekly).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "移除 每周版本报告", exact: true })).toBeVisible();
    await expect(runRow(page, "每周版本报告", "成功")).toHaveCount(4);
    await expect(runRow(page, "每日站会摘要", "成功")).toHaveCount(0);
    await expect(page.getByText("还有 2 次更早的运行", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "加载更早", exact: true }).click();
    await expect(runRow(page, "每周版本报告", "成功")).toHaveCount(6);
    await expect(page.getByText("还有 2 次更早的运行", { exact: true })).toHaveCount(0);
    expect((await rpcCalls(page, "observatory.schedules.list")).map(call => call.window)).toEqual(["recent", "all"]);
    await page.getByRole("button", { name: "移除 每周版本报告", exact: true }).click();
    await expect(runRow(page, "每日站会摘要", "成功").first()).toBeVisible();
    await noHorizontalOverflow(page);
  });

  test("runs of deleted schedules come from the ledger or, before it, from Agent labels", async ({ page }, testInfo) => {
    await openSchedules(page, testInfo);
    await (await scheduleCard(page, "旧版发布巡检")).click();
    let detail = await openRun(page, "旧版发布巡检", "成功");
    await expect(detail.getByText("这个定时任务已被删除，回复没有保留；可以读取会话记录查看最后回复。", { exact: true })).toBeVisible();
    await expect(detail.getByText("观测台账本（任务已删除）", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /^(返回列表|关闭详情)$/ }).click();
    await page.getByRole("button", { name: "移除 旧版发布巡检", exact: true }).click();
    await (await scheduleCard(page, "发布前检查")).click();
    await expect(runRow(page, "发布前检查", "结果未知")).toHaveCount(1);
    detail = await openRun(page, "发布前检查", "成功");
    await expect(detail.getByText("这个定时任务在观测台开始记录前已被删除，只能从 Agent 标签还原：没有计划时间、耗时和回复。", { exact: true })).toBeVisible();
    await expect(detail.getByText("Agent 标签（任务已删除）", { exact: true })).toBeVisible();
    // Its project was removed from Paseo: the host cannot open the session or workspace, so neither is offered.
    await expect(detail.getByText("这次运行所在的项目已从 Paseo 移除，宿主打不开它的会话和工作区；这里的信息来自 Paseo 保留的 Agent 记录。", { exact: true })).toBeVisible();
    await expect(detail.getByText("发布前检查（项目已移除）", { exact: true })).toBeVisible();
    await expect(detail.getByRole("button", { name: /^打开会话/ })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "打开工作区", exact: true })).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "读取会话记录", exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
  });

  test("Agent 详情 shows the 定时任务 card, and 查看全部运行 opens 定时运行 on that schedule", async ({ page }, testInfo) => {
    const errors = collectErrors(page);
    await open(page, testInfo);
    await search(page, "归档环境诊断");
    const row = page.getByRole("button", { name: "查看 归档环境诊断，已关闭", exact: true });
    await expect(row.getByLabel("由定时任务创建", { exact: true })).toBeVisible();
    await row.click();
    const card = page.getByTestId("agent-detail").getByTestId("schedule-run-card");
    await expect(card.getByText("每日环境诊断", { exact: true })).toBeVisible();
    await expect(card.getByText(/每天\s07:00（美东时间）\s·\s这次\s.+\s·\s耗时\s14\s分\s·\s已暂停/)).toBeVisible();
    // The page itself was never on screen, so it never polled.
    expect(await rpcCalls(page, "observatory.schedules.list")).toEqual([]);
    expect(await nestedButtons(page)).toBe(0);
    await screenshot(page, testInfo, "schedules-agent-card");
    await card.getByRole("button", { name: "查看全部运行", exact: true }).click();
    await expect(page.getByRole("button", { name: "移除 每日环境诊断", exact: true })).toBeVisible();
    await expect(runRow(page, "每日站会摘要", "成功")).toHaveCount(0);
    // The header names the focused schedule and sums its own week.
    await expect(page.getByText("近 7 天 2 次 · 失败 1 次 · 成功率 50%", { exact: true })).toBeVisible();
    if (compact(page)) {
      // On a phone the list comes first; the run is one tap away.
      await expect(page.getByTestId("schedule-run-detail")).toHaveCount(0);
      await expect(runRow(page, "每日环境诊断", "成功")).toBeVisible();
    } else {
      await expect(page.getByTestId("schedule-run-detail").getByText("预发布环境正常：数据库连接 12 ms，队列无积压，证书还有 64 天到期。", { exact: true })).toBeVisible();
      await expect(runRow(page, "每日环境诊断", "成功")).toHaveAttribute("aria-pressed", "true");
    }
    await noHorizontalOverflow(page);
    expect(errors).toEqual([]);
  });

  test("an archived schedule Agent shows the recorded reply first and loads the session only on tap", async ({ page }, testInfo) => {
    await open(page, testInfo, "archives");
    await search(page, "上周版本报告");
    const row = page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true });
    await expect(row.getByLabel("由定时任务创建", { exact: true })).toBeVisible();
    await row.click();
    const detail = page.getByTestId("agent-detail");
    await expect(detail.getByTestId("schedule-run-card").getByText("每周版本报告", { exact: true })).toBeVisible();
    await expect(detail.getByRole("heading", { name: "第 41 周版本报告", exact: true })).toBeVisible();
    await expect(detail.getByText("定时任务记录", { exact: true })).toBeVisible();
    const reads = async () => (await rpcCalls(page, "observatory.results.get")).filter(call => call.agentId === "old-report").length;
    expect(await reads()).toBe(0);
    await noHorizontalOverflow(page);
    await screenshot(page, testInfo, "schedules-archived-reply");
    await detail.getByRole("button", { name: "读取完整结果", exact: true }).click();
    await expect.poll(reads).toBe(1);
    await expect(detail.getByText("历史迭代已完成，原会话保留两轮交互与测试证据。", { exact: true }).first()).toBeVisible();
  });

  test("an archived schedule Agent with nothing recorded reads its session as before", async ({ page }, testInfo) => {
    await open(page, testInfo, "schedule-no-reply&archives=1");
    await search(page, "上周版本报告");
    await page.getByRole("button", { name: "查看 上周版本报告，已关闭", exact: true }).click();
    const detail = page.getByTestId("agent-detail");
    await expect(detail.getByTestId("schedule-run-card")).toBeVisible();
    await expect.poll(async () => (await rpcCalls(page, "observatory.results.get")).filter(call => call.agentId === "old-report").length).toBe(1);
    await expect(detail.getByText("历史迭代已完成，原会话保留两轮交互与测试证据。", { exact: true }).first()).toBeVisible();
    await expect(detail.getByRole("button", { name: "读取完整结果", exact: true })).toHaveCount(0);
  });

  test("a schedule Agent whose session cannot be read still shows the reply its run recorded", async ({ page }, testInfo) => {
    await open(page, testInfo, "schedule-session-error");
    await search(page, "归档环境诊断");
    await page.getByRole("button", { name: "查看 归档环境诊断，已关闭", exact: true }).click();
    const detail = page.getByTestId("agent-detail");
    await expect(detail.getByText("会话读取失败：会话无法恢复：这个 ACP Agent 不支持重新载入。下面是定时任务记录的回复。", { exact: true })).toBeVisible();
    await expect(detail.getByText("预发布环境正常：数据库连接 12 ms，队列无积压，证书还有 64 天到期。", { exact: true })).toBeVisible();
    const reads = async () => (await rpcCalls(page, "observatory.results.get")).filter(call => call.agentId === "environment-closed").length;
    const before = await reads();
    await detail.getByRole("button", { name: "重试读取会话", exact: true }).click();
    await expect.poll(reads).toBeGreaterThan(before);
    await noHorizontalOverflow(page);
  });

  test("empty, unreadable and ledger-notice states", async ({ page }, testInfo) => {
    await openSchedules(page, testInfo, "schedules-empty");
    await expect(page.getByText("还没有定时运行", { exact: true })).toBeVisible();
    await expect(page.getByText("这 7 天没有运行", { exact: true })).toBeVisible();
    await openSchedules(page, testInfo, "schedules-error");
    await expect(page.getByText("暂时读不到定时运行", { exact: true })).toBeVisible();
    await expect(page.getByText("模拟：定时任务目录暂时读不到", { exact: true })).toBeVisible();
    await openSchedules(page, testInfo, "schedules-notice");
    await expect(page.getByText(/^定时运行账本损坏，已另存为 schedule-ledger\.corrupt\.json /)).toBeVisible();
    await noHorizontalOverflow(page);
  });
});
