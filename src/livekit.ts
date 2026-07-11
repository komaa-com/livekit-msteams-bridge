import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { RoomAgentDispatch, RoomConfiguration } from "@livekit/protocol";
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
  const roomName = `${cfg.livekitRoomPrefix}${callId}`.slice(0, 128);

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
  let pumping = false;

  // First remote AUDIO track = the agent's voice (avatar agents publish
  // synchronized audio+video; we take the audio - the Teams tile is rendered
  // by the StandIn worker's own RMS avatar, not the room video).
  const startPump = (remote: RemoteTrack): void => {
    if (pumping) {
      return;
    }
    pumping = true;
    void (async () => {
      try {
        // request 16 kHz mono: the SDK resamples, keeping our side copy-only
        const stream = new AudioStream(remote, SAMPLE_RATE, NUM_CHANNELS);
        for await (const frame of stream as unknown as AsyncIterable<AudioFrame>) {
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
        pumping = false;
      }
    })();
  };

  room.on(RoomEvent.TrackSubscribed, (remote, _pub, participant) => {
    if (remote.kind === TrackKind.KIND_AUDIO) {
      log.info(`subscribed to agent audio from "${participant.identity}"`);
      handlers.onAgentJoined(participant.identity);
      startPump(remote);
    }
  });
  room.on(RoomEvent.ParticipantDisconnected, (participant) => {
    log.info(`participant "${participant.identity}" left the room`);
    // the agent leaving mid-call ends the call (parity with agent-disconnected)
    handlers.onClosed(`participant ${participant.identity} disconnected`);
  });
  room.on(RoomEvent.Disconnected, () => handlers.onClosed("room disconnected"));

  const encoder = new TextEncoder();

  return {
    roomName,
    async publishCallerAudio(base64Pcm: string): Promise<void> {
      const buf = Buffer.from(base64Pcm, "base64");
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
