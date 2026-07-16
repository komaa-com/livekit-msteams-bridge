# Microsoft Teams Bridge for LiveKit Agents

[![CI](https://github.com/komaa-com/livekit-msteams-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/komaa-com/livekit-msteams-bridge/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@komaa/livekit-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/livekit-msteams-bridge)
[![downloads](https://img.shields.io/npm/dm/@komaa/livekit-msteams-bridge.svg)](https://www.npmjs.com/package/@komaa/livekit-msteams-bridge)
[![docs](https://img.shields.io/badge/docs-komaa--com.github.io-2563eb.svg)](https://komaa-com.github.io/livekit-msteams-bridge/)
[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)

**`@komaa/livekit-msteams-bridge`** puts a [LiveKit Agent](https://docs.livekit.io/agents/) on a real **Microsoft Teams call** - including [avatar agents](https://github.com/livekit/agents/tree/main/examples/avatar_agents) (bitHuman, Tavus, ...) whose voice the caller hears in Teams.

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
- **Group-call awareness** - participant counts and DTMF digits reach the agent as data messages on the `teams.context` topic.
- **Two call governors** - a StandIn-side cutoff (the bridge forwards the goodbye request on `teams.goodbye`) and a bridge-side `MAX_CALL_MINUTES` hard cap.
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
`teams.context` (participants/DTMF as `{text}`) and `teams.goodbye` (`{text}` the agent should speak before the call is cut).

**Avatar agents** (e.g. the [bitHuman example](https://github.com/livekit/agents/tree/main/examples/avatar_agents/bithuman)): the caller always hears the avatar's synchronized audio. To also show the avatar's face on the Teams tile, set `LIVEKIT_TILE_VIDEO=auto` - the bridge then subscribes to the agent's avatar video and relays it onto the caller's tile. Left off (the default), the tile shows StandIn's own built-in animated avatar.

### 2. Run the bridge

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud \
LIVEKIT_API_KEY=API... \
LIVEKIT_API_SECRET=... \
LIVEKIT_AGENT_NAME=standin-agent \
WORKER_SHARED_SECRET=... \
  npx @komaa/livekit-msteams-bridge
```

Or as a library:

```ts
import { loadConfig, startServer } from "@komaa/livekit-msteams-bridge";
startServer(loadConfig()); // env-configured; see .env.example
```

### 3. Connect it to StandIn

Pick a tier at [standin.komaa.com](https://standin.komaa.com), pair an identity, then:

1. Point the identity's **agent WebSocket URL** at this bridge (e.g. `wss://lk-bridge.example.com:8080/voice/msteams/stream`; StandIn appends `/{callId}` per call).
2. Set `WORKER_SHARED_SECRET` to the pairing secret (both sides must match or the handshake is rejected with 401).
3. Call your Teams bot. StandIn joins, dials the bridge, the bridge creates the room and dispatches your agent, and the agent answers.

## Examples

- [`examples/basic-bridge/`](./examples/basic-bridge/) - embed the package in your own Node project (`npm install @komaa/livekit-msteams-bridge`, three lines of code).
- [`examples/voice-agent/`](./examples/voice-agent/) and [`examples/video-agent/`](./examples/video-agent/) - two ready-made Python agents the bridge can dispatch: a minimal voice pipeline and a bitHuman avatar variant, both showing the three Teams integration points (`agent_name`, `ctx.job.metadata`, the `teams.*` data topics).

## Configuration

See [`.env.example`](./.env.example) (ships with the package). Notable:

- `LIVEKIT_AGENT_NAME` - explicit dispatch (LiveKit's recommended model). Unset = automatic dispatch (agent joins every room; prototype-only).
- `LIVEKIT_TILE_VIDEO` (default `off`) - relay an avatar agent's video onto the Teams tile. `auto` uses the agent participant; or name a specific participant identity. `off` keeps StandIn's built-in animated avatar. `LIVEKIT_TILE_VIDEO_FPS` (default `15`) sets the relay send rate.
- `LIVEKIT_DELETE_ROOM_ON_END` (default `true`) - delete the room at teardown so the agent job ends immediately instead of idling out (billing hygiene).
- `MAX_CALL_MINUTES` / `GOODBYE_TEXT` / `GOODBYE_GRACE_MS` - the bridge-side governor. There is no bridge-side TTS on the room transport: the goodbye is a `teams.goodbye` data message your agent should speak, and the grace covers the unknown duration.
- Transport hardening knobs: `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP` (+ `TRUST_PROXY_XFF` behind a proxy), `PRE_START_TIMEOUT_MS`, `WORKER_IDLE_TIMEOUT_MS`, `HMAC_FRESHNESS_MS`.
- TLS: the bridge serves plain WS - front it with a TLS terminator (tunnel / ingress / LB).

## Known limitations (v1)

- **Barge-in flush**: interruption handling runs inside the LiveKit agent (as designed), but the room emits no interruption event the bridge could map to the wire protocol's `assistant.cancel` - so up to ~1 s of already-relayed agent audio can play out after the caller cuts in. Acceptable in practice; an agent-published data event could close this later.
- **Video**: caller video/screenshare frames are not published into the room. Avatar-agent video *can* be bridged to the Teams tile (opt-in, `LIVEKIT_TILE_VIDEO`); it is off by default.
- **No deterministic goodbye**: the governor's goodbye is spoken by the agent (`teams.goodbye` data topic), not synthesized by the bridge. The bridge flushes Teams-side playback first (`assistant.cancel`), but whether the agent interrupts its own in-flight sentence to speak the goodbye is the agent's choice - if its current turn outlasts `GOODBYE_GRACE_MS`, the goodbye gets cut. Have the `teams.goodbye` handler interrupt the current turn (see the example agents).
- **Reconnects**: the LiveKit SDK retries transient drops internally (reconnecting/reconnected); `Disconnected` is final and ends the Teams call. There is no bridge-level room re-join beyond that.

## Security notes

- `GET /healthz` and `GET /metrics` are unauthenticated and served on the same port StandIn dials. Restrict the port at the network layer (or scrape through your ingress); the metrics expose only counters, never call content.
- `TRUST_PROXY_XFF` takes the FIRST `X-Forwarded-For` hop, which is only trustworthy behind a single proxy that OVERWRITES the header (appending proxies make it client-controlled). Leave it off otherwise.
- The default per-IP cap equals the global cap (no per-IP throttle) because legitimate traffic arrives from StandIn's small, fixed egress set - a small per-IP default would cap total concurrent calls. Set `MAX_CONNECTIONS_PER_IP` explicitly if your bridge is exposed more broadly.

## Layout

```
src/
  server.ts      HTTP + WS upgrade, HMAC + replay guard, caps, drain (ported hardening)
  session.ts     per-call relay: worker WS ⇄ LiveKit room, governors, dead-peer
  livekit.ts     room join, agent dispatch (token RoomConfiguration), AudioSource/AudioStream
  protocol.ts    worker wire types (shared with the sibling bridges)
  hmac.ts        HMAC-SHA256("{timestampMs}.{callId}") sign/verify
  metrics.ts     Prometheus counters (/metrics)
  config.ts      env config (fail-loud numerics)
test/            node:test suites; a FakeRoom stands in for LiveKit (no network, no native module)
```

## License

MIT - see [LICENSE](./LICENSE).
