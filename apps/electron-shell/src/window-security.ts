import type { BrowserWindowConstructorOptions } from "electron";

export function secureWebPreferences(
  preload: string,
): NonNullable<BrowserWindowConstructorOptions["webPreferences"]> {
  return {
    preload,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    spellcheck: false,
  };
}

export interface RestrictedWebContents {
  on(event: "will-navigate", listener: (event: { preventDefault(): void }) => void): unknown;
  on(event: "will-attach-webview", listener: (event: { preventDefault(): void }) => void): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

/** Renderer content cannot navigate, create windows, or attach webviews. */
export function denyRendererEscapes(webContents: RestrictedWebContents): void {
  webContents.on("will-navigate", (event) => event.preventDefault());
  webContents.on("will-attach-webview", (event) => event.preventDefault());
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
