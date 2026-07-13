import { RoomEvent, TrackKind, VideoBufferType, VideoStream } from "@livekit/rtc-node";
import type { Participant, RemoteTrack, Room } from "@livekit/rtc-node";
import type { BridgeConfig } from "./config.js";
import type { Logger } from "./log.js";
import { metricInc } from "./metrics.js";

/**
 * EXPERIMENTAL: relay the agent avatar's published video track onto the Teams
 * tile as a continuous display.frame stream. Off by default (LIVEKIT_TILE_VIDEO).
 *
 * Selection: the agent that publishes the audio we already relay also publishes
 * the avatar video (LiveKit's avatar framework runs both on one participant and
 * tags it lk.publish_on_behalf). We subscribe THAT participant's video track.
 *
 * Delivery: rtc-node's VideoStream is an unbounded ReadableStream, so we drain
 * it continuously into a single "latest" slot and send from a fixed-rate ticker
 * (latest-wins at the source). Each frame is sent at most once - a stalled
 * source means a silent wire, not a frozen repeat. Frames are dropped, never
 * queued, under worker backpressure. seq is monotonic; ts is the sender
 * media-timeline ms (shared with outbound audio.frame) so A/V skew stays
 * measurable.
 */

const TILE_W = 640;
const TILE_H = 360;
const JPEG_QUALITY = 58;
/** Separate, tighter than the 1 MB audio cap: a loaded video path must go
 *  quiet promptly rather than build up seconds of A/V skew. */
const VIDEO_BACKPRESSURE_BYTES = 320 * 1024;
const PUBLISH_ON_BEHALF = "lk.publish_on_behalf";

/** What the relay needs to push a frame + read backpressure. */
export interface TileSink {
  /** True when the underlying socket is open. */
  isOpen(): boolean;
  /** Bytes currently buffered on the worker socket (drop when too high). */
  bufferedBytes(): number;
  /**
   * The sender's AUDIO media timeline, in ms (the same clock outbound
   * audio.frame.timestampMs rides). Video ts MUST come from this clock - a
   * wall clock keeps ticking through listening silence while the audio clock
   * does not, which would confound the A/V skew measurement with clock drift.
   */
  nowMediaMs(): number;
  /** Send one display.frame (already JSON-shaped by the caller's session). */
  sendFrame(seq: number, ts: number, dataBase64: string, width: number, height: number): void;
}

type JpegEncoder = (rgb: Buffer, width: number, height: number) => Promise<Buffer>;

/**
 * Load sharp lazily as an OPTIONAL dependency: the package keeps its single
 * runtime dependency (ws) for the non-avatar majority; avatar users add sharp.
 * Returns null (with one warn) when it is not installed.
 */
async function loadJpegEncoder(log: Logger): Promise<JpegEncoder | null> {
  try {
    // Variable specifier so the compiler does not require the optional 'sharp'
    // types/module to be present; it is resolved only at runtime when enabled.
    const sharpSpecifier = "sharp";
    const mod = (await import(sharpSpecifier)).default as unknown as (
      input: Buffer,
      opts: { raw: { width: number; height: number; channels: 3 } },
    ) => {
      resize(w: number, h: number, o: { fit: "fill" }): {
        jpeg(o: { quality: number }): { toBuffer(): Promise<Buffer> };
      };
    };
    // Downscale to the tile size before encoding: shipping the avatar's
    // native resolution only wastes bandwidth.
    return async (rgb, width, height) =>
      mod(rgb, { raw: { width, height, channels: 3 } })
        .resize(TILE_W, TILE_H, { fit: "fill" })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
  } catch {
    log.warn(
      "LIVEKIT_TILE_VIDEO is on but 'sharp' is not installed; avatar video relay disabled " +
        "(run `npm i sharp` to enable). Audio and everything else are unaffected.",
    );
    return null;
  }
}

/**
 * Pick the participant whose avatar video to relay, honoring the config:
 *   off        -> null (never called; the caller gates on this)
 *   auto       -> the agent identity (the one we relay audio from), verified by
 *                 lk.publish_on_behalf when present
 *   <identity> -> that exact identity
 */
export function selectParticipant(
  room: Room,
  mode: string,
  agentIdentity: string | null,
): Participant | null {
  const remotes = Array.from(room.remoteParticipants.values()) as Participant[];
  if (mode !== "auto") {
    return remotes.find((p) => p.identity === mode) ?? null;
  }
  // auto: prefer a participant that declares it publishes on behalf of the agent
  // (the avatar), else the agent identity itself.
  if (agentIdentity) {
    const byBehalf = remotes.find((p) => p.attributes?.[PUBLISH_ON_BEHALF] === agentIdentity);
    if (byBehalf) return byBehalf;
    const self = remotes.find((p) => p.identity === agentIdentity);
    if (self) return self;
  }
  return null;
}

/**
 * Wire the video relay onto a room. Returns a stop() to unwire on teardown.
 * The caller supplies the agentIdentity resolver (bound at first audio subscribe)
 * and the TileSink (its session's send path).
 */
export async function startVideoRelay(
  cfg: BridgeConfig,
  log: Logger,
  room: Room,
  getAgentIdentity: () => string | null,
  sink: TileSink,
): Promise<() => void> {
  const encode = await loadJpegEncoder(log);
  if (!encode) {
    return () => {}; // sharp missing: no-op, already warned
  }

  const periodMs = Math.max(1, Math.round(1000 / Math.max(1, Math.min(cfg.tileVideoFps, 20))));
  let stopped = false;
  let seq = 0;
  // The single latest decoded-to-RGB frame awaiting encode+send. Latest-wins.
  let latest: { rgb: Buffer; w: number; h: number } | null = null;
  let activeTrackSid: string | null = null;
  let activeStream: VideoStream | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let encoding = false;

  const cancelActiveStream = (): void => {
    const stream = activeStream;
    activeStream = null;
    activeTrackSid = null;
    latest = null; // stop sending (silence on the wire is how a stream ends)
    if (stream) {
      // Dispose the native handle NOW rather than waiting for the next frame
      // to wake the drain loop (a quiet or swapped track may never send one).
      void stream.cancel().catch(() => {});
    }
  };

  const drainTrack = (track: RemoteTrack, identity: string): void => {
    cancelActiveStream(); // a track swap replaces the old stream, never stacks
    const sid = track.sid ?? "unknown";
    activeTrackSid = sid;
    log.info(`avatar video relay: draining track from "${identity}"`);
    void (async () => {
      const stream = new VideoStream(track);
      activeStream = stream;
      try {
        for await (const ev of stream) {
          if (stopped) break;
          // Convert to packed RGB on the FFI side; overwrite the latest slot
          // (never queue - the ticker samples whatever is newest).
          const rgb = ev.frame.convert(VideoBufferType.RGB24);
          latest = {
            rgb: Buffer.from(rgb.data.buffer, rgb.data.byteOffset, rgb.data.length),
            w: rgb.width,
            h: rgb.height,
          };
        }
      } catch (err) {
        if (!stopped) log.warn(`avatar video stream ended: ${(err as Error).message}`);
      } finally {
        if (activeTrackSid === sid) {
          activeTrackSid = null;
        }
        if (activeStream === stream) {
          activeStream = null;
        }
      }
    })();
  };

  // Start draining the selected participant's ALREADY-subscribed video track,
  // if any. TrackSubscribed ordering is unspecified: the avatar's video can
  // subscribe BEFORE its audio binds the agent identity, in which case the
  // event-driven path alone would never start (the event will not re-fire).
  // Re-running this scan whenever the identity may have just bound closes
  // that race.
  const tryStartFromExisting = (): void => {
    if (stopped || activeTrackSid) return;
    const chosen = selectParticipant(room, cfg.tileVideo, getAgentIdentity());
    if (!chosen) return;
    for (const pub of chosen.trackPublications.values()) {
      if (pub.kind === TrackKind.KIND_VIDEO && pub.track) {
        drainTrack(pub.track as RemoteTrack, chosen.identity);
        return;
      }
    }
  };

  const onSubscribed = (track: RemoteTrack, _pub: unknown, participant: Participant): void => {
    if (stopped || activeTrackSid) return;
    if (track.kind === TrackKind.KIND_AUDIO) {
      // The audio subscribe is what binds the agent identity (in the room
      // wiring, registered before us, so it has run by the time we get this
      // event). The selected participant's video may already be subscribed -
      // pick it up now.
      tryStartFromExisting();
      return;
    }
    if (track.kind !== TrackKind.KIND_VIDEO) return;
    const chosen = selectParticipant(room, cfg.tileVideo, getAgentIdentity());
    if (!chosen || chosen.identity !== participant.identity) return;
    drainTrack(track, participant.identity);
  };
  const onUnsubscribed = (track: RemoteTrack): void => {
    if (track.sid && track.sid === activeTrackSid) {
      cancelActiveStream();
    }
  };

  room.on(RoomEvent.TrackSubscribed, onSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, onUnsubscribed);
  // The relay may be armed after tracks already subscribed (session wires it
  // once the room is relaying): scan once at start.
  tryStartFromExisting();

  // Fixed-rate send ticker: encode the latest slot and push it, honoring the
  // video backpressure budget. Skips a tick when the encode is still running or
  // there is no fresh frame.
  ticker = setInterval(() => {
    if (stopped || latest === null || encoding) return;
    if (!sink.isOpen()) return;
    if (sink.bufferedBytes() > VIDEO_BACKPRESSURE_BYTES) {
      metricInc("bridge_video_frames_dropped_total");
      return;
    }
    const frame = latest;
    // Consume the slot: each received frame is sent at most once. When the
    // source stalls (track alive but no new frames), the wire goes silent and
    // the receiving side can time the stream out, instead of us re-sending an
    // identical stale frame forever.
    latest = null;
    encoding = true;
    void (async () => {
      try {
        const jpeg = await encode(frame.rgb, frame.w, frame.h);
        if (stopped || !sink.isOpen()) return;
        // ts rides the sender's AUDIO media timeline (not wall clock): the
        // audio clock freezes through listening silence, and skew is only
        // measurable if both streams share one clock.
        sink.sendFrame(seq++, sink.nowMediaMs(), jpeg.toString("base64"), TILE_W, TILE_H);
      } catch (err) {
        log.warn(`avatar video encode failed: ${(err as Error).message}`);
      } finally {
        encoding = false;
      }
    })();
  }, periodMs);
  ticker.unref?.();

  log.info(`avatar video relay armed (mode=${cfg.tileVideo}, ${cfg.tileVideoFps} fps, tile ${TILE_W}x${TILE_H})`);

  return () => {
    stopped = true;
    if (ticker) clearInterval(ticker);
    room.off(RoomEvent.TrackSubscribed, onSubscribed);
    room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    cancelActiveStream();
  };
}
