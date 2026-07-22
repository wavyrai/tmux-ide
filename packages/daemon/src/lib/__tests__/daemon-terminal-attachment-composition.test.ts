import { describe, expect, it, vi } from "vitest";

import {
  retireTerminalAttachmentTransport,
  terminalAttachmentWebSocketUrl,
} from "../daemon-embed.ts";

describe("embedded daemon terminal attachment composition", () => {
  it.each([
    ["127.0.0.1", "ws://127.0.0.1:4100/v1/terminal/attachments/redeem"],
    ["localhost", "ws://localhost:4100/v1/terminal/attachments/redeem"],
    ["::1", "ws://[::1]:4100/v1/terminal/attachments/redeem"],
    ["0.0.0.0", "ws://127.0.0.1:4100/v1/terminal/attachments/redeem"],
    ["::", "ws://[::1]:4100/v1/terminal/attachments/redeem"],
  ])("projects listener %s to a canonical loopback descriptor", (bindHostname, expected) => {
    expect(terminalAttachmentWebSocketUrl(bindHostname, 4100)).toBe(expected);
  });

  it.each(["192.168.1.20", "example.com"])(
    "does not publish a remote-only listener %s as a renderer capability",
    (bindHostname) => {
      expect(() => terminalAttachmentWebSocketUrl(bindHostname, 4100)).toThrow(
        "canonical loopback",
      );
    },
  );

  it("detaches the upgrade boundary while a pending PTY retirement drains and reports either disposer failure", async () => {
    const events: string[] = [];
    let releasePty!: () => void;
    const pendingPty = new Promise<void>((resolve) => {
      releasePty = resolve;
    });
    const runtime = {
      dispose: vi.fn(() => {
        events.push("runtime-retiring");
        return pendingPty.then(() => {
          events.push("pty-drained");
        });
      }),
    };
    const boundaryError = new Error("listener disposer failed after detach");
    const boundary = {
      close: vi.fn(async () => {
        events.push("listener-detached");
        throw boundaryError;
      }),
    };

    let settled = false;
    const retirement = retireTerminalAttachmentTransport(runtime, boundary).then((failures) => {
      settled = true;
      return failures;
    });
    await Promise.resolve();

    expect(events).toEqual(["runtime-retiring", "listener-detached"]);
    expect(settled).toBe(false);

    releasePty();
    await expect(retirement).resolves.toEqual([boundaryError]);
    expect(events).toEqual(["runtime-retiring", "listener-detached", "pty-drained"]);
  });
});
