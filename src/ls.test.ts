import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cli = join(__dirname, "..", "bin", "cli.js");

// ls.js uses execSync directly (not our tmux.js layer), so we test via CLI
// to avoid needing to mock execSync at the module level.

let origLog;
let logged;

beforeEach(() => {
  logged = [];
  origLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
});

afterEach(() => {
  console.log = origLog;
});

describe("ls", () => {
  it("returns sessions array via CLI --json", () => {
    const result = spawnSync("node", [cli, "ls", "--json"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(Array.isArray(output.sessions)).toBeTruthy();
  });

  it("parses session list with expected fields", () => {
    const result = spawnSync("node", [cli, "ls", "--json"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const output = JSON.parse(result.stdout);
    // If there are sessions, each should have name, created, attached fields
    for (const session of output.sessions) {
      expect(typeof session.name === "string").toBeTruthy();
      expect(typeof session.created === "string").toBeTruthy();
      expect(typeof session.attached === "boolean").toBeTruthy();
    }
  });

  it("returns valid JSON structure even if sessions exist", () => {
    const result = spawnSync("node", [cli, "ls", "--json"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(Object.hasOwn(output, "sessions")).toBeTruthy();
    expect(Array.isArray(output.sessions)).toBeTruthy();
    // Each session must have the expected shape
    for (const s of output.sessions) {
      expect(typeof s.name === "string" && s.name.length > 0).toBeTruthy();
      expect(typeof s.created === "string").toBeTruthy();
      expect(typeof s.attached === "boolean").toBeTruthy();
    }
  });

  it("prints human-readable output without --json", () => {
    // Just verify it doesn't crash and produces output
    const result = spawnSync("node", [cli, "ls"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.length > 0).toBeTruthy();
  });
});
