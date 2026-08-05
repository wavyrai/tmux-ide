import type { DesktopPlatform, DesktopThemeState } from "@tmux-ide/contracts";

/**
 * How the native window frame is dressed.
 *
 * Two things the renderer cannot do for itself live here. The first is the
 * window's own background colour: it is painted by the compositor before the
 * renderer has drawn anything and again in every gap the renderer leaves (a
 * resize outrunning paint, the moment between show and first frame). A fixed
 * near-black there is what makes a warm-paper app flash dark on launch and
 * shimmer dark at the edges while dragging, so it follows the appearance.
 *
 * The second is vibrancy — the macOS behind-window blur. It is off by default
 * and opt-in through a setting, because it is not free: a vibrant surface makes
 * the window compositor sample and blur whatever sits behind it every frame the
 * window moves or the content under it changes. On a window that is mostly
 * opaque terminal that cost buys nothing, and on battery it is a real regressor.
 * When it is off, the sidebar keeps its CSS wash and looks like itself.
 */
export type WindowVibrancy = "sidebar" | "none";

export interface WindowAppearance {
  /** Painted by the compositor before and around the renderer's own frames. */
  readonly backgroundColor: string;
  /** `undefined` means "do not ask for vibrancy at all", which is the default. */
  readonly vibrancy: "sidebar" | undefined;
  /** Vibrancy needs a window the blur can show through. */
  readonly transparent: boolean;
}

/**
 * The inset content plane, per appearance, as sRGB.
 *
 * Duplicated from the renderer's token layer by necessity — the main process
 * has no DOM to read a custom property from, and Electron takes a hex string,
 * so the oklch value cannot travel. Keep in step with `--sf-background` in
 * apps/desktop-renderer/src/styles.css: oklch(98.7% 0 0) and
 * oklch(14.05% 0.004 285.8).
 */
const GROUND = Object.freeze({ light: "#fbfbfb", dark: "#1f1f22" });

/** Parse the vibrancy setting. Anything unrecognised means off, never a throw. */
export function parseVibrancySetting(value: string | undefined): WindowVibrancy {
  return value === "sidebar" ? "sidebar" : "none";
}

/** The query parameter the renderer reads to know it may go translucent. */
export const VIBRANCY_PARAM = "vibrancy";

/**
 * Carry the vibrancy decision to the renderer on its entry URL.
 *
 * The renderer has to know, because the translucency is half of the effect: a
 * vibrant window behind an opaque sidebar shows nothing. A startup parameter is
 * the whole channel — no schema version to bump for a setting that is off by
 * default, and no host-injected stylesheet, which would put product colour
 * somewhere other than the token layer.
 */
export function withVibrancyParam(url: string, appearance: WindowAppearance): string {
  if (appearance.vibrancy === undefined) return url;
  const parsed = new URL(url);
  parsed.searchParams.set(VIBRANCY_PARAM, appearance.vibrancy);
  return parsed.toString();
}

export function resolveWindowAppearance(input: {
  readonly platform: DesktopPlatform;
  readonly theme: Pick<DesktopThemeState, "mode">;
  readonly vibrancy: WindowVibrancy;
}): WindowAppearance {
  const backgroundColor = GROUND[input.theme.mode === "dark" ? "dark" : "light"];
  // Vibrancy is a macOS material. Asking for it anywhere else is a no-op at
  // best, and `transparent: true` without it is just a window with holes.
  const vibrant = input.platform === "darwin" && input.vibrancy === "sidebar";
  return Object.freeze({
    backgroundColor,
    vibrancy: vibrant ? "sidebar" : undefined,
    transparent: vibrant,
  });
}
