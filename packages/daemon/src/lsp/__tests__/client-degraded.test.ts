/**
 * Degraded-mode LSP client tests (G21-P4).
 *
 * When the language is registered but the binary isn't installed,
 * `createLspClient` returns a no-op client that resolves every verb
 * to null/empty. The chat tools' wrapping envelope stays unchanged
 * so the agent sees the same `{ hover: null }` / `{ diagnostics: [] }`
 * shape the live server produces when there's nothing to report.
 *
 * We point each language's env override at a non-existent path AND
 * clear PATH so resolution fails for sure, then assert the no-op
 * surface.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLspClient, languageForFile } from "../client";
import { LANGUAGE_SERVERS, languageServerConfig } from "../launch";

const ENV_KEYS = LANGUAGE_SERVERS.map((c) => c.binaryEnvVar).filter((v): v is string => Boolean(v));

let savedPath: string | undefined;
let savedEnv: Record<string, string | undefined> = {};
let tempDir = "";

beforeEach(() => {
  savedPath = process.env.PATH;
  process.env.PATH = "";
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  tempDir = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-degraded-"));
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

describe("createLspClient — degraded no-op mode", () => {
  for (const config of LANGUAGE_SERVERS) {
    it(`returns a no-op client for ${config.language} when the binary is missing`, async () => {
      const client = await createLspClient({
        root: tempDir,
        language: config.language,
      });
      expect(client.language).toBe(config.language);
      expect(client.root).toBe(tempDir);
      // Every verb resolves to the empty / null variant — chat tools'
      // wrapping envelope stays { hover: null } / { diagnostics: [] }
      // which is the same shape a live server produces when there's
      // nothing to report.
      const dummy = join(tempDir, "x");
      expect(await client.hover(dummy, 0, 0)).toBeNull();
      expect(await client.definition(dummy, 0, 0)).toBeNull();
      expect(await client.references(dummy, 0, 0)).toBeNull();
      expect(client.diagnostics(dummy)).toEqual([]);
      expect(await client.waitForDiagnostics(dummy, 10)).toEqual([]);
      // ensureOpen + shutdown resolve silently — no exception.
      await client.ensureOpen(dummy);
      await client.shutdown();
    });
  }

  it("languageForFile recognises every shipped extension", () => {
    expect(languageForFile("src/index.ts")).toBe("typescript");
    expect(languageForFile("src/index.tsx")).toBe("typescript");
    expect(languageForFile("src/main.py")).toBe("python");
    expect(languageForFile("src/main.pyi")).toBe("python");
    expect(languageForFile("src/main.rs")).toBe("rust");
    expect(languageForFile("cmd/main.go")).toBe("go");
    expect(languageForFile("README.md")).toBeUndefined();
  });

  it("throws on a typo'd language id — that's a programmer bug, not a missing binary", async () => {
    await expect(createLspClient({ root: tempDir, language: "pyhton" as never })).rejects.toThrow(
      /Unknown LSP language/,
    );
    // Sanity: the registered names work.
    expect(languageServerConfig("python").language).toBe("python");
  });
});
