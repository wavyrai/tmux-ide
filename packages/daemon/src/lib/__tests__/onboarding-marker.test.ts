import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  acknowledgeOnboardingIntro,
  onboardingMarkerPath,
  readOnboardingIntroAcknowledged,
} from "../onboarding-marker.ts";

let home: string;
const previousHome = process.env.TMUX_IDE_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-onboarding-"));
  process.env.TMUX_IDE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TMUX_IDE_HOME;
  else process.env.TMUX_IDE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("onboarding marker", () => {
  it("reads false on a fresh profile", () => {
    expect(readOnboardingIntroAcknowledged()).toBe(false);
  });

  it("persists acknowledgement under the state home and reads it back", () => {
    acknowledgeOnboardingIntro();
    expect(onboardingMarkerPath()).toBe(join(home, "onboarding.json"));
    expect(readOnboardingIntroAcknowledged()).toBe(true);
  });

  it("is idempotent", () => {
    acknowledgeOnboardingIntro();
    acknowledgeOnboardingIntro();
    expect(readOnboardingIntroAcknowledged()).toBe(true);
  });

  it("degrades to false on malformed marker content", () => {
    writeFileSync(join(home, "onboarding.json"), "{ not json");
    expect(readOnboardingIntroAcknowledged()).toBe(false);
  });

  it("treats a non-true flag as not acknowledged", () => {
    writeFileSync(join(home, "onboarding.json"), JSON.stringify({ introAcknowledged: "yes" }));
    expect(readOnboardingIntroAcknowledged()).toBe(false);
  });
});
