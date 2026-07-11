---
title: Wire Protocol
description: The JSON messages the StandIn media bridge and this bridge exchange over the authenticated WebSocket.
---

After a successful [HMAC handshake](/livekit-msteams-bridge/connecting-to-standin/), the StandIn media bridge and this bridge exchange JSON messages over the WebSocket, one JSON object per frame, discriminated on a `type` field with camelCase properties. Audio is 16 kHz, 16-bit, mono, little-endian PCM, base64-encoded. You only need this page if you are extending the bridge or writing a compatible peer - the [Library API](/livekit-msteams-bridge/library-api/) exposes all of these as TypeScript types.

## Worker → bridge

| `type` | Purpose |
| --- | --- |
| `session.start` | First message of a call. Carries `callId`, `threadId`, `caller` (`aadId`/`displayName`/`tenantId`, all nullable), `recordingStatus`, `direction`. The bridge connects the room and dispatches the agent. |
| `audio.frame` | Caller audio. `seq`, `timestampMs`, `payloadBase64` (PCM16K), optional `speakerName`. Published to the room. |
| `participants` | `count` of human participants. Forwarded to the agent on `teams.context`. |
| `dtmf` | A keypad `digit`. Forwarded to the agent on `teams.context`. |
| `recording.status` | Recording `status` change. Logged (nothing is persisted by this bridge). |
| `video.frame` | Caller camera/screenshare frame. Ignored in v1 (no room video publish). |
| `ping` | Heartbeat (every ~30 s). The bridge replies `pong`; also drives dead-peer detection. |
| `assistant.say` | Worker-side request for the agent to speak a line (funnels through the goodbye path). |
| `session.end` | The call is over (`reason`). The bridge tears down and deletes the room. |

## Bridge → worker

| `type` | Purpose |
| --- | --- |
| `audio.frame` | Agent audio. `seq`, `timestampMs`, `payloadBase64` (PCM16K). The timeline advances by the real PCM duration of each frame. |
| `pong` | Reply to `ping`. |
| `session.end` | The bridge is ending the call (`reason`) - governor cutoff, dead-peer, agent gone, or drain. |
| `assistant.cancel` | Flush Teams-side playback (barge-in / before a goodbye). |
| `expression`, `display.image` | Optional avatar-expression and image-display hints (bulky `display.image` is droppable under backpressure; control frames are not). |

## Framing and backpressure

- **Ordering** - `audio.frame`s carry a monotonic `seq` and a `timestampMs` derived from cumulative PCM duration, so the receiver can order and pace playback.
- **Backpressure** - if the worker's receive buffer backs up, the bridge drops only bulky realtime frames (`audio.frame`, `display.image`) and always delivers control frames (`session.end`, `pong`, `assistant.cancel`).
- **Parsing** - a frame that isn't valid JSON with a string `type` is dropped and logged, never thrown - a malformed frame can't crash a call.

## Helpers

The protocol module also exports two small utilities used across the relay:

- `parseWorkerMessage(raw)` - parse a frame to a typed message, or `null` on junk.
- `pcm16kBytesToMs(bytes)` - PCM16K byte length to milliseconds (16 kHz x 2 bytes = 32 bytes/ms), used to advance the outbound timeline.
