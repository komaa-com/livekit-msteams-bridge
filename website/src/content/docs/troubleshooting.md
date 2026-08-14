---
title: Troubleshooting
description: The failures you are most likely to hit - handshake rejects, the agent never joining, silent audio - and their causes.
---

Start by watching the bridge logs (`LOG_LEVEL=debug` for the most detail) and `GET /metrics`. Most problems fall into one of the buckets below.

## The upgrade is rejected (`401` / `403` / `409` / `503`)

| Symptom in logs | Cause | Fix |
| --- | --- | --- |
| `rejected upgrade … bad signature` | `BRIDGE_SECRET` differs between StandIn and the bridge | Copy the pairing secret exactly into `BRIDGE_SECRET`; restart. |
| `rejected upgrade … stale or missing timestamp` | Clock skew beyond `HMAC_FRESHNESS_MS`, or the headers aren't reaching the bridge | Fix host clock (NTP); make sure your proxy forwards the `X-StandIn-*` headers. |
| `rejected upgrade … replayed handshake` | The same handshake tuple was seen twice | Usually a benign retry; if persistent, check for a proxy duplicating the upgrade. |
| `rejected upgrade … bridge shared secret is not configured` | `BRIDGE_SECRET` is unset | Set it. The bridge fails closed rather than accepting unauthenticated calls. |
| `409 … already has a live session` | A second upgrade arrived for a `callId` already live | Expected on a reconnect/rollout; the original call keeps the slot. |
| `503 … connection cap reached` | `MAX_CONNECTIONS` (or per-IP) hit | Raise the cap, or check for stuck sessions with `bridge_calls_active` on `/metrics`. |

## The call connects but the agent never joins

The bridge logs `session.start` and `LiveKit room … joined`, but no `subscribed to agent audio`.

- **`LIVEKIT_AGENT_NAME` mismatch** - the name here must equal the `agent_name` your worker registered with. A typo means dispatch targets an agent that isn't there.
- **The agent worker isn't running / not registered** for that name against this LiveKit project. Start it and confirm it appears in your LiveKit dashboard.
- **Wrong project** - `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` point at a different project than the one your agent worker connects to. Dispatch only reaches agents on the same project.
- **`bridge_room_connect_failures_total` climbing** on `/metrics` means the bridge couldn't join or dispatch at all - check the API key/secret and that the URL is reachable.

## The worker won't start, or the first call takes minutes to answer

Large models - avatar runtimes (bitHuman, Tavus), local STT/TTS, turn detectors - take real time to load, and that trips two setup problems worth calling out because the symptom looks like the wire path is broken when it isn't:

- **The worker exits at startup with `TimeoutError` / "error initializing process".** The model load overran the process-init deadline. Raise it: `WorkerOptions(..., initialize_process_timeout=300)` in Python (Node's `WorkerOptions` has the equivalent option). A bitHuman `.imx` model converting for the first time can take a couple of minutes.
- **The first call takes minutes to answer; later calls are instant.** A cold job process loads the model on demand. Two fixes, use both: load the model in your `prewarm` function and stash it in `proc.userdata` (so the entrypoint reuses it), and keep a process warm with `num_idle_processes >= 1` so a dispatch never waits on a cold load. Run `python your_agent.py download-files` once first to prefetch downloadable weights (silero VAD, the turn detector).

If a call connects and dispatches but the agent then sits silent for a long time before speaking, this - not the handshake or the room - is almost always the cause.

## The agent joined but there's no audio

- **Caller can't hear the agent** - confirm the agent actually publishes an audio track (the bridge relays the first remote audio track). Avatar agents publish audio via the avatar participant; the bridge handles that, but a misconfigured avatar that publishes only video will be silent.
- **Agent can't hear the caller** - the bridge publishes caller audio as a 16 kHz mono track; make sure your agent subscribes to and feeds remote audio into its pipeline (the default `AgentSession` does).
- **Garbled audio** - both sides must be 16 kHz PCM16. The bridge captures/relays at 16 kHz and rejects malformed (odd-length) PCM loudly; if you replaced the room connector, keep the sample rate at 16 kHz mono.

## The call ends unexpectedly

- **`no worker message in 90000ms (dead peer?)`** - the worker stopped sending (network drop, half-open socket). The bridge ends the call so it doesn't hold the room and the `callId` lock. Tune with `WORKER_IDLE_TIMEOUT_MS` if your path has long legitimate silences (rare - the worker heartbeats every 30 s).
- **`agent … disconnected`** - the agent participant left the room. The bridge ends the call. Check your agent for crashes or an early `ctx.shutdown()`.
- **Governor cutoff** - `MAX_CALL_MINUTES` fired. Expected; raise or disable it (`0`) if unintended.
- **`had no agent answer in 120000ms; ending it`** (`session.end` reason `no-answer`, `bridge_calls_no_answer_total` climbing) - no agent ever joined the room and published audio, so the caller was sitting on a silent call. This is the reaper doing its job; the real fault is above, under *The call connects but the agent never joins*. If your worker legitimately needs longer than the grace to cold-start, raise `STALE_CALL_REAPER_SECONDS` - but fixing the cold start is the better answer.

## The agent is silent in a meeting but fine 1:1

That is the group-call gate. In a call with 2+ humans the agent must be addressed by one of `GROUP_CALL_WAKE_PHRASES` (default `assistant`) before its audio reaches Teams; `bridge_agent_frames_gated_total` on `/metrics` counts what was withheld.

- Say the wake phrase, or set `GROUP_CALL_REQUIRE_ADDRESS=false` to turn the gate off.
- Rename the phrase to whatever your agent is actually called: `GROUP_CALL_WAKE_PHRASES=aria,hey aria`.
- Multi-word phrases match literally, so `"hey team"` will not match `"hey, team"` or a double space.
- Note the gate arms only after a caller transcript has reached the bridge. If you never see gating at all, your agent is probably not publishing transcriptions (`lk.transcription`), and only the etiquette instruction is in force.

## Ambient vision sends nothing

- `AMBIENT_VISION` defaults to `false`. It is off until you set it.
- `REQUIRE_RECORDING_STATUS` defaults to `true`: nothing is captured until Teams reports recording as active, and frames from before that are never surfaced retroactively.
- `MAX_VISION_PER_MINUTE=0` **disables** the feature. It does not mean "unlimited" - if you want a high cap, set a high number.
- A frozen screen sends nothing by design - only changed frames are delivered. `bridge_vision_frames_sent_total` is the counter to watch.
- `AMBIENT_VISION is on but this room has no sendVision route` in the logs means a custom `RoomConnector` is in use whose room object does not implement `sendVision`.

## The goodbye gets cut off

The governor's goodbye is spoken by your agent, not the bridge. If the agent's current turn outlasts `GOODBYE_GRACE_MS`, the goodbye is truncated. Have the `msteams.goodbye` handler interrupt the current turn before speaking - see [Agents and Dispatch](/livekit-msteams-bridge/agents-and-dispatch/) - or raise `GOODBYE_GRACE_MS`.

## Rooms linger after calls

If rooms outlive their calls in the LiveKit dashboard, confirm `LIVEKIT_DELETE_ROOM_ON_END=true` (the default) and that the API key has permission to delete rooms. On shutdown, the drain window (a couple of seconds) lets `deleteRoom` land; a `deleteRoom failed` warning in the logs points at a permissions or connectivity issue.
