import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appSettingsPath, readAppSettings, writeAppSettings } from "./app-settings.ts";

describe("app settings", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tmux-ide-settings-"));
    process.env.TMUX_IDE_SETTINGS_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TMUX_IDE_SETTINGS_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the default when the settings file is missing", () => {
    expect(readAppSettings()).toEqual({
      remoteAccess: { enabled: false, token: null },
    });
  });

  it("writes and reads settings round-trip", () => {
    writeAppSettings({ remoteAccess: { enabled: true, token: "tok_123" } });

    expect(readAppSettings()).toEqual({
      remoteAccess: { enabled: true, token: "tok_123" },
    });
  });

  it("writes atomically through a temp file rename", () => {
    writeAppSettings({ remoteAccess: { enabled: true, token: "tok_abc" } });

    const path = appSettingsPath();
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf-8")).toContain("tok_abc");
    expect(readFileSync(path, "utf-8")).not.toContain(".tmp");
  });
});
