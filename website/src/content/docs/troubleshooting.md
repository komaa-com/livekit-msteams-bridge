---
title: Troubleshooting
description: The failures you are most likely to hit - handshake rejects, the agent never joining, silent audio - and their causes.
---

Start by watching the bridge logs (`LOG_LEVEL=debug` for the most detail) and `GET /metrics`. Most problems fall into one of the buckets below.

## The upgrade is rejected (`401` / `403` / `409` / `503`)

| Symptom in logs | Cause | Fix |
| --- | --- | --- |
| `rejected upgrade … bad signature` | `WORKER_SHARED_SECRET` differs between StandIn and the bridge | Copy the pairing secret exactly into `WORKER_SHARED_SECRET`; restart. |
| `rejected upgrade … stale or missing timestamp` | Clock skew beyond `HMAC_FRESHNESS_MS`, or the headers aren't reaching the bridge | Fix host clock (NTP); make sure your proxy forwards the `X-OpenClawTeamsBridge-*` headers. |
| `rejected upgrade … replayed handshake` | The same handshake tuple was seen twice | Usually a benign retry; if persistent, check for a proxy duplicating the upgrade. |
| `rejected upgrade … bridge shared secret is not configured` | `WORKER_SHARED_SECRET` is unset | Set it. The bridge fails closed rather than accepting unauthenticated calls. |
| `409 … already has a live session` | A second upgrade arrived for a `callId` already live | Expected on a reconnect/rollout; the original call keeps the slot. |
| `503 … connection cap reached` | `MAX_CONNECTIONS` (or per-IP) hit | Raise the cap, or check for stuck sessions with `bridge_calls_active` on `/metrics`. |

## The call connects but the agent never joins

The bridge logs `session.start` and `LiveKit room … joined`, but no `subscribed to agent audio`.

- **`LIVEKIT_AGENT_NAME` mismatch** - the name here must equal the `agent_name` your worker registered with. A typo means dispatch targets an agent that isn't there.
- **The agent worker isn't running / not registered** for that name against this LiveKit project. Start it and confirm it appears in your LiveKit dashboard.
- **Wrong project** - `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` point at a different project than the one your agent worker connects to. Dispatch only reaches agents on the same project.
- **`bridge_room_connect_failures_total` climbing** on `/metrics` means the bridge couldn't join or dispatch at all - check the API key/secret and that the URL is reachable.

## The agent joined but there's no audio

- **Caller can't hear the agent** - confirm the agent actually publishes an audio track (the bridge relays the first remote audio track). Avatar agents publish audio via the avatar participant; the bridge handles that, but a misconfigured avatar that publishes only video will be silent.
- **Agent can't hear the caller** - the bridge publishes caller audio as a 16 kHz mono track; make sure your agent subscribes to and feeds remote audio into its pipeline (the default `AgentSession` does).
- **Garbled audio** - both sides must be 16 kHz PCM16. The bridge captures/relays at 16 kHz and rejects malformed (odd-length) PCM loudly; if you replaced the room connector, keep the sample rate at 16 kHz mono.

## The call ends unexpectedly

- **`no worker message in 90000ms (dead peer?)`** - the worker stopped sending (network drop, half-open socket). The bridge ends the call so it doesn't hold the room and the `callId` lock. Tune with `WORKER_IDLE_TIMEOUT_MS` if your path has long legitimate silences (rare - the worker heartbeats every 30 s).
- **`agent … disconnected`** - the agent participant left the room. The bridge ends the call. Check your agent for crashes or an early `ctx.shutdown()`.
- **Governor cutoff** - `MAX_CALL_MINUTES` fired. Expected; raise or disable it (`0`) if unintended.

## The goodbye gets cut off

The governor's goodbye is spoken by your agent, not the bridge. If the agent's current turn outlasts `GOODBYE_GRACE_MS`, the goodbye is truncated. Have the `teams.goodbye` handler interrupt the current turn before speaking - see [Agents and Dispatch](/livekit-msteams-bridge/agents-and-dispatch/) - or raise `GOODBYE_GRACE_MS`.

## Rooms linger after calls

If rooms outlive their calls in the LiveKit dashboard, confirm `LIVEKIT_DELETE_ROOM_ON_END=true` (the default) and that the API key has permission to delete rooms. On shutdown, the drain window (a couple of seconds) lets `deleteRoom` land; a `deleteRoom failed` warning in the logs points at a permissions or connectivity issue.
