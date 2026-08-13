import type WebSocket from "ws";
import type { TileSink } from "./videoRelay.js";
import type { BridgeConfig } from "./config.js";
import type { ReapableCall } from "./callLifecycle.js";
import { logger, type Logger } from "./log.js";
import {
  parseWorkerMessage,
  pcm16kBytesToMs,
  type AudioFrameMessage,
  type DisplayFrameMessage,
  type SessionStartMessage,
  type WorkerOutbound,
} from "./protocol.js";
import {
  groupCallEtiquetteClause,
  isAddressed,
  isFollowUpWindowOpen,
  isGroupGateActive,
  type GroupCallGateConfig,
} from "./groupGate.js";
import { AmbientVision, type VisionImage } from "./vision.js";
import { metricInc } from "./metrics.js";

/** Pending caller-audio cap while the room connects: 250 × 20 ms = 5 s. */
const MAX_PENDING_AUDIO_FRAMES = 250;

/** Pending contextual-update cap while the room connects (participants/dtmf). */
const MAX_PENDING_CONTEXT = 32;
/**
 * Floor between speaker-change notices.
 *
 * VAD flaps between two people who talk over each other, and every flap would otherwise be a data
 * packet and a context line the agent has to read. Attribution is useful at conversational pace, not
 * at VAD pace.
 */
const SPEAKER_UPDATE_MIN_INTERVAL_MS = 5_000;

/** Outbound (bridge→worker) send-buffer cap: above it, drop realtime frames. */
const MAX_OUTBOUND_BUFFER_BYTES = 1 * 1024 * 1024;

/** Dead-peer window: worker heartbeats every 30 s → 3 missed pings ends the call. */
const DEFAULT_WORKER_IDLE_TIMEOUT_MS = 90_000;


/**
 * What the relay needs from the LiveKit side of a call. The real
 * implementation is connectLiveKitRoom (src/livekit.ts); tests fake it.
 */
export interface AgentRoomPort {
  readonly roomName: string;
  /** Caller audio (base64 PCM16K) → the room's published track. */
  publishCallerAudio(base64Pcm: string): Promise<void>;
  /** Non-interrupting context for the agent (data topic "msteams.context"). */
  sendContext(text: string): void;
  /** Governor goodbye request for the agent (data topic "msteams.goodbye"). */
  sendGoodbye(text: string): void;
  /** Leave (and by default delete) the room. */
  close(): Promise<void>;
  /**
   * Ambient vision: hand the agent one labelled picture of the caller's screen
   * or camera (data topic "msteams.vision"). MUST reject on failure so the
   * session can refund the per-call vision budget. Optional: a room without it
   * simply disables ambient vision for that call, with one warning.
   */
  sendVision?(image: VisionImage): Promise<void>;
  /**
   * EXPERIMENTAL: start relaying the agent avatar's video onto the Teams tile,
   * pushing display.frame through the given sink. Returns a stop() the caller
   * runs on teardown. Optional: fake rooms omit it, and it no-ops when the
   * feature or its optional encoder is off.
   */
  startAvatarRelay?(sink: TileSink): Promise<() => void>;
}

export interface RoomHandlers {
  /** Agent audio (base64 PCM16K, already resampled) → relay to the worker. */
  onAgentAudio: (base64Pcm: string) => void;
  onAgentJoined: (identity: string) => void;
  /**
   * One CALLER turn's transcript, as published by the agent on LiveKit's own
   * "lk.transcription" topic. Called repeatedly as a turn grows (partials as
   * well as the final text) — the group-call gate wants the partials, because a
   * wake phrase that is only ever seen mid-turn must still count.
   */
  onCallerTranscript: (text: string) => void;
  onClosed: (reason: string) => void;
  onError: (err: Error) => void;
}

/** Injectable room connector so tests can substitute a fake room. */
export type RoomConnector = (
  cfg: BridgeConfig,
  log: Logger,
  callId: string,
  metadata: Record<string, string>,
  handlers: RoomHandlers,
) => Promise<AgentRoomPort>;

/**
 * One Teams call: pairs the worker WebSocket with one LiveKit room (agent
 * dispatched into it) and relays audio between them.
 *
 * Both sides speak 16 kHz mono PCM16: the worker natively, the room via the
 * SDK's resampling AudioStream/AudioSource - so the hot path is copy-only.
 *
 * Barge-in note: interruption handling (VAD, turn-taking, cutting the agent
 * off) lives INSIDE the LiveKit agent session - the room gives the bridge no
 * interruption event to map to assistant.cancel, so up to ~1 s of already-
 * relayed agent audio may play out after a barge-in (the worker's own
 * flush-on-silence smooths this). Documented limitation of the room transport.
 */
export class CallSession implements ReapableCall {
  private readonly cfg: BridgeConfig;
  private readonly worker: WebSocket;
  private readonly log: Logger;
  private readonly connectRoom: RoomConnector;

  private room: AgentRoomPort | null = null;
  private stopAvatarRelay: (() => void) | null = null;
  private callId: string;
  private closed = false;
  private sessionStarted = false;

  // outbound audio bookkeeping (bridge → worker)
  private outSeq = 0;
  private outTimestampMs = 0;

  // backpressure log throttle
  private droppedFrames = 0;
  private lastBackpressureWarnMs = 0;

  // caller audio / context arriving while the room is still connecting
  private pendingAudio: string[] = [];
  private pendingContext: string[] = [];

  // Teams recording gate: nothing is persisted by this bridge, but the state
  // is tracked so downstream additions inherit the gate.
  private recordingActive = false;
  /**
   * Whether an explicit recording.status message has been seen.
   *
   * recording.status can arrive BEFORE session.start - on a live call both were stamped in the same
   * millisecond, and in the Python sibling session.start won. session.start carries its own
   * recordingStatus, a setup-time snapshot that is usually "unknown", so letting it overwrite a live
   * status that already arrived closes the media gate for the whole call. Ambient vision then refuses
   * every frame SILENTLY - refusing is the correct behaviour when recording is off - so it presents
   * as the agent hallucinating about a screen it cannot see, with nothing in the log.
   */
  private recordingStatusExplicit = false;

  // governors
  private governorTimer: NodeJS.Timeout | null = null;
  private goodbyeTimer: NodeJS.Timeout | null = null;
  private goodbyeInProgress = false;

  // dead-peer detection (worker heartbeats every 30 s; a half-open socket
  // would otherwise hold the room + the 409 dedup lock for hours)
  private lastWorkerActivityMs = Date.now();
  /**
   * Humans on the call, from the participants message. Speaker attribution and the group-call gate
   * are both group-only. Initialised to 1 so an unknown roster fails OPEN (the agent answers).
   */
  private participantCount = 1;
  private lastSpeakerName: string | null = null;
  private lastSpeakerUpdateMs = 0;
  private idleTimer: NodeJS.Timeout | null = null;

  // group-call gate
  private readonly gate: GroupCallGateConfig;
  /**
   * When a caller last addressed the agent. A TIMESTAMP, never a latched boolean: a wake phrase that
   * is missed or clipped can then never strand the agent silent for the rest of a meeting.
   */
  private lastAddressedAt: number | undefined;
  /**
   * Whether any caller transcript has ever reached us on this call.
   *
   * The deterministic egress gate stays OFF until one has. Transcripts arrive only if the LiveKit
   * agent publishes them (on by default, but an agent can turn it off), and a gate whose trigger
   * never fires would mute the agent for the whole meeting. Same fail-safe as an empty wake-phrase
   * list: no usable trigger means the gate is disabled, not that the agent is silenced.
   */
  private callerTranscriptSeen = false;

  // ambient vision
  private readonly vision: AmbientVision;
  /** The room came up without a sendVision route; ambient vision is off for this call. */
  private visionUnavailable = false;
  private loggedVisionOff = false;

  private readonly onClosed: (() => void) | undefined;
  /** When the bridge accepted this call. Read by the unanswered-call reaper. */
  readonly startedAtMs = Date.now();
  /** When the agent joined the room and published audio. Undefined until it does. */
  private agentAnsweredAtMs: number | undefined;

  constructor(
    cfg: BridgeConfig,
    worker: WebSocket,
    callId: string,
    connectRoom: RoomConnector,
    onClosed?: () => void,
  ) {
    this.cfg = cfg;
    this.worker = worker;
    this.callId = callId;
    this.log = logger(`call:${callId.slice(0, 12)}`);
    this.connectRoom = connectRoom;
    this.onClosed = onClosed;
    this.gate = cfg.groupCall;
    this.vision = new AmbientVision({
      callId,
      config: cfg.ambientVision,
      log: this.log,
      // Teams Media Access obligation: do not even STORE call media before recording is active.
      mediaPermitted: () =>
        !this.closed &&
        !this.visionUnavailable &&
        (!cfg.ambientVision.requireRecordingStatus || this.recordingActive),
      sinkReady: () => this.room !== null && !this.visionUnavailable,
      deliver: (image) => this.deliverVision(image),
    });

    worker.on("message", (data) => {
      this.lastWorkerActivityMs = Date.now();
      // a handler throw must never escape the ws listener (uncaught → process down)
      try {
        this.onWorkerMessage(data as Buffer);
      } catch (err) {
        this.log.error(`error handling worker message: ${(err as Error).message}`);
      }
    });
    worker.on("close", () => this.teardown("worker-closed"));
    worker.on("error", (err) => {
      this.log.warn(`worker socket error: ${(err as Error).message}`);
      this.teardown("worker-error");
    });

    const idleMs = cfg.workerIdleTimeoutMs > 0 ? cfg.workerIdleTimeoutMs : DEFAULT_WORKER_IDLE_TIMEOUT_MS;
    this.idleTimer = setInterval(() => {
      if (Date.now() - this.lastWorkerActivityMs > idleMs) {
        this.log.warn(`no worker message in ${idleMs}ms (dead peer?); ending the call`);
        this.endCall("worker-idle-timeout");
      }
    }, Math.max(20, Math.min(idleMs / 3, 30_000)));
    this.idleTimer.unref?.();
  }

  /** Whether session.start has arrived (the server's pre-start timer asks). */
  get hasStarted(): boolean {
    return this.sessionStarted;
  }

  /**
   * When the agent answered: it joined the room and published audio. The unanswered-call reaper
   * asks. Undefined means nobody ever picked up - a dispatch that never landed, most often a
   * LIVEKIT_AGENT_NAME that does not match the worker's agent_name.
   */
  get answeredAtMs(): number | undefined {
    return this.agentAnsweredAtMs;
  }

  // ---- worker → bridge ----

  private onWorkerMessage(data: Buffer): void {
    const msg = parseWorkerMessage(data);
    if (!msg) {
      this.log.warn("unparseable worker frame; dropping");
      return;
    }
    switch (msg.type) {
      case "session.start":
        this.onSessionStart(msg).catch((err) =>
          this.log.error(`session.start handling failed: ${(err as Error).message}`),
        );
        break;
      case "audio.frame":
        // Who is talking. Unmixed meeting audio names its speaker per frame, and the wire type has
        // carried speakerName all along - nothing read it, so in a meeting the agent heard a single
        // undifferentiated stream and could not tell who said what. The sibling bridges
        // (elevenlabs-msteams-bridge, hermes) both consume this; this one declared the field and
        // dropped it.
        this.noteSpeaker(msg.speakerName);
        // hot path: caller audio → room. While the room is still connecting,
        // buffer (bounded) so the caller's first words are not lost.
        if (this.room) {
          metricInc("bridge_frames_to_agent_total");
          this.room.publishCallerAudio(msg.payloadBase64).catch((err) => {
            this.log.warn(`publishCallerAudio failed: ${(err as Error).message}`);
          });
        } else if (this.sessionStarted) {
          this.pendingAudio.push(msg.payloadBase64);
          if (this.pendingAudio.length > MAX_PENDING_AUDIO_FRAMES) {
            this.pendingAudio.shift(); // keep the most recent speech
          }
        }
        break;
      case "ping":
        this.sendToWorker({ type: "pong", ts: msg.ts });
        break;
      case "participants":
        this.participantCount = msg.count;
        if (msg.count === 1) {
          this.pushContext("This is a 1:1 call with a single human caller.");
        } else if (msg.count > 1) {
          // Group-call gate, instruction lane. The agent owns turn-taking on this transport, so
          // telling it the policy IS the mechanism; the audio-egress check is the backstop behind it.
          const roster = `There are ${msg.count} human participants on this call.`;
          this.pushContext(
            isGroupGateActive(this.gate, true)
              ? `${roster} ${groupCallEtiquetteClause(this.gate)}`
              : roster,
          );
        }
        // count 0 = roster momentarily empty/unknown; say nothing rather than claim a 1:1
        break;
      case "dtmf":
        // A keypress is an unambiguous "I am talking to you", so it opens the follow-up window the
        // same way saying the agent's name does. Without this the agent's answer to a keypress would
        // be dropped at the egress in a meeting.
        this.lastAddressedAt = Date.now();
        this.pushContext(`The caller pressed the "${msg.digit}" key on their keypad.`);
        break;
      case "recording.status": {
        const active = msg.status === "active";
        this.log.info(`recording.status = ${msg.status}`);
        // surface the compliance-relevant state change to the agent so it can
        // disclose/adjust ("this call is being recorded")
        this.recordingStatusExplicit = true;
        if (active !== this.recordingActive) {
          this.recordingActive = active;
          this.pushContext(
            active
              ? "The Microsoft Teams call recording is now ACTIVE."
              : "The Microsoft Teams call recording is not active.",
          );
          // The media gate may have just opened on a screen that has not changed since, and a static
          // screen sends no new frame to re-trigger delivery.
          this.vision.flush();
        }
        break;
      }
      case "video.frame":
        // Ambient vision: the newest screen-share / camera frame becomes labelled context for the
        // agent's next natural turn. Opt-in (AMBIENT_VISION) and a no-op when off, so the default
        // call still costs nothing.
        if (this.cfg.ambientVision.enabled) {
          this.vision.offer(msg);
        } else if (!this.loggedVisionOff) {
          this.loggedVisionOff = true;
          this.log.debug("video.frame received but AMBIENT_VISION is off; ignoring inbound video");
        }
        break;
      case "assistant.say":
        // worker-side governor: ask the agent to speak, the worker tears down after
        this.performGoodbye(msg.text);
        break;
      case "session.end":
        this.log.info(`session.end from worker: ${msg.reason}`);
        this.teardown("worker-session-end");
        break;
      default:
        this.log.debug(`ignoring worker message type ${(msg as { type: string }).type}`);
    }
  }

  private async onSessionStart(msg: SessionStartMessage): Promise<void> {
    if (this.closed) {
      // a session.end/close raced ahead of this queued handler: do not create
      // a room + dispatch a billed agent job that nothing owns
      return;
    }
    if (this.sessionStarted) {
      this.log.warn("duplicate session.start ignored");
      return;
    }
    this.sessionStarted = true;
    if (msg.callId && msg.callId !== this.callId) {
      this.log.error(`session.start callId ${msg.callId} != URL callId ${this.callId}; closing`);
      this.endCall("callid-mismatch");
      return;
    }
    this.log.info(`session.start (direction=${msg.direction ?? "inbound"}, recording=${msg.recordingStatus ?? "unknown"})`);
    // Seed from session.start ONLY when no explicit recording.status has been seen: its value is a
    // setup-time snapshot and must never downgrade a live one that already arrived.
    if (!this.recordingStatusExplicit) {
      this.recordingActive = msg.recordingStatus === "active";
    }

    // Dispatch metadata: nullable caller fields are defaulted, never null; the
    // AAD id is included only when Teams provides one (per-person, never shared).
    const metadata: Record<string, string> = {
      source: "msteams",
      caller_name: msg.caller?.displayName?.trim() || "caller",
      tenant_id: msg.caller?.tenantId?.trim() || "unknown-tenant",
      call_direction: msg.direction?.trim() || "inbound",
    };
    const aadId = msg.caller?.aadId?.trim();
    if (aadId) {
      metadata.user_id = aadId;
    }

    let room: AgentRoomPort;
    try {
      room = await this.connectRoom(this.cfg, this.log, this.callId, metadata, {
        onAgentAudio: (b64) => this.emitAudioToWorker(b64),
        onAgentJoined: (identity) => {
          // "Answered": somebody picked up. Stamped once, and only the unanswered reaper reads it.
          this.agentAnsweredAtMs ??= Date.now();
          this.log.info(`agent "${identity}" joined the room`);
        },
        onCallerTranscript: (text) => this.onCallerTranscript(text),
        onClosed: (reason) => {
          this.log.info(`room closed: ${reason}`);
          this.endCall("agent-disconnected");
        },
        onError: (err) => this.log.warn(`room error: ${err.message}`),
      });
    } catch (err) {
      metricInc("bridge_room_connect_failures_total");
      this.log.error(`could not join the LiveKit room: ${(err as Error).message}`);
      this.endCall("agent-unavailable");
      return;
    }

    // the worker may have dropped DURING the connect; a room nothing owns
    // would leak a live agent job that nothing ever closes
    if (this.closed) {
      this.log.info("worker closed during room connect; leaving the orphaned room");
      void room.close();
      return;
    }
    this.room = room;

    for (const chunk of this.pendingAudio) {
      metricInc("bridge_frames_to_agent_total");
      void this.room.publishCallerAudio(chunk).catch(() => {});
    }
    this.pendingAudio = [];
    for (const text of this.pendingContext) {
      this.room.sendContext(text);
    }
    this.pendingContext = [];
    this.log.info(`LiveKit room "${room.roomName}" relaying`);

    if (this.cfg.ambientVision.enabled) {
      if (typeof room.sendVision !== "function") {
        // No delivery route: say so once and stop collecting, rather than filling the fallback
        // queue on every frame for a call that can never drain it.
        this.visionUnavailable = true;
        this.log.warn("AMBIENT_VISION is on but this room has no sendVision route; ambient vision disabled for this call");
      } else {
        // The room is the delivery route, so anything held while it connected can go now.
        this.vision.flush();
      }
    }

    // EXPERIMENTAL: relay the agent avatar's video onto the Teams tile (off by
    // default). The room owns the LiveKit side; this session is the sink.
    if (this.cfg.tileVideo !== "off" && this.room.startAvatarRelay) {
      this.room
        .startAvatarRelay(this.avatarTileSink())
        .then((stop) => {
          if (this.closed) {
            stop();
          } else {
            this.stopAvatarRelay = stop;
          }
        })
        .catch((err) => this.log.warn(`avatar video relay failed to start: ${(err as Error).message}`));
    }

    // bridge-side governor: LiveKit doesn't know about your billing
    if (this.cfg.maxCallMinutes > 0) {
      this.governorTimer = setTimeout(() => {
        this.onGovernorLimit();
      }, this.cfg.maxCallMinutes * 60_000);
      this.governorTimer.unref?.();
      this.log.info(`governor armed: max ${this.cfg.maxCallMinutes} min`);
    }
  }

  /**
   * Tell the agent who is speaking now, as ordinary context.
   *
   * Group calls only: in a 1:1 there is exactly one other person and naming them every few seconds is
   * noise, not information. Only on a CHANGE, and rate-limited, so two people talking over each other
   * cannot spam the agent with alternating notices.
   */
  private noteSpeaker(name: string | null | undefined): void {
    if (!name || this.participantCount <= 1) return;
    const now = Date.now();
    if (name === this.lastSpeakerName || now - this.lastSpeakerUpdateMs < SPEAKER_UPDATE_MIN_INTERVAL_MS) {
      return;
    }
    this.lastSpeakerName = name;
    this.lastSpeakerUpdateMs = now;
    this.pushContext(`The person now speaking is ${name}.`);
  }

  // ---- group-call gate ----

  /**
   * A caller turn's transcript (partial or final), from the agent's own transcription output.
   *
   * The only thing done with it is wake-phrase detection: the bridge does not store, forward or log
   * call content. Partials count deliberately - a wake phrase seen only mid-turn (echo-clipped, never
   * finalised) must still wake the agent, which is exactly the case a final-only check gets wrong.
   */
  private onCallerTranscript(text: string): void {
    if (!text.trim()) {
      return;
    }
    this.callerTranscriptSeen = true;
    if (isAddressed(text, this.gate.wakePhrases)) {
      this.lastAddressedAt = Date.now();
    }
  }

  /**
   * Is the deterministic egress gate in force right now?
   *
   * Every "no" here is a fail-safe leaning the same way - towards letting the agent be heard:
   *  - the governor's goodbye is never gated (it is the bridge speaking, not the agent interjecting);
   *  - a 1:1 call, requireAddress off, or no usable wake phrase means no gate at all;
   *  - followUpWindowMs = 0 means "address me every turn", which an audio egress has no turn boundary
   *    to express: the window could never open, so the gate would be a permanent mute. A gate with no
   *    way to open is treated as disabled;
   *  - and until a caller transcript has actually arrived there is no evidence the trigger works.
   */
  private egressGateActive(): boolean {
    if (this.goodbyeInProgress) {
      return false;
    }
    if (!isGroupGateActive(this.gate, this.participantCount >= 2)) {
      return false;
    }
    if (this.gate.followUpWindowMs <= 0) {
      return false;
    }
    return this.callerTranscriptSeen;
  }

  /**
   * Deterministic backstop behind the etiquette instruction: in a meeting, agent audio only reaches
   * Teams while the follow-up window is open. No tokens are saved here (the agent already generated
   * the reply) - this is the guarantee that an agent which ignores the instruction still cannot talk
   * over a meeting.
   */
  private admitAgentAudio(): boolean {
    if (!this.egressGateActive()) {
      return true;
    }
    const now = Date.now();
    if (
      !isFollowUpWindowOpen({
        lastAddressedAt: this.lastAddressedAt,
        followUpWindowMs: this.gate.followUpWindowMs,
        now,
      })
    ) {
      return false;
    }
    // Hold the window open while the agent is actually speaking, so a long answer is not cut
    // mid-sentence and the follow-up window is measured from when it STOPS talking.
    this.lastAddressedAt = now;
    return true;
  }

  // ---- ambient vision ----

  /** Hand one image to the agent through the room. Rejects so the budget is refunded on failure. */
  private async deliverVision(image: VisionImage): Promise<void> {
    const room = this.room;
    if (!room?.sendVision) {
      throw new Error("no room vision route");
    }
    await room.sendVision(image);
    metricInc("bridge_vision_frames_sent_total");
  }

  private pushContext(text: string): void {
    if (this.room) {
      this.room.sendContext(text);
    } else if (this.sessionStarted && !this.closed) {
      this.pendingContext.push(text);
      if (this.pendingContext.length > MAX_PENDING_CONTEXT) {
        this.pendingContext.shift();
      }
    }
  }

  // ---- governors ----

  private onGovernorLimit(): void {
    if (this.closed) {
      return;
    }
    this.log.info("governor: call time limit reached");
    this.performGoodbye(this.cfg.goodbyeText);
    // One deadline: the goodbye request is a synchronous data publish with no
    // reported duration, so the grace IS the budget (nothing async can wedge
    // the call open past it).
    this.goodbyeTimer = setTimeout(() => this.endCall("time-limit"), this.cfg.goodbyeGraceMs + 500);
    this.goodbyeTimer.unref?.();
  }

  /**
   * Ask the agent to say the goodbye (data topic "msteams.goodbye"; the agent
   * implements the actual speech - there is no bridge-side TTS on the room
   * transport). Both governors funnel here; first one wins. The worker-side
   * playback is flushed first (assistant.cancel) so Teams-side buffered agent
   * audio cannot eat the grace window; whether the AGENT interrupts its own
   * in-flight turn to speak the goodbye is the agent's choice (see the example
   * agents' msteams.goodbye handler).
   */
  private performGoodbye(text: string): void {
    if (this.goodbyeInProgress) {
      this.log.info("goodbye already in progress; ignoring duplicate");
      return;
    }
    this.goodbyeInProgress = true;
    this.log.info("requesting agent goodbye");
    this.sendToWorker({ type: "assistant.cancel", turnId: 0 });
    this.room?.sendGoodbye(text);
  }

  // ---- plumbing ----

  /** The sink the avatar video relay pushes display.frame through. Video gets
   *  its own tighter budget so it goes quiet promptly under load. */
  private avatarTileSink(): TileSink {
    return {
      isOpen: () => this.worker.readyState === this.worker.OPEN,
      bufferedBytes: () => this.worker.bufferedAmount,
      // The AUDIO media timeline (what outbound audio.frame.timestampMs rides):
      // it freezes through listening silence, unlike a wall clock, so video ts
      // stamped from it keeps A/V skew measurable.
      nowMediaMs: () => Math.round(this.outTimestampMs),
      sendFrame: (seq, ts, dataBase64, width, height) => {
        if (this.worker.readyState !== this.worker.OPEN) {
          return;
        }
        const frame: DisplayFrameMessage = { type: "display.frame", seq, ts, mime: "image/jpeg", dataBase64, width, height };
        metricInc("bridge_video_frames_sent_total");
        this.worker.send(JSON.stringify(frame));
      },
    };
  }

  private emitAudioToWorker(base64Pcm: string): void {
    if (!this.admitAgentAudio()) {
      metricInc("bridge_agent_frames_gated_total");
      return;
    }
    const frame: AudioFrameMessage = {
      type: "audio.frame",
      seq: this.outSeq++,
      timestampMs: Math.round(this.outTimestampMs),
      payloadBase64: base64Pcm,
    };
    this.outTimestampMs += pcm16kBytesToMs(Buffer.byteLength(base64Pcm, "base64"));
    metricInc("bridge_frames_to_worker_total");
    this.sendToWorker(frame);
  }

  private sendToWorker(msg: WorkerOutbound): void {
    if (this.worker.readyState !== this.worker.OPEN) {
      return;
    }
    // Backpressure: of everything that goes through here, only the continuous realtime audio.frame
    // is droppable - the control frames (pong, assistant.cancel, session.end) are tiny and
    // load-bearing. The other bulky stream, display.frame, never reaches this method: the avatar
    // relay writes it from avatarTileSink() against its own tighter video budget (videoRelay.ts).
    const droppable = msg.type === "audio.frame";
    if (droppable && this.worker.bufferedAmount > MAX_OUTBOUND_BUFFER_BYTES) {
      this.droppedFrames++;
      metricInc("bridge_frames_dropped_total");
      const now = Date.now();
      if (now - this.lastBackpressureWarnMs >= 1000) {
        this.log.warn(
          `worker send backpressure: dropped ${this.droppedFrames} frame(s) (buffered ${this.worker.bufferedAmount} bytes)`,
        );
        this.lastBackpressureWarnMs = now;
        this.droppedFrames = 0;
      }
      return;
    }
    this.worker.send(JSON.stringify(msg));
  }

  /** Graceful external shutdown (SIGTERM drain). */
  shutdown(reason: string): void {
    this.endCall(reason);
  }

  private endCall(reason: string): void {
    if (!this.closed) {
      this.sendToWorker({ type: "session.end", reason });
    }
    this.teardown(reason);
  }

  private teardown(reason: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.log.info(`teardown: ${reason}`);
    metricInc("bridge_call_seconds_total", Math.round((Date.now() - this.startedAtMs) / 1000));
    for (const t of [this.governorTimer, this.goodbyeTimer]) {
      if (t) {
        clearTimeout(t);
      }
    }
    this.governorTimer = null;
    this.goodbyeTimer = null;
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    // Per-call vision state is 1-2 MB of retained base64 plus a backstop timer; not releasing it
    // leaks for the process lifetime on every completed call.
    this.vision.release();
    if (this.room) {
      if (this.stopAvatarRelay) {
        this.stopAvatarRelay();
        this.stopAvatarRelay = null;
      }
      void this.room.close().catch(() => {});
      this.room = null;
    }
    try {
      this.worker.close(1000, reason);
    } catch {
      /* already closing */
    }
    this.pendingAudio = [];
    this.pendingContext = [];
    try {
      this.onClosed?.();
    } catch {
      /* registry callback must never throw back into teardown */
    }
  }
}
