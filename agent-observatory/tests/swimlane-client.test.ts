import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const clientSource = (name: string) => readFileSync(join(__dirname, "..", "client", `${name}.tsx`), "utf8");
const dashboard = clientSource("dashboard"), feed = clientSource("activity-feed"), swimlane = clientSource("swimlane");

test("desktop and mobile mount the swimlane without requiring retained events", () => {
  assert.match(dashboard, /\{!compact \? <Swimlane\b/);
  assert.match(feed, /\{swimlane \? <Swimlane\b/);
  assert.doesNotMatch(dashboard + feed, /events\.length \? <Swimlane\b/);
});

test("background-only lanes use the same filtered Agent scope as the event feed", () => {
  assert.match(dashboard, /const eventAgents = useMemo\(\(\) => scoped\.filter/);
  assert.match(dashboard, /const scopeIds = useMemo\(\(\) => new Set\(eventAgents\.map/);
  assert.match(dashboard, /<Swimlane[^\n]+agents=\{eventAgents\}/);
  assert.match(dashboard, /<ActivityFeed[^\n]+agents=\{eventAgents\}/);
});

test("background-only lanes show their concurrency summary while a truly empty swimlane stays hidden", () => {
  assert.match(swimlane, /if \(!events\.length && !lanes\.length\) return null;/);
  assert.match(swimlane, /\{turns \|\| peak \? tParts\(/);
});
