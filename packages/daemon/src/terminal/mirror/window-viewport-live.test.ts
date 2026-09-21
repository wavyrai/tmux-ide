import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

const available = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;

/** Qualify the native primitive separately from the authority/transport contract. */
describe.skipIf(!available)("native tmux window viewport isolation", () => {
  it("fits an initialized window without resizing its equal-sized neighbour", async () => {
    const socket = `tmux-ide-fit-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (args: string[]) => {
      const result = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || "tmux command failed");
      return result.stdout.trim();
    };
    let client: ReturnType<typeof spawn> | undefined;
    try {
      run([
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "100",
        "-y",
        "30",
        "-s",
        "proof",
        "/bin/cat",
      ]);
      const first = run(["display-message", "-p", "-t", "proof", "#{window_id}"]);
      const second = run([
        "new-window",
        "-d",
        "-t",
        "proof",
        "-P",
        "-F",
        "#{window_id}",
        "/bin/cat",
      ]);
      for (const window of [first, second])
        run(["set-option", "-w", "-t", window, "window-size", "latest"]);
      client = spawn("tmux", ["-L", socket, "-C", "attach-session", "-t", "proof"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let ready = false;
      client.stdout!.on("data", () => {
        ready = true;
      });
      client.stderr!.resume();
      await vi.waitFor(() => expect(ready).toBe(true));
      const size = (window: string) =>
        run(["display-message", "-p", "-t", window, "#{window_width}x#{window_height}"]);
      client.stdin!.write("refresh-client -C 100x30\n");
      await vi.waitFor(() => {
        expect(size(first)).toBe("100x30");
        expect(size(second)).toBe("100x30");
      });
      client.stdin!.write(`refresh-client -C ${first}:120x40\n`);
      await vi.waitFor(() => expect(size(first)).toBe("120x40"));
      expect(size(second)).toBe("100x30");
      client.stdin!.write(`refresh-client -C ${first}:\n`);
      await vi.waitFor(() => expect(size(first)).toBe("100x30"));
      expect(size(second)).toBe("100x30");
    } finally {
      client?.stdin?.end();
      spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      client?.kill();
    }
  });
  it("documents why unprimed scoped fit cannot yet promise window isolation", async () => {
    const socket = `tmux-ide-fit-${process.pid}-${randomUUID().slice(0, 8)}`;
    const run = (args: string[]) => {
      const result = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr || "tmux command failed");
      return result.stdout.trim();
    };
    let client: ReturnType<typeof spawn> | undefined;
    try {
      run([
        "-f",
        "/dev/null",
        "new-session",
        "-d",
        "-x",
        "100",
        "-y",
        "30",
        "-s",
        "proof",
        "/bin/cat",
      ]);
      const first = run(["display-message", "-p", "-t", "proof", "#{window_id}"]);
      const second = run([
        "new-window",
        "-d",
        "-t",
        "proof",
        "-P",
        "-F",
        "#{window_id}",
        "/bin/cat",
      ]);
      for (const window of [first, second])
        run(["set-option", "-w", "-t", window, "window-size", "latest"]);
      client = spawn("tmux", ["-L", socket, "-C", "attach-session", "-t", "proof"], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let ready = false;
      client.stdout!.on("data", () => {
        ready = true;
      });
      client.stderr!.resume();
      await vi.waitFor(() => expect(ready).toBe(true));
      const size = (window: string) =>
        run(["display-message", "-p", "-t", window, "#{window_width}x#{window_height}"]);

      await vi.waitFor(() => {
        expect(size(first)).toBe("100x30");
        expect(size(second)).toBe("100x30");
      });
      client.stdin!.write(`refresh-client -C ${first}:120x40\n`);
      await vi.waitFor(() => expect(size(first)).toBe("120x40"));
      expect(size(second)).toBe("80x24");
      client.stdin!.write(`refresh-client -C ${first}:\n`);
      await vi.waitFor(() => expect(size(first)).toBe("80x24"));
      expect(size(second)).toBe("80x24");
    } finally {
      client?.stdin?.end();
      spawnSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore" });
      client?.kill();
    }
  });
});
