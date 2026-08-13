import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AmbientVision,
  AMBIENT_VISION_DEFAULTS,
  MAX_QUEUED_AMBIENT_IMAGES,
  VisionBudget,
  captionFor,
  describeFrameOwner,
  fallbackOwner,
  resolveAmbientVisionConfig,
  visionSourceOf,
  type AmbientVisionConfig,
  type VisionImage,
} from "../src/vision.js";
import type { Logger } from "../src/log.js";
import type { VideoFrameMessage } from "../src/protocol.js";

const noopLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

function frame(over: Partial<VideoFrameMessage> = {}): VideoFrameMessage {
  return {
    type: "video.frame",
    source: "screenshare",
    ts: 1,
    width: 1280,
    height: 720,
    mime: "image/jpeg",
    dataBase64: "AAAA",
    ...over,
  };
}

/** A promise plus its resolver, so a test can hold a delivery in flight. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Let queued microtasks (the flush chain) run to completion. */
const settle = () => new Promise((r) => setTimeout(r, 5));

interface Harness {
  vision: AmbientVision;
  delivered: VisionImage[];
  state: { permitted: boolean; ready: boolean; now: number };
  failNext: () => void;
  holdNext: () => { resolve: () => void };
}

function harness(over: Partial<AmbientVisionConfig> = {}): Harness {
  const delivered: VisionImage[] = [];
  const state = { permitted: true, ready: true, now: 1_000 };
  let fail = false;
  let hold: { promise: Promise<void>; resolve: () => void } | null = null;
  const vision = new AmbientVision({
    callId: "c1",
    config: resolveAmbientVisionConfig({ enabled: true, requireRecordingStatus: false, ...over }),
    log: noopLog,
    mediaPermitted: () => state.permitted,
    sinkReady: () => state.ready,
    now: () => state.now,
    deliver: async (image) => {
      if (fail) {
        fail = false;
        throw new Error("delivery blew up");
      }
      if (hold) {
        const h = hold;
        hold = null;
        await h.promise;
      }
      delivered.push(image);
    },
  });
  return {
    vision,
    delivered,
    state,
    failNext: () => {
      fail = true;
    },
    holdNext: () => {
      const d = deferred();
      hold = d;
      return d;
    },
  };
}

// ---------------------------------------------------------------------------
// VisionBudget - the sliding-window spend cap
// ---------------------------------------------------------------------------

test("budget: maxPerMinute <= 0 DISABLES (the reference's 0 = unlimited was the inverse footgun)", () => {
  const b = new VisionBudget(0);
  assert.equal(b.tryConsume("c1", 0), false);
  assert.equal(new VisionBudget(-5).tryConsume("c1", 0), false);
});

test("budget: caps within the window, and the window slides after 60 s", () => {
  const b = new VisionBudget(2);
  assert.equal(b.tryConsume("c1", 0), true);
  assert.equal(b.tryConsume("c1", 10), true);
  assert.equal(b.tryConsume("c1", 20), false);
  // 60 s after the first hit it ages out and a slot frees up.
  assert.equal(b.tryConsume("c1", 60_001), true);
});

test("budget: per-call windows are independent; refund and release behave", () => {
  const b = new VisionBudget(1);
  assert.equal(b.tryConsume("c1", 0), true);
  assert.equal(b.tryConsume("c2", 0), true, "a second call has its own window");
  assert.equal(b.tryConsume("c1", 1), false);
  b.refund("c1");
  assert.equal(b.tryConsume("c1", 2), true, "a refunded slot is spendable again");
  b.refund("unknown-call"); // must be a no-op, not a throw
  b.release("c1");
  assert.equal(b.tryConsume("c1", 3), true, "release drops the call's window entirely");
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test("owner attribution degrades to the source kind instead of vanishing", () => {
  assert.equal(describeFrameOwner({ source: "screenshare", participantName: "Sara" }), "Sara's shared screen");
  assert.equal(describeFrameOwner({ source: "camera", participantName: "Bob" }), "Bob's camera");
  assert.equal(describeFrameOwner({ source: "camera", participantName: "  " }), null);
  assert.equal(describeFrameOwner({ source: "camera" }), null);
  assert.equal(fallbackOwner("screenshare"), "a shared screen");
  assert.equal(fallbackOwner("camera"), "a camera");
  assert.match(captionFor("Sara's shared screen"), /Sara's shared screen/);
});

test("only camera and screenshare are relayed; unknown sources are ignored", () => {
  assert.equal(visionSourceOf("screenshare"), "screenshare");
  assert.equal(visionSourceOf("camera"), "camera");
  assert.equal(visionSourceOf("whiteboard"), null);
});

test("config defaults: OFF, 30/min, recording gate on", () => {
  assert.deepEqual(resolveAmbientVisionConfig(undefined), AMBIENT_VISION_DEFAULTS);
  assert.equal(resolveAmbientVisionConfig({}).enabled, false, "must not self-enable");
  // Per-key ??, so an explicit 0 survives rather than being replaced by 30.
  assert.equal(resolveAmbientVisionConfig({ maxPerMinute: 0 }).maxPerMinute, 0);
});

// ---------------------------------------------------------------------------
// AmbientVision - the delivery algorithm
// ---------------------------------------------------------------------------

test("disabled by default: an inbound frame is never delivered", async () => {
  const delivered: VisionImage[] = [];
  const vision = new AmbientVision({
    callId: "c1",
    config: resolveAmbientVisionConfig(undefined),
    log: noopLog,
    mediaPermitted: () => true,
    sinkReady: () => true,
    deliver: async (i) => {
      delivered.push(i);
    },
  });
  vision.offer(frame());
  await settle();
  assert.equal(delivered.length, 0);
  vision.release();
});

test("a frame is delivered once, attributed; identical bytes are not re-sent", async () => {
  const h = harness();
  h.vision.offer(frame({ participantName: "Sara" }));
  await settle();
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].owner, "Sara's shared screen");
  assert.equal(h.delivered[0].source, "screenshare");

  // Same bytes again: a frozen screen must cost nothing.
  h.vision.offer(frame({ participantName: "Sara" }));
  await settle();
  assert.equal(h.delivered.length, 1, "unchanged frame skipped by the per-source latch");

  // Different bytes: delivered.
  h.vision.offer(frame({ participantName: "Sara", dataBase64: "BBBB" }));
  await settle();
  assert.equal(h.delivered.length, 2);
  h.vision.release();
});

test("the latch is per source: a still camera does not block a changing screen", async () => {
  const h = harness();
  h.vision.offer(frame({ source: "camera", dataBase64: "CAM" }));
  h.vision.offer(frame({ source: "screenshare", dataBase64: "S1" }));
  await settle();
  h.vision.offer(frame({ source: "camera", dataBase64: "CAM" })); // unchanged
  h.vision.offer(frame({ source: "screenshare", dataBase64: "S2" }));
  await settle();
  assert.deepEqual(
    h.delivered.map((i) => i.dataBase64),
    ["CAM", "S1", "S2"],
  );
  h.vision.release();
});

test("screen-share wins the last budget slot, and exhaustion breaks the pass", async () => {
  // To get BOTH sources pending in one pass, hold a camera delivery in flight (camera is last in
  // the order, so that pass ends there) and let new frames for both sources land meanwhile.
  const h = harness({ maxPerMinute: 2 });
  const held = h.holdNext();
  h.vision.offer(frame({ source: "camera", dataBase64: "CAM1" }));
  await settle();
  h.vision.offer(frame({ source: "screenshare", dataBase64: "S1" }));
  h.vision.offer(frame({ source: "camera", dataBase64: "CAM2" }));
  held.resolve();
  await settle();
  // CAM1 spent slot 1. The follow-up pass takes SCREENSHARE first (S1, slot 2) and then BREAKS -
  // the newer camera frame is dropped rather than the screen losing the slot.
  assert.deepEqual(
    h.delivered.map((i) => i.dataBase64),
    ["CAM1", "S1"],
  );
  h.vision.release();
});

test("a failed delivery refunds the budget and leaves the frame retryable", async () => {
  const h = harness({ maxPerMinute: 1 });
  h.failNext();
  h.vision.offer(frame({ dataBase64: "S1" }));
  await settle();
  assert.equal(h.delivered.length, 0, "the delivery threw");

  // Latching a failed push would lose the frame forever AND burn the only budget slot; both must
  // still be available, so the identical frame goes out on the next trigger.
  h.vision.flush();
  await settle();
  assert.deepEqual(
    h.delivered.map((i) => i.dataBase64),
    ["S1"],
  );
  h.vision.release();
});

test("frames captured before the room is up are held in a bounded newest-wins buffer", async () => {
  const h = harness();
  h.state.ready = false;
  for (let i = 0; i < MAX_QUEUED_AMBIENT_IMAGES + 2; i++) {
    h.vision.offer(frame({ dataBase64: `S${i}` }));
    await settle();
  }
  assert.equal(h.vision.queuedCount, MAX_QUEUED_AMBIENT_IMAGES);
  assert.equal(h.delivered.length, 0);

  h.state.ready = true;
  h.vision.flush();
  await settle();
  // Oldest evicted (S0, S1 gone): ambient context is about NOW.
  assert.deepEqual(
    h.delivered.map((i) => i.dataBase64),
    ["S2", "S3", "S4", "S5", "S6", "S7"],
  );
  h.vision.release();
});

test("the media gate blocks capture entirely, not just delivery", async () => {
  const h = harness();
  h.state.permitted = false;
  h.vision.offer(frame({ dataBase64: "PRE" }));
  await settle();
  assert.equal(h.delivered.length, 0);
  assert.equal(h.vision.queuedCount, 0, "a blocked frame is not even stored");

  // Opening the gate must not retroactively surface the frame captured while it was shut.
  h.state.permitted = true;
  h.vision.flush();
  await settle();
  assert.equal(h.delivered.length, 0);
  h.vision.release();
});

test("release clears the call's frames, queue and budget", async () => {
  const h = harness();
  h.state.ready = false;
  h.vision.offer(frame({ dataBase64: "S1" }));
  await settle();
  assert.equal(h.vision.queuedCount, 1);
  h.vision.release();
  assert.equal(h.vision.queuedCount, 0);
  // A released instance is inert.
  h.state.ready = true;
  h.vision.offer(frame({ dataBase64: "S2" }));
  await settle();
  assert.equal(h.delivered.length, 0);
});
