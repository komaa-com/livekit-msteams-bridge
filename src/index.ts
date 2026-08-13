/**
 * @komaa/livekit-msteams-bridge - public API.
 *
 * Typical embedding:
 *   import { loadConfig, startServer } from "@komaa/livekit-msteams-bridge";
 *   startServer(loadConfig());
 *
 * Or run the CLI: `npx @komaa/livekit-msteams-bridge` (env-configured).
 */

export { loadConfig, type BridgeConfig } from "./config.js";
export { startServer, authorizeUpgrade, callIdFromUrl, ReplayGuard } from "./server.js";
export { CallSession, type AgentRoomPort, type RoomHandlers, type RoomConnector } from "./session.js";
export { connectLiveKitRoom, TOPIC_CONTEXT, TOPIC_GOODBYE, TOPIC_VISION, TOPIC_TRANSCRIPTION } from "./livekit.js";
export {
  GROUP_CALL_GATE_DEFAULTS,
  groupCallEtiquetteClause,
  hasUsableWakePhrase,
  isAddressed,
  isFollowUpWindowOpen,
  isGroupGateActive,
  resolveGroupCallGateConfig,
  type GroupCallGateConfig,
} from "./groupGate.js";
export {
  AMBIENT_VISION_DEFAULTS,
  AmbientVision,
  VisionBudget,
  describeFrameOwner,
  resolveAmbientVisionConfig,
  visionSourceOf,
  type AmbientVisionConfig,
  type VisionImage,
  type VisionSource,
} from "./vision.js";
export {
  CallReaper,
  isUnanswered,
  REAPER_CHECK_INTERVAL_MS,
  type ReapableCall,
  type ReapReason,
} from "./callLifecycle.js";
export { sign, verify, isFresh, TIMESTAMP_HEADER, SIGNATURE_HEADER, LEGACY_TIMESTAMP_HEADER, LEGACY_SIGNATURE_HEADER } from "./hmac.js";
export * from "./protocol.js";
export { renderMetrics } from "./metrics.js";
export { logger, type Logger } from "./log.js";
