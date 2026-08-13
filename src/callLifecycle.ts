/**
 * No-answer fallback: end a call whose agent never answered.
 *
 * "Answered" here means the LiveKit agent joined the room and published audio. A call where that
 * never happens is the single most common misconfiguration of this bridge (a worker registered with
 * `agent_name` while `LIVEKIT_AGENT_NAME` is unset, or the worker simply not running): StandIn is on
 * the Teams call, the room exists, the caller hears nothing, and nothing ever ends it. The bridge's
 * other timers do not cover it - the pre-start timer only watches for `session.start`, and the
 * dead-peer timer is happy as long as the worker keeps heartbeating.
 *
 * This is deliberately NOT media-aware: it cannot tell a silent call from a busy one. Unanswered
 * means "the agent never joined", not "no audio arrived".
 *
 * The reference implementation pairs this with an over-duration ("timeout") branch and a concurrency
 * cap. Both already exist here under their own names - `MAX_CALL_MINUTES` (which is better: it asks
 * the agent to say goodbye first) and `MAX_CONNECTIONS` - so porting them would have meant two knobs
 * fighting over one behaviour.
 */

import type { Logger } from "./log.js";

/** Why the reaper ended a call. One member today; a union so the reason stays a closed vocabulary. */
export type ReapReason = "no-answer";

/**
 * Coarsest poll: the deadline is a grace period, not something anyone measures to the second.
 * The actual period is capped by the grace itself, so a short grace is still enforced promptly
 * (a 5-second grace polled every 15 seconds would be a 15-second grace).
 */
export const REAPER_CHECK_INTERVAL_MS = 15_000;
/** Floor on the poll period, so a tiny grace cannot spin the event loop. */
const REAPER_MIN_INTERVAL_MS = 50;

/** What the reaper needs from a call. {@link CallSession} implements it. */
export interface ReapableCall {
  /** When the bridge accepted this call (epoch ms). */
  readonly startedAtMs: number;
  /** When the agent answered - joined the room and published audio. Undefined = never. */
  readonly answeredAtMs: number | undefined;
  /** Same teardown a caller hangup runs: tell the worker, close the room, close the socket. */
  shutdown(reason: string): void;
}

/**
 * The whole decision, as a pure predicate so the boundary is testable without a clock.
 *
 * Strict `>`: at exactly the grace period the call is not yet stale.
 */
export function isUnanswered(
  call: Pick<ReapableCall, "startedAtMs" | "answeredAtMs">,
  staleCallReaperMs: number,
  now: number,
): boolean {
  return (
    call.answeredAtMs === undefined &&
    staleCallReaperMs > 0 &&
    now - call.startedAtMs > staleCallReaperMs
  );
}

export interface CallReaperOptions {
  /** Grace period before an unanswered call is ended. 0 disables the reaper entirely. */
  staleCallReaperMs: number;
  /** The live call registry. Read fresh on every pass so late calls are included. */
  calls: () => Iterable<[string, ReapableCall]>;
  /**
   * Owner notification, fired once per reaped call AFTER its teardown has run. Metrics/logging only.
   *
   * The teardown itself is `ReapableCall.shutdown`, deliberately called by the reaper rather than
   * left to this hook: in the reference implementation the teardown WAS the hook, so forgetting to
   * pass it freed the concurrency slot while the sockets stayed open. Here the type system makes
   * that impossible to forget.
   */
  onReap: (callId: string, reason: ReapReason) => void;
  log: Logger;
  /** Injectable clock, so tests advance time instead of waiting. */
  now?: () => number;
}

/**
 * Polls the live-call registry and ends calls the agent never answered.
 *
 * `reapStale()` is public and does the whole decision plus the action; the timer is a thin wrapper
 * around it. Burying this in a timer callback would make it untestable without real waiting.
 */
export class CallReaper {
  private timer: NodeJS.Timeout | null = null;
  /**
   * Calls already reaped. A teardown is idempotent, so a second attempt is harmless - but a call
   * that lingers in the registry (a teardown that races, an owner that removes entries lazily) would
   * otherwise emit a warning and a metric on every single poll for the rest of its life. Pruned
   * against the live registry each pass, so it is bounded by the number of live calls.
   */
  private readonly reaped = new Set<string>();

  constructor(private readonly opts: CallReaperOptions) {}

  /** Install the poll. No timer at all when the reaper is disabled. */
  start(): void {
    if (this.timer || this.opts.staleCallReaperMs <= 0) {
      return;
    }
    const period = Math.max(
      REAPER_MIN_INTERVAL_MS,
      Math.min(REAPER_CHECK_INTERVAL_MS, this.opts.staleCallReaperMs),
    );
    this.timer = setInterval(() => this.reapStale(), period);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  reapStale(): void {
    if (this.opts.staleCallReaperMs <= 0) {
      return;
    }
    const now = this.opts.now ? this.opts.now() : Date.now();
    // Snapshot: ending a call removes it from the registry we are iterating.
    const snapshot = [...this.opts.calls()];
    if (this.reaped.size > 0) {
      const live = new Set(snapshot.map(([callId]) => callId));
      for (const callId of this.reaped) {
        if (!live.has(callId)) {
          this.reaped.delete(callId);
        }
      }
    }
    for (const [callId, call] of snapshot) {
      if (this.reaped.has(callId)) {
        continue;
      }
      if (!isUnanswered(call, this.opts.staleCallReaperMs, now)) {
        continue;
      }
      this.reaped.add(callId);
      this.opts.log.warn(
        `call ${callId.slice(0, 12)}… had no agent answer in ${this.opts.staleCallReaperMs}ms; ending it`,
      );
      // Tear down FIRST, then notify: the owner's hook must never see a call that is still counted
      // as live, or the connection cap reopens while the room and socket are still up.
      call.shutdown("no-answer");
      this.opts.onReap(callId, "no-answer");
    }
  }
}
