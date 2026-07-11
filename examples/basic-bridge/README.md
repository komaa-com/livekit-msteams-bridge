# basic-bridge example

Embed `@komaa/livekit-msteams-bridge` in your own Node project instead of running the CLI.

```bash
npm install
cp .env.example .env   # fill in LiveKit + StandIn values
npm start
```

Pair it with an agent from [`../agents`](../agents) (`LIVEKIT_AGENT_NAME` must match the agent's `agent_name`), point your StandIn identity's agent WebSocket URL at this server, and call your Teams bot.
