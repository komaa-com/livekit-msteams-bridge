import { test, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import type { AddressInfo } from "node:net";
import { startServer } from "../src/server.js";
import { sign } from "../src/hmac.js";
import type { BridgeConfig } from "../src/config.js";
import type { AgentRoomPort, RoomHandlers, RoomConnector } from "../src/session.js";

const cfg: BridgeConfig = {
  port: 0,
  host: "127.0.0.1",
  workerSharedSecret: "test-secret",
  livekitUrl: "wss://unused.livekit.cloud",
  livekitApiKey: "unused",
  livekitApiSecret: "unused",
  livekitAgentName: "test-agent",
  livekitRoomPrefix: "msteams-",
  livekitDeleteRoomOnEnd: true,
  maxCallMinutes: 0,
  goodbyeText: "Time limit reached, goodbye!",
  goodbyeGraceMs: 8000,
  hmacFreshnessMs: 60_000,
  maxConnections: 0,
  maxConnectionsPerIp: 0,
  preStartTimeoutMs: 0,
  workerIdleTimeoutMs: 0,
  trustProxy: false,
};

/** Fake LiveKit room: records what the bridge publishes, lets tests push agent audio back. */
class FakeRoom implements AgentRoomPort {
  roomName = "msteams-fake";
  published: string[] = [];
  contexts: string[] = [];
  goodbyes: string[] = [];
  closed = false;
  handlers!: RoomHandlers;
  metadata: Record<string, string> = {};

  async publishCallerAudio(b64: string): Promise<void> {
    this.published.push(b64);
  }
  sendContext(text: string): void {
    this.contexts.push(text);
  }
  sendGoodbye(text: string): void {
    this.goodbyes.push(text);
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function makeConnector(room: FakeRoom, delayMs = 0): RoomConnector {
  return async (_cfg, _log, _callId, metadata, handlers) => {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
    room.metadata = metadata;
    room.handlers = handlers;
    return room;
  };
}

const fakeRoom = new FakeRoom();
const server = startServer(cfg, makeConnector(fakeRoom));
await new Promise<void>((r) => server.once("listening", () => r()));
const port = (server.address() as AddressInfo).port;
after(() => server.close());

function workerHeaders(callId: string, opts?: { badSig?: boolean; staleTs?: boolean }): Record<string, string> {
  const ts = opts?.staleTs ? Date.now() - 3_600_000 : Date.now();
  const sig = opts?.badSig ? "0".repeat(64) : sign(cfg.workerSharedSecret, ts, callId);
  return { "X-OpenClawTeamsBridge-Timestamp": String(ts), "X-OpenClawTeamsBridge-Signature": sig };
}

function connectWorker(p: number, callId: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${p}/voice/msteams/stream/${callId}`, { headers: workerHeaders(callId) });
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function until<T>(fn: () => T | undefined, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - start > timeoutMs) return reject(new Error("until() timed out"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test("rejects bad signature / stale timestamp / malformed callId escape with 401", async () => {
  for (const opts of [{ badSig: true }, { staleTs: true }]) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/x`, { headers: workerHeaders("x", opts) });
    const err = await new Promise<Error>((r) => ws.once("error", r));
    assert.match(err.message, /401/);
  }
  // pre-auth crash guard: %zz must 401, not kill the process
  const ws = new WebSocket(`ws://127.0.0.1:${port}/voice/msteams/stream/%zz`, { headers: workerHeaders("%zz") });
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /401/);
});

test("full relay: session.start dispatch metadata, audio both ways, ping/pong, context, teardown", async () => {
  const CALL_ID = "call-lk-1";
  const ws = await connectWorker(port, CALL_ID);
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));

  ws.send(JSON.stringify({
    type: "session.start",
    callId: CALL_ID,
    threadId: "19:thread",
    caller: { aadId: null, displayName: "Alaa", tenantId: null },
    direction: "inbound",
  }));
  await until(() => (fakeRoom.handlers ? true : undefined));
  assert.equal(fakeRoom.metadata.caller_name, "Alaa");
  assert.equal(fakeRoom.metadata.tenant_id, "unknown-tenant"); // nullable → defaulted
  assert.equal("user_id" in fakeRoom.metadata, false, "no aadId → user_id omitted, never a shared default");

  // caller audio → room, verbatim
  ws.send(JSON.stringify({ type: "audio.frame", seq: 1, timestampMs: 20, payloadBase64: "UENNMTZL" }));
  await until(() => (fakeRoom.published.includes("UENNMTZL") ? true : undefined));

  // agent audio → worker audio.frame with seq/timestamp bookkeeping (640 bytes = 20ms)
  const pcm640 = Buffer.alloc(640).toString("base64");
  fakeRoom.handlers.onAgentAudio(pcm640);
  fakeRoom.handlers.onAgentAudio(pcm640);
  await until(() => (received.filter((m) => m.type === "audio.frame").length >= 2 ? true : undefined));
  const frames = received.filter((m) => m.type === "audio.frame");
  assert.equal(frames[0].seq, 0);
  assert.equal(frames[0].timestampMs, 0);
  assert.equal(frames[1].seq, 1);
  assert.equal(frames[1].timestampMs, 20);

  // ping → pong echoing ts
  ws.send(JSON.stringify({ type: "ping", ts: 12345 }));
  await until(() => received.find((m) => m.type === "pong" && m.ts === 12345));

  // participants + dtmf → room context messages
  ws.send(JSON.stringify({ type: "participants", count: 3 }));
  await until(() => (fakeRoom.contexts.some((t) => t.includes("3 human participants")) ? true : undefined));
  ws.send(JSON.stringify({ type: "dtmf", digit: "7" }));
  await until(() => (fakeRoom.contexts.some((t) => t.includes('"7"')) ? true : undefined));

  // recording state changes are surfaced to the agent (compliance disclosure)
  ws.send(JSON.stringify({ type: "recording.status", status: "active" }));
  await until(() => (fakeRoom.contexts.some((t) => t.includes("recording is now ACTIVE")) ? true : undefined));

  // worker-side governor: assistant.say → goodbye data message to the agent
  ws.send(JSON.stringify({ type: "assistant.say", text: "Goodbye now." }));
  await until(() => (fakeRoom.goodbyes.includes("Goodbye now.") ? true : undefined));

  // duplicate session.start ignored (no second room)
  ws.send(JSON.stringify({ type: "session.start", callId: CALL_ID, threadId: "t", caller: {} }));
  await new Promise((r) => setTimeout(r, 50));

  // session.end → room closed (and deleted), socket closed
  ws.send(JSON.stringify({ type: "session.end", reason: "call-ended" }));
  await until(() => (fakeRoom.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
});

test("agent leaving the room ends the call with agent-disconnected", async () => {
  const room = new FakeRoom();
  const srv = startServer(cfg, makeConnector(room));
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const p = (srv.address() as AddressInfo).port;
  const ws = await connectWorker(p, "call-lk-leave");
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId: "call-lk-leave", threadId: "t", caller: {} }));
  await until(() => (room.handlers ? true : undefined));

  room.handlers.onClosed("participant agent-x disconnected");
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "agent-disconnected");
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));
  srv.close();
});

test("caller audio during room connect is buffered and flushed in order", async () => {
  const room = new FakeRoom();
  const srv = startServer(cfg, makeConnector(room, 80));
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const p = (srv.address() as AddressInfo).port;
  const ws = await connectWorker(p, "call-lk-buf");
  ws.send(JSON.stringify({ type: "session.start", callId: "call-lk-buf", threadId: "t", caller: {} }));
  ws.send(JSON.stringify({ type: "audio.frame", seq: 1, timestampMs: 0, payloadBase64: "Zmlyc3Q=" }));
  ws.send(JSON.stringify({ type: "audio.frame", seq: 2, timestampMs: 20, payloadBase64: "c2Vjb25k" }));
  await until(() => (room.published.length >= 2 ? true : undefined));
  assert.deepEqual(room.published, ["Zmlyc3Q=", "c2Vjb25k"]);
  ws.close();
  srv.close();
});

test("bridge-side governor: goodbye to the agent, then session.end(time-limit)", async () => {
  const room = new FakeRoom();
  const srv = startServer({ ...cfg, maxCallMinutes: 0.002, goodbyeGraceMs: 40 }, makeConnector(room));
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const p = (srv.address() as AddressInfo).port;
  const ws = await connectWorker(p, "call-lk-gov");
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId: "call-lk-gov", threadId: "t", caller: {} }));

  await until(() => (room.goodbyes.some((t) => t.includes("Time limit reached")) ? true : undefined));
  const end = await until(() => received.find((m) => m.type === "session.end"));
  assert.equal(end.reason, "time-limit");
  // Teams-side playback is flushed before the goodbye so buffered agent audio
  // cannot eat the grace window
  const cancelIdx = received.findIndex((m) => m.type === "assistant.cancel");
  const endIdx = received.findIndex((m) => m.type === "session.end");
  assert.ok(cancelIdx >= 0 && cancelIdx < endIdx, "assistant.cancel must precede session.end");
  await until(() => (room.closed ? true : undefined));
  srv.close();
});

test("dead-peer: silent worker torn down, callId freed for reconnect", async () => {
  const room = new FakeRoom();
  const srv = startServer({ ...cfg, workerIdleTimeoutMs: 150 }, makeConnector(room));
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const p = (srv.address() as AddressInfo).port;
  const ws = await connectWorker(p, "call-lk-idle");
  const received: Array<Record<string, unknown>> = [];
  ws.on("message", (d) => received.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: "session.start", callId: "call-lk-idle", threadId: "t", caller: {} }));
  await until(() => (room.handlers ? true : undefined));

  const end = await until(() => received.find((m) => m.type === "session.end"), 2000);
  assert.equal(end.reason, "worker-idle-timeout");
  await until(() => (room.closed ? true : undefined));
  await until(() => (ws.readyState === WebSocket.CLOSED ? true : undefined));

  const ws2 = await connectWorker(p, "call-lk-idle"); // no 409 lockout
  ws2.close();
  srv.close();
});

test("pre-start: pings without session.start do not defuse the timer; room is never dialed", async () => {
  const connector: RoomConnector = async () => {
    throw new Error("room must never be dialed for a never-started session");
  };
  const srv = startServer({ ...cfg, preStartTimeoutMs: 200 }, connector);
  await new Promise<void>((r) => srv.once("listening", () => r()));
  const p = (srv.address() as AddressInfo).port;
  const ws = await connectWorker(p, "call-lk-nostart");
  const pinger = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping", ts: 1 }));
  }, 40);
  const code = await new Promise<number>((r) => ws.once("close", (c) => r(c)));
  clearInterval(pinger);
  assert.equal(code, 1008);
  srv.close();
});

test("GET /metrics exposes call counters", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/metrics`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /# TYPE bridge_calls_total counter/);
  assert.match(body, /bridge_calls_total [1-9]/);
  assert.match(body, /bridge_frames_to_worker_total [1-9]/);
});
