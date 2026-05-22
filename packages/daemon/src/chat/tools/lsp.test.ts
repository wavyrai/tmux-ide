/**
 * G21-P2 — LSP chat-tool tests.
 *
 * Drives the four `lsp.*` tools through their public handler shape with
 * a stub backend. Verifies:
 *   - The 1-based → 0-based wire translation lands the right
 *     line/character at the backend.
 *   - The path sandbox rejects absolute paths + `..` traversal.
 *   - Every tool returns the wrapped REST-envelope shape (`{file,
 *     hover|definition|references|diagnostics}`).
 *   - Backend errors surface as `{ok: false, error}` ToolResult.
 *
 * Real `getLspClientForFile` is never reached — the stub backend is
 * mandatory in tests so the suite stays hermetic.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLspTools, type LspBackend } from "./lsp";
import { buildChatToolRegistry } from "../tool-registry";

interface Call {
  verb: "hover" | "definition" | "references" | "diagnostics";
  file: string;
  line?: number;
  character?: number;
}

function makeStubBackend(): { backend: LspBackend; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    backend: {
      async hover(file, line, character) {
        calls.push({ verb: "hover", file, line, character });
        return { contents: "stub-hover" };
      },
      async definition(file, line, character) {
        calls.push({ verb: "definition", file, line, character });
        return [
          {
            uri: `file://${file}`,
            range: { start: { line, character }, end: { line, character } },
          },
        ];
      },
      async references(file, line, character) {
        calls.push({ verb: "references", file, line, character });
        return [
          {
            uri: `file://${file}`,
            range: { start: { line, character }, end: { line, character } },
          },
        ];
      },
      async diagnostics(file) {
        calls.push({ verb: "diagnostics", file });
        return [{ severity: 1, message: "stub-error" }];
      },
    },
  };
}

function withTempWorkspace<T>(fn: (root: string) => T | Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-tool-"));
  return Promise.resolve(fn(root)).finally(() => {
    rmSync(root, { recursive: true, force: true });
  });
}

describe("lsp tools", () => {
  it("translates 1-based tool input to 0-based LSP wire coords", async () => {
    await withTempWorkspace(async (root) => {
      writeFileSync(join(root, "a.ts"), "x");
      const { backend, calls } = makeStubBackend();
      const tools = createLspTools({ sessionDir: root, lspBackend: backend });
      const result = await tools["lsp.hover"].handler({
        file: "a.ts",
        line: 12,
        column: 7,
      });
      expect(result.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ verb: "hover", line: 11, character: 6 });
    });
  });

  it("wraps the backend payload in {file, <verb>: payload}", async () => {
    await withTempWorkspace(async (root) => {
      writeFileSync(join(root, "a.ts"), "x");
      const { backend } = makeStubBackend();
      const tools = createLspTools({ sessionDir: root, lspBackend: backend });
      const hover = await tools["lsp.hover"].handler({ file: "a.ts", line: 1, column: 1 });
      expect(hover).toEqual({
        ok: true,
        output: { file: "a.ts", hover: { contents: "stub-hover" } },
      });
      const def = await tools["lsp.definition"].handler({ file: "a.ts", line: 1, column: 1 });
      expect(def.ok).toBe(true);
      if (def.ok) {
        expect(def.output.file).toBe("a.ts");
        expect(Array.isArray(def.output.definition)).toBe(true);
      }
      const refs = await tools["lsp.references"].handler({ file: "a.ts", line: 1, column: 1 });
      expect(refs.ok).toBe(true);
      const diag = await tools["lsp.diagnostics"].handler({ file: "a.ts" });
      expect(diag).toEqual({
        ok: true,
        output: { file: "a.ts", diagnostics: [{ severity: 1, message: "stub-error" }] },
      });
    });
  });

  it("rejects absolute paths and `..` traversal", async () => {
    await withTempWorkspace(async (root) => {
      const { backend } = makeStubBackend();
      const tools = createLspTools({ sessionDir: root, lspBackend: backend });
      const absolute = await tools["lsp.hover"].handler({
        file: "/etc/passwd",
        line: 1,
        column: 1,
      });
      expect(absolute).toMatchObject({ ok: false });
      const traversal = await tools["lsp.hover"].handler({
        file: "../outside.ts",
        line: 1,
        column: 1,
      });
      expect(traversal).toMatchObject({ ok: false });
    });
  });

  it("rejects symlink files that resolve outside the workspace", async () => {
    await withTempWorkspace(async (root) => {
      const outside = mkdtempSync(join(tmpdir(), "tmux-ide-lsp-outside-"));
      try {
        writeFileSync(join(outside, "secret.ts"), "x");
        // Symlink an in-workspace name to a file outside the workspace.
        // The sandbox must detect the realpath escape and refuse.
        const { symlinkSync } = await import("node:fs");
        symlinkSync(join(outside, "secret.ts"), join(root, "linked.ts"));
        const { backend } = makeStubBackend();
        const tools = createLspTools({ sessionDir: root, lspBackend: backend });
        const result = await tools["lsp.hover"].handler({
          file: "linked.ts",
          line: 1,
          column: 1,
        });
        expect(result).toMatchObject({ ok: false });
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  it("surfaces backend errors as ToolResult.error", async () => {
    await withTempWorkspace(async (root) => {
      writeFileSync(join(root, "a.ts"), "x");
      const failing: LspBackend = {
        hover: async () => {
          throw new Error("No LSP server registered for this file type");
        },
        definition: async () => null,
        references: async () => null,
        diagnostics: async () => [],
      };
      const tools = createLspTools({ sessionDir: root, lspBackend: failing });
      const r = await tools["lsp.hover"].handler({ file: "a.ts", line: 1, column: 1 });
      expect(r).toEqual({
        ok: false,
        error: "No LSP server registered for this file type",
      });
    });
  });

  it("accepts files in subdirectories", async () => {
    await withTempWorkspace(async (root) => {
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "src/nested.ts"), "x");
      const { backend, calls } = makeStubBackend();
      const tools = createLspTools({ sessionDir: root, lspBackend: backend });
      const r = await tools["lsp.definition"].handler({
        file: "src/nested.ts",
        line: 5,
        column: 1,
      });
      expect(r.ok).toBe(true);
      expect(calls[0]!.file.endsWith("/src/nested.ts")).toBe(true);
    });
  });

  it("advertises the four lsp.* tools with their JSON schemas", async () => {
    await withTempWorkspace(async (root) => {
      const { backend } = makeStubBackend();
      const registry = buildChatToolRegistry({
        session: "test",
        lsp: { sessionDir: root, backend },
      });
      const names = registry.advertise().map((t) => t.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "lsp.hover",
          "lsp.definition",
          "lsp.references",
          "lsp.diagnostics",
        ]),
      );
      // The position schema requires line + column ≥ 1 — confirm via the
      // advertised JSON shape so callers can introspect.
      const hoverAd = registry.advertise().find((t) => t.name === "lsp.hover")!;
      expect(hoverAd.inputSchema).toMatchObject({
        type: "object",
        required: expect.arrayContaining(["file", "line", "column"]),
      });
    });
  });

  it("omits the lsp.* suite when no `lsp` option is passed", async () => {
    const registry = buildChatToolRegistry({ session: "test" });
    const names = registry.advertise().map((t) => t.name);
    for (const n of ["lsp.hover", "lsp.definition", "lsp.references", "lsp.diagnostics"]) {
      expect(names).not.toContain(n);
    }
  });
});
