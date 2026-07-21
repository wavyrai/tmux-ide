import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";

import { registerHostIpc, rendererLocationIsTrusted } from "./host-ipc.ts";
import { HOST_IPC } from "./ipc-channels.ts";

describe("host IPC trust boundary", () => {
  it("accepts only the current window main frame and removes every handler", () => {
    const handlers = new Map<string, (event: IpcMainInvokeEvent) => unknown>();
    const ipcMain = {
      handle: (channel: string, handler: (event: IpcMainInvokeEvent) => unknown) =>
        handlers.set(channel, handler),
      removeHandler: (channel: string) => handlers.delete(channel),
    } as unknown as IpcMain;
    const mainFrame = { url: "file:///trusted/renderer/index.html" };
    const webContents = { id: 7, mainFrame, send: vi.fn() };
    const window = {
      isDestroyed: () => false,
      isMaximized: () => false,
      isFullScreen: () => false,
      isFocused: () => true,
      webContents,
    } as unknown as BrowserWindow;
    const unregister = registerHostIpc({
      ipcMain,
      getWindow: () => window,
      appVersion: "test",
      platform: "darwin",
      daemon: { status: "absent" },
      requestQuit: vi.fn(),
      selectProjectDirectory: async () => null,
      getTheme: () => ({ mode: "dark", highContrast: false, reducedMotion: false }),
      trustedRendererLocation: {
        kind: "packaged-url",
        url: "file:///trusted/renderer/index.html",
      },
    });

    const bootstrap = handlers.get(HOST_IPC.bootstrap);
    expect(
      bootstrap?.({ sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent),
    ).toMatchObject({ runtime: "electron", appVersion: "test" });
    expect(() =>
      bootstrap?.({ sender: webContents, senderFrame: {} } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");
    expect(() =>
      bootstrap?.({ sender: { id: 8 }, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");

    // A redirect must not retain bridge authority merely because the Electron
    // WebContents and WebFrameMain objects are still the expected identities.
    mainFrame.url = "https://attacker.invalid/renderer";
    expect(() =>
      bootstrap?.({ sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent),
    ).toThrow("untrusted renderer");

    unregister();
    expect(handlers.size).toBe(0);
  });

  it("accepts a configured development origin but not a lookalike or foreign origin", () => {
    const trusted = { kind: "development-origin", origin: "http://127.0.0.1:5173" } as const;
    expect(rendererLocationIsTrusted("http://127.0.0.1:5173/src/main.tsx", trusted)).toBe(true);
    expect(rendererLocationIsTrusted("http://127.0.0.1:5173.evil.invalid/", trusted)).toBe(false);
    expect(rendererLocationIsTrusted("http://127.0.0.1:5174/", trusted)).toBe(false);
    expect(rendererLocationIsTrusted("not a URL", trusted)).toBe(false);
  });
});
