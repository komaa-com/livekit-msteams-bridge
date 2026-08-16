/**
 * Bridge configuration, entirely from environment variables. The worker-side
 * contract (HMAC secret, wire protocol) must match the StandIn media bridge;
 * the LiveKit side needs a server URL, API key/secret, and (recommended) a
 * named agent for explicit dispatch.
 */

import { resolveGroupCallGateConfig, type GroupCallGateConfig } from "./groupGate.js";
import { resolveAmbientVisionConfig, type AmbientVisionConfig } from "./vision.js";

export interface BridgeConfig {
  /** TCP port the bridge listens on for worker WebSocket upgrades. */
  port: number;
  /**
   * Path the bridge answers on, e.g. /msteams/calling/{callId}. The bridge used to take the callId
   * from the LAST segment of ANY path, which meant it answered on every route it was given. That is
   * fine alone and wrong as soon as anything else shares the origin - notably a future official
   * LiveKit integration - because two handlers would both claim the same URLs. Owning one namespace
   * makes the collision impossible instead of unlikely.
   */
  wsPath: string;
  /** Bind address. */
  host: string;
  /** Must equal the shared secret the StandIn media bridge signs with (HMAC upgrade check). */
  bridgeSecret: string;
  /** LiveKit server URL (wss://<project>.livekit.cloud or self-hosted). */
  livekitUrl: string;
  /** LiveKit API key/secret; mint join tokens + dispatch agents + delete rooms. Server-side only. */
  livekitApiKey: string;
  livekitApiSecret: string;
  /**
   * Relay the agent avatar's video track onto the Teams tile.
   * "auto" (default; the agent participant) | "off" | a specific identity.
   * By default the bridge relays an avatar agent's video onto the caller's
   * Teams tile; set "off" to opt out. Voice-only agents are unaffected either
   * way (they publish no avatar video, so "auto" finds nothing to relay).
   */
  tileVideo: string;
  /** Send rate for the relayed tile stream (frames/s). Default 15. */
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
  /** Goodbye line sent to the agent (data topic "msteams.goodbye") on governor cutoff. */
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
  /**
   * End a call whose agent never joined the room, after this many seconds. 0 disables.
   * On by default: unlike the vision knobs it spends nothing, it only frees local resources.
   */
  staleCallReaperSeconds: number;
  /**
   * Group-call "speak only when addressed" policy. Already resolved (defaults applied once, in
   * resolveGroupCallGateConfig) so no later layer can restate a different default.
   */
  groupCall: GroupCallGateConfig;
  /** Ambient vision: relay caller screen-share/camera frames to the agent. Off by default. */
  ambientVision: AmbientVisionConfig;
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
  return optionalNumFromEnv(name) ?? fallback;
}

/** As numFromEnv, but reports "operator said nothing" so a defaults table can fill the gap. */
function optionalNumFromEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Env var ${name}="${raw}" is not a non-negative number`);
  }
  return n;
}

/**
 * Strict boolean: only "true"/"false". Fail loud for the same reason numerics do - a typo such as
 * REQUIRE_RECORDING_STATUS=yes must stop startup, not quietly resolve to false and disable a gate.
 */
function optionalBoolFromEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  throw new Error(`Env var ${name}="${raw}" must be "true" or "false"`);
}

/**
 * Comma-separated list. An empty or all-blank value reads as "unset" so the defaults table wins:
 * emptying the wake-phrase list is not a way to opt out of the group gate (that would mute the agent
 * in every meeting). GROUP_CALL_REQUIRE_ADDRESS=false is.
 */
function optionalListFromEnv(name: string): string[] | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) {
    return undefined;
  }
  const items = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

/** Leading slash, no trailing slash, so prefix comparison is a plain startsWith. */
export function normalizeWsPath(raw: string): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") {
    throw new Error("WS_PATH must be a non-empty path such as /msteams/calling");
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function loadConfig(): BridgeConfig {
  return {
    port: numFromEnv("PORT", 9442),
    // StandIn dials {WS_PATH}/{callId}, and the portal completes a bare host to this path, so the
    // default is what an identity registered with no explicit path will reach.
    wsPath: normalizeWsPath(process.env.WS_PATH ?? "/msteams/calling"),
    host: process.env.BIND?.trim() || "0.0.0.0",
    bridgeSecret: required("BRIDGE_SECRET"),
    livekitUrl: required("LIVEKIT_URL"),
    livekitApiKey: required("LIVEKIT_API_KEY"),
    livekitApiSecret: required("LIVEKIT_API_SECRET"),
    livekitAgentName: optional("LIVEKIT_AGENT_NAME"),
    tileVideo: process.env.LIVEKIT_TILE_VIDEO?.trim() || "auto",
    tileVideoFps: numFromEnv("LIVEKIT_TILE_VIDEO_FPS", 15),
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
    staleCallReaperSeconds: numFromEnv("STALE_CALL_REAPER_SECONDS", 120),
    groupCall: resolveGroupCallGateConfig({
      requireAddress: optionalBoolFromEnv("GROUP_CALL_REQUIRE_ADDRESS"),
      wakePhrases: optionalListFromEnv("GROUP_CALL_WAKE_PHRASES"),
      followUpWindowMs: optionalNumFromEnv("GROUP_CALL_FOLLOW_UP_WINDOW_MS"),
    }),
    ambientVision: resolveAmbientVisionConfig({
      enabled: optionalBoolFromEnv("AMBIENT_VISION"),
      maxPerMinute: optionalNumFromEnv("MAX_VISION_PER_MINUTE"),
      requireRecordingStatus: optionalBoolFromEnv("REQUIRE_RECORDING_STATUS"),
    }),
  };
}
