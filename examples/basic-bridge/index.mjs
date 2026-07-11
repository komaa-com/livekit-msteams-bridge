/**
 * basic-bridge example: embed @komaa/livekit-msteams-bridge in your own project.
 *
 * What it shows:
 *   1. loadConfig()  - the same env variables as the CLI (see .env.example here)
 *   2. startServer() - the HTTP + WebSocket server the StandIn media bridge dials into
 *   3. (optional) a custom RoomConnector if you want to decorate room setup
 *
 * Run:  npm install && cp .env.example .env  (fill it in)  && npm start
 *
 * With dummy env values the bridge starts and listens fine; a real Teams call
 * additionally needs a StandIn identity pointed at this server, a LiveKit
 * project, and a running LiveKit agent registered under LIVEKIT_AGENT_NAME
 * (see ../agents for two ready-made agents).
 */
import { loadConfig, startServer } from "@komaa/livekit-msteams-bridge";

// Env-driven config, identical to the CLI. Throws a clear error when a
// required variable is missing or a numeric one is invalid.
const cfg = loadConfig();

// Start the bridge. Per Teams call: StandIn dials {your-url}/{callId} with an
// HMAC-signed upgrade; the bridge creates one LiveKit room, dispatches your
// agent into it (LIVEKIT_AGENT_NAME), and relays audio both ways.
startServer(cfg);

console.log("basic-bridge example is up.");
console.log(`Point your StandIn identity's agent WebSocket URL at ws://<this-host>:${cfg.port}/voice/msteams/stream`);
console.log(`Dispatching agent "${cfg.livekitAgentName ?? "<automatic>"}" on ${cfg.livekitUrl}`);

// Graceful shutdown is built in: on SIGINT/SIGTERM every live call is ended
// cleanly (session.end to StandIn, the LiveKit room deleted) before exit.
