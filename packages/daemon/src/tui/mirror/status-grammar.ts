/**
 * The unified app's status glyph + color grammar — PURE declarative data, hoisted
 * out of app.tsx (M22.2) so every mirror surface shares ONE source of truth: the
 * sidebar fleet tree, the home rollup chips, the AGENTS section, and (post-merge)
 * the pane-chrome agent chips. Keyed by {@link AgentStatus}.
 *
 * This is the MIRROR app's grammar — deliberately distinct from the cockpit's
 * (whose idle glyph is a filled ●) and from chrome's color tokens. Do not swap
 * in either of those: keep every mirror surface in one visual family.
 */
import { RGBA } from "@opentui/core";
import type { AgentStatus } from "../detect/classify.ts";

/** Per-state foreground color: blocked red, working amber, done blue, idle
 *  green, unknown grey. */
export const STATUS_COLOR: Record<AgentStatus, RGBA> = {
  blocked: RGBA.fromInts(240, 100, 100, 255),
  working: RGBA.fromInts(235, 200, 100, 255),
  done: RGBA.fromInts(120, 170, 250, 255),
  idle: RGBA.fromInts(120, 200, 140, 255),
  unknown: RGBA.fromInts(110, 110, 130, 255),
};

/** Per-state glyph: working/blocked/done share the filled dot (color carries the
 *  distinction), idle is hollow, unknown a middot. */
export const STATUS_GLYPH: Record<AgentStatus, string> = {
  blocked: "●",
  working: "●",
  done: "●",
  idle: "○",
  unknown: "·",
};
