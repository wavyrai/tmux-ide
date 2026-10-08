import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { CapturedFrame, CapturedSpan } from "@opentui/core";

export interface DemoFrame {
  readonly label: string;
  readonly frame: CapturedFrame;
}

/** Geist Mono: 600/1000 advance, 1005 ascent + 295 descent, drawn at 14px. */
export const FONT_SIZE = 14;
export const CELL_WIDTH = 8.4;
export const CELL_HEIGHT = 18.2;
const BASELINE = 14.07;
/** One working-spinner frame every 80ms, exactly like the app's marker clock. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Under reduced motion the app draws the theme's active glyph instead. */
const SPINNER_STILL = "●";
const FRAME_SECONDS = 4;

const FONT_DIR = resolve(import.meta.dirname, "tui-demo-font");
const FONT_CHARS = new Set(
  [...readFileSync(resolve(FONT_DIR, "chars.txt"), "utf8").replace("\n", "")].concat(" "),
);

function hex(span: CapturedSpan, channel: "fg" | "bg"): string {
  const [red, green, blue] = span[channel].toInts();
  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export const x = (column: number) => +(column * CELL_WIDTH).toFixed(1);
export const y = (row: number) => +(row * CELL_HEIGHT).toFixed(1);

export interface Cell {
  readonly char: string;
  readonly fg: string;
  readonly bg: string;
  readonly bold: boolean;
}

export function cells(frame: CapturedFrame): Cell[][] {
  return frame.lines.map((line) =>
    line.spans.flatMap((span) => {
      const fg = hex(span, "fg");
      const bg = hex(span, "bg");
      const bold = (span.attributes & 1) === 1;
      const chars = [...span.text];
      // Wide glyphs are not used by the shell chrome; keep one char per cell.
      return Array.from({ length: span.width }, (_, index) => ({
        char: chars[index] ?? " ",
        fg,
        bg,
        bold,
      }));
    }),
  );
}

export type Grid = (Cell | null)[][];

/** The app's modal backdrop: black at alpha 150 (MODAL_BACKDROP in theme.ts). */
export const SCRIM_ALPHA = 150 / 255;

function near(left: string, right: string): boolean {
  for (let offset = 1; offset < 7; offset += 2)
    if (
      Math.abs(
        Number.parseInt(left.slice(offset, offset + 2), 16) -
          Number.parseInt(right.slice(offset, offset + 2), 16),
      ) > 1
    )
      return false;
  return true;
}

function dim(color: string, alpha: number): string {
  if (alpha === 0) return color;
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(Number.parseInt(color.slice(offset, offset + 2), 16) * (1 - alpha))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export const sameCell = (a: Cell, b: Cell, alpha: number) =>
  a.char === b.char &&
  a.bold === b.bold &&
  (a.char === " " || near(a.fg, dim(b.fg, alpha))) &&
  near(a.bg, dim(b.bg, alpha));

/**
 * Keep only each row's changed span, so a frame that is the previous frame
 * plus an overlay (the palette) repaints just the overlay.
 */
function overlay(
  grid: Cell[][],
  under: Cell[][],
): { readonly grid: Grid; readonly scrim: number } | null {
  for (const scrim of [0, SCRIM_ALPHA]) {
    let changed = 0;
    const out = grid.map((row, index) => {
      const below = under[index]!;
      const first = row.findIndex((cell, column) => !sameCell(cell, below[column]!, scrim));
      if (first < 0) return row.map(() => null);
      let last = row.length - 1;
      while (sameCell(row[last]!, below[last]!, scrim)) last -= 1;
      changed += last - first + 1;
      return row.map((cell, column) => (column >= first && column <= last ? cell : null));
    });
    if (changed < grid.length * grid[0]!.length * 0.5) return { grid: out, scrim };
  }
  return null;
}

function dominant(grid: Cell[][]): string {
  const counts = new Map<string, number>();
  for (const row of grid)
    for (const cell of row) counts.set(cell.bg, (counts.get(cell.bg) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]![0];
}

/** How a colour is applied: a literal fill, or a themed class for the figures. */
export type Paint = (color: string) => string;
const fill: Paint = (color) => `fill="${color}"`;

/**
 * Background runs, merged across cells and then across identical rows, as one
 * path per colour in cell units (wrap them in `scale(CELL_WIDTH CELL_HEIGHT)`).
 */
export function backgrounds(grid: Grid, base: string | null, paint: Paint = fill): string[] {
  const open = new Map<string, { row: number; rows: number }>();
  const done: { key: string; row: number; rows: number }[] = [];
  grid.forEach((cellsInRow, row) => {
    const keys = new Set<string>();
    for (let start = 0; start < cellsInRow.length; ) {
      const color = cellsInRow[start]?.bg ?? null;
      let end = start + 1;
      while (end < cellsInRow.length && (cellsInRow[end]?.bg ?? null) === color) end += 1;
      if (color && color !== base) keys.add(`${start},${end - start},${color}`);
      start = end;
    }
    for (const [key, run] of open)
      if (!keys.has(key)) {
        done.push({ key, ...run });
        open.delete(key);
      }
    for (const key of keys) {
      const run = open.get(key);
      if (run) run.rows += 1;
      else open.set(key, { row, rows: 1 });
    }
  });
  for (const [key, run] of open) done.push({ key, ...run });
  const paths = new Map<string, string>();
  for (const { key, row, rows } of done) {
    const [start, width, color] = key.split(",") as [string, string, string];
    paths.set(color, `${paths.get(color) ?? ""}M${start} ${row}h${width}v${rows}H${start}z`);
  }
  return [...paths].map(([color, d]) => `<path d="${d}" ${paint(color)}/>`);
}

/** Wrap `backgrounds()` output so its cell units land on the pixel grid. */
export const cellUnits = (paths: readonly string[]) =>
  paths.length ? `<g transform="scale(${CELL_WIDTH} ${CELL_HEIGHT})">${paths.join("")}</g>` : "";

export function text(grid: Grid, paint: Paint = fill, animateSpinner = true): string[] {
  const out: string[] = [];
  const blank = (cell: Cell | null | undefined) => cell?.char === " ";
  const spinning = (char: string) => animateSpinner && SPINNER.includes(char);
  grid.forEach((cellsInRow, row) => {
    for (let start = 0; start < cellsInRow.length; ) {
      const head = cellsInRow[start];
      if (!head || blank(head)) {
        start += 1;
        continue;
      }
      // A run keeps going across single blank cells: a space paints nothing,
      // so the next glyph of the same ink can share this <text>. Wider gaps
      // start a new run, so the markup never depends on whitespace handling
      // (the landing figures are <use> clones, where `white-space` is lost).
      let end = start + 1;
      let last = start;
      while (end < cellsInRow.length) {
        const cell = cellsInRow[end];
        if (!cell) break;
        if (!blank(cell)) {
          if (cell.fg !== head.fg || cell.bold !== head.bold || end - last > 2) break;
          last = end;
        }
        end += 1;
      }
      const chars = cellsInRow.slice(start, last + 1).map((cell) => cell!.char);
      const weight = head.bold ? ' font-weight="700"' : "";
      const plain = chars.map((char) => (spinning(char) ? " " : char)).join("");
      if (plain.trim())
        out.push(
          `<text x="${x(start + plain.search(/\S/u))}" y="${(y(row) + BASELINE).toFixed(1)}" ${paint(head.fg)}${weight}>${escapeXml(plain.trim())}</text>`,
        );
      chars.forEach((char, offset) => {
        if (!spinning(char)) return;
        // Rendered frame is ⠋; the SVG replays the app's full 10-frame cycle.
        out.push(
          `<g class="sp" transform="translate(${x(start + offset)} ${(y(row) + BASELINE).toFixed(1)})"><g ${paint(head.fg)}${weight}>${[
            ...SPINNER,
            SPINNER_STILL,
          ]
            .map((glyph) => `<text>${glyph}</text>`)
            .join("")}</g></g>`,
        );
      });
      start = last + 1;
    }
  });
  return out;
}

/**
 * The working spinner's 10-frame, 80ms cycle; under reduced motion the
 * theme's still glyph (●) shows instead, as in the app. `scope` prefixes
 * every selector so the rules can live in a page stylesheet.
 */
export function spinnerCss(scope: string): string {
  const sp = `${scope}.sp text`;
  return [
    `${sp}{opacity:0;animation:tui-sp .8s steps(1,end) infinite}`,
    ...SPINNER.map(
      (_, index) => `${sp}:nth-child(${index + 1}){animation-delay:${(index * 0.08).toFixed(2)}s}`,
    ),
    `@keyframes tui-sp{0%{opacity:1}10%,100%{opacity:0}}`,
    `${sp}:last-child{animation:none;opacity:0}`,
    `@media (prefers-reduced-motion:reduce){${sp}{animation:none}${sp}:last-child{opacity:1}}`,
  ].join("\n");
}

export function checkGlyphs(label: string, grid: Cell[][]): void {
  for (const row of grid)
    for (const cell of row)
      if (!FONT_CHARS.has(cell.char))
        throw new Error(
          `The ${label} frame draws ${JSON.stringify(cell.char)}, which the embedded demo font ` +
            `lacks. Add it to docs/scripts/tui-demo-font/chars.txt and run \`pnpm demo:font\`.`,
        );
}

export const FONT_FILES = { 400: "regular.woff2", 700: "bold.woff2" } as const;
export const FONT_DIR_PATH = FONT_DIR;

function fontFace(weight: number, file: string): string {
  const data = readFileSync(resolve(FONT_DIR, file)).toString("base64");
  return `@font-face{font-family:d;font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
}

export async function svgDocument(
  frames: readonly DemoFrame[],
  size: { readonly cols: number; readonly rows: number },
  stillFrame: number,
): Promise<string> {
  const grids = frames.map((frame) => cells(frame.frame));
  grids.forEach((grid, index) => checkGlyphs(frames[index]!.label, grid));
  const base = dominant(grids[0]!);
  // A frame either paints the whole screen or overlays the previous frame;
  // a painted frame stays up for its own slot plus its overlays' slots.
  const layers = grids.map((grid, index) => {
    const above = index > 0 ? overlay(grid, grids[index - 1]!) : null;
    return {
      grid: above?.grid ?? grid,
      overlay: above !== null,
      scrim: above?.scrim ?? 0,
      slots: 1,
    };
  });
  for (let index = layers.length - 1; index > 0; index -= 1)
    if (layers[index]!.overlay) layers[index - 1]!.slots += layers[index]!.slots;
  const cycle = frames.length * FRAME_SECONDS;
  const lengths = [...new Set(layers.map((layer) => layer.slots))];
  const keyframes = lengths
    .map(
      (slots) =>
        `@keyframes f${slots}{0%{opacity:1}${((100 * slots) / frames.length).toFixed(2)}%,100%{opacity:0}}`,
    )
    .join("\n");
  const still = new Set([stillFrame]);
  for (let index = stillFrame; layers[index]?.overlay; index -= 1) still.add(index - 1);
  const rules = layers
    .map(
      (layer, index) =>
        `.f${index}{animation:f${layer.slots} ${cycle}s steps(1,end) infinite;animation-delay:${index * FRAME_SECONDS - cycle}s}`,
    )
    .join("\n");
  const body = layers.map(
    (layer, index) =>
      `<g class="f f${index}">${[
        ...(layer.scrim
          ? [`<rect width="100%" height="100%" fill-opacity="${layer.scrim.toFixed(3)}"/>`]
          : []),
        cellUnits(backgrounds(layer.grid, layer.overlay ? null : base)),
        ...text(layer.grid),
      ].join("")}</g>`,
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="t d" width="${x(size.cols)}" height="${y(size.rows)}" viewBox="0 0 ${x(size.cols)} ${y(size.rows)}">
<title id="t">tmux-ide app</title>
<desc id="d">The tmux-ide app cycling through ${frames.map((frame) => frame.label).join(", then ")}: an agent roster on Home, live agent panes with status headers in Terminals, and the command palette.</desc>
<!-- Glyphs: a Geist Mono subset (SIL Open Font License 1.1), renamed as a modified version. -->
<style>
${fontFace(400, "regular.woff2")}
${fontFace(700, "bold.woff2")}
text{font-family:d,ui-monospace,monospace;font-size:${FONT_SIZE}px;white-space:pre;text-rendering:geometricPrecision}
.f{opacity:0}
${rules}
${keyframes}
${spinnerCss("")}
@media (prefers-reduced-motion:reduce){.f{animation:none}${[...still].map((index) => `.f${index}`).join(",")}{opacity:1}}
</style>
<rect width="100%" height="100%" rx="8" fill="${base}"/>
${body.join("\n")}
</svg>
`;
}
