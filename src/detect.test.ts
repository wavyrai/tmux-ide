import { describe, it, expect } from "bun:test";
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
    expect(config.rows[0].size).toBe("70%");
    expect(config.rows[0].panes.length).toBe(2);
    const bottom = config.rows[1].panes;
    expect(bottom[0].title).toBe("Next.js");
    expect(bottom[0].command).toBe("pnpm dev");
    expect(bottom[bottom.length - 1].title).toBe("Shell");
  });

  it("creates Next.js + Convex config with 3 Claude panes", () => {
    const config = suggestConfig("/project", {
      packageManager: "pnpm",
      frameworks: ["next", "convex"],
      devCommand: "pnpm dev",
      language: "javascript",
    });
    expect(config.rows[0].panes.length).toBe(3);
    const bottom = config.rows[1].panes;
    const titles = bottom.map((p) => p.title);
    expect(titles.includes("Next.js")).toBeTruthy();
    expect(titles.includes("Convex")).toBeTruthy();
    expect(titles.includes("Shell")).toBeTruthy();
  });

  it("creates Go config", () => {
    const config = suggestConfig("/project", {
      packageManager: null,
      frameworks: ["go"],
      devCommand: null,
      language: "go",
    });
    const bottom = config.rows[1].panes;
    expect(bottom[0].title).toBe("Go");
    expect(bottom[0].command).toBe("go run .");
  });

  it("creates Cargo config", () => {
    const config = suggestConfig("/project", {
      packageManager: null,
      frameworks: ["cargo"],
      devCommand: null,
      language: "rust",
    });
    const bottom = config.rows[1].panes;
    expect(bottom[0].title).toBe("Cargo");
    expect(bottom[0].command).toBe("cargo watch -x run");
  });

  it("falls back to dev command when no framework detected", () => {
    const config = suggestConfig("/project", {
      packageManager: "npm",
      frameworks: [],
      devCommand: "npm run dev",
      language: "javascript",
    });
    const bottom = config.rows[1].panes;
    expect(bottom[0].title).toBe("Dev Server");
    expect(bottom[0].command).toBe("npm run dev");
  });

  it("creates minimal config with just shell when nothing detected", () => {
    const config = suggestConfig("/project", {
      packageManager: null,
      frameworks: [],
      devCommand: null,
      language: null,
    });
    const bottom = config.rows[1].panes;
    expect(bottom.length).toBe(1);
    expect(bottom[0].title).toBe("Shell");
  });

  it("uses npm run for npm package manager", () => {
    const config = suggestConfig("/project", {
      packageManager: "npm",
      frameworks: ["next"],
      devCommand: "npm run dev",
      language: "javascript",
    });
    const bottom = config.rows[1].panes;
    expect(bottom[0].command).toBe("npm run dev");
  });

  it("uses bun for bun package manager", () => {
    const config = suggestConfig("/project", {
      packageManager: "bun",
      frameworks: ["vite"],
      devCommand: "bun dev",
      language: "javascript",
    });
    const bottom = config.rows[1].panes;
    expect(bottom[0].command).toBe("bun dev");
  });

  it("uses project directory basename as session name", () => {
    const config = suggestConfig("/home/user/my-app", {
      packageManager: null,
      frameworks: [],
      devCommand: null,
      language: null,
    });
    expect(config.name).toBe("my-app");
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
      expect(detected.packageManager).toBe("pnpm");
      expect(detected.reasons.some((reason) => reason.includes("pnpm-lock.yaml"))).toBeTruthy();
      expect(detected.reasons.some((reason) => reason.includes('dependency "next"'))).toBeTruthy();
      expect(detected.reasons.some((reason) => reason.includes("dev command"))).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
