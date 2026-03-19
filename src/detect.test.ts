import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectStack, suggestConfig } from "./detect.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("suggestConfig", () => {
  it("creates Next.js config with pnpm", () => {
    const config = suggestConfig("/project", {
      packageManager: "pnpm",
      frameworks: ["next"],
      devCommand: "pnpm dev",
      language: "javascript",
    });
    assert.strictEqual(config.rows[0].size, "70%");
    assert.strictEqual(config.rows[0].panes.length, 2);
    const bottom = config.rows[1].panes;
    assert.strictEqual(bottom[0].title, "Next.js");
    assert.strictEqual(bottom[0].command, "pnpm dev");
    assert.strictEqual(bottom[bottom.length - 1].title, "Shell");
  });

  it("creates Next.js + Convex config with 3 Claude panes", () => {
    const config = suggestConfig("/project", {
      packageManager: "pnpm",
      frameworks: ["next", "convex"],
      devCommand: "pnpm dev",
      language: "javascript",
    });
    assert.strictEqual(config.rows[0].panes.length, 3);
    const bottom = config.rows[1].panes;
    const titles = bottom.map((p) => p.title);
    assert.ok(titles.includes("Next.js"));
    assert.ok(titles.includes("Convex"));
    assert.ok(titles.includes("Shell"));
  });

  it("creates Go config", () => {
    const config = suggestConfig("/project", {
      packageManager: null,
      frameworks: ["go"],
      devCommand: null,
      language: "go",
    });
    const bottom = config.rows[1].panes;
    assert.strictEqual(bottom[0].title, "Go");
    assert.strictEqual(bottom[0].command, "go run .");
  });

  it("creates Cargo config", () => {
    const config = suggestConfig("/project", {
      packageManager: null,
      frameworks: ["cargo"],
      devCommand: null,
      language: "rust",
    });
    const bottom = config.rows[1].panes;
    assert.strictEqual(bottom[0].title, "Cargo");
    assert.strictEqual(bottom[0].command, "cargo watch -x run");
  });

  it("falls back to dev command when no framework detected", () => {
    const config = suggestConfig("/project", {
      packageManager: "npm",
      frameworks: [],
      devCommand: "npm run dev",
      language: "javascript",
    });
    const bottom = config.rows[1].panes;
    assert.strictEqual(bottom[0].title, "Dev Server");
    assert.strictEqual(bottom[0].command, "npm run dev");
  });

  it("creates minimal config with just shell when nothing detected", () => {
    const config = suggestConfig("/project", {
      packageManager: null,
      frameworks: [],
      devCommand: null,
      language: null,
    });
    const bottom = config.rows[1].panes;
    assert.strictEqual(bottom.length, 1);
    assert.strictEqual(bottom[0].title, "Shell");
  });

  it("uses npm run for npm package manager", () => {
    const config = suggestConfig("/project", {
      packageManager: "npm",
      frameworks: ["next"],
      devCommand: "npm run dev",
      language: "javascript",
    });
    const bottom = config.rows[1].panes;
    assert.strictEqual(bottom[0].command, "npm run dev");
  });

  it("uses bun for bun package manager", () => {
    const config = suggestConfig("/project", {
      packageManager: "bun",
      frameworks: ["vite"],
      devCommand: "bun dev",
      language: "javascript",
    });
    const bottom = config.rows[1].panes;
    assert.strictEqual(bottom[0].command, "bun dev");
  });

  it("uses project directory basename as session name", () => {
    const config = suggestConfig("/home/user/my-app", {
      packageManager: null,
      frameworks: [],
      devCommand: null,
      language: null,
    });
    assert.strictEqual(config.name, "my-app");
  });
});

describe("detectStack reasoning", () => {
  it("includes reasons for detected frameworks and command choices", () => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-ide-detect-test-"));

    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          dependencies: { next: "latest", convex: "latest" },
          scripts: { dev: "next dev" },
        }),
      );
      writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: 9");

      const detected = detectStack(dir);
      assert.strictEqual(detected.packageManager, "pnpm");
      assert.ok(detected.reasons.some((reason) => reason.includes("pnpm-lock.yaml")));
      assert.ok(detected.reasons.some((reason) => reason.includes('dependency "next"')));
      assert.ok(detected.reasons.some((reason) => reason.includes("dev command")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
