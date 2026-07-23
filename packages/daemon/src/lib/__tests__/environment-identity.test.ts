import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { environmentIdentityPath, readOrMintEnvironmentId } from "../environment-identity.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "env-identity-"));
  previousHome = process.env.TMUX_IDE_HOME;
  process.env.TMUX_IDE_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.TMUX_IDE_HOME;
  else process.env.TMUX_IDE_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("environment identity", () => {
  it("mints a UUID once and returns the same id on every subsequent call", () => {
    const first = readOrMintEnvironmentId();
    expect(first).toMatch(UUID_PATTERN);
    expect(readOrMintEnvironmentId()).toBe(first);
    expect(readOrMintEnvironmentId()).toBe(first);
  });

  it("persists the id in the state home so a daemon restart preserves it", () => {
    const minted = readOrMintEnvironmentId();
    const persisted = JSON.parse(readFileSync(environmentIdentityPath(), "utf-8")) as {
      environmentId: string;
      mintedAt: string;
    };
    expect(persisted.environmentId).toBe(minted);
    expect(Number.isFinite(Date.parse(persisted.mintedAt))).toBe(true);
    // A fresh read of the same state home — the restart case — finds the id.
    expect(readOrMintEnvironmentId()).toBe(minted);
  });

  it("re-mints a fresh id after the identity file is deleted", () => {
    const first = readOrMintEnvironmentId();
    rmSync(environmentIdentityPath(), { force: true });
    const second = readOrMintEnvironmentId();
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
    expect(readOrMintEnvironmentId()).toBe(second);
  });

  it("heals a malformed identity file instead of crashing or returning it", () => {
    writeFileSync(environmentIdentityPath(), "not json at all");
    const healed = readOrMintEnvironmentId();
    expect(healed).toMatch(UUID_PATTERN);
    expect(readOrMintEnvironmentId()).toBe(healed);
  });

  it("rejects a syntactically valid record whose id is not a UUID", () => {
    writeFileSync(
      environmentIdentityPath(),
      JSON.stringify({ environmentId: "definitely-not-a-uuid" }),
    );
    const healed = readOrMintEnvironmentId();
    expect(healed).toMatch(UUID_PATTERN);
    expect(readOrMintEnvironmentId()).toBe(healed);
  });

  it("scopes the identity to the state home", () => {
    const first = readOrMintEnvironmentId();
    const otherHome = mkdtempSync(join(tmpdir(), "env-identity-other-"));
    try {
      process.env.TMUX_IDE_HOME = otherHome;
      const other = readOrMintEnvironmentId();
      expect(other).toMatch(UUID_PATTERN);
      expect(other).not.toBe(first);
    } finally {
      process.env.TMUX_IDE_HOME = home;
      rmSync(otherHome, { recursive: true, force: true });
    }
    expect(readOrMintEnvironmentId()).toBe(first);
  });
});
