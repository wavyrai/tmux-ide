import assert from "node:assert/strict";
import test from "node:test";

import { frameShowsTerminalFocus, frameShowsSelectedHomeAgent } from "./packed-opentui-frame.mjs";

const narrowHome = `• Codex [WORKING]
  journey-beta
  1 observed agent · 0 need attention · 1 working
  AGENT                 MACHINE / SERVER / SE… STATUS
  › Codex               Local / Default / jou… WORKING
  Local / Default / journey-beta · Enter open`;

test("accepts a truncated Home location with its exact selected-row footer", () => {
  assert.equal(frameShowsSelectedHomeAgent(narrowHome, "Codex", "journey-beta"), true);
  assert.equal(
    frameShowsSelectedHomeAgent(
      narrowHome.replace("jou…", "journey-beta"),
      "Codex",
      "journey-beta",
    ),
    true,
  );
});

test("requires the Home roster row, working status and exact selected location", () => {
  for (const frame of [
    narrowHome.replace("› Codex", "› Other"),
    narrowHome.replace("jou… WORKING", "jou… IDLE"),
    narrowHome.replace("journey-beta · Enter open", "journey-other · Enter open"),
    narrowHome.replace("  › Codex               Local / Default / jou… WORKING\n", ""),
  ])
    assert.equal(frameShowsSelectedHomeAgent(frame, "Codex", "journey-beta"), false);
});

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

const calmHome = `Your agents
  1 observed agent · 0 need attention · 1 working
  Agent             Workspace / machine       Status
  Codex             journey-beta              working
  codex             Local / Default
  Local / Default / journey-beta · Enter open`;

test("accepts the calm two-line Home row without a selection chevron", () => {
  assert.equal(frameShowsSelectedHomeAgent(calmHome, "Codex", "journey-beta"), true);
  for (const frame of [
    calmHome.replace("Codex", "Other"),
    calmHome.replace("              working", "              idle"),
    calmHome.replace("codex             Local / Default", "codex             Remote / Default"),
    calmHome.replace("journey-beta · Enter open", "another · Enter open"),
  ])
    assert.equal(frameShowsSelectedHomeAgent(frame, "Codex", "journey-beta"), false);
});

const unifiedHome = `tmux-ide
  1 observed agent · 0 need attention · 1 working
  All machines · All agents · f machine
  Codex                                                     working
  journey-beta · Local · Default · codex
  Local / Default / journey-beta · Enter open`;

test("accepts unified Home while retaining exact agent, status and location checks", () => {
  assert.equal(frameShowsSelectedHomeAgent(unifiedHome, "Codex", "journey-beta"), true);
  for (const frame of [
    unifiedHome.replace("Codex", "Other"),
    unifiedHome.replace(
      "Codex                                                     working",
      "Codex                                                     idle",
    ),
    unifiedHome.replace("· Local ·", "· Remote ·"),
    unifiedHome.replace("journey-beta · Local", "other · Local"),
    unifiedHome.replace("journey-beta · Enter open", "other · Enter open"),
  ])
    assert.equal(frameShowsSelectedHomeAgent(frame, "Codex", "journey-beta"), false);
});

test("requires idle for the inactive installed agent fixture", () => {
  const idleHome = unifiedHome.replaceAll("working", "idle");
  assert.equal(frameShowsSelectedHomeAgent(idleHome, "Codex", "journey-beta", "idle"), true);
  assert.equal(frameShowsSelectedHomeAgent(unifiedHome, "Codex", "journey-beta", "idle"), false);
  assert.equal(frameShowsSelectedHomeAgent(idleHome, "Other", "journey-beta", "idle"), false);
  assert.equal(frameShowsSelectedHomeAgent(idleHome, "Codex", "other", "idle"), false);
});
