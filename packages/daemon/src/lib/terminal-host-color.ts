import type { RendererNeutralColor } from "@tmux-ide/contracts";
import type { ResolvedThemeMode } from "./theme-mode.ts";

function color(red: number, green: number, blue: number): RendererNeutralColor {
  return { space: "srgb", red, green, blue, alpha: 255 };
}

export function parseTerminalHostColor(
  value: string | null | undefined,
): RendererNeutralColor | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  const hex = /^#([\da-f]{3}|[\da-f]{6})$/u.exec(normalized)?.[1];
  if (hex) {
    const expanded =
      hex.length === 3 ? `${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}` : hex;
    return color(
      Number.parseInt(expanded.slice(0, 2), 16),
      Number.parseInt(expanded.slice(2, 4), 16),
      Number.parseInt(expanded.slice(4, 6), 16),
    );
  }
  // OSC palette replies may use X11's rgb:RR/GG/BB form with one to four
  // hexadecimal digits per channel. Scale each channel to a byte rather than
  // truncating high-fidelity replies.
  const x11 = /^rgb:([\da-f]{1,4})\/([\da-f]{1,4})\/([\da-f]{1,4})$/u.exec(normalized);
  if (!x11) return null;
  const channel = (part: string): number => {
    const maximum = 16 ** part.length - 1;
    return Math.round((Number.parseInt(part, 16) / maximum) * 255);
  };
  return color(channel(x11[1]!), channel(x11[2]!), channel(x11[3]!));
}

/** Only a reported default background determines host appearance. */
export function terminalHostMode(background: string | null | undefined): ResolvedThemeMode | null {
  const value = parseTerminalHostColor(background);
  return value
    ? 0.299 * value.red + 0.587 * value.green + 0.114 * value.blue > 127.5
      ? "light"
      : "dark"
    : null;
}
