/** Tiny independent visual oracle for the SSH fixture; no production decoder. */
export type VisualCell = { text: string; width: number; fg: string; bg: string; bold: boolean };
export type VisualFrame = {
  cells: VisualCell[][];
  cursor: { x: number; y: number; visible: boolean };
};
export type CompletedFrame = {
  cols: number;
  rows: number;
  char: number[];
  fg: number[];
  bg: number[];
  attributes: number[];
  text: string;
  cursor: { x: number; y: number; visible: boolean };
};
function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
const blank = (): VisualCell => ({ text: "", width: 1, fg: "ffffff", bg: "000000", bold: false });
export function literalStyledFrame(marker: string, cols: 24 | 40 = 40): VisualFrame {
  check(cols === 24 || cols === 40, "literal geometry");
  check(marker.length <= cols, "marker width");
  const cells = Array.from({ length: 8 }, () => Array.from({ length: cols }, blank));
  [...marker].forEach((text, x) => (cells[0]![x] = { ...blank(), text }));
  const initial = marker === "BEFORE_SSH";
  const glyphs = initial ? ["X", "界", "", "é", "Z"] : ["Y", "q", "", "é", "R"];
  glyphs.forEach(
    (text, x) =>
      (cells[1]![x] = {
        text,
        width: initial ? (x === 1 ? 2 : x === 2 ? 0 : 1) : 1,
        fg: text ? "123456" : "ffffff",
        bg: "214365",
        bold: !!text,
      }),
  );
  for (let x = 0; x < cols; x++)
    cells[3]![x] = { ...blank(), text: x < 2 ? String(x + 1) : "", bg: "445566" };
  return { cells, cursor: { x: 4, y: 2, visible: true } };
}
export function styledBytes(marker: string): string {
  return `\x1b[0m\x1b[2J\x1b[H${marker}\x1b[2;1H\x1b[1;38;2;18;52;86;48;2;33;67;101m${marker === "BEFORE_SSH" ? "X界éZ" : "Yq éR"}\x1b[0m\x1b[4;1H\x1b[48;2;68;85;102m123456\x1b[4;3H\x1b[K\x1b[0m\x1b[3;5H\x1b]2;${marker}\x07`;
}
export function readCompletedFrame(raw: CompletedFrame): VisualFrame {
  check((raw.cols === 24 || raw.cols === 40) && raw.rows === 8, "geometry");
  const size = raw.cols * raw.rows;
  check(
    raw.char.length === size &&
      raw.attributes.length === size &&
      raw.fg.length === size * 4 &&
      raw.bg.length === size * 4,
    "buffer lengths",
  );
  const lines = raw.text.replace(/\n$/u, "").split("\n");
  check(lines.length === 8, "line count");
  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
  const rgb = (a: number[], i: number) => {
    const c = a.slice(i * 4, i * 4 + 4);
    check(
      c.length === 4 && c.every((v) => Number.isInteger(v) && v >= 0 && v <= 255) && c[3] === 255,
      "RGBA",
    );
    return c
      .slice(0, 3)
      .map((v) => v.toString(16).padStart(2, "0"))
      .join("");
  };
  const continuation = (n: number) => n === 0 || n >>> 30 === 3;
  const cells = lines.map((line, y) => {
    const text = [...segmenter.segment(line)].map((s) => s.segment);
    let pos = 0;
    const row = Array.from({ length: raw.cols }, (_, x) => {
      const i = y * raw.cols + x,
        cp = raw.char[i]!;
      const cont =
        continuation(cp) && x > 0 && !continuation(raw.char[i - 1]!) && raw.char[i - 1] !== 32;
      let glyph = "";
      if (cont) {
        if (cp === 0) {
          check(text[pos] === " ", "direct continuation text");
          pos++;
        }
      } else {
        glyph = text[pos++] ?? "";
        check(/^(?:[\x20-\x7e]|界|é)$/u.test(glyph), "unsupported grapheme");
      }
      const width = cont ? 0 : x < raw.cols - 1 && continuation(raw.char[i + 1]!) ? 2 : 1;
      const kind = cp >>> 30;
      if (cont) {
        const prev = raw.char[i - 1]!;
        check(
          prev === 0x754c || (prev >>> 30 === 2 && ((prev >>> 28) & 3) === 1),
          "continuation owner",
        );
        if (kind === 3)
          check(
            ((cp >>> 26) & 3) === 1 &&
              ((cp >>> 28) & 3) === 0 &&
              (cp & 0x03ffffff) === (prev & 0x03ffffff),
            "interned continuation",
          );
      } else if (kind === 0) {
        check(
          cp !== 0 && glyph.codePointAt(0) === cp && [...glyph].length === 1,
          "direct codepoint mismatch",
        );
        check(width === (glyph === "界" ? 2 : 1), "direct width");
      } else if (kind === 2) {
        check(
          glyph === "é" && ((cp >>> 26) & 3) === 0 && ((cp >>> 28) & 3) === 0 && width === 1,
          "interned grapheme shape",
        );
      } else check(false, "unsupported raw char flags");
      const visible = glyph !== " " && glyph !== "";
      check((raw.attributes[i]! & ~1) === 0, "unsupported attributes");
      return {
        text: visible ? glyph : "",
        width,
        fg: visible ? rgb(raw.fg, i) : "ffffff",
        bg: rgb(raw.bg, i),
        bold: visible && (raw.attributes[i]! & 1) !== 0,
      };
    });
    check(pos === text.length, "unconsumed text");
    return row;
  });
  return {
    cells,
    cursor: { x: raw.cursor.x - 1, y: raw.cursor.y - 1, visible: raw.cursor.visible },
  };
}
export function compareVisual(actual: VisualFrame, expected: VisualFrame): void {
  check(JSON.stringify(actual.cursor) === JSON.stringify(expected.cursor), "cursor mismatch");
  check(actual.cells.length === expected.cells.length, "rows mismatch");
  actual.cells.forEach((row, y) => {
    check(row.length === expected.cells[y]!.length, "cols mismatch");
    row.forEach((cell, x) => {
      for (const key of ["text", "width", "fg", "bg", "bold"] as const)
        check(cell[key] === expected.cells[y]![x]![key], `${y}:${x}.${key} mismatch`);
    });
  });
}

export function nativeVisualFrame(frame: {
  cols: number;
  rows: number;
  cursor: number[];
  cells: {
    text: string;
    width: number;
    foreground: string;
    background: string;
    attributes: string[];
  }[][];
}): VisualFrame {
  check((frame.cols === 24 || frame.cols === 40) && frame.rows === 8, "native geometry");
  const color = (value: string, defaultValue: string) => {
    if (value === "default") return defaultValue;
    check(/^rgb:[0-9a-f]{6}$/u.test(value), "native color vocabulary");
    return value.slice(4);
  };
  return {
    cells: frame.cells.map((row) =>
      row.map((c) => {
        const visible = c.text !== "" && c.text !== " ";
        check(
          c.attributes.every((a) => a === "bold"),
          "native attribute vocabulary",
        );
        return {
          text: visible ? c.text : "",
          width: c.width,
          fg: visible ? color(c.foreground, "ffffff") : "ffffff",
          bg: color(c.background, "000000"),
          bold: visible && c.attributes.includes("bold"),
        };
      }),
    ),
    cursor: { x: frame.cursor[0]!, y: frame.cursor[1]!, visible: true },
  };
}

/** Declared workspace chrome: one tab row plus one title row, then eight native rows. */
export function cropWorkspaceCompletedFrame(raw: CompletedFrame): CompletedFrame {
  check((raw.cols === 24 || raw.cols === 40) && raw.rows === 10, "workspace geometry");
  const size = raw.cols * raw.rows;
  check(
    raw.char.length === size &&
      raw.attributes.length === size &&
      raw.fg.length === size * 4 &&
      raw.bg.length === size * 4,
    "workspace buffer lengths",
  );
  const lines = raw.text.replace(/\n$/u, "").split("\n");
  check(lines.length === 10, "workspace line count");
  check(raw.cursor.y >= 3 && raw.cursor.y <= 10, "workspace cursor outside content");
  const offset = 2 * raw.cols;
  return {
    cols: raw.cols,
    rows: 8,
    char: raw.char.slice(offset),
    attributes: raw.attributes.slice(offset),
    fg: raw.fg.slice(offset * 4),
    bg: raw.bg.slice(offset * 4),
    text: lines.slice(2).join("\n"),
    cursor: { ...raw.cursor, y: raw.cursor.y - 2 },
  };
}
