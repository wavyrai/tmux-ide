import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
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
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(Array.isArray(output.sessions));
  });

  it("parses session list with expected fields", () => {
    const result = spawnSync("node", [cli, "ls", "--json"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    const output = JSON.parse(result.stdout);
    // If there are sessions, each should have name, created, attached fields
    for (const session of output.sessions) {
      assert.ok(typeof session.name === "string");
      assert.ok(typeof session.created === "string");
      assert.ok(typeof session.attached === "boolean");
    }
  });

  it("returns valid JSON structure even if sessions exist", () => {
    const result = spawnSync("node", [cli, "ls", "--json"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.ok(Object.hasOwn(output, "sessions"));
    assert.ok(Array.isArray(output.sessions));
    // Each session must have the expected shape
    for (const s of output.sessions) {
      assert.ok(typeof s.name === "string" && s.name.length > 0);
      assert.ok(typeof s.created === "string");
      assert.ok(typeof s.attached === "boolean");
    }
  });

  it("prints human-readable output without --json", () => {
    // Just verify it doesn't crash and produces output
    const result = spawnSync("node", [cli, "ls"], {
      encoding: "utf-8",
      timeout: 10000,
    });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.length > 0);
  });
});
