import { describe, expect, it } from "vitest";

import {
  TERMINAL_FONT_FAMILY,
  TERMINAL_THEME_FALLBACK,
  TERMINAL_THEME_TOKEN,
  resolveTerminalFontFamily,
  resolveTerminalTheme,
  type TerminalTokenReader,
} from "./xterm-renderer.ts";

function readerFrom(values: Record<string, string>): TerminalTokenReader {
  return {
    getPropertyValue(name: string): string {
      return values[name] ?? "";
    },
  };
}

const THEME_ROLES = Object.keys(TERMINAL_THEME_TOKEN) as (keyof typeof TERMINAL_THEME_TOKEN)[];

const DARK_TOKENS: Record<string, string> = {
  "--tmux-ide-terminal-background": "rgb(18 19 26)",
  "--tmux-ide-terminal-foreground": "rgb(230 232 242)",
  "--tmux-ide-terminal-cursor": "rgb(199 212 255)",
  "--tmux-ide-terminal-cursor-accent": "rgb(18 19 26)",
  "--tmux-ide-terminal-selection": "rgb(51 64 107)",
  "--tmux-ide-terminal-ansi-black": "#2a2c37",
  "--tmux-ide-terminal-ansi-red": "#f0748c",
  "--tmux-ide-terminal-ansi-green": "#7fd88f",
  "--tmux-ide-terminal-ansi-yellow": "#e6c67a",
  "--tmux-ide-terminal-ansi-blue": "#8bb4ff",
  "--tmux-ide-terminal-ansi-magenta": "#cba6f7",
  "--tmux-ide-terminal-ansi-cyan": "#7fd4d8",
  "--tmux-ide-terminal-ansi-white": "#cdd0da",
  "--tmux-ide-terminal-ansi-bright-black": "#5c6072",
  "--tmux-ide-terminal-ansi-bright-red": "#ff92a6",
  "--tmux-ide-terminal-ansi-bright-green": "#9ce8a8",
  "--tmux-ide-terminal-ansi-bright-yellow": "#f4d99a",
  "--tmux-ide-terminal-ansi-bright-blue": "#aecbff",
  "--tmux-ide-terminal-ansi-bright-magenta": "#ddc4ff",
  "--tmux-ide-terminal-ansi-bright-cyan": "#a3e8ec",
  "--tmux-ide-terminal-ansi-bright-white": "#f6f8fc",
};

/**
 * A second, deliberately unrelated palette.
 *
 * The shipped terminal palette is one dark machine ground in both app themes
 * (m50.2, gap 2), so this no longer names an appearance. It stays because the
 * claim it proves is about the RESOLVER: every role is read from the token
 * reader it was handed, so a palette change in styles.css reaches xterm without
 * a code change here. A resolver that hardcoded the dark ramp would pass the
 * test above and fail this one.
 */
const ALTERNATE_TOKENS: Record<string, string> = {
  "--tmux-ide-terminal-background": "rgb(255 255 255)",
  "--tmux-ide-terminal-foreground": "rgb(36 37 43)",
  "--tmux-ide-terminal-cursor": "rgb(47 77 143)",
  "--tmux-ide-terminal-cursor-accent": "rgb(255 255 255)",
  "--tmux-ide-terminal-selection": "rgb(205 216 251)",
  "--tmux-ide-terminal-ansi-black": "#2c3542",
  "--tmux-ide-terminal-ansi-red": "#c0435a",
  "--tmux-ide-terminal-ansi-green": "#2f8a5b",
  "--tmux-ide-terminal-ansi-yellow": "#97710f",
  "--tmux-ide-terminal-ansi-blue": "#3a63cf",
  "--tmux-ide-terminal-ansi-magenta": "#8a4fb0",
  "--tmux-ide-terminal-ansi-cyan": "#2f8794",
  "--tmux-ide-terminal-ansi-white": "#c9ccd4",
  "--tmux-ide-terminal-ansi-bright-black": "#6a6f7c",
  "--tmux-ide-terminal-ansi-bright-red": "#d05068",
  "--tmux-ide-terminal-ansi-bright-green": "#3a9b68",
  "--tmux-ide-terminal-ansi-bright-yellow": "#a9821b",
  "--tmux-ide-terminal-ansi-bright-blue": "#4a70de",
  "--tmux-ide-terminal-ansi-bright-magenta": "#9a5fc0",
  "--tmux-ide-terminal-ansi-bright-cyan": "#3a97a4",
  "--tmux-ide-terminal-ansi-bright-white": "#1c2129",
};

describe("resolveTerminalTheme", () => {
  it("derives every xterm theme role from the dark appearance tokens", () => {
    const theme = resolveTerminalTheme(readerFrom(DARK_TOKENS));
    for (const role of THEME_ROLES) {
      expect(theme[role]).toBe(DARK_TOKENS[TERMINAL_THEME_TOKEN[role]]);
    }
  });

  it("derives every role from the tokens it is given, not from a built-in ramp", () => {
    const theme = resolveTerminalTheme(readerFrom(ALTERNATE_TOKENS));
    for (const role of THEME_ROLES) {
      expect(theme[role]).toBe(ALTERNATE_TOKENS[TERMINAL_THEME_TOKEN[role]]);
    }
    expect(theme.background).not.toBe(DARK_TOKENS["--tmux-ide-terminal-background"]);
    expect(theme.foreground).not.toBe(DARK_TOKENS["--tmux-ide-terminal-foreground"]);
  });

  it("supplies a complete theme even when no tokens resolve", () => {
    const theme = resolveTerminalTheme(readerFrom({}));
    for (const role of THEME_ROLES) {
      expect(theme[role]).toBe(TERMINAL_THEME_FALLBACK[role]);
      expect(theme[role]).toMatch(/^#[0-9a-f]{6}$/u);
    }
  });

  it("never emits an empty color for a whitespace-only token", () => {
    const theme = resolveTerminalTheme(readerFrom({ "--tmux-ide-terminal-red": "   " }));
    expect(theme.red).toBe(TERMINAL_THEME_FALLBACK.red);
  });

  it("trims surrounding whitespace from resolved token values", () => {
    const theme = resolveTerminalTheme(
      readerFrom({ "--tmux-ide-terminal-background": "  #010203  " }),
    );
    expect(theme.background).toBe("#010203");
  });
});

describe("resolveTerminalFontFamily", () => {
  it("reads the monospace cascade from the font token", () => {
    const family = resolveTerminalFontFamily(
      readerFrom({ "--tmux-ide-terminal-font-family": '"JetBrains Mono", monospace' }),
    );
    expect(family).toBe('"JetBrains Mono", monospace');
  });

  it("falls back to the built-in monospace cascade when unset", () => {
    expect(resolveTerminalFontFamily(readerFrom({}))).toBe(TERMINAL_FONT_FAMILY);
    expect(TERMINAL_FONT_FAMILY).toMatch(/monospace$/u);
  });
});
