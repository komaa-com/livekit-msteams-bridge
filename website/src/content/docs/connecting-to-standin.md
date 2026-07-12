---
title: Connecting to StandIn
description: What StandIn is, how pairing issues the shared secret, the agent WebSocket URL, TLS, and how a call is authenticated.
---

**StandIn** ([standin.komaa.com](https://standin.komaa.com)) is the hosted service that owns the Microsoft Teams side of the call. It joins the meeting as a bot, captures the media, and dials into your bridge over an HMAC-authenticated WebSocket. You never touch the Teams SDK or Microsoft Graph - StandIn does, and hands your bridge a clean 16 kHz audio stream.

## Pairing and the shared secret

Pick a tier and pair an identity in the StandIn portal. Pairing issues a **shared secret**. That exact string goes in `WORKER_SHARED_SECRET` on the bridge. Both sides sign and verify with it; a mismatch is rejected at the upgrade with `401`.

Keep the secret out of your shell history and images - pass it through your secret manager or an env file the process reads at start.

## The agent WebSocket URL

In the identity's settings, set the **agent WebSocket URL** to your bridge, using the `wss://.../voice/msteams/stream` path:

```text
wss://lk-bridge.example.com:8080/voice/msteams/stream
```

StandIn appends `/{callId}` per call, so the bridge receives `/voice/msteams/stream/{callId}`. The bridge takes the last path segment as the `callId` and binds the whole call to it (the HMAC is computed over that `callId`, so it cannot be tampered with).

## TLS

The bridge serves **plain WebSocket** - put TLS in front of it. StandIn dials from the internet, so `wss://` is required in any real deployment:

- A tunnel (Tailscale Funnel, Cloudflare Tunnel, ngrok) terminates TLS and gives you a public `https`/`wss` host - ideal for a laptop or a quick trial.
- An ingress or load balancer (NGINX, cloud LB) terminates TLS in front of the bridge for a fixed production host.

Never give StandIn a plain `ws://` URL outside local testing - the shared secret and audio would cross the network unencrypted.

If your terminator is a reverse proxy and you rely on the per-IP cap, set `TRUST_PROXY_XFF=true` so the bridge reads the first `X-Forwarded-For` hop - but only behind a single proxy that *overwrites* that header (see [Configuration Reference](/livekit-msteams-bridge/configuration-reference/)).

## How a call is authenticated

Each upgrade carries a millisecond timestamp and an HMAC-SHA256 signature over `"{timestampMs}.{callId}"`, hex-lowercased, in these headers (the legacy `X-OpenClawTeamsBridge-*` names are still accepted; StandIn sends both pairs during the transition):

```text
X-StandIn-Timestamp: 1720000000000
X-StandIn-Signature: <hmac-sha256 hex>
```

The bridge checks the timestamp is fresh (`HMAC_FRESHNESS_MS`, default 60 s), verifies the signature in constant time, and enforces single use of the `(callId, ts, sig)` tuple within the window. A live session already owning that `callId` returns `409` rather than starting a second billed agent. See [Wire Protocol](/livekit-msteams-bridge/wire-protocol/) for the message flow that follows a successful handshake.
