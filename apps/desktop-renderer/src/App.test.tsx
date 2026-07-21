/* @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "solid-js/web";
import {
  DESKTOP_HOST_API_VERSION,
  type DesktopHostBootstrap,
  type DesktopThemeState,
  type DesktopWindowState,
  type HostCapabilities,
} from "@tmux-ide/contracts";

import { App } from "./App.tsx";
import styles from "./styles.css?raw";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function installLightMediaPreference(): void {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      }) satisfies MediaQueryList,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("desktop App host lifecycle", () => {
  it("paints the synchronous light seed, reacts to deferred bootstrap/events, and unsubscribes", async () => {
    installLightMediaPreference();
    const pendingBootstrap = deferred<DesktopHostBootstrap>();
    const stopTheme = vi.fn();
    const stopWindow = vi.fn();
    let publishTheme: ((state: DesktopThemeState) => void) | undefined;
    let publishWindow: ((state: DesktopWindowState) => void) | undefined;
    const initialWindow: DesktopWindowState = {
      maximized: false,
      fullscreen: false,
      focused: true,
    };
    const host: HostCapabilities = {
      apiVersion: DESKTOP_HOST_API_VERSION,
      bootstrap: () => pendingBootstrap.promise,
      lifecycle: { requestQuit: async () => undefined },
      window: {
        getState: async () => initialWindow,
        minimize: async () => initialWindow,
        toggleMaximized: async () => initialWindow,
        close: async () => undefined,
        onStateChanged(listener) {
          publishWindow = listener;
          return stopWindow;
        },
      },
      menu: { showApplicationMenu: async () => ({ status: "unavailable" }) },
      dialog: { selectProjectDirectory: async () => null },
      theme: {
        getState: async () => ({ mode: "light", highContrast: false, reducedMotion: false }),
        onChanged(listener) {
          publishTheme = listener;
          return stopTheme;
        },
      },
    };
    const root = document.createElement("div");
    document.body.append(root);
    const dispose = render(() => <App host={host} />, root);
    const app = root.querySelector<HTMLElement>(".app")!;

    expect(app.dataset.theme).toBe("light");
    expect(app.style.getPropertyValue("--tmux-ide-surface-canvas")).toBe("rgb(245 245 247)");
    expect(app.dataset.increasedContrast).toBe("false");
    expect(root.querySelector(".window-controls")).toBeNull();

    pendingBootstrap.resolve({
      apiVersion: DESKTOP_HOST_API_VERSION,
      runtime: "electron",
      platform: "linux",
      appVersion: "test",
      theme: { mode: "light", highContrast: true, reducedMotion: false },
      window: initialWindow,
      daemon: { status: "deferred", reason: "test boundary" },
    });
    await vi.waitFor(() => {
      expect(app.dataset.increasedContrast).toBe("true");
      expect(app.dataset.reducedMotion).toBe("false");
      expect(root.querySelector(".window-controls")).not.toBeNull();
    });
    expect(styles).toMatch(
      /\.window-controls button \{[\s\S]*?transition:\s*color var\(--tmux-ide-motion-fast\) linear,\s*background-color var\(--tmux-ide-motion-fast\) linear;/u,
    );

    publishTheme?.({ mode: "dark", highContrast: false, reducedMotion: false });
    publishWindow?.({ ...initialWindow, maximized: true });
    await vi.waitFor(() => {
      expect(app.dataset.theme).toBe("dark");
      expect(app.style.getPropertyValue("--tmux-ide-surface-canvas")).toBe("rgb(14 14 18)");
      expect(root.querySelector('[aria-label="Restore"]')).not.toBeNull();
    });

    dispose();
    expect(stopTheme).toHaveBeenCalledOnce();
    expect(stopWindow).toHaveBeenCalledOnce();
  });
});
