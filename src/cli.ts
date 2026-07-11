#!/usr/bin/env node
/**
 * CLI entry point: `livekit-msteams-bridge` (or `npx @komaa/livekit-msteams-bridge`).
 * Entirely env-configured - see .env.example in the package root.
 */
import { loadConfig } from "./config.js";
import { startServer } from "./server.js";

try {
  const server = startServer(loadConfig());
  server.on("error", (err) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "EADDRINUSE") {
      console.error(`livekit-msteams-bridge: port already in use (${e.message}). Set PORT to a free port.`);
    } else {
      console.error(`livekit-msteams-bridge: server error: ${e.message}`);
    }
    process.exit(1);
  });
} catch (err) {
  console.error(`livekit-msteams-bridge: ${(err as Error).message}`);
  console.error("Required env: LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET, WORKER_SHARED_SECRET (see .env.example).");
  process.exit(1);
}
