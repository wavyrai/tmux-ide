import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TerminalReplicaInterpreter } from "../session-runtime/terminal-replica-interpreter.ts";
import type { CanonicalTerminalReplicaUpdate } from "@tmux-ide/contracts";
import {
  KITTY_PLACEMENT_OSC,
  KittyApcScanner,
  KittyImageStore,
  decodePlaceholderCell,
  parseKittyCommand,
} from "./kitty-graphics.ts";

const ESC = "\x1b";
const apc = (control: string, payload = "") => `${ESC}_G${control};${payload}${ESC}\\`;
const bytes = (text: string) => Buffer.from(text, "latin1");
// 2x1 PNG (red, green); only IHDR matters to the daemon.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA8J8BAAf/Af8Bf4mnAAAAAElFTkSuQmCC",
  "base64",
);
const PLACEHOLDER = String.fromCodePoint(0x10eeee);
const D = ["̅", "̍", "̎", "̐"];

function scanAll(scanner: KittyApcScanner, input: Uint8Array, split: number[]) {
  const forward: number[] = [];
  const commands = [];
  let start = 0;
  for (const end of [...split, input.length]) {
    const result = scanner.scan(input.subarray(start, end));
    forward.push(...result.forward);
    commands.push(...result.commands);
    start = end;
  }
  return { forward: Buffer.from(forward).toString("latin1"), commands };
}

describe("kitty APC scanner", () => {
  const stream = `a${apc("a=T,f=100,i=7", PNG.toString("base64"))}b${ESC}[1mc${ESC}_Xother${ESC}\\d`;

  it("extracts commands at every split point and leaves other bytes verbatim", () => {
    const input = bytes(stream);
    for (let cut = 0; cut <= input.length; cut += 1) {
      const { forward, commands } = scanAll(new KittyApcScanner(), input, [cut]);
      expect(commands).toHaveLength(1);
      expect(commands[0]!.control.get("i")).toBe("7");
      expect(Buffer.from(commands[0]!.payload, "base64")).toEqual(PNG);
      expect(forward).toBe(`a${ESC}]${KITTY_PLACEMENT_OSC};1\x07b${ESC}[1mc${ESC}_Xother${ESC}\\d`);
    }
  });

  it("unwraps tmux DCS passthrough with doubled ESCs", () => {
    const inner = apc("a=T,f=100,i=10", PNG.toString("base64")).replaceAll(ESC, ESC + ESC);
    const input = bytes(`x${ESC}Ptmux;${inner}${ESC}\\y`);
    for (const cut of [1, 3, 9, input.length - 2, input.length - 1]) {
      const { forward, commands } = scanAll(new KittyApcScanner(), input, [cut]);
      expect(commands.map((c) => c.control.get("i"))).toEqual(["10"]);
      expect(forward).toBe(`x${ESC}]${KITTY_PLACEMENT_OSC};1\x07y`);
    }
  });

  it("parses control keys", () => {
    const command = parseKittyCommand("Ga=T,f=32,s=2,v=1;AAAA")!;
    expect(Object.fromEntries(command.control)).toEqual({ a: "T", f: "32", s: "2", v: "1" });
    expect(command.payload).toBe("AAAA");
    expect(parseKittyCommand("Xa=T")).toBeNull();
  });
});

describe("kitty image store", () => {
  const rgba = Buffer.alloc(4 * 4 * 4, 0xff);

  it("assembles chunked m=1 RGBA transmissions, optionally compressed", () => {
    for (const compressed of [false, true]) {
      const store = new KittyImageStore();
      const data = (compressed ? deflateSync(rgba) : rgba).toString("base64");
      const head = `a=t,f=32,s=4,v=4,i=8,m=1${compressed ? ",o=z" : ""}`;
      store.apply(parseKittyCommand(`G${head};${data.slice(0, 8)}`)!, null);
      store.apply(parseKittyCommand(`Gm=1;${data.slice(8, 16)}`)!, null);
      expect(store.images().size).toBe(0);
      store.apply(parseKittyCommand(`Gm=0;${data.slice(16)}`)!, null);
      const image = store.images().get(8)!;
      expect(image).toMatchObject({ format: "rgba", width: 4, height: 4 });
      expect(Buffer.from(image.data)).toEqual(rgba);
    }
  });

  it("projects cursor placements clipped by scroll and deletes by id", () => {
    const store = new KittyImageStore({ cellWidthPx: 1, cellHeightPx: 1 });
    store.apply(parseKittyCommand(`Ga=T,f=100,i=3,c=4,r=3;${PNG.toString("base64")}`)!, {
      x: 2,
      line: 10,
      alternate: false,
    });
    const grid = Array.from({ length: 5 }, () => ({ cells: [] }));
    // Viewport scrolled so the placement's first row is above row 0.
    expect(store.project(grid, 20, 11, false)).toEqual([
      expect.objectContaining({ id: "kitty:3:1:0:3:4", row: 0, column: 2, rows: 2, columns: 4 }),
    ]);
    expect(store.project(grid, 20, 11, true)).toEqual([]);
    store.apply(parseKittyCommand("Ga=d,d=i,i=3")!, null);
    expect(store.project(grid, 20, 11, false)).toEqual([]);
    expect(store.images().size).toBe(1);
  });

  it("decodes placeholder cells with inherited row and column", () => {
    const fg = { kind: "indexed", index: 9 } as const;
    const first = decodePlaceholderCell(PLACEHOLDER + D[1] + D[2], fg, null)!;
    expect(first).toEqual({ imageId: 9, row: 1, col: 2 });
    expect(decodePlaceholderCell(PLACEHOLDER, fg, first)).toEqual({ imageId: 9, row: 1, col: 3 });
    expect(decodePlaceholderCell("x", fg, first)).toBeNull();
  });
});

describe("interpreter integration", () => {
  it("places a direct image at the parser cursor and a placeholder image from grid text", async () => {
    const updates: CanonicalTerminalReplicaUpdate[] = [];
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols: 20,
      rows: 6,
      onUpdate: (update) => updates.push(update),
    });
    await interpreter.enqueue({
      type: "reseed",
      cols: 20,
      rows: 6,
      chunks: [],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
    const png = PNG.toString("base64");
    const row = (r: number) => [0, 1, 2].map((c) => PLACEHOLDER + D[r] + D[c]).join("");
    const wire =
      `ab${apc("a=T,f=100,i=7,c=2,r=1", png)}\r\n` +
      apc("a=T,f=100,i=9,U=1,c=3,r=2", png) +
      `${ESC}[38;5;9m  ${row(0)}\r\n  ${row(1)}${ESC}[0m\r\n`;
    // Split mid-APC exactly like `%output` line boundaries do.
    const all = Buffer.from(wire, "utf8");
    await interpreter.enqueue({ type: "write", data: all.subarray(0, 17) });
    await interpreter.enqueue({ type: "write", data: all.subarray(17) });
    await interpreter.whenIdle();
    const snapshot = interpreter.currentSnapshot();
    expect(snapshot.placements).toEqual([
      expect.objectContaining({ id: "kitty:7:0:0:1:2", row: 0, column: 2, rows: 1, columns: 2 }),
      expect.objectContaining({ id: "kitty:9:0:0:2:3", row: 1, column: 2, rows: 2, columns: 3 }),
    ]);
    const digest = snapshot.placements[0]!.contentDigest;
    expect(interpreter.kittyImages().imageByDigest(digest)?.format).toBe("png");
    expect(updates.length).toBeGreaterThan(0);
  });
});
