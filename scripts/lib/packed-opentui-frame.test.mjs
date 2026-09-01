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

test("rejects non-terminal focus", () => {
  assert.equal(frameShowsTerminalFocus("Home · primary navigation · ready"), false);
});
