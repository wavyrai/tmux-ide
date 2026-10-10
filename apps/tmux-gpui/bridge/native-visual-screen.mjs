import process from "node:process";
import { setInterval } from "node:timers";
// Synthetic one-screen visual specimen. This does not assess rendered pixels.
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export function visualScreen(cols, rows) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 64 ||
    cols > 512 ||
    rows < 20 ||
    rows > 256
  )
    throw new Error("Visual specimen requires 64..512 columns and 20..256 rows");
  const anchors = [
    "GPUI_VISUAL_BEGIN",
    "ASCII |0123456789|ABCDEFGHIJKLMNOPQRSTUVWXYZ|",
    "WIDE |界語| END",
    "COMBINING |e\u0301 A\u030a| END",
    "EMOJI |😀 🚀| END",
    "GPUI_VISUAL_END",
  ];
  const at = (row, text) => `\x1b[${row};1H${text}`;
  const palette = Array.from({ length: 8 }, (_, i) => `\x1b[${40 + i};97m ${i} `).join("");
  const wrap = "WRAP>" + "w".repeat(cols - 5) + "WRAP_END";
  const bytes =
    "\x1b[?7h\x1b[0m\x1b[2J\x1b[H" +
    anchors
      .slice(0, 5)
      .map((s, i) => at(i + 1, s))
      .join("") +
    at(7, "PALETTE " + palette + "\x1b[0m") +
    at(8, "RGB |\x1b[38;2;255;96;32;48;2;16;64;128m TRUECOLOR \x1b[0m| END") +
    at(9, "STYLE |\x1b[1mBOLD\x1b[0m \x1b[3mITALIC\x1b[0m \x1b[4mUNDERLINE\x1b[0m|") +
    at(10, "BLANK |\x1b[48;2;192;32;160m        \x1b[0m| END") +
    at(12, wrap) +
    at(15, anchors[5]) +
    at(17, "CURSOR |X| (cursor on X)") +
    "\x1b[17;9H\x1b[?25h";
  return {
    bytes,
    expected: {
      version: 1,
      cols,
      rows,
      anchors,
      cursor: { x: 8, y: 16, visible: true },
      wrap: { row: 11, width: cols, continuationRow: 12, continuation: "WRAP_END" },
      styledBlank: { row: 9, startColumn: 7, cells: 8, backgroundRGB: [192, 32, 160] },
      rgb: { foreground: [255, 96, 32], background: [16, 64, 128] },
      visualVerdict: "unassessed; compare native screenshot with source evidence",
    },
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const draw = () => {
    try {
      process.stdout.write(visualScreen(process.stdout.columns, process.stdout.rows).bytes);
    } catch {
      process.stdout.write("\x1b[2J\x1b[HVISUAL_SIZE_UNSUPPORTED");
    }
  };
  // The stream emits resize only after refreshing columns/rows for SIGWINCH.
  process.stdout.on("resize", draw);
  process.on("SIGTERM", () => process.exit(0));
  draw();
  setInterval(() => {}, 1000); // Keep only this owned producer alive until fleet disposal.
}
