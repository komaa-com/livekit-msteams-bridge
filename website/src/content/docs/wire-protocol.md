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
| `participants` | `count` of human participants. Forwarded to the agent on `msteams.context`. |
| `dtmf` | A keypad `digit`. Forwarded to the agent on `msteams.context`. |
| `recording.status` | Recording `status` change. Surfaced to the agent on `msteams.context`, and it opens the ambient-vision media gate (nothing is persisted by this bridge). |
| `video.frame` | Caller camera/screenshare frame. Ignored unless `AMBIENT_VISION=true`, in which case the newest *changed* frame per source is published to the agent as a labelled image on `msteams.vision`. Never published as a room video track. |
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
| `display.frame` | One frame of the avatar-video stream for the bot's Teams tile (JPEG, base64). Sent only when the agent publishes avatar video and `LIVEKIT_TILE_VIDEO` is not `off` (default `auto`). Latest-wins: frames are dropped, never queued, under backpressure. |

The StandIn worker also accepts `expression` (avatar emotion cues) and `display.image` (one still picture on the bot's tile). **This bridge never sends either**, and they are not in its `WorkerOutbound` type. Both need the agent to ask for them, and this transport has no agent-to-bridge command lane: the bridge subscribes to room track events and to caller transcripts, and nothing carries a command back the other way. Supporting them means defining a new inbound contract that every deployed LiveKit agent would have to adopt - a protocol change rather than a bridge change. The plugin-shaped siblings, which run inside an agent host, do emit them.

## Framing and backpressure

- **Ordering** - `audio.frame`s carry a monotonic `seq` and a `timestampMs` derived from cumulative PCM duration, so the receiver can order and pace playback.
- **Backpressure** - if the worker's receive buffer backs up, the bridge drops only the continuous realtime streams (`audio.frame`, and `display.frame` against its own tighter video budget) and always delivers control frames (`session.end`, `pong`, `assistant.cancel`).
- **Parsing** - a frame that isn't valid JSON with a string `type` is dropped and logged, never thrown - a malformed frame can't crash a call.

## Helpers

The protocol module also exports two small utilities used across the relay:

- `parseWorkerMessage(raw)` - parse a frame to a typed message, or `null` on junk.
- `pcm16kBytesToMs(bytes)` - PCM16K byte length to milliseconds (16 kHz x 2 bytes = 32 bytes/ms), used to advance the outbound timeline.
