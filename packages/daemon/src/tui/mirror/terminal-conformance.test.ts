import {
  TERMINAL_CONFORMANCE_FIXTURES,
  XTERM_PALETTE,
  type TerminalConformanceAttribute,
  type TerminalConformanceCell,
  type TerminalConformanceColor,
} from "@tmux-ide/core";
import { describe, expect, it } from "vitest";

import { PaneMirror } from "./pane-mirror.ts";

const DEFAULT_FOREGROUND = 0xdedee6;
const DEFAULT_BACKGROUND = 0x0b0b10;

function arrays(width: number, height: number) {
  return {
    char: new Uint32Array(width * height),
    fg: new Uint16Array(width * height * 4),
    bg: new Uint16Array(width * height * 4),
    attributes: new Uint32Array(width * height),
  };
}

function packed(channels: Uint16Array, cell: number): number {
  const offset = cell * 4;
  return (channels[offset]! << 16) | (channels[offset + 1]! << 8) | channels[offset + 2]!;
}

function resolved(color: TerminalConformanceColor, fallback: number): number {
  if (color.kind === "default") return fallback;
  if (color.kind === "indexed") return XTERM_PALETTE[color.index]!;
  return color.value;
}

const ATTRIBUTE_BITS: Readonly<Record<Exclude<TerminalConformanceAttribute, "inverse">, number>> = {
  bold: 1,
  dim: 2,
  italic: 4,
  underline: 8,
  blink: 16,
  hidden: 64,
  strikethrough: 128,
};

function renderedAttributes(cell: TerminalConformanceCell): number {
  return (cell.attributes ?? []).reduce(
    (mask, attribute) => mask | (attribute === "inverse" ? 0 : ATTRIBUTE_BITS[attribute]),
    0,
  );
}

function renderedColors(cell: TerminalConformanceCell): { foreground: number; background: number } {
  const foreground = resolved(cell.foreground, DEFAULT_FOREGROUND);
  const background = resolved(cell.background, DEFAULT_BACKGROUND);
  return cell.attributes?.includes("inverse")
    ? { foreground: background, background: foreground }
    : { foreground, background };
}

async function waitForParse(mirror: PaneMirror, expected: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mirror.bufferLines().some((line) => line.includes(expected))) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`terminal fixture did not parse ${JSON.stringify(expected)}`);
}

describe("OpenTUI framebuffer terminal conformance", () => {
  for (const fixture of TERMINAL_CONFORMANCE_FIXTURES) {
    it(fixture.description, async () => {
      const mirror = new PaneMirror(fixture.cols, fixture.rows);
      try {
        for (const chunk of fixture.writes) mirror.write(chunk);
        const needle = fixture.cells
          .filter((cell) => cell.width > 0)
          .map((cell) => cell.chars)
          .join("");
        await waitForParse(mirror, needle);

        const buffers = arrays(fixture.cols, fixture.rows);
        const graphemes: Array<{
          x: number;
          y: number;
          chars: string;
          fg: number | null;
          bg: number | null;
          attrs: number;
        }> = [];
        mirror.blit(
          buffers,
          fixture.cols,
          fixture.rows,
          0,
          DEFAULT_FOREGROUND,
          DEFAULT_BACKGROUND,
          { full: true, dirtyRows: [], graphemes },
        );

        for (const expected of fixture.cells) {
          const index = expected.row * fixture.cols + expected.column;
          const colors = renderedColors(expected);
          expect(packed(buffers.fg, index), `${fixture.id} fg ${expected.column}`).toBe(
            colors.foreground,
          );
          expect(packed(buffers.bg, index), `${fixture.id} bg ${expected.column}`).toBe(
            colors.background,
          );
          expect(buffers.attributes[index], `${fixture.id} attrs ${expected.column}`).toBe(
            renderedAttributes(expected),
          );
          if (expected.width === 0) {
            expect(buffers.char[index], `${fixture.id} continuation ${expected.column}`).toBe(0);
          } else {
            expect(buffers.char[index], `${fixture.id} char ${expected.column}`).toBe(
              expected.chars.codePointAt(0),
            );
          }

          if (expected.chars.length > (expected.chars.codePointAt(0)! > 0xffff ? 2 : 1)) {
            const grapheme = graphemes.find(
              (candidate) =>
                candidate.x === expected.column &&
                candidate.y === expected.row &&
                candidate.chars === expected.chars,
            );
            expect(grapheme, `${fixture.id} grapheme ${expected.column}`).toBeDefined();
            // Default colors intentionally stay null until PaneSurface.setCell;
            // compare the effective post-pass colors rather than its compact
            // representation. Explicit inverse colors must already be swapped.
            expect(grapheme!.fg ?? DEFAULT_FOREGROUND).toBe(colors.foreground);
            expect(grapheme!.bg ?? DEFAULT_BACKGROUND).toBe(colors.background);
            expect(grapheme!.attrs).toBe(renderedAttributes(expected));
          }
        }
      } finally {
        mirror.dispose();
      }
    });
  }
});
