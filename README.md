# Microsoft Teams Bridge for LiveKit Agents (Node.js)

[![CI](https://github.com/komaa-com/livekit-msteams-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/komaa-com/livekit-msteams-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@komaa/livekit-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/livekit-msteams-bridge)
[![downloads](https://img.shields.io/npm/dm/@komaa/livekit-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/livekit-msteams-bridge)
[![docs](https://img.shields.io/badge/docs-komaa--com.github.io-2563eb.svg)](https://komaa-com.github.io/livekit-msteams-bridge/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

Put a [LiveKit Agent](https://docs.livekit.io/agents/) on a real **Microsoft Teams call** - voice-only, or with a video avatar whose face and voice the caller sees and hears in Teams.

The hosted **StandIn media bridge** ([standin.komaa.com](https://standin.komaa.com)) joins the Teams call and dials into this bridge over an HMAC-authenticated WebSocket. Per call, the bridge creates one LiveKit room, **dispatches your agent into it** (explicit dispatch by `agentName`), joins as a participant, publishes the caller's audio, and relays the agent's audio back to Teams.

```text
Microsoft Teams call
       |
       v
StandIn media bridge       (hosted; joins the call)
       |   HMAC WebSocket, PCM 16 kHz
       v
this bridge                (you run it)
       |   WebRTC (room, one per call)
       v
LiveKit room  <--dispatch--  your LiveKit Agent
                             (STT + LLM + TTS + turn-taking, any plugin stack)
```

Both sides speak 16 kHz mono PCM16: the wire protocol natively, the room via the SDK's resampling `AudioSource`/`AudioStream` - the bridge itself never transcodes.

## Features

- **Any LiveKit agent answers Teams calls** - your existing agent (Python or Node, any STT/LLM/TTS/realtime plugin combo) needs no Teams-specific code. The bridge dispatches it by `agentName` with per-call metadata (caller name, tenant, direction, AAD id when known).
- **One room per call** - clean lifecycle: room created at `session.start`, agent dispatched via the join token (`RoomConfiguration`), room deleted at teardown so the agent job ends immediately.
- **Turn-taking is the agent's own** - VAD, interruption, and endpointing all run inside your LiveKit agent session, exactly as they do for WebRTC users.
- **Group-call awareness** - participant counts, speaker changes and DTMF digits reach the agent as data messages on the `msteams.context` topic.
- **Speak only when addressed, in meetings** - in a call with 2+ humans the bridge tells the agent the etiquette (naming its wake phrases) and deterministically withholds its audio from Teams until a caller addresses it, with a short follow-up window so a back-and-forth does not need the name every turn. 1:1 calls are never gated.
- **Ambient vision (opt-in)** - the caller's screen-share and camera reach the agent as labelled images on the `msteams.vision` topic, only when the scene actually changes and inside a per-call spend cap.
- **No-answer fallback** - a call whose agent never joins the room is ended after `STALE_CALL_REAPER_SECONDS` instead of sitting silent forever.
- **Two call governors** - a StandIn-side cutoff (the bridge forwards the goodbye request on `msteams.goodbye`) and a bridge-side `MAX_CALL_MINUTES` hard cap.
- **Hardened transport** (ported from the proven `@komaa/elevenlabs-msteams-bridge`): replay-proof single-use HMAC upgrade, connection caps checked before crypto, payload caps, backpressure bounds with control-frame exemption, pre-start timeout that only a real `session.start` clears, dead-peer detection (90 s), duplicate-call 409, pre-auth crash guard, graceful SIGTERM drain.
- **Observability** - `GET /healthz` and `GET /metrics` (Prometheus text format): calls, durations, rejects, relay/drop counters.

## Install

```bash
npx @komaa/livekit-msteams-bridge
# or
npm install @komaa/livekit-msteams-bridge
```

Node.js `>= 20`. Runtime deps: `ws`, `livekit-server-sdk`, `@livekit/rtc-node` (native).

## Quick start

### 1. Prepare the agent

Any LiveKit agent works. Register it with an explicit **agent name** so the bridge can dispatch it:

```python
# Python (agents >= 1.0): explicit dispatch by name
if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="standin-agent"))
```

Per-call metadata arrives in the job context (`ctx.job.metadata`, JSON):
`{"source":"msteams","caller_name":"...","tenant_id":"...","call_direction":"inbound","user_id":"<aad-id, when known>"}`.

Optional: subscribe to the bridge's data topics -
`msteams.context` (participants/DTMF/speaker changes and the group-call etiquette clause, as `{text}`), `msteams.goodbye` (`{text}` the agent should speak before the call is cut), and - with `AMBIENT_VISION=true` - `msteams.vision`, a **byte stream** carrying one image whose attributes name the `source`, `owner` and `caption`:

```python
def on_vision(reader, participant):
    async def read():
        image = b"".join([chunk async for chunk in reader])
        # reader.info.attributes: source, owner ("Sara's shared screen"), caption, width, height, ts
        ...
    asyncio.create_task(read())

ctx.room.register_byte_stream_handler("msteams.vision", on_vision)
```

**Avatar agents**: the caller hears the avatar's synchronized audio and, by default, sees its face on the Teams tile. The bridge subscribes to the agent's video and relays it onto the caller's tile (`LIVEKIT_TILE_VIDEO=auto`). Set `off` for audio only, and the tile shows StandIn's own animated avatar instead. Voice-only agents are unaffected either way, since they publish no video.

> **Seeing no video?** Check that your StandIn connection has video enabled. The relay draws onto the
> tile StandIn publishes, so if that tile does not exist the bridge streams valid frames into nothing
> and has no way to detect it. Check the connection setting before debugging the bridge.

### 2. Run the bridge

#### StandIn Managed Bot (recommended)

StandIn provides the Teams bot. You install **StandIn** from the Teams Store, connect this bridge in
the StandIn portal, and paste **one secret** here. No Azure bot registration, no App ID, no client
secret, no endpoint configuration.

This is the whole configuration - five values, all required, no optional keys. Everything else has a
default that is already correct.

```bash
# --- LiveKit project (LiveKit Cloud, or your self-hosted server) ---
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=API...
LIVEKIT_API_SECRET=...

# The exact agent_name your worker registers with. A worker that registers a name is reachable
# ONLY by explicit dispatch: set agent_name in the worker but leave this unset and the bridge
# falls back to automatic dispatch, so your agent never joins and the call connects to silence.
# This is the single most common setup mistake.
LIVEKIT_AGENT_NAME=standin-agent

# The connection secret from the StandIn portal. Must byte-match, or the handshake is
# rejected with 401 - a mismatch fails silently from the caller's point of view.
BRIDGE_SECRET=paste-the-value-from-the-StandIn-portal
```

Run it:

```bash
npx @komaa/livekit-msteams-bridge
```

The bridge listens on **`:8080`** at **`/msteams/calling`** (override with `PORT` and `WS_PATH`).
It binds `0.0.0.0` by default; put your tunnel or reverse proxy in front of it and register the
public `wss://` URL - never the local `ws://` bind.

**Check it before you call.** Two things have to be true, and both are visible without placing a call:

```bash
curl -sS http://127.0.0.1:8080/healthz          # the bridge is up
curl -sS http://127.0.0.1:8080/metrics | head   # counters exist
```

Then confirm your worker is registered under the same name you set above - if
`LIVEKIT_AGENT_NAME` and the worker's `agent_name` disagree, everything looks healthy on both
sides and the agent still never joins.

Or as a library:

```ts
import { loadConfig, startServer } from "@komaa/livekit-msteams-bridge";
startServer(loadConfig()); // env-configured; see .env.example
```

### 3. Connect it to StandIn

Pick a tier at [standin.komaa.com](https://standin.komaa.com), pair an identity, then:

1. Point the identity's **agent WebSocket URL** at this bridge (e.g. `wss://lk-bridge.example.com:8080/msteams/calling`; StandIn appends `/{callId}` per call).
2. Set `BRIDGE_SECRET` to the pairing secret (both sides must match or the handshake is rejected with 401).
3. Call your Teams bot. StandIn joins, dials the bridge, the bridge creates the room and dispatches your agent, and the agent answers.

## Examples

Three runnable examples, each with its own README:

| Example | What it is |
|---|---|
| [`examples/basic-bridge/`](./examples/basic-bridge/) | Embed the package in your own Node project instead of running the CLI. Three lines of code. |
| [`examples/voice-agent/`](./examples/voice-agent/) | A working voice agent the bridge dispatches onto a Teams call: an STT/LLM/TTS pipeline plus silero VAD. Ships a Dockerfile. |
| [`examples/avatar-agent/`](./examples/avatar-agent/) | The same pipeline plus a video avatar, so the caller sees a face on the Teams tile and hears its synchronized voice. Ships a Dockerfile. |

Both agent examples show the three Teams integration points: `agent_name` for dispatch, `ctx.job.metadata` for per-call context, and the `msteams.*` data topics.

## Configuration

Every setting is an environment variable, and [`.env.example`](./.env.example) ships fully commented with the package.

**[Configuration reference](https://komaa-com.github.io/livekit-msteams-bridge/configuration-reference/)** documents all of them: what each does, its default, and when to change it.

## Roadmap

Where the bridge stands today, and what each of these needs to move:

- **Barge-in flush**: interruption handling runs inside the LiveKit agent (as designed), but the room emits no interruption event the bridge could map to the wire protocol's `assistant.cancel` - so up to ~1 s of already-relayed agent audio can play out after the caller cuts in. Acceptable in practice; an agent-published data event could close this later.
- **Video**: caller video/screenshare frames are not published into the room as a *track*. With `AMBIENT_VISION=true` they reach the agent as discrete labelled images on the `msteams.vision` byte-stream topic instead - which is what carries the attribution ("Sara's shared screen") a track cannot. Avatar-agent video is bridged to the Teams tile by default (`LIVEKIT_TILE_VIDEO=auto`); set `off` to disable.
- **The group-call gate needs the agent's transcripts**: the bridge runs no STT, so it detects its wake phrase from what the agent publishes on LiveKit's `lk.transcription` topic (on by default in `AgentSession`). If your agent disables transcription output, the etiquette instruction still goes out but the deterministic audio-egress backstop stays off - deliberately, because a gate whose trigger never fires would mute the agent for the whole meeting.
- **No deterministic goodbye**: the governor's goodbye is spoken by the agent (`msteams.goodbye` data topic), not synthesized by the bridge. The bridge flushes Teams-side playback first (`assistant.cancel`), but whether the agent interrupts its own in-flight sentence to speak the goodbye is the agent's choice - if its current turn outlasts `GOODBYE_GRACE_MS`, the goodbye gets cut. Have the `msteams.goodbye` handler interrupt the current turn (see the example agents).
- **Reconnects**: the LiveKit SDK retries transient drops internally (reconnecting/reconnected); `Disconnected` is final and ends the Teams call. There is no bridge-level room re-join beyond that.

## Security notes

- `GET /healthz` and `GET /metrics` are unauthenticated and served on the same port StandIn dials. Restrict the port at the network layer (or scrape through your ingress); the metrics expose only counters, never call content.
- `TRUST_PROXY_XFF` takes the FIRST `X-Forwarded-For` hop, which is only trustworthy behind a single proxy that OVERWRITES the header (appending proxies make it client-controlled). Leave it off otherwise.
- The default per-IP cap equals the global cap (no per-IP throttle) because legitimate traffic arrives from StandIn's small, fixed egress set - a small per-IP default would cap total concurrent calls. Set `MAX_CONNECTIONS_PER_IP` explicitly if your bridge is exposed more broadly.

## License

MIT (c) Komaa DigiTech
