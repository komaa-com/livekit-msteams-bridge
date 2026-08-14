---
title: Configuration Reference
description: Every environment variable the bridge reads, its default, and what it does.
---

The bridge is configured entirely through environment variables (`loadConfig()` reads them). The package ships a commented [`.env.example`](https://github.com/komaa-com/livekit-msteams-bridge/blob/main/.env.example). Numeric variables **fail loudly** on a non-numeric or negative value - a typo stops startup rather than silently disabling a governor.

## Required

| Variable | Description |
| --- | --- |
| `BRIDGE_SECRET` | The shared secret from your StandIn identity (pairing issues it). Must match exactly or the upgrade is rejected with `401`. |
| `LIVEKIT_URL` | LiveKit server URL - a LiveKit Cloud project (`wss://<project>.livekit.cloud`) or self-hosted. |
| `LIVEKIT_API_KEY` | LiveKit API key. Mints join tokens, dispatches agents, deletes rooms. Server-side only. |
| `LIVEKIT_API_SECRET` | LiveKit API secret paired with the key. |

## LiveKit dispatch

| Variable | Default | Description |
| --- | --- | --- |
| `LIVEKIT_AGENT_NAME` | *(unset)* | The `agentName` your worker registers with, for **explicit dispatch** (recommended). Unset falls back to automatic dispatch (an unnamed agent joins every room; prototype-only). |
| `LIVEKIT_ROOM_PREFIX` | `msteams-` | Room name prefix; the room is `${prefix}${callId}` (sanitized, capped at 100 chars). |
| `LIVEKIT_DELETE_ROOM_ON_END` | `true` | Delete the room at teardown so the agent job ends immediately instead of idling out. Set `false` only if something else owns room lifecycle. |

## Governor

There is no bridge-side TTS on the room transport: the goodbye is a `msteams.goodbye` data message your agent speaks. See [Governors and Privacy](/livekit-msteams-bridge/governors-and-privacy/).

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_CALL_MINUTES` | `0` | Bridge-side hard cap on call duration in minutes (fractional allowed). `0` disables it. On limit, the bridge asks the agent to say goodbye, waits the grace, then ends the call. |
| `GOODBYE_TEXT` | *(a polite default)* | The line sent on `msteams.goodbye` at cutoff. |
| `GOODBYE_GRACE_MS` | `8000` | How long to let the goodbye play before `session.end`. |

## Ambient vision

Relays the caller's screen-share and camera to the agent as discrete labelled images, published as a **byte stream** on the `msteams.vision` topic (read it with `room.register_byte_stream_handler`). Only frames that actually changed are sent, so a frozen screen costs nothing.

**Off by default.** This is the one capability here that spends money - a vision-model call per delivered frame - so it never turns itself on.

| Variable | Default | Description |
| --- | --- | --- |
| `AMBIENT_VISION` | `false` | Master switch. Off means inbound `video.frame` messages are ignored entirely. |
| `MAX_VISION_PER_MINUTE` | `30` | Per-call spend cap over a sliding 60-second window. **`0` disables.** Set it deliberately: this is the knob that spends money per frame. |
| `REQUIRE_RECORDING_STATUS` | `true` | Hold frames back until Teams reports the call recording as active (Media Access obligation). While it blocks, frames are not even stored, so nothing captured beforehand can surface later. |

Under a tight budget the screen-share wins the last slot ahead of the camera: a shared screen carries far more than a talking head. Each image's stream attributes carry `source`, `owner` (`"Sara's shared screen"`, degrading to `"a shared screen"` when Teams does not name the participant), `caption`, `width`, `height` and `ts`.

## Group-call gate

In a call with 2+ humans the bridge sends the agent a **GROUP-CALL ETIQUETTE** clause on `msteams.context` naming its wake phrases, and deterministically withholds the agent's audio from Teams while it has not been addressed. **A 1:1 call is never gated, whatever these are set to.**

This one is on by default, which does not break the "opt-in by default" rule: it only ever suppresses output, it never adds an API call.

| Variable | Default | Description |
| --- | --- | --- |
| `GROUP_CALL_REQUIRE_ADDRESS` | `true` | Require the agent to be addressed by name before it may speak in a group call. `false` opts out completely. |
| `GROUP_CALL_WAKE_PHRASES` | `assistant` | Comma-separated. Matching is case-insensitive and boundary-aware: `assistant` matches `"Assistant, what's this?"` but not `"assistantship"`. An empty value reads as *unset* and falls back to the default - emptying the list is not a way to opt out, because that would be a mute switch. |
| `GROUP_CALL_FOLLOW_UP_WINDOW_MS` | `12000` | Keep answering for this long after being addressed, without being named again. `0` means "address me every turn" - and because an audio egress has no turn boundary to express that, `0` also disables the deterministic backstop and leaves the etiquette instruction alone. |

The wake phrase is detected from what your agent publishes on LiveKit's own `lk.transcription` topic (enabled by default in `AgentSession`) - the bridge runs no STT. If your agent disables transcription output, the instruction still goes out but the audio backstop stays off, deliberately: a gate whose trigger can never fire must not be allowed to mute the agent for a whole meeting.

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | TCP port for worker WebSocket upgrades (and `/healthz`, `/metrics`). |
| `BIND` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |
| `STALE_CALL_REAPER_SECONDS` | `120` | End a call whose agent never joined the room (`session.end` reason `no-answer`). `0` disables. Covers the most common setup mistake - `LIVEKIT_AGENT_NAME` not matching the worker's `agent_name` - where the caller would otherwise sit on a silent call that nothing ever ends. Costs nothing to leave on: it makes no provider call, it only frees local resources. |

## Transport hardening

| Variable | Default | Description |
| --- | --- | --- |
| `HMAC_FRESHNESS_MS` | `60000` | Allowed clock skew for the upgrade timestamp, and the replay-guard window. |
| `MAX_CONNECTIONS` | `64` | Max concurrent worker connections. `0` uses the default. |
| `MAX_CONNECTIONS_PER_IP` | *(= `MAX_CONNECTIONS`)* | Max concurrent connections from one remote IP. Default is the global cap (no per-IP throttle) because StandIn dials from a small fixed egress set. Set explicitly if the bridge is more broadly exposed. |
| `PRE_START_TIMEOUT_MS` | `10000` | Drop a client that authenticates but never sends `session.start`. |
| `WORKER_IDLE_TIMEOUT_MS` | `90000` | Dead-peer window: end the call after this long with no worker message (the worker heartbeats every 30 s). |
| `TRUST_PROXY_XFF` | `false` | Trust the first `X-Forwarded-For` hop for the per-IP cap. Enable **only** behind a single proxy that overwrites the header - otherwise it is client-controlled. |

## A note on TLS

There is no TLS variable: the bridge serves plain WebSocket by design. Front it with a TLS terminator (tunnel, ingress, or load balancer). See [Connecting to StandIn](/livekit-msteams-bridge/connecting-to-standin/).
