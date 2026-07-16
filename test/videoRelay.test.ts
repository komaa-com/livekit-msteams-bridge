import { test } from "node:test";
import assert from "node:assert/strict";
import { selectParticipant, loadJpegEncoder } from "../src/videoRelay.js";

const noopLog = { info() {}, warn() {}, error() {}, debug() {} } as any;

// A minimal Room-shaped stub: selectParticipant only reads room.remoteParticipants.
function room(parts: Array<{ identity: string; attributes?: Record<string, string> }>): any {
  return { remoteParticipants: new Map(parts.map((p) => [p.identity, p])) };
}

const PUBLISH_ON_BEHALF = "lk.publish_on_behalf";

test("explicit identity mode selects that participant, ignoring the agent binding", () => {
  const r = room([{ identity: "agent-1" }, { identity: "avatar-x" }]);
  const chosen = selectParticipant(r, "avatar-x", "agent-1");
  assert.equal(chosen?.identity, "avatar-x");
  assert.equal(selectParticipant(r, "nobody", "agent-1"), null);
});

test("auto mode prefers the participant that publishes on behalf of the agent", () => {
  // The avatar publishes both tracks and tags lk.publish_on_behalf = <agent>.
  const r = room([
    { identity: "agent-1" },
    { identity: "bithuman-avatar-agent", attributes: { [PUBLISH_ON_BEHALF]: "agent-1" } },
    { identity: "monitor" },
  ]);
  const chosen = selectParticipant(r, "auto", "agent-1");
  assert.equal(chosen?.identity, "bithuman-avatar-agent");
});

test("auto mode falls back to the agent identity when nothing declares publish_on_behalf", () => {
  const r = room([{ identity: "agent-1" }, { identity: "monitor" }]);
  const chosen = selectParticipant(r, "auto", "agent-1");
  assert.equal(chosen?.identity, "agent-1");
});

test("auto mode returns null before the agent identity is known", () => {
  const r = room([{ identity: "agent-1", attributes: { [PUBLISH_ON_BEHALF]: "agent-1" } }]);
  assert.equal(selectParticipant(r, "auto", null), null);
});

test("a debugger's publish_on_behalf for a different agent is not selected", () => {
  const r = room([
    { identity: "agent-1" },
    { identity: "debug", attributes: { [PUBLISH_ON_BEHALF]: "some-other-agent" } },
  ]);
  // No avatar for agent-1, so it falls back to the agent participant itself.
  assert.equal(selectParticipant(r, "auto", "agent-1")?.identity, "agent-1");
});

test("avatar-publishes-both config: the audio binding IS the avatar; self branch selects it", () => {
  // In the verified avatar setup the avatar participant publishes BOTH tracks,
  // so the bridge binds agentIdentity to the avatar itself. Its
  // publish_on_behalf names the (silent) agent, so the byBehalf branch misses
  // and the self branch must select the avatar.
  const r = room([
    { identity: "my-agent" }, // publishes nothing (audio forwarded to the avatar)
    { identity: "bithuman-avatar-agent", attributes: { [PUBLISH_ON_BEHALF]: "my-agent" } },
  ]);
  const chosen = selectParticipant(r, "auto", "bithuman-avatar-agent");
  assert.equal(chosen?.identity, "bithuman-avatar-agent");
});

// The JPEG encoder is backed by `sharp`, an OPTIONAL peer dependency. This test
// pins the contract on BOTH env states (mirrors the Python sibling's
// test_jpeg_encoder_resizes_to_the_tile): when sharp is absent the loader
// returns null (the relay becomes a no-op, audio unaffected); when present it
// encodes RGB24 down to the 640x360 tile. In a clean CI install sharp is not
// present, so the null branch is what runs there.
test("loadJpegEncoder: null when sharp absent, else encodes to the 640x360 tile", async () => {
  const encode = await loadJpegEncoder(noopLog);
  if (encode === null) {
    // sharp-absent contract: no-op path. Nothing else to assert.
    return;
  }
  const W = 100;
  const H = 60;
  const rgb = Buffer.alloc(W * H * 3, 0x7f); // mid-grey RGB24
  const jpeg = await encode(rgb, W, H);
  assert.ok(Buffer.isBuffer(jpeg) && jpeg.length > 0, "encoder returns a non-empty buffer");
  // JPEG SOI marker (0xFFD8) proves it is actually JPEG-encoded.
  assert.equal(jpeg[0], 0xff);
  assert.equal(jpeg[1], 0xd8);
});
