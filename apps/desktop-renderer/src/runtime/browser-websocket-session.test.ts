import { afterEach, describe, expect, it } from "vitest";

import {
  browserWebSocketHandshakeUrl,
  installBrowserWebSocketUrlRewriter,
} from "./browser-websocket-session.ts";

let cleanup: (() => void) | null = null;
afterEach(() => cleanup?.());

describe("browser WebSocket document seam", () => {
  it("keeps credentials off descriptors and adds them only to the handshake", () => {
    const descriptorUrl = "ws://127.0.0.1:5173/v1/terminal/attachments/redeem";
    cleanup = installBrowserWebSocketUrlRewriter(
      (url) => `${url}?__tmux_ide_dev_host_session=document-a`,
    );
    expect(descriptorUrl).not.toContain("document-a");
    expect(browserWebSocketHandshakeUrl(descriptorUrl)).toBe(
      `${descriptorUrl}?__tmux_ide_dev_host_session=document-a`,
    );
  });

  it("lets a reload replace the document generation without stale cleanup winning", () => {
    const cleanupOld = installBrowserWebSocketUrlRewriter((url) => `${url}?generation=old`);
    cleanup = installBrowserWebSocketUrlRewriter((url) => `${url}?generation=new`);
    cleanupOld();
    expect(browserWebSocketHandshakeUrl("ws://127.0.0.1:5173/ws/events")).toContain(
      "generation=new",
    );
  });
});
