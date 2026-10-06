/**
 * Turns the figure specs into theme-aware SVG markup for the landing page.
 *
 * Each figure is rendered twice — the app's dark and light themes — and the
 * two renders must agree cell for cell except in colour. Every (light, dark)
 * colour pair becomes one custom property set to `light-dark(...)`, so the
 * figures follow the site's theme toggle with the app's own palettes. All
 * figures live in one cached sprite (docs/public/tui-figures.svg) that the
 * page references with <use>; the "after" frame holds only the cells that
 * change, painted over "before".
 */
import { createHash } from "node:crypto";

import type { CapturedFrame } from "@opentui/core";

import {
  APP_COLS,
  APP_ROWS,
  CROP_COLS,
  CROP_ROWS,
  FIGURES,
  type FigureFrame,
} from "./tui-demo-figures.ts";
import { renderScene, renderShell, type ThemeMode } from "./tui-demo-scene.tsx";
import {
  CELL_HEIGHT,
  CELL_WIDTH,
  FONT_SIZE,
  SCRIM_ALPHA,
  backgrounds,
  cellUnits,
  cells,
  checkGlyphs,
  sameCell,
  text,
  x,
  y,
  type Cell,
  type Grid,
} from "./tui-demo-svg.ts";

export interface FigureMarkup {
  readonly label: string;
  /** Cursor choreography in viewBox units. */
  readonly cursor: readonly (readonly ["click" | "move", number, number])[];
}

export interface FigureDocument {
  readonly width: number;
  readonly height: number;
  /** Page CSS: glyph faces and one custom property per themed colour pair. */
  readonly css: string;
  /** Content-hashed URL of the sprite; `#<variant>-before` / `#<variant>-after`. */
  readonly sprite: string;
  readonly figures: Readonly<Record<string, FigureMarkup>>;
}

export interface FigureOutput {
  readonly document: FigureDocument;
  /** docs/public/tui-figures.svg */
  readonly sprite: string;
}

async function frame(spec: FigureFrame, mode: ThemeMode): Promise<CapturedFrame> {
  return "shell" in spec
    ? renderShell(spec.shell, { cols: APP_COLS, rows: APP_ROWS, mode })
    : renderScene({ ...spec, mode });
}

function crop(grid: Cell[][], [column, row]: readonly [number, number]): Cell[][] {
  return grid.slice(row, row + CROP_ROWS).map((cellsInRow) => {
    const out = cellsInRow.slice(column, column + CROP_COLS);
    if (out.length !== CROP_COLS)
      throw new Error(`figure crop leaves the ${cellsInRow.length}-column frame`);
    return out;
  });
}

/** The changed span of each row, in either theme (with or without the modal scrim). */
function changedSpans(
  after: Cell[][][],
  before: Cell[][][],
): { spans: ([number, number] | null)[]; scrim: number } {
  for (const scrim of [0, SCRIM_ALPHA]) {
    let changed = 0;
    const spans = after[0]!.map((_, row) => {
      let first = Infinity;
      let last = -1;
      after.forEach((grid, mode) => {
        grid[row]!.forEach((cell, column) => {
          if (sameCell(cell, before[mode]![row]![column]!, scrim)) return;
          first = Math.min(first, column);
          last = Math.max(last, column);
        });
      });
      if (last < 0) return null;
      changed += last - first + 1;
      return [first, last] as [number, number];
    });
    if (changed < CROP_COLS * CROP_ROWS * 0.6) return { spans, scrim };
  }
  return { spans: after[0]!.map(() => [0, CROP_COLS - 1]), scrim: 0 };
}

export async function figureDocument(): Promise<FigureOutput> {
  const pairs = new Map<string, string>();
  const key = (light: string, dark: string) => {
    const id = `${light}${dark}`;
    if (!pairs.has(id)) pairs.set(id, `k${pairs.size.toString(36)}`);
    return pairs.get(id)!;
  };
  /** Merge the light and dark grids into one grid of themed colour classes. */
  const themed = (dark: Cell[][], light: Cell[][], label: string): Cell[][] =>
    dark.map((row, r) =>
      row.map((cell, c) => {
        const other = light[r]![c]!;
        if (other.char !== cell.char || other.bold !== cell.bold)
          throw new Error(`${label}: light and dark renders differ at ${c},${r}`);
        return { ...cell, fg: key(other.fg, cell.fg), bg: key(other.bg, cell.bg) };
      }),
    );
  // The sprite is cloned into the page through <use>: page selectors cannot
  // reach the clone, but inherited custom properties and font settings can.
  const paint = (color: string) => `style="fill:var(--${color})"`;

  const figures: Record<string, FigureMarkup> = {};
  const groups: string[] = [];
  for (const spec of FIGURES) {
    const grids = await Promise.all(
      [spec.before, spec.after].flatMap((scene) =>
        (["dark", "light"] as const).map(async (mode) => {
          const grid = crop(cells(await frame(scene, mode)), spec.crop);
          checkGlyphs(`${spec.variant} figure`, grid);
          return grid;
        }),
      ),
    );
    const [beforeDark, beforeLight, afterDark, afterLight] = grids as [
      Cell[][],
      Cell[][],
      Cell[][],
      Cell[][],
    ];
    const before = themed(beforeDark, beforeLight, spec.variant);
    const after = themed(afterDark, afterLight, spec.variant);
    const { spans, scrim } = changedSpans([afterDark, afterLight], [beforeDark, beforeLight]);
    const overlay: Grid = after.map((row, r) =>
      row.map((cell, c) => {
        const span = spans[r];
        return span && c >= span[0] && c <= span[1] ? cell : null;
      }),
    );
    groups.push(
      `<g id="${spec.variant}-before">${[cellUnits(backgrounds(before, null, paint)), ...text(before, paint, false)].join("")}</g>`,
      `<g id="${spec.variant}-after">${[
        ...(scrim
          ? [
              `<rect width="${x(CROP_COLS)}" height="${y(CROP_ROWS)}" fill-opacity="${scrim.toFixed(3)}"/>`,
            ]
          : []),
        cellUnits(backgrounds(overlay, null, paint)),
        ...text(overlay, paint, false),
      ].join("")}</g>`,
    );
    figures[spec.variant] = {
      label: spec.label,
      cursor: spec.cursor.map(([action, column, row]) => [
        action,
        +((column + 0.5) * CELL_WIDTH).toFixed(1),
        +((row + 0.5) * CELL_HEIGHT).toFixed(1),
      ]),
    };
  }

  const sprite = `<svg xmlns="http://www.w3.org/2000/svg"><!-- Landing figures: crops of the tmux-ide app, rendered by \`pnpm demo:tui\`. --><defs>${groups.join("")}</defs></svg>\n`;
  const scope = ".tui-figure";
  const css = [
    `@font-face{font-family:tui-figure;font-weight:400;font-display:block;src:url(/fonts/tui-demo-regular.woff2) format("woff2")}`,
    `@font-face{font-family:tui-figure;font-weight:700;font-display:block;src:url(/fonts/tui-demo-bold.woff2) format("woff2")}`,
    `${scope}{font-family:tui-figure,var(--font-geist-mono),ui-monospace,monospace;font-size:${FONT_SIZE}px;white-space:pre;text-rendering:geometricPrecision;${[
      ...pairs,
    ]
      .map(([id, name]) => `--${name}:light-dark(${id.slice(0, 7)},${id.slice(7)})`)
      .join(";")}}`,
  ].join("\n");
  const hash = createHash("sha256").update(sprite).digest("hex").slice(0, 10);
  return {
    document: {
      width: x(CROP_COLS),
      height: y(CROP_ROWS),
      css,
      sprite: `/tui-figures.svg?v=${hash}`,
      figures,
    },
    sprite,
  };
}
