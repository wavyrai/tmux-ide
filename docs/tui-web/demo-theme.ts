/**
 * One resolved theme for every browser-hosted TUI scene.
 *
 * Keeping the snapshot shared matters for components such as Sidebar: their
 * semantic role lookups must agree with the colors used by the surrounding
 * staged surfaces.
 */
import { DARK_THEME } from "@daemon/tui/mirror/theme.ts";

export const DEMO_THEME = DARK_THEME;
export const DEMO_PANEL_BG = DEMO_THEME.roles.surfaces.panel;
