import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AsciicastRecorder } from "./recorder.ts";

describe("AsciicastRecorder", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cast-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates recording directory", () => {
    const rec = new AsciicastRecorder({
      dir,
      session: "test-sess",
      paneId: "%0",
    });
    // Starting will fail since no tmux is running, but the file should be created
    try {
      rec.start();
      rec.stop();
    } catch {
      // expected in test environment
    }

    // The .tasks/recordings/ directory should have been created
    // existsSync imported at top
    expect(existsSync(join(dir, ".tasks", "recordings"))).toBe(true);
  });

  it("writes asciicast v2 header on start", () => {
    const rec = new AsciicastRecorder({
      dir,
      session: "test-sess",
      paneId: "%0",
      intervalMs: 60000, // long interval so timer doesn't fire
    });

    const filePath = rec.start();
    rec.stop();

    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const header = JSON.parse(lines[0]!);
    expect(header.version).toBe(2);
    expect(typeof header.width).toBe("number");
    expect(typeof header.height).toBe("number");
    expect(typeof header.timestamp).toBe("number");
    expect(header.width).toBeGreaterThan(0);
    expect(header.height).toBeGreaterThan(0);
  });

  it("getFilePath returns the .cast file path", () => {
    const rec = new AsciicastRecorder({
      dir,
      session: "my-session",
      paneId: "%5",
    });
    const path = rec.start();
    rec.stop();
    expect(path).toBe(rec.getFilePath());
    expect(path).toContain(".cast");
    expect(path).toContain("my-session");
    expect(path).toContain("5"); // %5 with % stripped
  });

  it("file is in .tasks/recordings/", () => {
    const rec = new AsciicastRecorder({
      dir,
      session: "s",
      paneId: "%0",
    });
    const path = rec.start();
    rec.stop();
    expect(path).toContain(join(".tasks", "recordings"));
  });

  it("event lines follow asciicast v2 format", () => {
    // We can't easily capture from a real tmux pane in tests, but we can
    // verify the header format is correct and that stop doesn't throw.
    const rec = new AsciicastRecorder({
      dir,
      session: "fmt-test",
      paneId: "%0",
      intervalMs: 60000,
    });
    rec.start();
    rec.stop();

    const content = readFileSync(rec.getFilePath(), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // First line is header
    const header = JSON.parse(lines[0]!);
    expect(header.version).toBe(2);

    // Any subsequent lines should be [number, "o", string] arrays
    for (const line of lines.slice(1)) {
      const event = JSON.parse(line);
      expect(Array.isArray(event)).toBe(true);
      expect(event.length).toBe(3);
      expect(typeof event[0]).toBe("number"); // elapsed seconds
      expect(event[1]).toBe("o"); // output event type
      expect(typeof event[2]).toBe("string"); // data
    }
  });

  it("stop is idempotent", () => {
    const rec = new AsciicastRecorder({
      dir,
      session: "s",
      paneId: "%0",
      intervalMs: 60000,
    });
    rec.start();
    rec.stop();
    rec.stop(); // should not throw
  });
});
