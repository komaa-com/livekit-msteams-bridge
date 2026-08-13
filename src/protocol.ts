/**
 * Worker wire protocol: the JSON messages the StandIn media bridge speaks (discriminated on "type").
 * JSON, camelCase properties, discriminated on "type". The peer serializes
 * camelCase; keep field names in exact sync with the published wire contract.
 */

export interface CallerInfo {
  /** All nullable: Graph returns partial identities for guest/anonymous callers. */
  aadId?: string | null;
  displayName?: string | null;
  tenantId?: string | null;
}

export interface SessionStartMessage {
  type: "session.start";
  callId: string;
  threadId: string;
  caller: CallerInfo;
  recordingStatus?: string | null;
  direction?: string | null;
}

export interface SessionEndMessage {
  type: "session.end";
  reason: string;
}

export interface RecordingStatusMessage {
  type: "recording.status";
  status: string;
}

export interface AudioFrameMessage {
  type: "audio.frame";
  seq: number;
  timestampMs: number;
  /** Base64 PCM16K (16 kHz, 16-bit, mono, little-endian). */
  payloadBase64: string;
  speakerName?: string | null;
}

export interface VideoFrameMessage {
  type: "video.frame";
  source: "camera" | "screenshare" | string;
  ts: number;
  width: number;
  height: number;
  mime: string;
  dataBase64: string;
  participantId?: string | null;
  participantName?: string | null;
}

export interface ParticipantsMessage {
  type: "participants";
  count: number;
}

export interface DtmfMessage {
  type: "dtmf";
  digit: string;
}

export interface PingMessage {
  type: "ping";
  ts: number;
}

export interface PongMessage {
  type: "pong";
  ts: number;
}

export interface AssistantSayMessage {
  type: "assistant.say";
  text: string;
}

export interface AssistantCancelMessage {
  type: "assistant.cancel";
  turnId: number;
}

/**
 * DELIBERATELY NOT DECLARED: `expression` (avatar emotion cues) and `display.image` (put one still
 * picture on the bot's own Teams tile).
 *
 * Both are real messages the StandIn worker accepts, and the plugin-shaped sibling bridges emit
 * them. This one cannot, and the blocker is structural rather than missing work: emitting either
 * requires the AGENT to ask for it, and this transport has no agent-to-bridge command lane. The room
 * subscription in livekit.ts registers track events and a single text-stream reader for caller
 * transcripts; nothing carries a command back from the agent. Adding one means defining a new
 * inbound contract - a data topic the bridge subscribes to - that every deployed LiveKit agent would
 * have to adopt. That is a protocol change, not a port, so it is out of scope here.
 *
 * They are absent rather than declared-and-unused on purpose. A member of WorkerOutbound reads as a
 * capability: it is what an SDK consumer sees and what the wire-protocol docs get written from, so a
 * type with no producer is an advertisement for a feature that does not exist.
 * test/wiredNotOrphaned.test.ts enforces that every member of the union has a construction site.
 */

/**
 * Bridge -> worker (experimental). One frame of a continuous avatar-video
 * stream onto the bot tile, JPEG in base64. Latest-wins: only the newest frame
 * matters, and senders MUST drop (not buffer) frames under backpressure, like
 * audio.frame. No lifecycle handshake: the first frames start the stream,
 * silence ends it. Additive: an older worker ignores it.
 */
export interface DisplayFrameMessage {
  type: "display.frame";
  seq: number;
  ts: number;
  mime: string;
  dataBase64: string;
  width?: number | null;
  height?: number | null;
}

/** Messages the worker sends to the bridge. */
export type WorkerInbound =
  | SessionStartMessage
  | SessionEndMessage
  | RecordingStatusMessage
  | AudioFrameMessage
  | VideoFrameMessage
  | ParticipantsMessage
  | DtmfMessage
  | PingMessage
  | AssistantSayMessage;

/** Messages the bridge sends to the worker. */
export type WorkerOutbound =
  | AudioFrameMessage
  | AssistantCancelMessage
  | PongMessage
  | SessionEndMessage
  | DisplayFrameMessage;

/** Parse a worker frame; returns null on junk rather than throwing (drop + log at call site). */
export function parseWorkerMessage(raw: string | Buffer): WorkerInbound | null {
  let obj: unknown;
  try {
    obj = JSON.parse(typeof raw === "string" ? raw : raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || typeof (obj as { type?: unknown }).type !== "string") {
    return null;
  }
  return obj as WorkerInbound;
}

/** PCM16K byte length → milliseconds (16 kHz × 2 bytes = 32 bytes per ms). */
export function pcm16kBytesToMs(bytes: number): number {
  return bytes / 32;
}
