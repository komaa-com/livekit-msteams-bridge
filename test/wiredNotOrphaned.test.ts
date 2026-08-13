// A capability nothing calls is a bug, not a feature.
//
// Each of these features was built once as a tidy, fully unit-tested module and then reimplemented
// inline (or simply never called) at the site that mattered - so the unit tests passed while
// production ran a different copy, or none at all. A behavioural test cannot catch "nobody calls
// this": if the call site vanishes, the behaviour vanishes with it and there is nothing left to
// assert against.
//
// So these assertions read the SOURCE and require the literal call. Comments are stripped first, so
// prose that merely names a symbol cannot satisfy the check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

function source(relPath: string): string {
  const path = fileURLToPath(new URL(`../src/${relPath}`, import.meta.url));
  return (
    readFileSync(path, "utf8")
      // block comments (including the JSDoc that explains each of these features)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // line comments, but not the "//" inside a URL such as https://
      .replace(/(^|[^:])\/\/.*$/gm, "$1")
  );
}

/** Every src module except the protocol declarations themselves - where a producer has to live. */
function producerSources(): string {
  const dir = fileURLToPath(new URL("../src/", import.meta.url));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "protocol.ts")
    .map((f) => source(f))
    .join("\n");
}

function requireCall(relPath: string, ...needles: string[]): void {
  const code = source(relPath);
  for (const needle of needles) {
    assert.ok(
      code.includes(needle),
      `src/${relPath} must actually call ${needle} - the capability is unreachable without it`,
    );
  }
}

test("ambient vision is wired into the real call path", () => {
  // Store-and-deliver on inbound worker video, re-try when the gate or the room unblocks, and free
  // the per-call frames at teardown.
  requireCall("session.ts", "this.vision.offer(msg)", "this.vision.flush()", "this.vision.release()");
  // ...and the room really publishes the image (a byte stream, because an image does not fit a data
  // packet). Dropping this leaves a feature that collects frames and delivers nothing.
  requireCall("livekit.ts", "async sendVision(", "local.streamBytes({");
});

test("the group-call gate is wired at both of its decision points", () => {
  // Instruction lane: the etiquette clause the agent receives on a roster change.
  requireCall("session.ts", "isGroupGateActive(this.gate", "groupCallEtiquetteClause(this.gate)");
  // Wake detection on caller transcripts, and the deterministic audio-egress backstop.
  requireCall("session.ts", "isAddressed(text, this.gate.wakePhrases)", "isFollowUpWindowOpen({");
  requireCall("session.ts", "this.admitAgentAudio()");
  // The transcript has to come from somewhere: the bridge runs no STT, it reads LiveKit's own topic.
  requireCall("livekit.ts", "registerTextStreamHandler(TOPIC_TRANSCRIPTION", "handlers.onCallerTranscript(");
});

test("the no-answer reaper is installed and can see an answered call", () => {
  requireCall("server.ts", "new CallReaper({", "reaper.start()", "reaper.stop()");
  // Without this stamp every call looks unanswered and the reaper would end healthy calls.
  requireCall("session.ts", "this.agentAnsweredAtMs ??= Date.now()");
});

test("every bridge->worker message type in WorkerOutbound has a real producer", () => {
  // The same failure as an uncalled module, one level up: a message declared in WorkerOutbound READS
  // as a capability. It is what an SDK consumer sees, it is what the wire-protocol docs get written
  // from, and it is what a keyword search for "does this bridge do X" finds - while nothing in src/
  // ever constructs one. So the union is checked against its construction sites, both ways: a member
  // with no producer fails here, and dropping the call site that produces an existing one fails here
  // too (which is the only thing standing between "the bridge answers pings" and a silent removal).
  const protocol = source("protocol.ts");
  const union = /export type WorkerOutbound\s*=([^;]+);/.exec(protocol);
  assert.ok(union, "src/protocol.ts must declare a WorkerOutbound union");
  const members = union[1]
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.ok(members.length > 0, "WorkerOutbound must list at least one message");

  for (const member of members) {
    const decl = new RegExp(`interface\\s+${member}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(protocol);
    assert.ok(decl, `${member} is in WorkerOutbound but has no interface declaration`);
    const discriminant = /type:\s*"([^"]+)"/.exec(decl[1]);
    assert.ok(discriminant, `${member} has no literal "type" discriminant`);
    const wireType = discriminant[1];
    assert.ok(
      producerSources().includes(`type: "${wireType}"`),
      `nothing in src/ constructs a "${wireType}" message, so ${member} advertises a capability this bridge does not have`,
    );
  }
});

test("every new capability resolves its defaults through its single resolver", () => {
  // One defaults table per feature. A second copy in the env layer is how two backends end up
  // disagreeing about what "unset" means.
  requireCall("config.ts", "resolveGroupCallGateConfig({", "resolveAmbientVisionConfig({");
});

test("the comment stripper cannot be satisfied by prose", () => {
  // Guards the guard: if the stripper stopped stripping, every assertion above would pass on a file
  // that only TALKS about the call.
  const code = source("session.ts");
  assert.ok(!code.includes("Barge-in note"), "block comments must be stripped");
  assert.ok(!code.includes("hot path: caller audio"), "line comments must be stripped");
  assert.ok(code.includes("class CallSession"), "stripping must not eat the code");
});
