import { test } from "node:test";
import assert from "node:assert/strict";
import { selectParticipant } from "../src/videoRelay.js";

// A minimal Room-shaped stub: selectParticipant only reads room.remoteParticipants.
function room(parts: Array<{ identity: string; attributes?: Record<string, string> }>): any {
  return { remoteParticipants: new Map(parts.map((p) => [p.identity, p])) };
}

const PUBLISH_ON_BEHALF = "lk.publish_on_behalf";

test("explicit identity mode selects that participant, ignoring the agent binding", () => {
  const r = room([{ identity: "agent-1" }, { identity: "avatar-x" }]);
  const chosen = selectParticipant(r, "avatar-x", "agent-1");
  assert.equal(chosen?.identity, "avatar-x");
  assert.equal(selectParticipant(r, "nobody", "agent-1"), null);
});

test("auto mode prefers the participant that publishes on behalf of the agent", () => {
  // The avatar publishes both tracks and tags lk.publish_on_behalf = <agent>.
  const r = room([
    { identity: "agent-1" },
    { identity: "bithuman-avatar-agent", attributes: { [PUBLISH_ON_BEHALF]: "agent-1" } },
    { identity: "monitor" },
  ]);
  const chosen = selectParticipant(r, "auto", "agent-1");
  assert.equal(chosen?.identity, "bithuman-avatar-agent");
});

test("auto mode falls back to the agent identity when nothing declares publish_on_behalf", () => {
  const r = room([{ identity: "agent-1" }, { identity: "monitor" }]);
  const chosen = selectParticipant(r, "auto", "agent-1");
  assert.equal(chosen?.identity, "agent-1");
});

test("auto mode returns null before the agent identity is known", () => {
  const r = room([{ identity: "agent-1", attributes: { [PUBLISH_ON_BEHALF]: "agent-1" } }]);
  assert.equal(selectParticipant(r, "auto", null), null);
});

test("a debugger's publish_on_behalf for a different agent is not selected", () => {
  const r = room([
    { identity: "agent-1" },
    { identity: "debug", attributes: { [PUBLISH_ON_BEHALF]: "some-other-agent" } },
  ]);
  // No avatar for agent-1, so it falls back to the agent participant itself.
  assert.equal(selectParticipant(r, "auto", "agent-1")?.identity, "agent-1");
});
