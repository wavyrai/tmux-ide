import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consentPath,
  consentState,
  grantConsent,
  hashPluginDirectory,
  readConsent,
  revokeConsent,
} from "./consent.ts";

let home: string;
let dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tmux-ide-consent-"));
  dir = join(home, "plugins", "tasks");
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "manifest.json"), '{"name":"tasks"}');
  writeFileSync(join(dir, "init.lua"), "return 1");
  writeFileSync(join(dir, "lib", "util.lua"), "return {}");
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("hashPluginDirectory", () => {
  it("is stable for the same content", () => {
    expect(hashPluginDirectory(dir)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(hashPluginDirectory(dir)).toBe(hashPluginDirectory(dir));
  });

  it("changes when any file, name, new file or symlink target changes", () => {
    const seen = new Set([hashPluginDirectory(dir)]);
    const changed = (label: string) => {
      const hash = hashPluginDirectory(dir);
      expect(seen.has(hash), label).toBe(false);
      seen.add(hash);
    };
    writeFileSync(join(dir, "lib", "util.lua"), "return { x = 1 }");
    changed("nested file content");
    writeFileSync(join(dir, "manifest.json"), '{"name":"tasks","api":"^1.0"}');
    changed("manifest content");
    renameSync(join(dir, "lib", "util.lua"), join(dir, "lib", "util2.lua"));
    changed("file renamed");
    writeFileSync(join(dir, "extra.lua"), "");
    changed("new empty file");
    symlinkSync("/etc/hosts", join(dir, "link"));
    changed("new symlink");
    rmSync(join(dir, "link"));
    symlinkSync("/etc/passwd", join(dir, "link"));
    changed("symlink target");
  });

  it("refuses an oversized plugin instead of hashing it", () => {
    for (let i = 0; i < 2001; i += 1) writeFileSync(join(dir, `f${i}.lua`), "");
    expect(() => hashPluginDirectory(dir)).toThrow(/more than 2000 files/u);
  });
});

describe("consent records", () => {
  it("starts empty, records a hash, notices a change and can be revoked", () => {
    const hash = hashPluginDirectory(dir);
    expect(consentState(readConsent(home), "tasks", hash)).toBe("new");
    grantConsent(home, "tasks", hash, new Date("2026-11-09T10:00:00Z"));
    expect(readConsent(home)).toEqual({
      version: 1,
      plugins: { tasks: { hash, at: "2026-11-09T10:00:00.000Z" } },
    });
    expect(statSync(consentPath(home)).mode & 0o777).toBe(0o600);
    expect(consentState(readConsent(home), "tasks", hash)).toBe("consented");
    writeFileSync(join(dir, "init.lua"), "return 2");
    expect(consentState(readConsent(home), "tasks", hashPluginDirectory(dir))).toBe("changed");
    expect(revokeConsent(home, "tasks")).toBe(true);
    expect(revokeConsent(home, "tasks")).toBe(false);
    expect(consentState(readConsent(home), "tasks", hash)).toBe("new");
  });

  it("treats a corrupt consent file as no consent", () => {
    mkdirSync(dirname(consentPath(home)), { recursive: true });
    writeFileSync(consentPath(home), '{"version":1,"plugins":{"tasks":{"hash":"md5:x","at":""}}}');
    expect(readConsent(home)).toEqual({ version: 1, plugins: {} });
    writeFileSync(consentPath(home), "not json");
    expect(readConsent(home).plugins).toEqual({});
    expect(readFileSync(consentPath(home), "utf8")).toBe("not json");
  });
});
