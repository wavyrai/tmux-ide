import { describe, expect, it } from "vitest";

import {
  parseVibrancySetting,
  resolveWindowAppearance,
  withVibrancyParam,
} from "./window-appearance.ts";

describe("window appearance", () => {
  it("paints the window ground in the appearance the app is about to render", () => {
    // Bug this catches: a fixed near-black window background under a light
    // app — the launch flash, and the dark shimmer at the edges during a resize
    // the renderer has not caught up with.
    expect(
      resolveWindowAppearance({
        platform: "darwin",
        theme: { mode: "light" },
        vibrancy: "none",
      }).backgroundColor,
    ).toBe("#fbfbfb");
    expect(
      resolveWindowAppearance({
        platform: "darwin",
        theme: { mode: "dark" },
        vibrancy: "none",
      }).backgroundColor,
    ).toBe("#1f1f22");
  });

  it("leaves vibrancy off unless it is asked for", () => {
    // Bug this catches: shipping a behind-window blur by default, which makes
    // the compositor resample everything behind the window every frame it moves
    // for a surface that is mostly opaque terminal anyway.
    const appearance = resolveWindowAppearance({
      platform: "darwin",
      theme: { mode: "light" },
      vibrancy: "none",
    });
    expect(appearance.vibrancy).toBeUndefined();
    expect(appearance.transparent).toBe(false);
  });

  it("grants vibrancy only on macOS, where the material exists", () => {
    expect(
      resolveWindowAppearance({
        platform: "darwin",
        theme: { mode: "light" },
        vibrancy: "sidebar",
      }),
    ).toMatchObject({ vibrancy: "sidebar", transparent: true });

    // Bug this catches: a transparent window on a platform with no material
    // behind it — a window with holes in it rather than a blurred sidebar.
    for (const platform of ["win32", "linux", "unknown"] as const) {
      const appearance = resolveWindowAppearance({
        platform,
        theme: { mode: "light" },
        vibrancy: "sidebar",
      });
      expect(appearance.vibrancy, `${platform} was granted a macOS material`).toBeUndefined();
      expect(appearance.transparent, `${platform} was made transparent`).toBe(false);
    }
  });

  it("tells the renderer only when the window actually got the material", () => {
    const off = resolveWindowAppearance({
      platform: "darwin",
      theme: { mode: "light" },
      vibrancy: "none",
    });
    const on = resolveWindowAppearance({
      platform: "darwin",
      theme: { mode: "light" },
      vibrancy: "sidebar",
    });

    // Bug this catches: the renderer makes its sidebar translucent on a window
    // that has no material behind it, so the sidebar shows the desktop through
    // a hole instead of a blur.
    expect(withVibrancyParam("http://127.0.0.1:5173/", off)).toBe("http://127.0.0.1:5173/");
    expect(withVibrancyParam("http://127.0.0.1:5173/", on)).toBe(
      "http://127.0.0.1:5173/?vibrancy=sidebar",
    );

    // The packaged entry is a custom scheme, and it has to survive the round
    // trip intact — a mangled entry URL is a window that loads nothing.
    expect(withVibrancyParam("tmux-ide-renderer://app/index.html", on)).toContain(
      "vibrancy=sidebar",
    );
    expect(withVibrancyParam("tmux-ide-renderer://app/index.html", on)).toContain(
      "tmux-ide-renderer://app/index.html",
    );
  });

  it("reads any unrecognised setting as off rather than failing to start", () => {
    expect(parseVibrancySetting("sidebar")).toBe("sidebar");
    for (const value of [undefined, "", "true", "1", "yes", "window", "SIDEBAR"]) {
      expect(parseVibrancySetting(value), `"${value}" was treated as an opt-in`).toBe("none");
    }
  });
});
