import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTerminalLinkOpener, openTerminalLink } from "./terminal-link-opener.ts";
const launch = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: launch }));
describe("terminal link opener", () => {
  beforeEach(() => launch.mockReset());
  it("reports opener outcomes without exposing URLs or rejecting the event handler", async () => {
    const notify = vi.fn();
    const open = createTerminalLinkOpener(notify);
    const child = new EventEmitter();
    launch.mockReturnValue(child);
    open("https://example.com/private-query");
    child.emit("close", 0);
    await Promise.resolve();
    expect(notify).toHaveBeenLastCalledWith("Opened terminal link");
    open("https://example.com/private-query");
    child.emit("close", 1);
    await Promise.resolve();
    expect(notify).toHaveBeenLastCalledWith("Could not open terminal link");
  });

  it("opens validated links through argv without a shell and propagates launch errors", async () => {
    const child = new EventEmitter();
    launch.mockReturnValue(child);
    const pending = openTerminalLink("https://example.com/?q=$(touch)");
    expect(launch).toHaveBeenCalledWith(expect.any(String), ["https://example.com/?q=$(touch)"], {
      stdio: "ignore",
      shell: false,
    });
    child.emit("close", 0);
    await pending;
    const failed = openTerminalLink("https://example.com");
    child.emit("error", new Error("no opener"));
    await expect(failed).rejects.toThrow("no opener");
    launch.mockClear();
    await expect(openTerminalLink("file:///etc/passwd")).rejects.toThrow("Only HTTP");
    expect(launch).not.toHaveBeenCalled();
  });
});
