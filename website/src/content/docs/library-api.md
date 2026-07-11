---
title: Library API
description: The exports of @komaa/livekit-msteams-bridge for embedding the bridge in your own Node project.
---

Most deployments run the CLI (`npx @komaa/livekit-msteams-bridge`). When you want to embed the bridge in a larger Node process - to share a supervisor, add your own health checks, or inject a test double - import it instead. The package is ESM, TypeScript-typed, and Node `>= 20`.

## Typical embedding

```ts
import { loadConfig, startServer } from "@komaa/livekit-msteams-bridge";

const server = startServer(loadConfig());
server.on("error", (err) => {
  console.error(`bridge server error: ${err.message}`);
  process.exit(1);
});
```

`startServer` returns the Node `http.Server`, so you own its lifecycle (`close()`, `listening`, etc.). SIGTERM/SIGINT draining of live calls is wired automatically.

## Exports

### Config

- **`loadConfig(): BridgeConfig`** - read and validate all environment variables. Throws on a missing required var or a bad numeric.
- **`BridgeConfig`** *(type)* - the resolved config shape.

### Server

- **`startServer(cfg, connectRoom?): http.Server`** - start the worker-facing server. `connectRoom` is an injectable `RoomConnector` (defaults to the real LiveKit implementation); pass a fake in tests to avoid the native module and the network.
- **`authorizeUpgrade(cfg, req, replay?)`** - the HMAC + replay check for a WS upgrade; returns `{ callId }` or `{ error }`.
- **`callIdFromUrl(url)`** - extract the `callId` from an upgrade URL (returns `null` on a malformed escape).
- **`ReplayGuard`** - single-use guard for verified upgrade tuples.

### Session and LiveKit

- **`CallSession`** - one call: pairs the worker WebSocket with an `AgentRoomPort` and relays audio.
- **`AgentRoomPort`, `RoomHandlers`, `RoomConnector`** *(types)* - the interface between the session and the room, so you can substitute your own room implementation.
- **`connectLiveKitRoom(cfg, log, callId, metadata, handlers)`** - the real LiveKit connector (join, dispatch, publish/subscribe).
- **`TOPIC_CONTEXT` (`"teams.context"`), `TOPIC_GOODBYE` (`"teams.goodbye"`)** - the data topics the agent listens on.

### HMAC

- **`sign(secret, timestampMs, callId)`**, **`verify(secret, timestampMs, callId, signature)`**, **`isFresh(timestampMs, windowMs)`** - the handshake primitives.
- **`TIMESTAMP_HEADER`, `SIGNATURE_HEADER`** - the header names carrying the handshake.

### Protocol and metrics

- Everything from the wire protocol module (message types, `parseWorkerMessage`, `pcm16kBytesToMs`) - see [Wire Protocol](/livekit-msteams-bridge/wire-protocol/).
- **`renderMetrics(): string`** - the Prometheus exposition text served at `GET /metrics`.
- **`logger(scope)`, `Logger`** *(type)* - the structured logger the bridge uses.

## Testing against a fake room

`startServer`'s second argument lets tests drive a full call without LiveKit:

```ts
import { startServer, type RoomConnector } from "@komaa/livekit-msteams-bridge";

const fakeConnector: RoomConnector = async (_cfg, _log, callId, _meta, handlers) => ({
  roomName: `fake-${callId}`,
  async publishCallerAudio() {},
  sendContext() {},
  sendGoodbye() {},
  async close() {},
});

const server = startServer(cfg, fakeConnector);
```

This is exactly how the package's own `node:test` suites exercise the session and transport without the network or the native `@livekit/rtc-node` module.
