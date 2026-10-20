// Writes N distinct kitty placeholder frames (transmit + place + placeholder cells)
// as files that play.py streams into a pane at a fixed rate.
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export function png(width, height, frame, noise) {
  const raw = Buffer.alloc(height * (width * 3 + 1));
  let seed = 0x9e3779b9 ^ frame;
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width; x++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = noise ? (seed >>> 24) % noise : 0;
      const ring = Math.floor(Math.hypot(x - width / 2 - frame * 7, y - height / 2) / 6) % 2;
      raw[o++] = ((x * 255) / width + n) & 255;
      raw[o++] = ((y * 255) / height + n) & 255;
      raw[o++] = (ring ? 255 : 90) - n;
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([length, Buffer.from(type), data, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const ESC = "\x1b";
const apc = (control, payload = "") => `${ESC}_G${control};${payload}${ESC}\\`;
const DIACRITICS = "0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357 035B 0363 0364 0365"
  .split(" ")
  .map((hex) => String.fromCodePoint(parseInt(hex, 16)));

export function writeFrames(dir, { count, width, height, columns = 20, rows = 10, noise = 24 }) {
  let pngBytes = 0;
  let sequenceBytes = 0;
  for (let f = 0; f < count; f++) {
    const image = png(width, height, f, noise);
    pngBytes += image.length;
    const base64 = image.toString("base64");
    const parts = Math.ceil(base64.length / 4096);
    const transfer = Array.from({ length: parts }, (_, i) =>
      apc(
        (i === 0 ? "a=t,f=100,i=9,q=2," : "") + (i < parts - 1 ? "m=1" : "m=0"),
        base64.slice(i * 4096, (i + 1) * 4096),
      ),
    ).join("");
    const cells = Array.from(
      { length: rows },
      (_, r) =>
        `${ESC}[${r + 1};1H${ESC}[38;5;9m` +
        Array.from({ length: columns }, (_, c) => "\u{10EEEE}" + DIACRITICS[r] + DIACRITICS[c]).join("") +
        `${ESC}[39m`,
    ).join("");
    const sequence = transfer + apc(`a=p,U=1,i=9,c=${columns},r=${rows},q=2`) + cells;
    sequenceBytes += Buffer.byteLength(sequence);
    writeFileSync(join(dir, `frame-${String(f).padStart(3, "0")}.seq`), sequence);
  }
  return { pngBytes: pngBytes / count, sequenceBytes: sequenceBytes / count };
}
