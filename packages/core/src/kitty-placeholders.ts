/**
 * Kitty graphics Unicode placeholders, decoded from replica cells.
 *
 * A program places an image with a `U=1` virtual placement and then prints
 * U+10EEEE cells whose combining diacritics give the image row and column and
 * whose foreground colour gives the image id. To tmux these are ordinary text,
 * so they survive scrolling, history, capture and reattach; renderers derive
 * placements from the cells they already hold and stay in exact sync.
 */
import type {
  TerminalGraphicsPlacement,
  TerminalGraphicsState,
  TerminalReplicaRow,
} from "@tmux-ide/contracts";

export const KITTY_PLACEHOLDER = 0x10eeee;

type KittyCellColor =
  | { readonly kind: "default" }
  | { readonly kind: "indexed"; readonly index: number }
  | { readonly kind: "rgb"; readonly value: number };

// Row/column diacritics for Unicode placeholders, in protocol order (index = value).
const DIACRITICS = [
  "0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357 035B 0363 0364",
  "0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484 0485 0486 0487 0592 0593 0594",
  "0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1 05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612",
  "0613 0614 0615 0616 0617 0657 0658 0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC",
  "06DF 06E0 06E1 06E2 06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741",
  "0743 0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819 081B 081C",
  "081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C 082D 0951 0953 0954 0F82",
  "0F83 0F86 0F87 135D 135E 135F 17DD 193A 1A17 1A75 1A76 1A77 1A78 1A79 1A7A 1A7B 1A7C 1B6B 1B6D",
  "1B6E 1B6F 1B70 1B71 1B72 1B73 1CD0 1CD1 1CD2 1CDA 1CDB 1CE0 1DC0 1DC1 1DC3 1DC4 1DC5 1DC6 1DC7",
  "1DC8 1DC9 1DCB 1DCC 1DD1 1DD2 1DD3 1DD4 1DD5 1DD6 1DD7 1DD8 1DD9 1DDA 1DDB 1DDC 1DDD 1DDE 1DDF",
  "1DE0 1DE1 1DE2 1DE3 1DE4 1DE5 1DE6 1DFE 20D0 20D1 20D4 20D5 20D6 20D7 20DB 20DC 20E1 20E7 20E9",
  "20F0 2CEF 2CF0 2CF1 2DE0 2DE1 2DE2 2DE3 2DE4 2DE5 2DE6 2DE7 2DE8 2DE9 2DEA 2DEB 2DEC 2DED 2DEE",
  "2DEF 2DF0 2DF1 2DF2 2DF3 2DF4 2DF5 2DF6 2DF7 2DF8 2DF9 2DFA 2DFB 2DFC 2DFD 2DFE 2DFF A66F A67C",
  "A67D A6F0 A6F1 A8E0 A8E1 A8E2 A8E3 A8E4 A8E5 A8E6 A8E7 A8E8 A8E9 A8EA A8EB A8EC A8ED A8EE A8EF",
  "A8F0 A8F1 AAB0 AAB2 AAB3 AAB7 AAB8 AABE AABF AAC1 FE20 FE21 FE22 FE23 FE24 FE25 FE26 10A0F 10A38",
  "1D185 1D186 1D187 1D188 1D189 1D1AA 1D1AB 1D1AC 1D1AD 1D242 1D243 1D244",
]
  .join(" ")
  .split(" ");
const DIACRITIC_VALUE = new Map(DIACRITICS.map((hex, index) => [Number.parseInt(hex, 16), index]));

export interface PlaceholderCell {
  imageId: number;
  row: number;
  col: number;
}

/** PURE — decode one cell; null when it is not a placeholder. */
export function decodeKittyPlaceholderCell(
  grapheme: string,
  foreground: KittyCellColor,
  left: PlaceholderCell | null,
): PlaceholderCell | null {
  const points = [...grapheme].map((ch) => ch.codePointAt(0)!);
  if (points[0] !== KITTY_PLACEHOLDER) return null;
  const marks = points.slice(1).map((p) => DIACRITIC_VALUE.get(p));
  let imageId =
    foreground.kind === "indexed"
      ? foreground.index
      : foreground.kind === "rgb"
        ? foreground.value & 0xffffff
        : 0;
  if (marks[2] !== undefined) imageId += marks[2] * 0x1000000;
  const continues = left !== null && (marks[0] === undefined || marks[0] === left.row);
  const row = marks[0] ?? (continues ? left!.row : 0);
  const col = marks[1] ?? (continues ? left!.col + 1 : 0);
  if (marks[2] === undefined && continues && imageId === (left!.imageId & 0xffffff))
    imageId = left!.imageId;
  return { imageId, row, col };
}

export interface PlaceholderRect {
  imageId: number;
  row: number;
  column: number;
  rows: number;
  columns: number;
  srcRow: number;
  srcCol: number;
}

export function kittyPlaceholderRects(
  grid: readonly {
    readonly cells: readonly { readonly grapheme: string; readonly foreground: KittyCellColor }[];
  }[],
): PlaceholderRect[] {
  // Horizontal runs: same image and source row, consecutive source columns.
  const open: PlaceholderRect[] = [];
  const done: PlaceholderRect[] = [];
  for (let y = 0; y < grid.length; y += 1) {
    const runs: PlaceholderRect[] = [];
    let left: PlaceholderCell | null = null;
    let run: PlaceholderRect | null = null;
    const cells = grid[y]!.cells;
    for (let x = 0; x < cells.length; x += 1) {
      const cell = decodeKittyPlaceholderCell(cells[x]!.grapheme, cells[x]!.foreground, left);
      left = cell;
      if (
        cell &&
        run &&
        cell.imageId === run.imageId &&
        cell.row === run.srcRow &&
        cell.col === run.srcCol + run.columns
      ) {
        run.columns += 1;
        continue;
      }
      if (run) runs.push(run);
      run = cell
        ? {
            imageId: cell.imageId,
            row: y,
            column: x,
            rows: 1,
            columns: 1,
            srcRow: cell.row,
            srcCol: cell.col,
          }
        : null;
    }
    if (run) runs.push(run);
    // Merge with the rectangle directly above when it continues the image.
    const stillOpen: PlaceholderRect[] = [];
    for (const candidate of runs) {
      const above = open.find(
        (rect) =>
          rect.imageId === candidate.imageId &&
          rect.column === candidate.column &&
          rect.columns === candidate.columns &&
          rect.srcCol === candidate.srcCol &&
          rect.row + rect.rows === y &&
          rect.srcRow + rect.rows === candidate.srcRow,
      );
      if (above) {
        above.rows += 1;
        open.splice(open.indexOf(above), 1);
        stillOpen.push(above);
      } else stillOpen.push(candidate);
    }
    done.push(...open);
    open.length = 0;
    open.push(...stillOpen);
  }
  done.push(...open);
  return done;
}

/**
 * PURE — every visible image placement for one pane: placeholder rectangles
 * resolved through the pane's image registry, then the daemon's best-effort
 * cursor-anchored placements. Cells naming an unknown image are skipped.
 */
export function resolveKittyPlacements(
  grid: readonly TerminalReplicaRow[],
  state: TerminalGraphicsState,
): TerminalGraphicsPlacement[] {
  const placements: TerminalGraphicsPlacement[] = [];
  const byId = new Map(state.images.map((image) => [image.imageId, image]));
  let scan = false;
  for (const image of state.images) if (image.placeholder) scan = true;
  if (scan) {
    for (const rect of kittyPlaceholderRects(grid)) {
      const image = byId.get(rect.imageId);
      const virtualGrid = image?.placeholder;
      if (!image || !virtualGrid) continue;
      if (
        rect.srcRow + rect.rows > virtualGrid.rows ||
        rect.srcCol + rect.columns > virtualGrid.columns
      )
        continue;
      placements.push({
        digest: image.digest,
        row: rect.row,
        column: rect.column,
        rows: rect.rows,
        columns: rect.columns,
        sourceRow: rect.srcRow,
        sourceColumn: rect.srcCol,
        totalRows: virtualGrid.rows,
        totalColumns: virtualGrid.columns,
      });
    }
  }
  placements.push(...state.placements);
  return placements;
}
