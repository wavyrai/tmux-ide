/**
 * The first-run onboarding marker — a machine-local record that the desktop
 * app's gentle intro layer has been dismissed, so it shows exactly once and
 * never returns.
 *
 * It lives in the shared state home (`TMUX_IDE_HOME` when set, else
 * `~/.tmux-ide`) alongside the welcome and update-check markers, and follows the
 * same discipline: the read is offline/error-safe and degrades to "not yet
 * acknowledged" on anything unreadable; the write is best-effort and never
 * throws. Nothing here is on a hot path.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { stateHome } from "./state-home.ts";

/** Absolute path to the marker file: `<state-home>/onboarding.json`. */
export function onboardingMarkerPath(): string {
  return join(stateHome(), "onboarding.json");
}

/**
 * Has the first-run intro been acknowledged? False (never throws) when the
 * marker is absent, unreadable, malformed, or explicitly not acknowledged.
 */
export function readOnboardingIntroAcknowledged(): boolean {
  const path = onboardingMarkerPath();
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object") return false;
    return (parsed as { introAcknowledged?: unknown }).introAcknowledged === true;
  } catch {
    return false;
  }
}

/**
 * Persist that the first-run intro was dismissed. Idempotent and best-effort:
 * an unwritable state home simply means the intro may show again next launch,
 * never a crash.
 */
export function acknowledgeOnboardingIntro(): void {
  const path = onboardingMarkerPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ introAcknowledged: true }));
  } catch {
    // A failed write only costs us the one-time guarantee, never correctness.
  }
}
