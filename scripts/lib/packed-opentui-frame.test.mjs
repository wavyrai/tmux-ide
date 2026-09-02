import assert from "node:assert/strict";
import test from "node:test";

import { frameShowsTerminalFocus } from "./packed-opentui-frame.mjs";

test("accepts the wide terminal-focus footer", () => {
  assert.equal(frameShowsTerminalFocus("Terminals · focus terminal · ready"), true);
});

test("accepts the compact responsive terminal-focus footer", () => {
  assert.equal(frameShowsTerminalFocus("Terminals · terminal · Live tmux session"), true);
});

test("accepts the component status-bar terminal focus", () => {
  assert.equal(frameShowsTerminalFocus("Terminals / terminal  Live tmux session"), true);
});

test("accepts the session-scoped component status bar", () => {
  assert.equal(
    frameShowsTerminalFocus("journey-beta  Terminals  Live tmux session discovered"),
    true,
  );
});

test("accepts the narrow Linux active-tab marker with a live session footer", () => {
  assert.equal(
    frameShowsTerminalFocus(
      "  ⌂  ●❯                              live\n journey-beta  Live tmux session discovered  F5",
    ),
    true,
  );
});

test("rejects non-terminal focus", () => {
  assert.equal(frameShowsTerminalFocus("Home · primary navigation · ready"), false);
});

test("rejects a live session footer without terminal focus evidence", () => {
  assert.equal(frameShowsTerminalFocus("journey-beta  Live tmux session discovered"), false);
});
