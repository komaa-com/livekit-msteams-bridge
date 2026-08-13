import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GROUP_CALL_GATE_DEFAULTS,
  groupCallEtiquetteClause,
  hasUsableWakePhrase,
  isAddressed,
  isFollowUpWindowOpen,
  isGroupGateActive,
  resolveGroupCallGateConfig,
} from "../src/groupGate.js";

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

test("defaults: gate on, wake phrase \"assistant\", 12 s follow-up", () => {
  assert.deepEqual(resolveGroupCallGateConfig(undefined), GROUP_CALL_GATE_DEFAULTS);
  assert.deepEqual(resolveGroupCallGateConfig({}), GROUP_CALL_GATE_DEFAULTS);
  assert.deepEqual(GROUP_CALL_GATE_DEFAULTS, {
    requireAddress: true,
    wakePhrases: ["assistant"],
    followUpWindowMs: 12_000,
  });
});

test("a partial config fills only what is missing, and 0 survives as 0", () => {
  const c = resolveGroupCallGateConfig({ followUpWindowMs: 0 });
  // Proves per-key `??` rather than a truthiness check: `0 || 12000` would silently be 12000.
  assert.equal(c.followUpWindowMs, 0);
  assert.equal(c.requireAddress, true);
  assert.deepEqual(c.wakePhrases, ["assistant"]);
  assert.deepEqual(resolveGroupCallGateConfig({ wakePhrases: ["aria"] }).wakePhrases, ["aria"]);
});

// ---------------------------------------------------------------------------
// Wake-phrase matching
// ---------------------------------------------------------------------------

test("matching is case-insensitive and boundary-aware", () => {
  assert.equal(isAddressed("Assistant, what's this?", ["assistant"]), true);
  assert.equal(isAddressed("hey ARIA", ["aria"]), true);
  assert.equal(isAddressed("aria!", ["aria"]), true, "punctuation is a boundary");
  assert.equal(isAddressed("aria", ["aria"]), true, "string edges are boundaries");
  assert.equal(isAddressed("the assistantship program", ["assistant"]), false, "no inner-substring match");
  assert.equal(isAddressed("mariana told me", ["aria"]), false);
});

test("blank phrases are skipped and an empty list never matches", () => {
  assert.equal(isAddressed("assistant", ["   ", ""]), false);
  assert.equal(isAddressed("assistant", []), false);
  assert.equal(isAddressed("assistant", ["  ", "assistant"]), true);
  assert.equal(hasUsableWakePhrase(["", "  "]), false);
  assert.equal(hasUsableWakePhrase(["aria"]), true);
});

// ---------------------------------------------------------------------------
// The follow-up window
// ---------------------------------------------------------------------------

test("follow-up window: inclusive boundary, 0 is closed, never-addressed is closed", () => {
  assert.equal(isFollowUpWindowOpen({ lastAddressedAt: 1000, followUpWindowMs: 8000, now: 9000 }), true);
  assert.equal(isFollowUpWindowOpen({ lastAddressedAt: 1000, followUpWindowMs: 8000, now: 9001 }), false);
  // 0 means "address me every turn", NOT "always open".
  assert.equal(isFollowUpWindowOpen({ lastAddressedAt: 1000, followUpWindowMs: 0, now: 1000 }), false);
  assert.equal(isFollowUpWindowOpen({ lastAddressedAt: undefined, followUpWindowMs: 8000, now: 9000 }), false);
});

// ---------------------------------------------------------------------------
// Gate activation - every fail-safe leans towards letting the agent be heard
// ---------------------------------------------------------------------------

test("the gate never applies to a 1:1 call", () => {
  assert.equal(isGroupGateActive(GROUP_CALL_GATE_DEFAULTS, false), false);
  assert.equal(isGroupGateActive(GROUP_CALL_GATE_DEFAULTS, true), true);
});

test("a gate with no usable trigger is DISABLED, never a permanent mute", () => {
  assert.equal(isGroupGateActive(resolveGroupCallGateConfig({ requireAddress: false }), true), false);
  assert.equal(isGroupGateActive(resolveGroupCallGateConfig({ wakePhrases: [] }), true), false);
  assert.equal(isGroupGateActive(resolveGroupCallGateConfig({ wakePhrases: ["", "  "] }), true), false);
});

// ---------------------------------------------------------------------------
// The instruction the agent actually receives
// ---------------------------------------------------------------------------

test("the etiquette clause names every wake phrase and the follow-up window", () => {
  const clause = groupCallEtiquetteClause(
    resolveGroupCallGateConfig({ wakePhrases: ["aria", "hey team"], followUpWindowMs: 12_000 }),
  );
  assert.match(clause, /GROUP-CALL ETIQUETTE/);
  assert.match(clause, /"aria" or "hey team"/);
  assert.match(clause, /12s/);
});

test("with followUpWindowMs 0 the clause says every turn must address the agent", () => {
  const clause = groupCallEtiquetteClause(resolveGroupCallGateConfig({ followUpWindowMs: 0 }));
  assert.match(clause, /Every turn must address you by name/);
});
