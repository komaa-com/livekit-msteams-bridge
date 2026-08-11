// Guard against LiveKit SDK API drift: every rtc-node / server-sdk symbol this bridge relies on must
// exist with the expected shape. Mirrors the Python bridge's tests/test_livekit_sdk_surface.py, which
// this repo lacked - and TypeScript needs it MORE, not less.
//
// Why: Python raises TypeError on an unknown keyword, so a renamed SDK parameter fails loudly at the
// first call. TypeScript silently discards an unknown property on an options object, so the same drift
// produces a bridge that connects, runs, and quietly does not do the thing you configured. Two bugs
// this week were exactly that shape (an `images` property a host signature never declared; a `task_id`
// inside an args dict the host only read from kwargs) - both invisible until someone spent a day on
// the media path.
//
// So these assertions deliberately ROUND-TRIP the options we set rather than just constructing them:
// `new TrackPublishOptions({source})` never throws on a bad key, and only reading `.source` back
// proves the SDK actually accepted it. This is what lets the dependency pin ride a minor-version range
// without a live LiveKit server in CI.
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from "livekit-server-sdk";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import assert from "node:assert/strict";
import test from "node:test";

test("access token + room dispatch surface (agent dispatch path)", () => {
  const at = new AccessToken("key", "s".repeat(32), { identity: "bridge", ttl: "6h" });
  // roomConfig is how the bridge asks LiveKit to dispatch the customer's agent into the room.
  assert.ok("roomConfig" in at, "AccessToken must expose roomConfig");

  const dispatch = new RoomAgentDispatch({ agentName: "my-agent", metadata: JSON.stringify({ a: 1 }) });
  // Round-trip: an SDK that renamed these would accept the object and drop the values silently.
  assert.equal(dispatch.agentName, "my-agent", "RoomAgentDispatch.agentName must round-trip");
  assert.equal(dispatch.metadata, JSON.stringify({ a: 1 }), "RoomAgentDispatch.metadata must round-trip");

  const rc = new RoomConfiguration({ agents: [dispatch] });
  assert.ok(Array.isArray(rc.agents) && rc.agents.length === 1, "RoomConfiguration.agents must round-trip");

  assert.equal(typeof at.toJwt, "function", "AccessToken.toJwt must exist");
  assert.equal(typeof RoomServiceClient, "function", "RoomServiceClient must be constructible");
});

test("track publish options round-trip the source we set", () => {
  const opts = new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE });
  // The whole point: construction never throws on an unknown key, so read it back.
  assert.equal(opts.source, TrackSource.SOURCE_MICROPHONE, "TrackPublishOptions.source must round-trip");
});

test("room surface: connect, publish, and the events the bridge subscribes to", () => {
  assert.equal(typeof Room.prototype.connect, "function");
  assert.equal(typeof Room.prototype.disconnect, "function");
  // connect(url, token, options) - the bridge passes { autoSubscribe, dynacast } as the 3rd arg.
  assert.ok(Room.prototype.connect.length >= 2, "Room.connect must accept url, token (+ options)");

  // Every event the bridge attaches a handler to. A renamed member would leave a handler that never
  // fires - a call that connects and then does nothing, with no error anywhere.
  for (const evt of ["TrackSubscribed", "TrackUnsubscribed", "ParticipantDisconnected", "Disconnected"]) {
    assert.ok(evt in RoomEvent, `RoomEvent.${evt} must exist`);
  }

  for (const kind of ["KIND_AUDIO", "KIND_VIDEO"]) {
    assert.ok(kind in TrackKind, `TrackKind.${kind} must exist`);
  }
  assert.ok("SOURCE_MICROPHONE" in TrackSource, "TrackSource.SOURCE_MICROPHONE must exist");
});

test("audio surface: the exact shape the Teams->LiveKit leg builds", () => {
  // 16 kHz mono PCM16, 20 ms = 320 samples = 640 bytes: the frame size the Teams wire carries.
  const frame = new AudioFrame(new Int16Array(320), 16000, 1, 320);
  assert.equal(frame.sampleRate, 16000);
  assert.equal(frame.channels, 1);
  assert.equal(frame.samplesPerChannel, 320);
  assert.equal(frame.data.length, 320, "AudioFrame.data must expose the PCM samples");

  assert.equal(typeof AudioSource, "function");
  assert.equal(typeof AudioSource.prototype.captureFrame, "function", "AudioSource.captureFrame must exist");
  assert.equal(typeof LocalAudioTrack.createAudioTrack, "function", "LocalAudioTrack.createAudioTrack must exist");
  assert.equal(typeof AudioStream, "function", "AudioStream must exist (LiveKit -> Teams leg)");
});
