// RoomAgentDispatch/RoomConfiguration are re-exported by livekit-server-sdk —
// import them from there, NOT from @livekit/protocol (a transitive dep this
// package does not declare; a non-hoisting package manager would break it).
import { AccessToken, RoomAgentDispatch, RoomConfiguration, RoomServiceClient } from "livekit-server-sdk";
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteTrack,
} from "@livekit/rtc-node";
import type { BridgeConfig } from "./config.js";
import type { Logger } from "./log.js";
import type { AgentRoomPort, RoomHandlers } from "./session.js";
import type { VisionImage } from "./vision.js";
import { startVideoRelay, type TileSink } from "./videoRelay.js";

/**
 * The real LiveKit side of a call: one room per Teams call, the bridge joins
 * as a publishing participant, the agent is dispatched into the same room
 * (explicit dispatch via the join token's RoomConfiguration when
 * LIVEKIT_AGENT_NAME is set - LiveKit's recommended model; token-based
 * dispatch fires when the room is first created, which is exactly our shape:
 * one fresh room per call).
 *
 * Audio in:  worker audio.frame (PCM16K base64) -> AudioSource.captureFrame
 * Audio out: first remote audio track -> AudioStream resampled to 16 kHz mono
 *            -> worker audio.frame (the FFI layer resamples to the requested
 *            rate, so the hot path stays copy-only on our side)
 */

const SAMPLE_RATE = 16_000;
const NUM_CHANNELS = 1;

/** Data topics the agent can listen on (documented in the README). */
export const TOPIC_CONTEXT = "msteams.context";
export const TOPIC_GOODBYE = "msteams.goodbye";
/**
 * Ambient vision images. A byte STREAM, not a data packet: a screen-share JPEG is far larger than a
 * LiveKit data packet may be, and streamBytes chunks it for us. Agents read it with
 * `room.register_byte_stream_handler("msteams.vision", ...)`; the attribution rides in the stream's
 * attributes so a handler never has to parse the image to know whose screen it is.
 */
export const TOPIC_VISION = "msteams.vision";

/**
 * LiveKit's own transcription topic. AgentSession publishes both sides' transcripts here by default
 * (RoomOutputOptions.transcription_enabled), which is the ONLY transcript this bridge can see - it
 * runs no STT of its own. The group-call gate uses it to detect its wake phrase.
 */
export const TOPIC_TRANSCRIPTION = "lk.transcription";
/** Stream attribute naming the audio track a transcript belongs to. */
const TRANSCRIBED_TRACK_ID_ATTR = "lk.transcribed_track_id";

export async function connectLiveKitRoom(
  cfg: BridgeConfig,
  log: Logger,
  callId: string,
  metadata: Record<string, string>,
  handlers: RoomHandlers,
): Promise<AgentRoomPort> {
  // Sanitize: callId comes from a decoded URL segment (%2F would smuggle "/");
  // keep room names to a safe charset and a conservative length.
  const safeCallId = callId.replace(/[^A-Za-z0-9._@:-]/g, "-");
  const roomName = `${cfg.livekitRoomPrefix}${safeCallId}`.slice(0, 100);

  const at = new AccessToken(cfg.livekitApiKey, cfg.livekitApiSecret, {
    identity: "msteams-bridge",
    ttl: "6h",
  });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true, canPublishData: true });
  if (cfg.livekitAgentName) {
    at.roomConfig = new RoomConfiguration({
      agents: [new RoomAgentDispatch({ agentName: cfg.livekitAgentName, metadata: JSON.stringify(metadata) })],
    });
  }
  const token = await at.toJwt();

  const room = new Room();
  await room.connect(cfg.livekitUrl, token, { autoSubscribe: true, dynacast: false });
  const local = room.localParticipant;
  if (!local) {
    try {
      await room.disconnect();
    } catch {
      /* already closing */
    }
    throw new Error("room connected without a local participant");
  }
  log.info(`LiveKit room "${roomName}" joined${cfg.livekitAgentName ? ` (agent "${cfg.livekitAgentName}" dispatched)` : ""}`);

  const source = new AudioSource(SAMPLE_RATE, NUM_CHANNELS);
  const track = LocalAudioTrack.createAudioTrack("teams-caller", source);
  // Keep the publication: its sid identifies the caller's audio track, which is how a transcript on
  // lk.transcription is recognised as the CALLER's rather than the agent's own speech. Read through
  // the object (never cached) because the SDK re-issues the sid in place after a full reconnect.
  const callerPub = await local.publishTrack(
    track,
    new TrackPublishOptions({ source: TrackSource.SOURCE_MICROPHONE }),
  );

  let closed = false;
  // The identity whose audio we relay = "the agent". Captured on first audio
  // subscribe; only THIS identity leaving ends the call (a monitor/debugger/
  // second participant leaving must not tear the Teams call down).
  let agentIdentity: string | null = null;
  // One live pump keyed by track sid, RESET when the stream ends or the track
  // unsubscribes - an agent that unpublishes and re-publishes its audio
  // (avatar track swaps, mute-cycle republish) gets pumped again instead of
  // going silent for the rest of the call.
  let activePumpSid: string | null = null;

  const startPump = (remote: RemoteTrack, identity: string): void => {
    if (activePumpSid) {
      return; // one agent voice at a time; the next subscribe after it ends takes over
    }
    activePumpSid = remote.sid ?? "unknown";
    void (async () => {
      try {
        // request 16 kHz mono: the SDK resamples, keeping our side copy-only
        const stream = new AudioStream(remote, SAMPLE_RATE, NUM_CHANNELS);
        for await (const frame of stream) {
          if (closed) {
            break;
          }
          const pcm = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.length * 2);
          handlers.onAgentAudio(pcm.toString("base64"));
        }
      } catch (err) {
        if (!closed) {
          handlers.onError(err as Error);
        }
      } finally {
        activePumpSid = null;
        log.debug(`audio pump for "${identity}" ended`);
      }
    })();
  };

  room.on(RoomEvent.TrackSubscribed, (remote, _pub, participant) => {
    if (remote.kind === TrackKind.KIND_AUDIO) {
      log.info(`subscribed to agent audio from "${participant.identity}"`);
      if (!agentIdentity) {
        agentIdentity = participant.identity;
        handlers.onAgentJoined(participant.identity);
      }
      startPump(remote, participant.identity);
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (remote) => {
    if (remote.sid && remote.sid === activePumpSid) {
      activePumpSid = null; // the stream is ending; allow a re-published track to pump
    }
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    log.info(`participant "${participant.identity}" left the room`);
    // only the AGENT leaving ends the call
    if (agentIdentity && participant.identity === agentIdentity) {
      handlers.onClosed(`agent ${participant.identity} disconnected`);
    }
  });
  // Disconnected is FINAL: the SDK retries transient drops internally
  // (reconnecting/reconnected) before this fires.
  room.on(RoomEvent.Disconnected, () => handlers.onClosed("room disconnected"));

  // Caller transcripts, for the group-call gate's wake-phrase detection. Best-effort by design: an
  // agent with transcription output disabled publishes nothing here, and the gate then falls back to
  // the etiquette instruction alone rather than muting the agent (see CallSession.egressGateActive).
  try {
    room.registerTextStreamHandler(TOPIC_TRANSCRIPTION, (reader, participant) => {
      // Both sides' transcripts arrive on this topic, and the agent saying its OWN name must never
      // wake the gate. Prefer the transcribed track id (unambiguous: it is the track this bridge
      // publishes), and fall back to "not the agent's identity" when the attribute is absent.
      const trackId = reader.info.attributes?.[TRANSCRIBED_TRACK_ID_ATTR];
      const isCaller = trackId ? trackId === callerPub.sid : participant.identity !== agentIdentity;
      if (!isCaller) {
        return;
      }
      void (async () => {
        try {
          // The reader yields the transcript SO FAR, growing as the turn finalises. Feeding every
          // yield in is what makes a wake phrase that only ever appears in a partial still count.
          for await (const soFar of reader) {
            if (closed) {
              break;
            }
            handlers.onCallerTranscript(soFar);
          }
        } catch (err) {
          log.debug(`caller transcript stream ended: ${(err as Error).message}`);
        }
      })();
    });
  } catch (err) {
    log.warn(
      `could not subscribe to caller transcripts (${(err as Error).message}); the group-call gate falls back to the etiquette instruction alone`,
    );
  }

  const encoder = new TextEncoder();

  return {
    roomName,
    async publishCallerAudio(base64Pcm: string): Promise<void> {
      const buf = Buffer.from(base64Pcm, "base64");
      // PCM16 = 2 bytes/sample: reject malformed frames loudly instead of
      // silently truncating an odd byte
      if (buf.length < 2 || buf.length % 2 !== 0) {
        throw new Error(`malformed PCM16 payload (${buf.length} bytes)`);
      }
      // copy into a fresh, aligned buffer (Buffer views may be unaligned for Int16Array)
      const aligned = Uint8Array.from(buf);
      const samples = new Int16Array(aligned.buffer, 0, aligned.byteLength >> 1);
      await source.captureFrame(new AudioFrame(samples, SAMPLE_RATE, NUM_CHANNELS, samples.length));
    },
    sendContext(text: string): void {
      void local
        .publishData(encoder.encode(JSON.stringify({ text })), { reliable: true, topic: TOPIC_CONTEXT })
        .catch((err: Error) => log.warn(`context publish failed: ${err.message}`));
    },
    sendGoodbye(text: string): void {
      void local
        .publishData(encoder.encode(JSON.stringify({ text })), { reliable: true, topic: TOPIC_GOODBYE })
        .catch((err: Error) => log.warn(`goodbye publish failed: ${err.message}`));
    },
    async sendVision(image: VisionImage): Promise<void> {
      if (closed) {
        throw new Error("room is closed");
      }
      // The image rides as bytes, not base64-in-JSON: a data packet is capped well below a
      // screen-share frame, and streamBytes chunks the payload for us. Rejecting (rather than
      // swallowing) a failure is load-bearing - it is what refunds the per-call vision budget.
      const bytes = Buffer.from(image.dataBase64, "base64");
      const writer = await local.streamBytes({
        topic: TOPIC_VISION,
        name: `${image.source}-${image.ts}`,
        mimeType: image.mime,
        totalSize: bytes.byteLength,
        attributes: {
          source: image.source,
          owner: image.owner,
          caption: image.caption,
          width: String(image.width),
          height: String(image.height),
          ts: String(image.ts),
        },
      });
      try {
        await writer.write(new Uint8Array(bytes));
      } catch (err) {
        await writer.close().catch(() => {});
        throw err;
      }
      await writer.close();
    },
    async startAvatarRelay(sink: TileSink): Promise<() => void> {
      // The relay reads the agent identity captured on first audio subscribe
      // (the avatar publishes both tracks); off/auto/<identity> per config.
      return startVideoRelay(cfg, log, room, () => agentIdentity, sink);
    },
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      try {
        await room.disconnect();
      } catch {
        /* already closing */
      }
      if (cfg.livekitDeleteRoomOnEnd) {
        // end the agent's job immediately instead of letting the room idle out
        try {
          const svc = new RoomServiceClient(cfg.livekitUrl, cfg.livekitApiKey, cfg.livekitApiSecret);
          await svc.deleteRoom(roomName);
        } catch (err) {
          log.warn(`deleteRoom failed (room will idle out): ${(err as Error).message}`);
        }
      }
    },
  };
}
