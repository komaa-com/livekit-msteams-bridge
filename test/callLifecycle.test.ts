import { test } from "node:test";
import assert from "node:assert/strict";
import { CallReaper, isUnanswered, type ReapReason, type ReapableCall } from "../src/callLifecycle.js";
import type { Logger } from "../src/log.js";

const noopLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

class FakeCall implements ReapableCall {
  shutdowns: string[] = [];
  constructor(
    readonly startedAtMs: number,
    public answeredAtMs: number | undefined = undefined,
  ) {}
  shutdown(reason: string): void {
    this.shutdowns.push(reason);
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

test("unanswered: strictly PAST the grace, and only while answeredAtMs is unset", () => {
  const call = { startedAtMs: 1_000, answeredAtMs: undefined };
  assert.equal(isUnanswered(call, 5_000, 5_999), false);
  // Exactly at the threshold is NOT yet stale (strict >), the classic off-by-one.
  assert.equal(isUnanswered(call, 5_000, 6_000), false);
  assert.equal(isUnanswered(call, 5_000, 6_001), true);
  // An answered call is never unanswered, however long it has run.
  assert.equal(isUnanswered({ startedAtMs: 1_000, answeredAtMs: 1_500 }, 5_000, 999_999), false);
});

test("staleCallReaperMs 0 disables the decision entirely", () => {
  assert.equal(isUnanswered({ startedAtMs: 0, answeredAtMs: undefined }, 0, 999_999), false);
});

// ---------------------------------------------------------------------------
// The reaper
// ---------------------------------------------------------------------------

function reaperOver(
  calls: Map<string, FakeCall>,
  staleCallReaperMs: number,
  now: () => number,
): { reaper: CallReaper; reaped: Array<[string, ReapReason]> } {
  const reaped: Array<[string, ReapReason]> = [];
  const reaper = new CallReaper({
    staleCallReaperMs,
    calls: () => calls.entries(),
    onReap: (callId, reason) => reaped.push([callId, reason]),
    log: noopLog,
    now,
  });
  return { reaper, reaped };
}

test("reapStale ends only the unanswered call, with reason no-answer", () => {
  let t = 0;
  const calls = new Map<string, FakeCall>([
    ["never-answered", new FakeCall(0)],
    ["answered", new FakeCall(0, 100)],
  ]);
  const { reaper, reaped } = reaperOver(calls, 1_000, () => t);

  t = 500;
  reaper.reapStale();
  assert.deepEqual(reaped, [], "inside the grace, nothing is reaped");

  t = 1_501;
  reaper.reapStale();
  assert.deepEqual(reaped, [["never-answered", "no-answer"]]);
  assert.deepEqual(calls.get("never-answered")!.shutdowns, ["no-answer"], "teardown runs, not just the hook");
  assert.deepEqual(calls.get("answered")!.shutdowns, [], "an answered call is untouched");
});

test("the scan survives a call removing itself from the registry mid-pass", () => {
  let t = 0;
  const calls = new Map<string, FakeCall>();
  // Real CallSessions delete themselves from the registry during shutdown(); the scan must iterate
  // a snapshot or it would skip entries.
  class SelfRemoving extends FakeCall {
    constructor(private readonly id: string) {
      super(0);
    }
    override shutdown(reason: string): void {
      super.shutdown(reason);
      calls.delete(this.id);
    }
  }
  calls.set("a", new SelfRemoving("a"));
  calls.set("b", new SelfRemoving("b"));
  calls.set("c", new SelfRemoving("c"));
  const { reaper, reaped } = reaperOver(calls, 1_000, () => t);

  t = 2_000;
  reaper.reapStale();
  assert.deepEqual(
    reaped.map(([id]) => id),
    ["a", "b", "c"],
  );
  assert.equal(calls.size, 0);
});

test("a call that lingers in the registry is reaped once, not on every poll", () => {
  let t = 2_000;
  // FakeCall never removes itself, standing in for a teardown that races the registry delete.
  const calls = new Map<string, FakeCall>([["x", new FakeCall(0)]]);
  const { reaper, reaped } = reaperOver(calls, 1_000, () => t);
  reaper.reapStale();
  t = 3_000;
  reaper.reapStale();
  assert.deepEqual(reaped, [["x", "no-answer"]], "one warning and one metric, not one per poll");
  assert.deepEqual(calls.get("x")!.shutdowns, ["no-answer"]);
});

test("start() installs no timer when the reaper is disabled, and stop() is idempotent", () => {
  const calls = new Map<string, FakeCall>([["x", new FakeCall(0)]]);
  const { reaper, reaped } = reaperOver(calls, 0, () => 999_999);
  reaper.start();
  reaper.reapStale();
  assert.deepEqual(reaped, [], "a disabled reaper reaps nothing even when driven directly");
  reaper.stop();
  reaper.stop();
});

test("a started reaper reaps on its own poll", async () => {
  const calls = new Map<string, FakeCall>([["x", new FakeCall(Date.now() - 10_000)]]);
  const { reaper, reaped } = reaperOver(calls, 100, () => Date.now());
  reaper.start();
  await new Promise((r) => setTimeout(r, 250));
  reaper.stop();
  assert.deepEqual(reaped, [["x", "no-answer"]]);
});
