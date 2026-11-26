import { t } from "../shared/text";
import { deferOffer, isOnItsWay, isScheduled, type DeferredView } from "../shared/deferred-rpc";
import { contentKey, newMessageId, type Consent } from "./send-plan";

/**
 * 「等这一轮结束再发」 and sending now, on the client. The plugin server's ledger (server/deferred-send.ts, shared kit) owns
 * every message to an Agent and sends it; this names the messages, decides what the send entries draw and when they ask
 * again, and remembers the id of a request whose answer never came back.
 */

/** Where a message comes from: its key and its row both name it. */
// i18n-ignore: persisted ledger source prefixes are also message identity keys; translate only their display.
export const SOURCES = { quickReply: "快捷回复", finding: "分析建议", reply: "手写回复" } as const;

/** The ledger's rows for the user's own typed or dictated replies. */
export const isReplyMessage = (view: { source: string }) => view.source === SOURCES.reply;

/** What makes two messages the same request: the ledger keeps one per Agent and key on its way. */
export function messageKey(source: string, text: string): string {
  return contentKey(["observatory", source, text]);
}

const instant = (value: string | null | undefined) => { const at = value ? Date.parse(value) : NaN; return Number.isFinite(at) ? at : null; };
const quickReplyTurn = (prompt: string | null | undefined, round: string | null | undefined) => `${SOURCES.quickReply}@${instant(prompt) ?? ""}/${instant(round) ?? ""}`;
/**
 * A quick reply answers one turn (P1-1; a heartbeat's rounds share their prompt, codex-obs-attn-F1): the same words to
 * another turn are another request, so the turn is part of its source. Instants, so every way of writing one gives one key.
 */
export function quickReplyKey(text: string, prompt: string | null | undefined, round: string | null | undefined): string {
  return messageKey(quickReplyTurn(prompt, round), text);
}
/**
 * The question a quick reply answers, whichever button (codex-obs-attn-R3): the ledger's group for that turn, so on every
 * device one reply goes out and any other answers with it.
 */
export function quickReplyGroup(prompt: string | null | undefined, round: string | null | undefined): string {
  return contentKey(["observatory", quickReplyTurn(prompt, round)]);
}
/**
 * The turn a quick reply answers, for the server to check right before it goes out (`answeringGuard` in
 * server/send-ledger.ts): the prompt that turn answered and when the plugin saw it start.
 */
export function quickReplyGuard(prompt: string | null | undefined, round: string | null | undefined): { prompt: string | null; round: string | null } {
  return { prompt: prompt ?? null, round: round ?? null };
}

/**
 * While a message is on its way and the app is in front, the list is read again this often; otherwise never. A message
 * scheduled for later (定时发送) does not count: `scheduledPollInterval` reads for it, slowly, until its time.
 */
export const DEFERRED_POLL_MS = 5_000;
export function deferredPollInterval(views: readonly Pick<DeferredView, "state" | "notBefore">[] | undefined, foreground: boolean, now = Date.now()): number | false {
  return foreground && !!views?.some(view => isOnItsWay(view) && !isScheduled(view, now)) ? DEFERRED_POLL_MS : false;
}
/** Only scheduled messages on their way: once a minute, and just after the next one's time; never in the background. */
export function scheduledPollInterval(views: readonly Pick<DeferredView, "state" | "notBefore">[] | undefined, foreground: boolean, now = Date.now()): number | false {
  const times = (views ?? []).filter(view => isOnItsWay(view)).map(view => view.notBefore ?? now);
  if (!foreground || !times.length) return false;
  return Math.max(DEFERRED_POLL_MS, Math.min(60_000, Math.min(...times) - now + 3_000));
}

/** How long an outcome stays after this app first saw it: 已送达 / 已取消 briefly, the ones to look at longer. */
export const OUTCOME_SHOWN_MS: Record<Exclude<DeferredView["state"], "queued" | "held" | "sending">, number> = { sent: 12_000, canceled: 6_000, "maybe-sent": 45_000, discarded: 45_000, expired: 45_000 };

const SEEN_LIMIT = 400;
/** When this app first saw each message in each outcome (`id:state`), shared by every entry. */
const firstSeen = new Map<string, number>();

/** Messages on their way, and outcomes for a while after this app first saw them; `until` is when the next one goes. */
export function visibleDeferred(views: readonly DeferredView[], now = Date.now(), seen: Map<string, number> = firstSeen): { views: DeferredView[]; until: number | null } {
  const shown: DeferredView[] = [];
  let until: number | null = null;
  for (const view of views) {
    if (isOnItsWay(view)) { shown.push(view); continue; }
    const key = `${view.messageId}:${view.state}`;
    let first = seen.get(key);
    if (first === undefined) {
      first = now; seen.set(key, now);
      if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value!);
    }
    const end = first + OUTCOME_SHOWN_MS[view.state as keyof typeof OUTCOME_SHOWN_MS];
    if (end > now) { shown.push(view); until = until === null ? end : Math.min(until, end); }
  }
  return { views: shown, until };
}

/** This request's record for the Agent: one on its way first, else the newest outcome; null when there is none. */
export function messageRecord(views: readonly DeferredView[] | undefined, agentId: string, key: string): DeferredView | null {
  let newest: DeferredView | null = null;
  for (const view of views ?? []) {
    if (view.agentId !== agentId || view.key !== key) continue;
    if (isOnItsWay(view)) return view;
    if (!newest || view.at > newest.at) newest = view;
  }
  return newest;
}

const UNANSWERED_LIMIT = 200;
/** Sends and queueings whose answer never came back, by Agent and key, with the id they went under. */
const unanswered = new Map<string, string>();
const requestSlot = (agentId: string, key: string) => `${agentId}\n${key}`;

/**
 * The id of a send or queueing of this message (the four plugins' r3-F5). One whose answer never came back may have
 * reached the server, so trying again asks for the same id, and the ledger answers with what became of it instead of
 * sending a second copy. A new id once that request is settled: an answer came, or the server's list (`listed`) shows its
 * message, which is its record from then on.
 */
export function requestId(agentId: string, key: string, listed: readonly Pick<DeferredView, "messageId">[] = []): string {
  const slot = requestSlot(agentId, key), kept = unanswered.get(slot);
  if (kept && !listed.some(view => view.messageId === kept)) return kept;
  unanswered.delete(slot);
  return newMessageId();
}
/** The id of this message's request whose answer was lost, if there is one. */
export function unansweredId(agentId: string, key: string): string | null {
  return unanswered.get(requestSlot(agentId, key)) ?? null;
}
/** A request's answer was lost: the next try of the same message asks for its id. */
export function rememberUnanswered(agentId: string, key: string, messageId: string): void {
  const slot = requestSlot(agentId, key);
  unanswered.delete(slot);
  unanswered.set(slot, messageId);
  if (unanswered.size > UNANSWERED_LIMIT) unanswered.delete(unanswered.keys().next().value!);
}
/** The server answered: its answer is the record from now on, and another send is a new request. */
export function settleRequest(agentId: string, key: string): void {
  unanswered.delete(requestSlot(agentId, key));
}

/** 「等这一轮结束再发」 next to the server's confirmation, which lists the approvals a send would cancel. */
export function confirmOffer(consent: Pick<Consent, "approvals">): { label: string; note: string } | null {
  return deferOffer({ pendingPermissions: consent.approvals.length }, { kind: "confirm" });
}

/**
 * What a send entry says about the ledger's answer for its own message (codex-obs-send-ui-R2), by the message's state: only
 * a queued one waits for the turn to end and goes out by itself; one sending says so; one held waits for the user, which
 * its row below says with the ledger's reason, 仍然发送 and 取消; maybe-sent is an uncertain outcome, never a queueing;
 * canceled, expired and discarded end in their own words, the ledger's note. `title` names the Agent, `item` the words a
 * quick reply sends.
 * `kind`: sent, on its way (waiting), the user's to look at (attention, uncertain), or over without sending (ended).
 */
export function ledgerNotice(view: Pick<DeferredView, "state" | "note">, title: string, item?: string): { tone: "success" | "warning" | "danger" | "info"; kind: "sent" | "waiting" | "attention" | "uncertain" | "ended"; text: string } {
  const words = item ? t("coreDeferredState.message", { value1: item }) : "";
  switch (view.state) {
    case "queued": return { tone: "success", kind: "waiting", text: item ? t("coreDeferredState.queuedItWillSendAutomaticallyWhenFinishes", { value1: item, value2: title }) : t("coreDeferredState.queuedItWillSendAutomaticallyWhenFinishes2", { value1: title }) };
    case "sending": return { tone: "success", kind: "waiting", text: t("coreDeferredState.sendingToSeeBelow", { value1: title, value2: words }) };
    case "sent": return { tone: "success", kind: "sent", text: t("coreDeferredState.sentTo", { value1: title, value2: words }) };
    case "held": return { tone: "warning", kind: "attention", text: t("coreDeferredState.isWaitingForYourConfirmationSeeBelow", { value1: item ? t("coreDeferredState.quotedItem", { item }) : t("coreDeferredState.thisMessage") }) };
    case "maybe-sent": return { tone: "warning", kind: "uncertain", text: view.note || t("coreDeferredState.theSendResultIsUncertainItMay") };
    case "canceled": return { tone: "info", kind: "ended", text: view.note || t("coreDeferredState.canceledNotSent") };
    case "expired": return { tone: "danger", kind: "ended", text: view.note || t("coreDeferredState.queuedForMoreThanADaySending") };
    case "discarded": return { tone: "danger", kind: "ended", text: view.note || t("coreDeferredState.notSent") };
  }
}

/** How a message already on its way (or out moments ago) is named in a notice. */
export function onItsWayLabel(view: Pick<DeferredView, "state">): string {
  if (view.state === "held") return t("coreDeferredState.isWaitingForYourConfirmation");
  if (view.state === "sending") return t("coreDeferredState.isSending");
  if (isOnItsWay(view)) return t("coreDeferredState.isAlreadyQueued");
  return view.state === "maybe-sent" ? t("coreDeferredState.mayJustHaveBeenSent") : t("coreDeferredState.wasJustSent");
}

/** Legacy source values remain message identity; only their presentation follows the language. */
export function deferredSourceLabel(source: string): string {
  if (source === SOURCES.quickReply) return t("coreDeferredState.quickReplySource");
  if (source === SOURCES.finding) return t("coreDeferredState.findingSource");
  if (source === SOURCES.reply) return t("coreDeferredState.replySource");
  const prefix = source.startsWith(SOURCES.finding) ? SOURCES.finding : source.startsWith(SOURCES.quickReply) ? SOURCES.quickReply : null;
  if (!prefix) return source;
  // i18n-ignore: strip the persisted quotation marks, including a source truncated at the ledger's length limit.
  const title = source.slice(prefix.length).replace(/^「|」$/g, "");
  return t(prefix === SOURCES.finding ? "coreDeferredState.findingSourceWithTitle" : "coreDeferredState.quickReplySourceWithTitle", { title });
}
