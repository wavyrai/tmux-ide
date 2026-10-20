import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { TerminalReplicaInterpreter } from "../session-runtime/terminal-replica-interpreter.ts";
import type { TerminalGraphicsState } from "@tmux-ide/contracts";
import {
  KITTY_PLACEMENT_OSC,
  KittyApcScanner,
  KittyImageBudget,
  KittyImageStore,
  parseKittyCommand,
} from "./kitty-graphics.ts";
import { resolveKittyPlacements } from "@tmux-ide/core";

const budget = () => new KittyImageBudget({ perPaneBytes: 1 << 20, globalBytes: 1 << 22 });

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
      const store = new KittyImageStore({ budget: budget() });
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
    const store = new KittyImageStore({ cellWidthPx: 1, cellHeightPx: 1, budget: budget() });
    store.apply(parseKittyCommand(`Ga=T,f=100,i=3,c=4,r=3;${PNG.toString("base64")}`)!, {
      x: 2,
      line: 10,
      alternate: false,
    });
    // Viewport scrolled so the placement's first row is above row 0.
    const state = store.state(11, 5, 20, false);
    expect(state.placements).toEqual([
      expect.objectContaining({
        row: 0,
        column: 2,
        rows: 2,
        columns: 4,
        sourceRow: 1,
        totalRows: 3,
      }),
    ]);
    expect(state.images).toEqual([
      expect.objectContaining({
        imageId: 3,
        format: "png",
        width: 2,
        height: 1,
        placeholder: null,
      }),
    ]);
    expect(store.state(11, 5, 20, true).placements).toEqual([]);
    store.apply(parseKittyCommand("Ga=d,d=i,i=3")!, null);
    expect(store.state(11, 5, 20, false).placements).toEqual([]);
    expect(store.images().size).toBe(1);
    store.apply(parseKittyCommand("Ga=d,d=I,i=3")!, null);
    expect(store.images().size).toBe(0);
  });

  it("records the virtual placement grid for placeholders", () => {
    const store = new KittyImageStore({ budget: budget() });
    store.apply(parseKittyCommand(`Ga=t,f=100,i=9;${PNG.toString("base64")}`)!, null);
    store.apply(parseKittyCommand("Ga=p,U=1,i=9,c=24,r=8")!, null);
    expect(store.state(0, 5, 20, false).images[0]!.placeholder).toEqual({ columns: 24, rows: 8 });
  });

  it("evicts least recently used images within per-pane and global quotas", () => {
    const shared = new KittyImageBudget({ perPaneBytes: 200, globalBytes: 300 });
    const a = new KittyImageStore({ budget: shared });
    const b = new KittyImageStore({ budget: shared });
    const send = (store: KittyImageStore, id: number) =>
      store.apply(
        parseKittyCommand(`Ga=t,f=32,s=5,v=5,i=${id};${Buffer.alloc(100, id).toString("base64")}`)!,
        null,
      );
    send(a, 1);
    send(a, 2);
    send(a, 3); // per-pane: 300 > 200 drops a's oldest
    expect([...a.images().keys()]).toEqual([2, 3]);
    send(b, 4);
    send(b, 5); // global: 400 > 300 drops the oldest across panes (a:2)
    expect([...a.images().keys()]).toEqual([3]);
    expect([...b.images().keys()]).toEqual([4, 5]);
    expect(shared.totalBytes).toBe(300);
    a.dispose();
    expect(shared.totalBytes).toBe(200);
  });
});

describe("interpreter integration", () => {
  it("publishes cursor placements and the placeholder registry; cells resolve placements", async () => {
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols: 20,
      rows: 6,
      kittyImageBudget: budget(),
    });
    const states: TerminalGraphicsState[] = [];
    interpreter.onGraphics((state) => states.push(state));
    await interpreter.enqueue({
      type: "reseed",
      cols: 20,
      rows: 6,
      chunks: [],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
    expect(interpreter.currentGraphics()).toBeNull();
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
    const state = interpreter.currentGraphics()!;
    expect(states.at(-1)).toBe(state);
    expect(interpreter.currentSnapshot().placements).toEqual([]);
    const digest = state.images[0]!.digest;
    expect(resolveKittyPlacements(interpreter.currentSnapshot().grid, state)).toEqual([
      {
        digest,
        row: 1,
        column: 2,
        rows: 2,
        columns: 3,
        sourceRow: 0,
        sourceColumn: 0,
        totalRows: 2,
        totalColumns: 3,
      },
      {
        digest,
        row: 0,
        column: 2,
        rows: 1,
        columns: 2,
        sourceRow: 0,
        sourceColumn: 0,
        totalRows: 1,
        totalColumns: 2,
      },
    ]);
    expect(interpreter.kittyImages().imageByDigest(digest)?.format).toBe("png");
    // A capture reseed keeps placeholder images and drops cursor placements.
    await interpreter.enqueue({
      type: "reseed",
      cols: 20,
      rows: 6,
      chunks: [Buffer.from(`ab\r\n${ESC}[38;5;9m  ${row(0)}\r\n  ${row(1)}`, "utf8")],
      cursor: { x: 0, y: 3 },
      bootstrap: "painted-capture",
    });
    const after = interpreter.currentGraphics()!;
    expect(after.placements).toEqual([]);
    expect(resolveKittyPlacements(interpreter.currentSnapshot().grid, after)).toEqual([
      expect.objectContaining({ digest, row: 1, column: 2, rows: 2, columns: 3 }),
    ]);
  });
});
