import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { BridgeConfig } from "./config.js";
import { isFresh, verify, LEGACY_SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./hmac.js";
import { logger } from "./log.js";
import { CallSession, type RoomConnector } from "./session.js";
import { metricDec, metricInc, renderMetrics } from "./metrics.js";

const log = logger("server");

/**
 * Worker-facing WebSocket server. The StandIn media bridge dials
 * {wsBaseUrl}/{callId} with an HMAC-signed upgrade
 * (X-OpenClawTeamsBridge-Timestamp / -Signature over "{timestampMs}.{callId}").
 * Hardening is a straight port of the proven @komaa/elevenlabs-msteams-bridge
 * transport: replay-proof single-use handshakes, caps checked before crypto,
 * pre-start + dead-peer timers, duplicate-callId 409, SIGTERM drain.
 */

const MAX_INBOUND_PAYLOAD_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CONNECTIONS = 64;
const DEFAULT_PRE_START_TIMEOUT_MS = 10_000;
// room.close() does an async disconnect + deleteRoom (network round-trips to
// LiveKit); a short grace would orphan rooms on redeploy and the agent jobs
// would idle out instead of ending - the exact cost LIVEKIT_DELETE_ROOM_ON_END
// exists to avoid.
const SHUTDOWN_GRACE_MS = 2_500;

/** callId = last non-empty path segment of the upgrade URL. */
export function callIdFromUrl(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  const path = url.split("?")[0];
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) {
    return null;
  }
  try {
    // A malformed percent-escape (%zz) makes decodeURIComponent throw URIError
    // inside the pre-auth "upgrade" listener - an unguarded throw would be an
    // unauthenticated remote process crash. Treat it as no callId.
    return decodeURIComponent(segments[segments.length - 1]);
  } catch {
    return null;
  }
}

/** Single-use guard for verified upgrade tuples within the freshness window. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();
  constructor(private readonly windowMs: number) {}

  claim(callId: string, ts: number, sig: string, nowMs = Date.now()): boolean {
    for (const [key, expiry] of this.seen) {
      // Strict `<`: `isFresh` is inclusive at `ts + windowMs`, so at exactly the
      // boundary the tuple is still replayable and its record must survive. A
      // `<=` sweep would evict it one instant early, reopening a 1 ms replay gap.
      if (expiry < nowMs) {
        this.seen.delete(key);
      }
    }
    const key = `${callId}.${ts}.${sig}`;
    if (this.seen.has(key)) {
      return false;
    }
    this.seen.set(key, ts + this.windowMs);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}

export function authorizeUpgrade(
  cfg: BridgeConfig,
  req: IncomingMessage,
  replay?: ReplayGuard,
): { callId: string } | { error: string } {
  const callId = callIdFromUrl(req.url);
  if (!callId) {
    return { error: "no callId in path" };
  }
  if (!cfg.workerSharedSecret) {
    return { error: "bridge shared secret is not configured" }; // fail closed
  }
  const tsHeader = req.headers[TIMESTAMP_HEADER] ?? req.headers[LEGACY_TIMESTAMP_HEADER];
  const sigHeader = req.headers[SIGNATURE_HEADER] ?? req.headers[LEGACY_SIGNATURE_HEADER];
  const ts = Number(Array.isArray(tsHeader) ? tsHeader[0] : tsHeader);
  const sig = (Array.isArray(sigHeader) ? sigHeader[0] : sigHeader) ?? "";
  if (!isFresh(ts, cfg.hmacFreshnessMs)) {
    return { error: "stale or missing timestamp" };
  }
  if (!verify(cfg.workerSharedSecret, ts, callId, sig)) {
    return { error: "bad signature" };
  }
  if (replay && !replay.claim(callId, ts, sig)) {
    return { error: "replayed handshake" };
  }
  return { callId };
}

/** Per-IP key; first X-Forwarded-For hop when trustProxy is on (proxy deployments). */
function remoteKey(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return req.socket.remoteAddress ?? "unknown";
}

// SIGTERM/SIGINT drain: gracefully end every live call, then exit after a
// short flush window. Wired once per process.
const liveRegistries = new Set<Map<string, CallSession>>();
let signalsWired = false;
function wireDrainSignals(): void {
  if (signalsWired) {
    return;
  }
  signalsWired = true;
  const drain = (sig: string): void => {
    const sessions = [...liveRegistries].flatMap((m) => [...m.values()]);
    log.info(`${sig}: draining ${sessions.length} live call(s)`);
    for (const s of sessions) {
      try {
        s.shutdown("bridge-shutdown");
      } catch {
        /* keep draining the rest */
      }
    }
    setTimeout(() => process.exit(0), sessions.length > 0 ? SHUTDOWN_GRACE_MS : 0);
  };
  process.once("SIGTERM", () => drain("SIGTERM"));
  process.once("SIGINT", () => drain("SIGINT"));
}

/** Default connector: lazy-imports the real LiveKit implementation so tests
 *  (which inject fakes) never load the native @livekit/rtc-node module. */
const lazyLiveKitConnector: RoomConnector = async (cfg, sessionLog, callId, metadata, handlers) => {
  const { connectLiveKitRoom } = await import("./livekit.js");
  return connectLiveKitRoom(cfg, sessionLog, callId, metadata, handlers);
};

export function startServer(cfg: BridgeConfig, connectRoom: RoomConnector = lazyLiveKitConnector): Server {
  const maxConnections = cfg.maxConnections > 0 ? cfg.maxConnections : DEFAULT_MAX_CONNECTIONS;
  const maxPerIp = cfg.maxConnectionsPerIp > 0 ? cfg.maxConnectionsPerIp : maxConnections;
  const preStartTimeoutMs = cfg.preStartTimeoutMs > 0 ? cfg.preStartTimeoutMs : DEFAULT_PRE_START_TIMEOUT_MS;
  const replay = new ReplayGuard(cfg.hmacFreshnessMs);

  let openConnections = 0;
  const perIp = new Map<string, number>();
  const sessions = new Map<string, CallSession>();
  liveRegistries.add(sessions);
  wireDrainSignals();

  const onRequest = (req: IncomingMessage, res: import("node:http").ServerResponse): void => {
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(renderMetrics());
      return;
    }
    res.writeHead(404);
    res.end();
  };

  const httpServer = createServer(onRequest);

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_PAYLOAD_BYTES });

  const reject = (socket: Duplex, status: string, reason: string, ip: string): void => {
    log.warn(`rejected upgrade from ${ip}: ${reason}`);
    // The peer may already be gone; only write while the socket is alive.
    if (!socket.destroyed) {
      socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
    }
    socket.destroy();
  };

  httpServer.on("upgrade", (req, socket, head) => {
    // A peer can drop the connection at any moment in the window before the
    // WebSocket exists; give the raw socket an error handler so that stays tidy
    // (the reject write below also skips sockets that are already gone).
    socket.on("error", () => {
      socket.destroy();
    });
    const ip = remoteKey(req, cfg.trustProxy);
    // Defense in depth: any throw in this listener is an uncaught exception that
    // kills the process (everything in processUpgrade is guarded, but never rely
    // on one guard).
    try {
      processUpgrade(req, socket, head, ip);
    } catch (err) {
      log.error(`upgrade handler threw: ${(err as Error).message}`);
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
    }
  });

  function processUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ip: string): void {
    // cheap caps first (before HMAC) so a flood can't force crypto
    if (openConnections >= maxConnections) {
      metricInc("bridge_upgrades_rejected_cap_total");
      return reject(socket, "503 Service Unavailable", "server connection cap reached", ip);
    }
    if ((perIp.get(ip) ?? 0) >= maxPerIp) {
      metricInc("bridge_upgrades_rejected_cap_total");
      return reject(socket, "503 Service Unavailable", "per-IP connection cap reached", ip);
    }
    const auth = authorizeUpgrade(cfg, req, replay);
    if ("error" in auth) {
      metricInc("bridge_upgrades_rejected_auth_total");
      return reject(socket, "401 Unauthorized", auth.error, ip);
    }
    if (sessions.has(auth.callId)) {
      metricInc("bridge_upgrades_rejected_duplicate_total");
      return reject(socket, "409 Conflict", `callId ${auth.callId.slice(0, 12)}… already has a live session`, ip);
    }

    // claim slots BEFORE the async handleUpgrade callback (burst-safe), release exactly once
    openConnections++;
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    let released = false;
    const releaseSlots = (): void => {
      if (released) {
        return;
      }
      released = true;
      openConnections = Math.max(0, openConnections - 1);
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) {
        perIp.delete(ip);
      } else {
        perIp.set(ip, n);
      }
    };
    socket.once("close", releaseSlots);

    wss.handleUpgrade(req, socket, head, (ws) => {
      log.info(`worker connected for call ${auth.callId.slice(0, 12)}… (${openConnections}/${maxConnections})`);
      metricInc("bridge_calls_total");
      metricInc("bridge_calls_active");

      const session = new CallSession(cfg, ws, auth.callId, connectRoom, () => sessions.delete(auth.callId));
      sessions.set(auth.callId, session);

      // only a real session.start clears the pre-start guard (pings do not)
      const preStartTimer = setTimeout(() => {
        if (!session.hasStarted) {
          log.warn(`call ${auth.callId.slice(0, 12)}… sent no session.start in ${preStartTimeoutMs}ms; closing`);
          try {
            ws.close(1008, "no session.start");
          } catch {
            /* already closing */
          }
        }
      }, preStartTimeoutMs);
      preStartTimer.unref?.();

      ws.once("close", () => {
        clearTimeout(preStartTimer);
        metricDec("bridge_calls_active");
        releaseSlots();
      });
    });
  }

  httpServer.on("close", () => liveRegistries.delete(sessions));

  httpServer.listen(cfg.port, cfg.host, () => {
    log.info(`livekit-msteams-bridge listening on ${cfg.host}:${cfg.port} (LiveKit ${cfg.livekitUrl}, agent ${cfg.livekitAgentName ?? "<automatic dispatch>"})`);
  });
  return httpServer;
}
