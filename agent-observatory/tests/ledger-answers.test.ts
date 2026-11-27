import { t } from "../shared/text";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ledgerNotice, onItsWayLabel, deferredSourceLabel } from "../client/deferred-state";
import { isSendRefused, ledgerInput } from "../client/send-check";
import type { DeferredView } from "../shared/deferred-rpc";

/**
 * The send entries' own callbacks, cut out of their component by the TypeScript parser and run with the closure given:
 * what a tap on 「等这一轮结束再发」 does with each answer the ledger can give (codex-obs-send-ui-R2), without a DOM or a host.
 */
function callbacks(file: string, names: readonly string[], scope: Record<string, unknown>): Record<string, (...args: unknown[]) => Promise<void>> {
  const path = join(__dirname, "..", "client", file);
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text) && node.initializer && ts.isArrowFunction(node.initializer))
      found.set(node.name.text, `const ${node.name.text} = ${node.initializer.getText(source)};`);
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.deepEqual([...found.keys()].sort(), [...names].sort(), `${file}: every callback found`);
  const body = `(function () {\n${names.map(name => found.get(name)).join("\n")}\nreturn { ${names.join(", ")} };\n})`;
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  return (runInNewContext(js, { ...scope, t, deferredSourceLabel, Error, Promise }) as () => Record<string, (...args: unknown[]) => Promise<void>>)();
}

const view = (state: DeferredView["state"], patch: Partial<DeferredView> = {}): DeferredView =>
  ({ messageId: "message-0001", agentId: "a", key: "k-go", source: "快捷回复「继续做完」", preview: "继续做完。", createdAt: 1, at: 2, state, note: `${state} 的说明`, ...patch });
/** A toast that records what it showed. */
const toasts = () => { const shown: Array<[string, string]> = []; return { shown, show: (text: string, options?: { variant?: string }) => { shown.push([options?.variant ?? "default", text]); }, error: (text: string) => { shown.push(["error", text]); } }; };

test("快捷回复's 等这一轮结束再发 says what the ledger answered: only a queued reply waits for the turn (codex-obs-send-ui-R2)", async () => {
  const replies = [{ key: "go", text: "继续做完" }, { key: "hold", text: "先别动" }];
  const run = async (answer: DeferredView) => {
    const toast = toasts(), seen = { sent: [] as unknown[], onSent: [] as unknown[], refused: [] as unknown[], problem: [] as unknown[], lost: [] as unknown[] };
    const message = { agentId: "a", text: "继续做完。", what: "回复", source: "快捷回复「继续做完」", key: "k-go", messageId: "message-0001", group: "turn", guard: { prompt: null, round: null } };
    const { defer } = callbacks("quick-replies.tsx", ["defer", "answeredOwn", "answeredElsewhere"], {
      inFlight: { current: false }, mounted: { current: true }, refused: null, taken: () => false, messageFor: () => message, setBusy: () => {}, setConfirming: () => {},
      setProblem: (value: unknown) => { if (value) seen.problem.push(JSON.parse(JSON.stringify(value))); }, checkFits: async () => {}, paseo: {}, expect: () => null, precheck: async () => null,
      deferred: { enqueue: async () => answer }, ledgerInput, settleRequest: () => {}, agentId: "a", agentTitle: "重构支付服务", toast, ledgerNotice, onItsWayLabel, isSendRefused,
      replies, keyOf: (reply: { key: string }) => `k-${reply.key}`, onSent: (reply: unknown) => seen.onSent.push(reply), setSent: (reply: unknown) => seen.sent.push(reply),
      setRefused: (text: unknown) => seen.refused.push(text), lost: (...args: unknown[]) => seen.lost.push(args),
    });
    await defer(replies[0]);
    return { toasts: toast.shown, ...seen };
  };
  const queued = await run(view("queued"));
  assert.deepEqual(queued.toasts, [["success", "已排队：继续做完，等「重构支付服务」这一轮结束后自动发送"]]);
  // Held: it waits for the user (its row below has the reason, 仍然发送 and 取消), never announced as queued.
  assert.deepEqual((await run(view("held", { note: "没收到发送结果，可能已经送达。" }))).toasts, [["warning", "「继续做完」在等你确认，见下方。"]]);
  // Maybe sent: an uncertain outcome, not a success.
  assert.deepEqual((await run(view("maybe-sent", { note: "发送结果不确定，可能已经送达，请打开会话看一下" }))).toasts, [["warning", "发送结果不确定，可能已经送达，请打开会话看一下"]]);
  assert.deepEqual((await run(view("sending"))).toasts, [["success", "正在发给「重构支付服务」：继续做完，见下方。"]]);
  const sent = await run(view("sent"));
  assert.deepEqual([sent.toasts, sent.sent, sent.onSent], [[["success", "已回复「重构支付服务」：继续做完"]], [replies[0]], [replies[0]]]);
  // Dropped by the server (its turn moved on): said as a refusal, the replies no longer offered.
  const dropped = await run(view("discarded", { note: "「重构支付服务」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用，没有发送。" }));
  assert.deepEqual([dropped.toasts, dropped.refused], [[], ["「重构支付服务」之后又跑了一轮，这条快捷回复答的是之前那一轮，不再适用，没有发送。"]]);
  assert.deepEqual((await run(view("expired", { note: "排队超过一天，已放弃发送" }))).toasts, [["error", "排队超过一天，已放弃发送"]]);
  // Another device answered this turn with 先别动: named for it, and this button is never marked sent (codex-obs-attn-R3).
  const elsewhere = await run(view("sent", { messageId: "message-0002", key: "k-hold", source: "快捷回复「先别动」" }));
  assert.deepEqual([elsewhere.toasts, elsewhere.sent, elsewhere.onSent], [[["success", "这一轮已经回复了「先别动」，没有再发。"]], [], []]);
  for (const outcome of [queued, dropped, elsewhere]) assert.deepEqual([outcome.problem, outcome.lost], [[], []]);
});

test("发给这个 Agent's 等这一轮结束再发 closes only on a queued or sent message; held, uncertain and ended ones stay (codex-obs-send-ui-R2)", async () => {
  const run = async (answer: DeferredView) => {
    const toast = toasts(), seen = { problem: [] as unknown[], closed: [] as unknown[], onSent: [] as unknown[], lost: [] as unknown[] };
    const next = { agentId: "a", text: "请复查", what: "消息", source: "分析建议「复查」", key: "k-go", messageId: "message-0001", tried: false };
    const { defer } = callbacks("insight-actions.tsx", ["defer", "answeredWith", "finished"], {
      body: "请复查", busy: false, current: () => next, taken: () => false, setBusy: () => {}, setConfirming: () => {},
      // Made in the sandbox: copied out, so they compare as plain objects.
      setProblem: (value: unknown) => { if (value) seen.problem.push(JSON.parse(JSON.stringify(value))); },
      deferred: { enqueue: async () => answer }, ledgerInput, settleRequest: () => {}, agentId: "a", agentTitle: "重构支付服务", toast, ledgerNotice, onItsWayLabel,
      reply: false, setText: () => {}, onSent: () => seen.onSent.push(true), onClose: () => seen.closed.push(true), lost: (...args: unknown[]) => seen.lost.push(args),
    });
    await defer();
    return { toasts: toast.shown, ...seen };
  };
  const queued = await run(view("queued"));
  assert.deepEqual([queued.toasts, queued.closed], [[["success", "已排队：等「重构支付服务」这一轮结束后自动发送"]], [true]]);
  const sent = await run(view("sent"));
  assert.deepEqual([sent.toasts, sent.closed, sent.onSent], [[["success", "已发给「重构支付服务」"]], [true], [true]]);
  // The review's two (codex-obs-send-ui-R2): held keeps the sheet, its reason and 仍然发送 on its row; maybe-sent is no success.
  const held = await run(view("held", { note: "没收到发送结果，可能已经送达。" }));
  assert.deepEqual([held.toasts, held.closed, held.problem], [[["warning", "这条消息在等你确认，见下方。"]], [], []]);
  const maybe = await run(view("maybe-sent", { note: "发送结果不确定，可能已经送达，请打开会话看一下" }));
  assert.deepEqual([maybe.toasts, maybe.closed], [[["warning", "发送结果不确定，可能已经送达，请打开会话看一下"]], []]);
  const sending = await run(view("sending"));
  assert.deepEqual([sending.toasts, sending.closed], [[["success", "正在发给「重构支付服务」，见下方。"]], []]);
  for (const [state, tone] of [["canceled", "warning"], ["expired", "danger"], ["discarded", "danger"]] as const) {
    const ended = await run(view(state, { note: `${state}：没有发送` }));
    assert.deepEqual([ended.toasts, ended.closed, ended.problem], [[], [], [{ tone, message: `${state}：没有发送`, retry: false }]], state);
  }
  // The same text already on its way under another id: its row says so; the sheet stays.
  const other = await run(view("queued", { messageId: "message-0002" }));
  assert.deepEqual([other.toasts, other.closed], [[["success", "这条消息已在排队，见下方。"]], []]);
});

test("回复: a typed answer is cleared once it went out or was queued; one that waits, may have arrived or ended stays to edit", async () => {
  const answer = (state: DeferredView["state"], patch: Partial<DeferredView> = {}) => view(state, { source: "手写回复", ...patch });
  const run = async (ledgerView: DeferredView, how: "defer" | "schedule" = "defer") => {
    const seen = { closed: [] as unknown[], text: [] as unknown[], lost: [] as unknown[] };
    const next = { agentId: "a", text: "先把登录改版排进这一轮", what: "消息", source: "手写回复", key: "k-go", messageId: "message-0001", tried: false };
    const sheet = callbacks("insight-actions.tsx", ["defer", "schedule", "answeredWith", "finished"], {
      body: next.text, busy: false, current: () => next, taken: () => false, setBusy: () => {}, setConfirming: () => {}, setProblem: () => {}, setScheduling: () => {},
      deferred: { enqueue: async () => ledgerView }, ledgerInput, settleRequest: () => {}, agentId: "a", agentTitle: "规划下一轮迭代", toast: toasts(), ledgerNotice, onItsWayLabel,
      scheduleWhen: () => "明天 09:00", reply: true, setText: (value: unknown) => seen.text.push(value), onSent: () => {}, onClose: () => seen.closed.push(true),
      lost: (...args: unknown[]) => seen.lost.push(args),
    });
    await (how === "schedule" ? sheet.schedule!(Date.now() + 3_600_000) : sheet.defer!());
    return seen;
  };
  const cleared = { closed: [true], text: [""], lost: [] }, kept = { closed: [], text: [], lost: [] };
  for (const state of ["queued", "sent"] as const) assert.deepEqual(await run(answer(state)), cleared, state);
  assert.deepEqual(await run(answer("queued", { notBefore: Date.now() + 3_600_000 }), "schedule"), cleared, "scheduled");
  // Already sent under another id (a second tap, another device): it went out all the same.
  assert.deepEqual(await run(answer("sent", { messageId: "message-0002" })), cleared, "sent elsewhere");
  for (const state of ["held", "maybe-sent", "sending", "canceled", "expired", "discarded"] as const) assert.deepEqual(await run(answer(state)), kept, state);
});
