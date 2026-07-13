/**
 * Bridge configuration, entirely from environment variables. The worker-side
 * contract (HMAC secret, wire protocol) must match the StandIn media bridge;
 * the LiveKit side needs a server URL, API key/secret, and (recommended) a
 * named agent for explicit dispatch.
 */

export interface BridgeConfig {
  /** TCP port the bridge listens on for worker WebSocket upgrades. */
  port: number;
  /** Bind address. */
  host: string;
  /** Must equal the shared secret the StandIn media bridge signs with (HMAC upgrade check). */
  workerSharedSecret: string;
  /** LiveKit server URL (wss://<project>.livekit.cloud or self-hosted). */
  livekitUrl: string;
  /** LiveKit API key/secret; mint join tokens + dispatch agents + delete rooms. Server-side only. */
  livekitApiKey: string;
  livekitApiSecret: string;
  /**
   * EXPERIMENTAL: relay the agent avatar's video track onto the Teams tile.
   * "off" (default) | "auto" (the agent participant) | a specific identity.
   */
  tileVideo: string;
  /** Send rate for the relayed tile stream (frames/s). */
  tileVideoFps: number;
  /**
   * Named agent for EXPLICIT dispatch (recommended by LiveKit): the agent
   * registered with ServerOptions.agentName. Null = rely on automatic dispatch
   * (agents with no name join every room; prototype-only per LiveKit docs).
   */
  livekitAgentName: string | null;
  /** Room name prefix; the room is `${prefix}${callId}`. */
  livekitRoomPrefix: string;
  /** Delete the LiveKit room at teardown so the agent job ends immediately (billing hygiene). */
  livekitDeleteRoomOnEnd: boolean;
  /**
   * Bridge-side call governor: hard cap on call duration in minutes
   * (fractional allowed). 0 = disabled. LiveKit doesn't know about your
   * billing; on limit the bridge asks the agent to say goodbye (data topic),
   * waits the grace, then ends the call.
   */
  maxCallMinutes: number;
  /** Goodbye line sent to the agent (data topic "teams.goodbye") on governor cutoff. */
  goodbyeText: string;
  /** How long to let the goodbye play before session.end (the bridge cannot know the real duration). */
  goodbyeGraceMs: number;
  /** Allowed clock skew for the HMAC timestamp, in ms (worker side documents ±60s). */
  hmacFreshnessMs: number;
  /** Max concurrent worker connections (0 = default 64). */
  maxConnections: number;
  /** Max concurrent connections from one remote IP (0 = default: same as maxConnections). */
  maxConnectionsPerIp: number;
  /** Drop a worker that authenticates but never sends session.start after this many ms (0 = default 10s). */
  preStartTimeoutMs: number;
  /** Dead-peer window: end the call after this many ms without ANY worker message (0 = default 90s; the worker heartbeats every 30s). */
  workerIdleTimeoutMs: number;
  /** Trust X-Forwarded-For for the per-IP cap (only behind a proxy you control). */
  trustProxy: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var ${name}`);
  }
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() ? v.trim() : null;
}

/**
 * Parse a numeric env var, failing LOUD on non-numeric or negative values: a
 * typo like MAX_CALL_MINUTES=abc or -1 must stop startup, not silently disable
 * the governor (all these knobs are counts/durations where negative is never
 * meaningful).
 */
function numFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Env var ${name}="${raw}" is not a non-negative number`);
  }
  return n;
}

export function loadConfig(): BridgeConfig {
  return {
    port: numFromEnv("PORT", 8080),
    host: process.env.BIND?.trim() || "0.0.0.0",
    workerSharedSecret: required("WORKER_SHARED_SECRET"),
    livekitUrl: required("LIVEKIT_URL"),
    livekitApiKey: required("LIVEKIT_API_KEY"),
    livekitApiSecret: required("LIVEKIT_API_SECRET"),
    livekitAgentName: optional("LIVEKIT_AGENT_NAME"),
    tileVideo: process.env.LIVEKIT_TILE_VIDEO?.trim() || "off",
    tileVideoFps: numFromEnv("LIVEKIT_TILE_VIDEO_FPS", 10),
    livekitRoomPrefix: process.env.LIVEKIT_ROOM_PREFIX?.trim() || "msteams-",
    livekitDeleteRoomOnEnd: process.env.LIVEKIT_DELETE_ROOM_ON_END !== "false",
    maxCallMinutes: numFromEnv("MAX_CALL_MINUTES", 0),
    goodbyeText:
      process.env.GOODBYE_TEXT?.trim() ||
      "I'm sorry, we've reached the time limit for this call. Thank you for calling, goodbye!",
    goodbyeGraceMs: numFromEnv("GOODBYE_GRACE_MS", 8000),
    hmacFreshnessMs: numFromEnv("HMAC_FRESHNESS_MS", 60_000),
    maxConnections: numFromEnv("MAX_CONNECTIONS", 0),
    maxConnectionsPerIp: numFromEnv("MAX_CONNECTIONS_PER_IP", 0),
    preStartTimeoutMs: numFromEnv("PRE_START_TIMEOUT_MS", 0),
    workerIdleTimeoutMs: numFromEnv("WORKER_IDLE_TIMEOUT_MS", 0),
    trustProxy: process.env.TRUST_PROXY_XFF === "true",
  };
}
