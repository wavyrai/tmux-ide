/** The canonical xterm 256-color palette, packed as `0xRRGGBB`. */
export const XTERM_PALETTE: readonly number[] = Object.freeze(buildXtermPalette());

/** The same protocol palette in the CSS form accepted by xterm.js themes. */
export const XTERM_PALETTE_HEX: readonly string[] = Object.freeze(
  XTERM_PALETTE.map((color) => `#${color.toString(16).padStart(6, "0")}`),
);

function buildXtermPalette(): number[] {
  const base = [
    0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5, 0x7f7f7f,
    0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
  ];
  const palette = [...base];
  const levels = [0, 95, 135, 175, 215, 255];
  for (let index = 16; index < 232; index += 1) {
    const offset = index - 16;
    const red = levels[Math.floor(offset / 36)]!;
    const green = levels[Math.floor(offset / 6) % 6]!;
    const blue = levels[offset % 6]!;
    palette.push((red << 16) | (green << 8) | blue);
  }
  for (let index = 232; index < 256; index += 1) {
    const value = 8 + 10 * (index - 232);
    palette.push((value << 16) | (value << 8) | value);
  }
  return palette;
}

/** Packed RGB semantic inputs. Hosts convert their color types at their own boundary. */
export interface VisualTerminalPaletteColors {
  readonly foreground: number;
  readonly background: number;
  readonly danger: number;
  readonly success: number;
  readonly warning: number;
  readonly link: number;
  readonly accent: number;
  readonly info: number;
  readonly secondary: number;
  readonly muted: number;
  readonly bright: number;
}
/** Presentation-only ANSI 0–15 projection; extended xterm colors remain unchanged.
 * Optional already-parsed host colors override only their corresponding first16 slots.
 * The caller owns system-theme eligibility and host color parsing.
 */
export function createVisualTerminalPalette(
  colors: VisualTerminalPaletteColors,
  hostColors?: readonly (number | null | undefined)[],
): readonly number[] {
  const normal = [
    colors.background,
    colors.danger,
    colors.success,
    colors.warning,
    colors.link,
    colors.accent,
    colors.info,
    colors.secondary,
  ];
  const brighten = (color: number): number => {
    const channel = (shift: number) =>
      Math.round(((color >>> shift) & 255) * 0.8 + ((colors.foreground >>> shift) & 255) * 0.2);
    return (channel(16) << 16) | (channel(8) << 8) | channel(0);
  };
  const indexed = [
    ...normal,
    colors.muted,
    ...normal.slice(1, 7).map(brighten),
    colors.bright,
    ...XTERM_PALETTE.slice(16),
  ];
  if (hostColors)
    for (let index = 0; index < 16; index++) {
      const color = hostColors[index];
      if (color !== null && color !== undefined) indexed[index] = color;
    }
  return Object.freeze(indexed);
}
