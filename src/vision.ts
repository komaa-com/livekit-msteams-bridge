/**
 * Ambient vision: keep the agent continuously visually aware of the Teams call.
 *
 * While a call is live, the newest picture of what each participant is SHARING (screen-share) and
 * SHOWING (camera) is handed to the agent as labelled context - without the caller invoking
 * anything. Nothing here ever makes the agent speak: a delivered frame is context it uses on its
 * next natural turn.
 *
 * On this transport there is no model session the bridge can push into, so "deliver" means "publish
 * onto the room" (see `AgentRoomPort.sendVision`, a byte stream on the `teams.vision` topic). The
 * queue below is the port of the reference's "cannot deliver between turns" fallback: here the only
 * moment delivery is impossible is while the room is still connecting, so frames are held in a
 * small newest-wins buffer and flushed the instant the room is up.
 *
 * OPT-IN. Vision tokens are the dominant cost of continuous perception, so `enabled` defaults to
 * false: a bridge nobody configured must not start spending because a worker happened to send video.
 */

import type { Logger } from "./log.js";
import type { VideoFrameMessage } from "./protocol.js";

/**
 * Safety-net poll interval. Frame ARRIVAL is the real trigger; this only catches frames that were
 * skipped for a reason that later went away - the recording gate was closed, the room was still
 * connecting, or the minute's budget was spent. A static screen sends no new frame, so without this
 * the agent would never see it. Armed lazily on the first frame, so a call with no video has no timer.
 */
export const AMBIENT_VISION_BACKSTOP_MS = 6_000;

/**
 * Fallback-queue cap. Ambient context is about NOW, so eviction is oldest-first. Unbounded here
 * meant hundreds of megabytes retained per long call (50-200 KB of base64 per frame).
 */
export const MAX_QUEUED_AMBIENT_IMAGES = 6;

/**
 * Screen-share FIRST, camera second - so a tight budget spends its last slot on the screen, which
 * carries far more information than a talking head.
 */
export const VISION_SOURCE_ORDER = ["screenshare", "camera"] as const;
export type VisionSource = (typeof VISION_SOURCE_ORDER)[number];

/** Map a wire `video.frame.source` onto a source we relay; unknown sources are ignored. */
export function visionSourceOf(raw: string): VisionSource | null {
  return raw === "screenshare" || raw === "camera" ? raw : null;
}

export interface AmbientVisionConfig {
  /** Master switch. Off by default: this is the knob that costs money. */
  enabled: boolean;
  /**
   * Per-call spend cap over a sliding 60-second window.
   *
   * NOTE a deliberate divergence from the reference implementation, where `0` meant UNLIMITED - the
   * inverse of what everyone reads it as, and its only kill switch. Here `0` DISABLES, and the
   * separate `enabled` flag is how the feature is turned on. Set a large number for "effectively
   * unlimited".
   */
  maxPerMinute: number;
  /** Hold frames back until Teams reports the call recording as active (Media Access obligation). */
  requireRecordingStatus: boolean;
}

/** Defaults, in one place so the env layer and the docs cannot drift apart. */
export const AMBIENT_VISION_DEFAULTS: AmbientVisionConfig = {
  enabled: false,
  maxPerMinute: 30,
  requireRecordingStatus: true,
};

export function resolveAmbientVisionConfig(
  raw: Partial<AmbientVisionConfig> | undefined,
): AmbientVisionConfig {
  return {
    enabled: raw?.enabled ?? AMBIENT_VISION_DEFAULTS.enabled,
    maxPerMinute: raw?.maxPerMinute ?? AMBIENT_VISION_DEFAULTS.maxPerMinute,
    requireRecordingStatus: raw?.requireRecordingStatus ?? AMBIENT_VISION_DEFAULTS.requireRecordingStatus,
  };
}

/** One picture handed to the agent, already attributed. */
export interface VisionImage {
  source: VisionSource;
  mime: string;
  /** Base64 image bytes, exactly as the worker sent them (the bridge never transcodes). */
  dataBase64: string;
  width: number;
  height: number;
  /** Capture timestamp from the worker, epoch ms. */
  ts: number;
  /** Whose screen/camera this is, e.g. `Sara's shared screen` - never empty. */
  owner: string;
  /** One short sentence the agent can read as context. */
  caption: string;
}

/**
 * Per-call vision spend cap: a sliding 60-second window per call.
 *
 * Pure apart from the injected `nowMs`, so it is unit-testable without fake timers.
 * `maxPerMinute <= 0` means DISABLED (see {@link AmbientVisionConfig.maxPerMinute}).
 */
export class VisionBudget {
  private readonly hitsByCall = new Map<string, number[]>();

  constructor(private readonly maxPerMinute: number) {}

  /** True (recording a hit) while under budget; false when the caller must skip this frame. */
  tryConsume(callId: string, nowMs: number): boolean {
    if (this.maxPerMinute <= 0) {
      return false;
    }
    const recent = (this.hitsByCall.get(callId) ?? []).filter((t) => nowMs - t < 60_000);
    if (recent.length >= this.maxPerMinute) {
      this.hitsByCall.set(callId, recent); // keep the trimmed window
      return false;
    }
    recent.push(nowMs);
    this.hitsByCall.set(callId, recent);
    return true;
  }

  /**
   * Give back the most recent hit: the delivery it paid for never happened. Without this a failed
   * push burns a budget slot forever. A refund for a call with no window is a no-op.
   */
  refund(callId: string): void {
    this.hitsByCall.get(callId)?.pop();
  }

  /** Drop a call's window when the call ends, or it leaks for the process lifetime. */
  release(callId: string): void {
    this.hitsByCall.delete(callId);
  }
}

/**
 * Whose screen/camera a frame shows, or null when the worker did not name the participant. Returning
 * null (rather than a guess) lets the caller degrade the label to the source kind instead of
 * dropping attribution entirely - a meeting screenshot with no owner is close to unusable.
 */
export function describeFrameOwner(frame: {
  source: string;
  participantName?: string | null;
}): string | null {
  const name = frame.participantName?.trim();
  if (!name) {
    return null;
  }
  return frame.source === "screenshare" ? `${name}'s shared screen` : `${name}'s camera`;
}

/** The degraded label used when the worker did not name the participant. */
export function fallbackOwner(source: VisionSource): string {
  return source === "screenshare" ? "a shared screen" : "a camera";
}

export function captionFor(owner: string): string {
  return `Live frame of ${owner}.`;
}

export interface AmbientVisionDeps {
  callId: string;
  config: AmbientVisionConfig;
  log: Logger;
  /**
   * True while the bridge may process this call's media at all (recording gate + call still live).
   * Checked before a frame is even STORED, unlike the reference, which stored everything and gated
   * only delivery - so pre-recording frames sat in memory and stayed reachable afterwards.
   */
  mediaPermitted: () => boolean;
  /** True when the agent side can accept an image right now (the room is connected). */
  sinkReady: () => boolean;
  /** Deliver one image. MUST reject on failure, so the budget can be refunded. */
  deliver: (image: VisionImage) => Promise<void>;
  /** Injectable clock, so the budget window is testable without waiting. */
  now?: () => number;
}

interface StoredFrame {
  source: VisionSource;
  mime: string;
  dataBase64: string;
  width: number;
  height: number;
  ts: number;
  owner: string;
}

/**
 * Per-call ambient vision: the frame store, the per-source change latch, the budget, the fallback
 * queue and the backstop timer. One instance per {@link CallSession}.
 */
export class AmbientVision {
  private readonly deps: AmbientVisionDeps;
  private readonly budget: VisionBudget;
  private readonly latest = new Map<VisionSource, StoredFrame>();
  /** Bytes of the frame most recently DELIVERED per source: the change latch. */
  private readonly lastPushed = new Map<VisionSource, string>();
  private readonly queued: VisionImage[] = [];
  private backstop: NodeJS.Timeout | null = null;
  private flushing = false;
  private dirty = false;
  private released = false;
  private announcedQueueRoute = false;

  constructor(deps: AmbientVisionDeps) {
    this.deps = deps;
    this.budget = new VisionBudget(deps.config.maxPerMinute);
  }

  /** Frames currently held for a room that is not up yet (tests read this). */
  get queuedCount(): number {
    return this.queued.length;
  }

  /** Store an inbound worker frame and try to deliver. A no-op when the feature is off. */
  offer(frame: VideoFrameMessage): void {
    if (!this.deps.config.enabled || this.released) {
      return;
    }
    const source = visionSourceOf(frame.source);
    if (!source || !frame.dataBase64) {
      return;
    }
    if (!this.deps.mediaPermitted()) {
      return;
    }
    this.latest.set(source, {
      source,
      mime: frame.mime || "image/jpeg",
      dataBase64: frame.dataBase64,
      width: frame.width,
      height: frame.height,
      ts: frame.ts,
      owner: describeFrameOwner(frame) ?? fallbackOwner(source),
    });
    this.startBackstop();
    this.flush();
  }

  /**
   * Deliver whatever is newest and unseen. Safe to call from anywhere that may have unblocked
   * delivery (a frame arrived, the room came up, recording went active, the backstop ticked).
   */
  flush(): void {
    if (!this.deps.config.enabled || this.released) {
      return;
    }
    if (this.flushing) {
      // Delivery is async; a second pass over an unlatched frame would send it twice and pay twice.
      this.dirty = true;
      return;
    }
    this.flushing = true;
    void this.run()
      // Ambient vision is best-effort context: nothing about it may become an unhandled rejection
      // that takes the call (or the process) down.
      .catch((err) => this.deps.log.debug(`ambient vision: flush failed: ${(err as Error).message}`))
      .finally(() => {
        this.flushing = false;
        if (this.dirty) {
          this.dirty = false;
          this.flush();
        }
      });
  }

  /** Drop the call's frames, queue and budget window, and stop the backstop. */
  release(): void {
    this.released = true;
    if (this.backstop) {
      clearInterval(this.backstop);
      this.backstop = null;
    }
    this.latest.clear();
    this.lastPushed.clear();
    this.queued.length = 0;
    this.budget.release(this.deps.callId);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private startBackstop(): void {
    if (this.backstop || this.released) {
      return;
    }
    this.backstop = setInterval(() => this.flush(), AMBIENT_VISION_BACKSTOP_MS);
    this.backstop.unref?.();
  }

  private enqueue(image: VisionImage): void {
    if (!this.announcedQueueRoute) {
      this.announcedQueueRoute = true;
      // Announced ONCE per call, not once per frame: the delivery route is a real behavioural
      // difference (the agent sees these frames later than it otherwise would) and silence about it
      // is how such differences stay invisible for weeks.
      this.deps.log.info(
        `ambient vision: the agent room is not ready yet; holding the newest ${MAX_QUEUED_AMBIENT_IMAGES} frame(s) until it is`,
      );
    }
    this.queued.push(image);
    while (this.queued.length > MAX_QUEUED_AMBIENT_IMAGES) {
      this.queued.shift(); // newest wins: ambient context is about NOW
    }
  }

  private async run(): Promise<void> {
    if (!this.deps.mediaPermitted()) {
      return;
    }
    if (this.deps.sinkReady() && this.queued.length > 0) {
      // Already paid for at collection time; a drain failure drops them rather than refunding,
      // because by now they are stale and the live frames below are the ones worth spending on.
      for (const image of this.queued.splice(0, this.queued.length)) {
        try {
          await this.deps.deliver(image);
        } catch (err) {
          this.deps.log.debug(`ambient vision: queued frame dropped: ${(err as Error).message}`);
        }
      }
    }

    for (const source of VISION_SOURCE_ORDER) {
      const frame = this.latest.get(source);
      if (!frame) {
        continue;
      }
      if (frame.dataBase64 === this.lastPushed.get(source)) {
        continue; // per-source change latch: a frozen screen costs nothing
      }
      if (!this.budget.tryConsume(this.deps.callId, this.now())) {
        break; // break, not continue: the budget is per call, not per source
      }
      const image: VisionImage = {
        source,
        mime: frame.mime,
        dataBase64: frame.dataBase64,
        width: frame.width,
        height: frame.height,
        ts: frame.ts,
        owner: frame.owner,
        caption: captionFor(frame.owner),
      };
      if (!this.deps.sinkReady()) {
        this.enqueue(image);
        this.lastPushed.set(source, frame.dataBase64);
        continue;
      }
      try {
        await this.deps.deliver(image);
      } catch (err) {
        // The spend never happened, and the frame must stay retryable: latching a failed delivery
        // loses the frame forever AND burns the budget slot.
        this.budget.refund(this.deps.callId);
        this.deps.log.debug(`ambient vision: delivery failed: ${(err as Error).message}`);
        continue;
      }
      // Latch only AFTER a successful delivery.
      this.lastPushed.set(source, frame.dataBase64);
      this.deps.log.debug(`ambient vision: delivered ${source} frame (${image.owner})`);
    }
  }
}
