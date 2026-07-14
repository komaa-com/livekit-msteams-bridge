import { RoomEvent, TrackKind, VideoBufferType, VideoStream } from "@livekit/rtc-node";
import type { Participant, RemoteTrack, Room, VideoFrameEvent } from "@livekit/rtc-node";
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
/** Sender-side sanity clamp on the send rate: a talking-head avatar tile gains
 *  nothing above this, and a higher rate only wastes local CPU/bandwidth on
 *  encode+base64. Not a protocol limit - just how fast this sender bothers to
 *  push. */
const MAX_TILE_FPS = 20;
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

  const periodMs = Math.max(1, Math.round(1000 / Math.max(1, Math.min(cfg.tileVideoFps, MAX_TILE_FPS))));
  let stopped = false;
  let seq = 0;
  // The single latest decoded-to-RGB frame awaiting encode+send. Latest-wins.
  let latest: { rgb: Buffer; w: number; h: number } | null = null;
  let activeTrackSid: string | null = null;
  let activeTrack: RemoteTrack | null = null;
  let activeStream: VideoStream | null = null;
  // The reader that holds the stream's lock while the drain loop runs. We MUST
  // cancel through this reader, not stream.cancel(): a VideoStream is a
  // ReadableStream, the drain loop's async iterator locks it, and cancel() on a
  // locked stream rejects without cancelling. Cancelling the reader unblocks a
  // parked read() immediately (a quiet/swapped track may never send another
  // frame to wake the loop) and disposes the native handle.
  let activeReader: ReadableStreamDefaultReader<VideoFrameEvent> | null = null;
  let ticker: NodeJS.Timeout | null = null;
  let encoding = false;

  const cancelActiveStream = (): void => {
    const reader = activeReader;
    const stream = activeStream;
    activeReader = null;
    activeStream = null;
    activeTrackSid = null;
    activeTrack = null;
    latest = null; // stop sending (silence on the wire is how a stream ends)
    if (reader) {
      // Cancel via the lock holder so a parked read() resolves now and the
      // drain loop's finally disposes the stream.
      void reader.cancel().catch(() => {});
    } else if (stream) {
      // No reader yet (loop not entered): cancel the stream directly.
      void stream.cancel().catch(() => {});
    }
  };

  const drainTrack = (track: RemoteTrack, identity: string): void => {
    cancelActiveStream(); // a track swap replaces the old stream, never stacks
    const sid = track.sid ?? "unknown";
    activeTrackSid = sid;
    activeTrack = track;
    log.info(`avatar video relay: draining track from "${identity}"`);
    void (async () => {
      const stream = new VideoStream(track);
      activeStream = stream;
      // Own an explicit reader so cancelActiveStream can cancel through the lock
      // holder (see its comment). A raw `for await...of stream` locks the stream
      // via a hidden reader we cannot reach to cancel.
      const reader = stream.getReader();
      activeReader = reader;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || stopped) break;
          // Convert to packed RGB on the FFI side; overwrite the latest slot
          // (never queue - the ticker samples whatever is newest).
          const rgb = value.frame.convert(VideoBufferType.RGB24);
          latest = {
            rgb: Buffer.from(rgb.data.buffer, rgb.data.byteOffset, rgb.data.length),
            w: rgb.width,
            h: rgb.height,
          };
        }
      } catch (err) {
        if (!stopped) log.warn(`avatar video stream ended: ${(err as Error).message}`);
      } finally {
        reader.releaseLock();
        if (activeReader === reader) {
          activeReader = null;
        }
        if (activeTrackSid === sid) {
          activeTrackSid = null;
        }
        if (activeTrack === track) {
          activeTrack = null;
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
    // Match by track KIND only, never by track source: avatar workers (bitHuman
    // etc.) publish their video UNTAGGED - it arrives as SOURCE_UNKNOWN, not
    // SOURCE_CAMERA - so a source filter would select the participant yet stream
    // zero frames. Take the video publication's track directly (VideoStream(track)).
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
    // Match by object identity first: a track that never exposed a sid would
    // otherwise never cancel the active stream and the drain would linger.
    if (track === activeTrack || (track.sid && track.sid === activeTrackSid)) {
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
    // Consume the slot: each received frame is sent at most once, so a source
    // that stops producing (track alive but no new frames) means a silent
    // wire, not an endless repeat of one stale frame.
    latest = null;
    encoding = true;
    void (async () => {
      try {
        const jpeg = await encode(frame.rgb, frame.w, frame.h);
        if (stopped || !sink.isOpen()) return;
        // Re-check the budget after the encode yielded: audio may have filled
        // the socket while we were off the loop. Dropping here keeps a video
        // frame from nudging the shared socket buffer up and starving audio.
        if (sink.bufferedBytes() > VIDEO_BACKPRESSURE_BYTES) {
          metricInc("bridge_video_frames_dropped_total");
          return;
        }
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

  log.info(`avatar video relay armed (mode=${cfg.tileVideo}, ${cfg.tileVideoFps} fps, ${TILE_W}x${TILE_H})`);

  return () => {
    stopped = true;
    if (ticker) clearInterval(ticker);
    room.off(RoomEvent.TrackSubscribed, onSubscribed);
    room.off(RoomEvent.TrackUnsubscribed, onUnsubscribed);
    cancelActiveStream();
  };
}
