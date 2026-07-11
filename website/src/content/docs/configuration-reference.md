---
title: Configuration Reference
description: Every environment variable the bridge reads, its default, and what it does.
---

The bridge is configured entirely through environment variables (`loadConfig()` reads them). The package ships a commented [`.env.example`](https://github.com/komaa-com/livekit-msteams-bridge/blob/main/.env.example). Numeric variables **fail loudly** on a non-numeric or negative value - a typo stops startup rather than silently disabling a governor.

## Required

| Variable | Description |
| --- | --- |
| `WORKER_SHARED_SECRET` | The shared secret from your StandIn identity (pairing issues it). Must match exactly or the upgrade is rejected with `401`. |
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

There is no bridge-side TTS on the room transport: the goodbye is a `teams.goodbye` data message your agent speaks. See [Governors and Privacy](/livekit-msteams-bridge/governors-and-privacy/).

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_CALL_MINUTES` | `0` | Bridge-side hard cap on call duration in minutes (fractional allowed). `0` disables it. On limit, the bridge asks the agent to say goodbye, waits the grace, then ends the call. |
| `GOODBYE_TEXT` | *(a polite default)* | The line sent on `teams.goodbye` at cutoff. |
| `GOODBYE_GRACE_MS` | `8000` | How long to let the goodbye play before `session.end`. |

## Server

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | TCP port for worker WebSocket upgrades (and `/healthz`, `/metrics`). |
| `BIND` | `0.0.0.0` | Bind address. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. |

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
