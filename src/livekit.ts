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
export const TOPIC_CONTEXT = "teams.context";
export const TOPIC_GOODBYE = "teams.goodbye";

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
  await local.publishTrack(
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
