import assert from "node:assert/strict";
import test from "node:test";
import { SOURCES, deferredSourceLabel, isReplyMessage, messageKey } from "../client/deferred-state";
import type { DeferredView } from "../shared/deferred-rpc";

// 回复: typed or dictated answers go through the same ledger as quick replies and findings, under their own source.

test("typed replies have their own ledger source, label and list, apart from findings and quick replies", () => {
  const view = (source: string) => ({ source }) as DeferredView;
  assert.equal(isReplyMessage(view(SOURCES.reply)), true);
  assert.equal(isReplyMessage(view(SOURCES.finding)), false); assert.equal(isReplyMessage(view(SOURCES.quickReply)), false);
  assert.equal(view(SOURCES.reply).source.startsWith(SOURCES.finding), false);
  assert.ok(deferredSourceLabel(SOURCES.reply).length > 0); assert.notEqual(deferredSourceLabel(SOURCES.reply), SOURCES.reply);
  // The same words are another request when typed than when sent as a finding or a quick reply.
  assert.notEqual(messageKey(SOURCES.reply, "go ahead"), messageKey(SOURCES.quickReply, "go ahead"));
  assert.notEqual(messageKey(SOURCES.reply, "go ahead"), messageKey(SOURCES.finding, "go ahead"));
});
