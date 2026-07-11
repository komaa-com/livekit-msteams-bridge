---
title: Getting Started
description: Install the bridge, register a LiveKit agent for explicit dispatch, run the bridge, and make your first Teams call.
---

By the end of this page a LiveKit agent answers a Microsoft Teams call. You need Node.js `>= 20`, a LiveKit server (Cloud project or self-hosted) with an API key/secret, a LiveKit agent, and a StandIn identity (the sandbox tier is enough to try it).

## 1. Register your agent for explicit dispatch

Any LiveKit agent works unchanged. Register it with an **agent name** so the bridge can dispatch it into the per-call room. This is LiveKit's recommended model.

```python
# Python (livekit-agents >= 1.0)
from livekit.agents import cli, WorkerOptions

if __name__ == "__main__":
    cli.run_app(WorkerOptions(entrypoint_fnc=entrypoint, agent_name="my-teams-agent"))
```

```ts
// Node (@livekit/agents)
cli.runApp(new WorkerOptions({ agent: fileURLToPath(import.meta.url), agentName: "my-teams-agent" }));
```

That `agent_name` is what you pass to the bridge as `LIVEKIT_AGENT_NAME`.

:::note
Leaving `LIVEKIT_AGENT_NAME` unset falls back to **automatic dispatch** (an unnamed agent joins every room). LiveKit documents that as prototype-only - use explicit dispatch in production.
:::

## 2. Install and run the bridge

Run it directly:

```bash
LIVEKIT_URL=wss://your-project.livekit.cloud \
LIVEKIT_API_KEY=API... \
LIVEKIT_API_SECRET=... \
LIVEKIT_AGENT_NAME=my-teams-agent \
WORKER_SHARED_SECRET=... \
  npx @komaa/livekit-msteams-bridge
```

Or embed it in your own project:

```bash
npm install @komaa/livekit-msteams-bridge
```

```ts
import { loadConfig, startServer } from "@komaa/livekit-msteams-bridge";

startServer(loadConfig()); // same env variables as the CLI
```

Every option is an environment variable; the package ships a commented [`.env.example`](https://github.com/komaa-com/livekit-msteams-bridge/blob/main/.env.example), and the [Configuration Reference](/livekit-msteams-bridge/configuration-reference/) documents each one. The bridge listens on `0.0.0.0:8080` by default and exposes `GET /healthz` for liveness.

`WORKER_SHARED_SECRET` comes from StandIn in the next step.

## 3. Connect a StandIn identity

StandIn is the hosted service that joins the Teams call and dials into your bridge. Pick a tier at [standin.komaa.com](https://standin.komaa.com) (sandbox for an instant trial), pair, and you get a **shared secret**.

1. Put the secret in `WORKER_SHARED_SECRET` (both sides must match exactly).
2. Point the identity's **agent WebSocket URL** at your bridge, for example `wss://lk-bridge.example.com:8080/voice/msteams/stream`. StandIn appends `/{callId}` per call.
3. Restart the bridge if you changed the env.

StandIn dials in **from the internet**, so a laptop or private host needs a public URL. A tunnel gives you one and terminates TLS (so you get `wss://` for free). Run one pointing at port `8080`, then use the `wss://.../voice/msteams/stream` form of the printed host:

Tailscale Funnel:

```bash
tailscale funnel --bg --https=8080 8080
```

Cloudflare Tunnel:

```bash
cloudflared tunnel --url http://localhost:8080
```

ngrok:

```bash
ngrok http 8080
```

For a fixed production host use an ingress or load balancer that terminates TLS in front of the bridge. See [Connecting to StandIn](/livekit-msteams-bridge/connecting-to-standin/) for the full detail. Never give StandIn a plain `ws://` URL outside local testing.

## 4. Make the first call

Call your Teams bot (or join the sandbox meeting). In the bridge logs you should see the call arrive, the room open, the agent dispatched, and the relay start:

```text
INFO  [server] worker connected for call 19:meeting_ab… (1/64)
INFO  [call:19:meeting_ab] session.start (direction=inbound, recording=unknown)
INFO  [call:19:meeting_ab] LiveKit room "msteams-19:meeting_ab…" joined (agent "my-teams-agent" dispatched)
INFO  [call:19:meeting_ab] subscribed to agent audio from "my-teams-agent"
INFO  [call:19:meeting_ab] LiveKit room "msteams-19:meeting_ab…" relaying
```

Speak, and the agent answers in the room; the bridge relays its audio back to Teams. If the call connects but something is off, [Troubleshooting](/livekit-msteams-bridge/troubleshooting/) maps the common failures (401 handshake, agent never joins, silent audio) to their cause.
