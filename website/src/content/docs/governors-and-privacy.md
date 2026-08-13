---
title: Governors and Privacy
description: The two call governors, why there is no bridge-side TTS on the room transport, and what data the bridge does and does not handle.
---

## Two governors

A call can be cut off from two places:

1. **StandIn-side** - StandIn enforces the caller's tier limits and, at cutoff, asks the bridge to wind the call down. The bridge forwards the goodbye request to the agent on `msteams.goodbye`.
2. **Bridge-side (`MAX_CALL_MINUTES`)** - an independent hard cap you set on the bridge. LiveKit doesn't know about your billing, so this is your own backstop against a call that runs forever.

Both funnel through the same goodbye path; the first to fire wins, and a duplicate goodbye is ignored.

Separately, `STALE_CALL_REAPER_SECONDS` (default 120) ends a call whose **agent never joined the room at all**. That is not a governor - there is nobody to say goodbye - so it just tears the call down with `session.end` reason `no-answer`. See [Troubleshooting](/livekit-msteams-bridge/troubleshooting/).

## How the goodbye works

There is **no bridge-side TTS** on the room transport - the bridge cannot synthesize speech into the room. So the governor's goodbye is a `msteams.goodbye` **data message** carrying the text; **your agent speaks it**. The sequence on `MAX_CALL_MINUTES`:

1. The bridge arms a hard deadline (`GOODBYE_GRACE_MS` + headroom) so nothing can wedge the call past its limit.
2. It sends `msteams.goodbye` to the agent.
3. It waits `GOODBYE_GRACE_MS` for the agent to speak, then ends the call.

Because the bridge can't know your agent's real speech duration, `GOODBYE_GRACE_MS` (default 8 s) is the budget. If the agent's current turn outlasts the grace, the goodbye can be cut - so have your `msteams.goodbye` handler **interrupt the current turn** and speak the line with interruptions disabled (see [Agents and Dispatch](/livekit-msteams-bridge/agents-and-dispatch/)).

## Privacy and data handling

- **No recording, no persistence.** This bridge stores nothing on disk. Audio is relayed frame-by-frame between the worker socket and the room and never written out.
- **Video is opt-in and gated.** Caller screen-share/camera frames are ignored entirely unless `AMBIENT_VISION=true`. When it is on, `REQUIRE_RECORDING_STATUS` (default `true`) means a frame is not even held in memory before Teams reports recording active, so nothing captured beforehand can surface later; the newest frame per source is kept only until it is superseded, and everything is dropped at teardown.
- **Transcripts are read, never kept.** The group-call gate reads what your agent publishes on LiveKit's `lk.transcription` topic purely to test it against the wake phrases. No transcript text is stored, forwarded, or logged.
- **Caller identity is minimal and defaulted.** The agent receives `caller_name`, `tenant_id`, `call_direction`, and `user_id` (AAD id) - and `user_id` is included *only* when Teams provides one, so it is never a shared placeholder. Nullable fields default to safe strings, never null.
- **Metrics carry no call content.** `GET /metrics` exposes counters (calls, durations, rejects, relay/drop counts) only - never audio, text, or identities.
- **The room is deleted at teardown** (`LIVEKIT_DELETE_ROOM_ON_END=true`), so the agent job ends immediately and no room lingers with call context.

## Hardening summary

The transport carries the same protections as the sibling bridges: replay-proof single-use HMAC upgrade, connection caps checked before crypto, payload caps, a pre-start timeout, dead-peer detection, duplicate-call `409`, a pre-auth crash guard, and a graceful SIGTERM drain. See [Architecture](/livekit-msteams-bridge/architecture/) for how each fits into the call flow.
