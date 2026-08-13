/**
 * Group-call "speak only when addressed" gate.
 *
 * In a 1:1 Teams call the agent answers everything. In a meeting it should stay quiet until someone
 * actually addresses it - the same policy a chat bot gets for free from @mentions. A call has no
 * structured @mention, so "addressed" is inferred from the transcript: a caller said one of the
 * agent's wake phrases. After being addressed a short follow-up window keeps the agent engaged for a
 * natural back-and-forth without re-stating its name every turn.
 *
 * This module is pure (no I/O, no clock, no state) so it is unit-testable and so both call sites -
 * the `teams.context` etiquette clause and the agent-audio egress - resolve the policy identically.
 *
 * WHY THERE IS NO `shouldRespondToGroupTurn` HERE (the reference implementation has one):
 * that function answers "may the agent take this turn", which only makes sense where the bridge
 * itself decides to invoke a model. This bridge never does - the LiveKit agent owns STT, turn-taking
 * and the LLM call - so there is no pre-agent decision point to gate. The two decision points this
 * bridge actually owns are the instruction it sends the agent and the audio it lets back onto the
 * Teams call, and those need exactly `isAddressed` and `isFollowUpWindowOpen`. Shipping the third
 * function with no caller would be shipping dead code.
 */

/** Resolved gate policy for a call. */
export interface GroupCallGateConfig {
  /** Require the agent to be addressed by name before it may speak in a group call. */
  requireAddress: boolean;
  /** Phrases that count as addressing the agent (case-insensitive, boundary-aware). */
  wakePhrases: string[];
  /** After being addressed, keep answering without re-addressing for this many ms (0 = every turn). */
  followUpWindowMs: number;
}

/**
 * Defaults, kept here so every caller resolves them the same way.
 *
 * Same values as the sibling bridges deliberately: an operator moving between backends should not
 * have to relearn the policy. `requireAddress` defaults ON even though this repo's house rule is
 * "opt-in by default" - that rule guards against a default that silently SPENDS, and this gate only
 * ever suppresses output. It never adds an API call.
 */
export const GROUP_CALL_GATE_DEFAULTS: GroupCallGateConfig = {
  requireAddress: true,
  wakePhrases: ["assistant"],
  followUpWindowMs: 12_000,
};

/**
 * Apply {@link GROUP_CALL_GATE_DEFAULTS} to a possibly-partial config. Single source of truth, so the
 * env layer, the session wiring and the docs cannot each restate a different default. Per-key `??`,
 * so `followUpWindowMs: 0` survives as 0 rather than being replaced by the default.
 */
export function resolveGroupCallGateConfig(
  raw: Partial<GroupCallGateConfig> | undefined,
): GroupCallGateConfig {
  return {
    requireAddress: raw?.requireAddress ?? GROUP_CALL_GATE_DEFAULTS.requireAddress,
    wakePhrases: raw?.wakePhrases ?? GROUP_CALL_GATE_DEFAULTS.wakePhrases,
    followUpWindowMs: raw?.followUpWindowMs ?? GROUP_CALL_GATE_DEFAULTS.followUpWindowMs,
  };
}

/** A word character for boundary purposes: any Unicode letter or digit. */
function isWordChar(ch: string): boolean {
  return ch.length > 0 && /[\p{L}\p{N}]/u.test(ch);
}

/** At least one phrase that could ever match. Blank entries are not triggers. */
export function hasUsableWakePhrase(wakePhrases: string[]): boolean {
  return wakePhrases.some((p) => p.trim().length > 0);
}

/**
 * Whether `transcript` addresses the agent by any wake phrase. Case-insensitive and boundary-aware,
 * so "assistant" matches "Assistant, what's this?" and "aria!" but not "assistantship" or "mariana".
 * A boundary is the string edge or any non-letter/non-digit character, so punctuation and spaces
 * count. An empty (or all-blank) phrase list never matches; the caller decides what that means.
 */
export function isAddressed(transcript: string, wakePhrases: string[]): boolean {
  const text = transcript.toLowerCase();
  for (const phrase of wakePhrases) {
    const needle = phrase.trim().toLowerCase();
    if (!needle) {
      continue;
    }
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) {
        break;
      }
      const before = at === 0 ? "" : text[at - 1];
      const after = at + needle.length >= text.length ? "" : text[at + needle.length];
      if (!isWordChar(before) && !isWordChar(after)) {
        return true;
      }
      from = at + needle.length;
    }
  }
  return false;
}

/**
 * Is the follow-up window still open?
 *
 * A TIME window, never a latched boolean. That is the load-bearing decision: a wake phrase that is
 * missed, clipped, or only ever seen in a partial transcript can then never strand the agent
 * permanently silent - the gate self-heals by clock. Inclusive at the boundary, and
 * `followUpWindowMs === 0` means "no follow-up", not "always open".
 */
export function isFollowUpWindowOpen(params: {
  lastAddressedAt: number | undefined;
  followUpWindowMs: number;
  now: number;
}): boolean {
  const { lastAddressedAt, followUpWindowMs, now } = params;
  return (
    followUpWindowMs > 0 && lastAddressedAt !== undefined && now - lastAddressedAt <= followUpWindowMs
  );
}

/**
 * Is the gate in force for this call at all?
 *
 * A gate with no usable trigger would be a mute switch, so it is treated as DISABLED: not a group
 * call, `requireAddress` off, or no non-blank wake phrase all mean "answer everything". Every
 * fail-safe in this module leans the same way.
 */
export function isGroupGateActive(config: GroupCallGateConfig, isGroup: boolean): boolean {
  return isGroup && config.requireAddress && hasUsableWakePhrase(config.wakePhrases);
}

/**
 * The etiquette instruction sent to the agent on `teams.context` when the gate is active.
 *
 * This is the PRIMARY mechanism on this transport: the LiveKit agent owns turn-taking, so telling it
 * the policy is what actually produces good behaviour. The audio-egress check in the session is the
 * deterministic backstop behind it, not a replacement for it.
 */
export function groupCallEtiquetteClause(config: GroupCallGateConfig): string {
  const phrases = config.wakePhrases
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `"${p}"`)
    .join(" or ");
  const followUp =
    config.followUpWindowMs > 0
      ? ` Once addressed you may keep answering for about ${Math.round(config.followUpWindowMs / 1000)}s without being named again.`
      : " Every turn must address you by name.";
  return (
    `GROUP-CALL ETIQUETTE: stay silent unless someone addresses you as ${phrases}.` +
    ` Do not answer questions the participants are asking each other.${followUp}`
  );
}
