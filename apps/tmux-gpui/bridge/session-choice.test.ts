import { test } from "node:test";
import assert from "node:assert/strict";
import { sessionChoice } from "./catalog.ts";

test("session pane counts preserve daemon values, unknown stays absent and labels never become identity", () => {
  const session = { liveSessionId: "live-session.fixture", sessionName: "Same label" };
  assert.deepEqual(sessionChoice(session), {
    id: session.liveSessionId,
    label: session.sessionName,
  });
  for (const paneCount of [0, 1, 24, Number.MAX_SAFE_INTEGER]) {
    assert.deepEqual(sessionChoice({ ...session, paneCount }), {
      id: session.liveSessionId,
      label: session.sessionName,
      paneCount,
    });
  }
  for (const paneCount of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => sessionChoice({ ...session, paneCount }));
});
