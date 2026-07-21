import { describe, expect, it, vi } from "vitest";

import { denyRendererEscapes, secureWebPreferences } from "./window-security.ts";

describe("desktop window security", () => {
  it("enables isolation and removes Node renderer capabilities", () => {
    expect(secureWebPreferences("/trusted/preload.cjs")).toMatchObject({
      preload: "/trusted/preload.cjs",
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      allowRunningInsecureContent: false,
    });
  });

  it("denies navigation, server redirects, popups, and webviews", () => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    const setWindowOpenHandler = vi.fn();
    denyRendererEscapes({
      on: (event, listener) => listeners.set(event, listener),
      setWindowOpenHandler,
    });

    const preventNavigation = vi.fn();
    const preventRedirect = vi.fn();
    const preventWebview = vi.fn();
    listeners.get("will-navigate")?.({ preventDefault: preventNavigation });
    listeners.get("will-redirect")?.({ preventDefault: preventRedirect });
    listeners.get("will-attach-webview")?.({ preventDefault: preventWebview });

    expect(preventNavigation).toHaveBeenCalledOnce();
    expect(preventRedirect).toHaveBeenCalledOnce();
    expect(preventWebview).toHaveBeenCalledOnce();
    expect(setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
  });

  it("blocks a server redirect before Electron can commit an escaped URL", () => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    denyRendererEscapes({
      on: (event, listener) => listeners.set(event, listener),
      setWindowOpenHandler: vi.fn(),
    });

    let redirectPrevented = false;
    const redirect = {
      url: "https://attacker.invalid/renderer",
      preventDefault: () => {
        redirectPrevented = true;
      },
    };
    listeners.get("will-redirect")?.(redirect);

    expect(redirectPrevented).toBe(true);
  });
});
