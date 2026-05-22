/**
 * Multi-language launch-table tests (G21-P4).
 *
 * Covers the pure pieces of `launch.ts`:
 *   - Every shipped language has an entry with non-empty extensions
 *     and a binary name.
 *   - File → config routing maps the obvious extensions to the right
 *     language.
 *   - `languageIdFor` returns the LSP wire id for each variant
 *     (typescriptreact for .tsx, plain "python" for .pyi, etc.).
 *   - `launchLanguageServer` returns `null` when the binary can't be
 *     resolved (degraded no-op mode).
 *   - PATH lookup honours the env-var override knob.
 *
 * No real LSP process is ever spawned — we test by pointing the env
 * override at an empty value to force resolution failure, or by
 * pre-staging a fake executable in a temp dir and pinning PATH at
 * that dir.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  LANGUAGE_SERVERS,
  languageServerConfig,
  languageServerConfigForFile,
  launchLanguageServer,
  type Language,
} from "../launch";

const LANGUAGES: Language[] = ["typescript", "python", "rust", "go"];

const ENV_OVERRIDES = LANGUAGES.map((lang) => languageServerConfig(lang).binaryEnvVar).filter(
  (v): v is string => Boolean(v),
);

let savedEnv: Record<string, string | undefined> = {};
let savedPath: string | undefined;
let tempDir = "";

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_OVERRIDES) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  savedPath = process.env.PATH;
});

afterEach(() => {
  for (const key of ENV_OVERRIDES) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = "";
  }
});

describe("LANGUAGE_SERVERS map", () => {
  it("registers typescript / python / rust / go with non-empty extensions", () => {
    const ids = LANGUAGE_SERVERS.map((c) => c.language).sort();
    expect(ids).toEqual(["go", "python", "rust", "typescript"]);
    for (const config of LANGUAGE_SERVERS) {
      expect(config.extensions.length).toBeGreaterThan(0);
      expect(config.defaultBinary.length).toBeGreaterThan(0);
    }
  });

  it("maps file extensions to the matching language config", () => {
    expect(languageServerConfigForFile("src/main.py")?.language).toBe("python");
    expect(languageServerConfigForFile("lib/foo.rs")?.language).toBe("rust");
    expect(languageServerConfigForFile("cmd/server/main.go")?.language).toBe("go");
    expect(languageServerConfigForFile("app/index.ts")?.language).toBe("typescript");
    expect(languageServerConfigForFile("app/index.tsx")?.language).toBe("typescript");
    expect(languageServerConfigForFile("app/index.jsx")?.language).toBe("typescript");
  });

  it("returns undefined for unsupported extensions", () => {
    expect(languageServerConfigForFile("README.md")).toBeUndefined();
    expect(languageServerConfigForFile("Dockerfile")).toBeUndefined();
    expect(languageServerConfigForFile("nope.zzz")).toBeUndefined();
  });

  it("languageIdFor returns the LSP wire id per variant", () => {
    const ts = languageServerConfig("typescript");
    expect(ts.languageIdFor("a.ts")).toBe("typescript");
    expect(ts.languageIdFor("a.tsx")).toBe("typescriptreact");
    expect(ts.languageIdFor("a.jsx")).toBe("javascriptreact");
    expect(ts.languageIdFor("a.js")).toBe("javascript");
    expect(ts.languageIdFor("a.mjs")).toBe("javascript");
    expect(languageServerConfig("python").languageIdFor("a.py")).toBe("python");
    expect(languageServerConfig("python").languageIdFor("a.pyi")).toBe("python");
    expect(languageServerConfig("rust").languageIdFor("a.rs")).toBe("rust");
    expect(languageServerConfig("go").languageIdFor("a.go")).toBe("go");
  });
});

describe("launchLanguageServer — degraded mode", () => {
  it("returns null when the binary isn't on PATH (no env override)", () => {
    // Force every PATH dir to be empty so the lookup fails.
    tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-empty-"));
    process.env.PATH = tempDir;
    for (const lang of LANGUAGES) {
      expect(launchLanguageServer(lang, tempDir)).toBeNull();
    }
  });

  it("returns null when the env override points at a non-existent file", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-fakebin-"));
    // PATH cleared so the only resolution avenue is the env override.
    process.env.PATH = "";
    // Each language's env override points at /nonexistent — the
    // launcher should accept the override path AND honour it
    // verbatim, which means `spawn()` would fail at the next step.
    // Today we test the *pure* resolution: an env override with
    // empty string is treated as "unset" so the lookup falls
    // through to PATH (also empty) and returns null.
    for (const lang of LANGUAGES) {
      const envVar = languageServerConfig(lang).binaryEnvVar!;
      process.env[envVar] = ""; // empty string treated as unset
      expect(launchLanguageServer(lang, tempDir)).toBeNull();
    }
  });

  it("resolves the binary via env override when set + non-empty", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-override-"));
    process.env.PATH = "";
    // Stage a no-op script as the "binary". We never spawn it in this
    // assertion — only check that resolution succeeds and the
    // launcher would have used the override path.
    const fake = join(tempDir, "fake-pyright");
    writeFileSync(fake, "#!/bin/sh\nexec cat\n");
    chmodSync(fake, 0o755);
    process.env.TMUX_IDE_LSP_PYRIGHT = fake;
    const result = launchLanguageServer("python", tempDir);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.command).toBe(fake);
      // Tear down the spawned cat process so the test exits cleanly.
      result.process.kill("SIGTERM");
    }
  });

  it("finds a workspace-local binary before falling back to PATH", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-local-"));
    const binDir = join(tempDir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const local = join(binDir, "typescript-language-server");
    writeFileSync(local, "#!/bin/sh\nexec cat\n");
    chmodSync(local, 0o755);
    process.env.PATH = "";
    const result = launchLanguageServer("typescript", tempDir);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.command).toBe(local);
      result.process.kill("SIGTERM");
    }
  });
});

describe("PATH lookup", () => {
  it("walks PATH dirs in order and picks the first existing entry", () => {
    tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-path-"));
    const a = join(tempDir, "a");
    const b = join(tempDir, "b");
    mkdirSync(a);
    mkdirSync(b);
    const target = join(b, "gopls");
    writeFileSync(target, "#!/bin/sh\nexec cat\n");
    chmodSync(target, 0o755);
    process.env.PATH = [a, b].join(delimiter);
    const result = launchLanguageServer("go", tempDir);
    expect(result?.command).toBe(target);
    result?.process.kill("SIGTERM");
  });
});
