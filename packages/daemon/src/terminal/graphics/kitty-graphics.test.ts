import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { parseControlLine } from "../protocol/control.ts";
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
      // Deflated pixels stay deflated end to end; renderers inflate them.
      expect(image).toMatchObject({
        format: compressed ? "rgba-zlib" : "rgba",
        width: 4,
        height: 4,
      });
      expect(Buffer.from(compressed ? inflateSync(image.data) : image.data)).toEqual(rgba);
    }
  });

  it("re-transmitting an id keeps its placements and shows the new pixels", () => {
    const store = new KittyImageStore({ budget: budget() });
    const send = (fill: number) =>
      store.apply(
        parseKittyCommand(
          `Ga=T,f=32,o=z,s=4,v=4,i=0x0a0b0c,U=1,c=8,r=2,q=2;${deflateSync(Buffer.alloc(64, fill)).toString("base64")}`.replace(
            "0x0a0b0c",
            String(0x0a0b0c),
          ),
        )!,
        null,
      );
    send(1);
    const first = store.state(0, 5, 20, false).images[0]!;
    // A plain transmit (no placement keys) must not orphan the placeholder grid.
    store.apply(
      parseKittyCommand(
        `Ga=t,f=32,o=z,s=4,v=4,i=${0x0a0b0c},q=2;${deflateSync(Buffer.alloc(64, 2)).toString("base64")}`,
      )!,
      null,
    );
    const second = store.state(0, 5, 20, false).images[0]!;
    expect(second.placeholder).toEqual({ columns: 8, rows: 2 });
    expect(second.digest).not.toBe(first.digest);
    expect(store.images().size).toBe(1);
  });

  it("deletes only the named placement when p is given", () => {
    const store = new KittyImageStore({ budget: budget() });
    store.apply(
      parseKittyCommand(`Ga=T,f=100,i=5,U=1,c=4,r=2,q=2;${PNG.toString("base64")}`)!,
      null,
    );
    store.apply(parseKittyCommand(`Ga=p,i=5,p=1,c=2,r=1,q=2`)!, {
      x: 0,
      line: 0,
      alternate: false,
    });
    store.apply(parseKittyCommand("Ga=d,d=i,i=5,p=1,q=2")!, null);
    const state = store.state(0, 5, 20, false);
    expect(state.placements).toEqual([]);
    expect(state.images[0]!.placeholder).toEqual({ columns: 4, rows: 2 });
    store.apply(parseKittyCommand("Ga=d,d=I,i=5,p=0,q=2")!, null);
    expect(store.state(0, 5, 20, false).images[0]!.placeholder).toBeNull();
    expect(store.images().size).toBe(1);
    store.apply(parseKittyCommand("Ga=d,d=I,i=5,q=2")!, null);
    expect(store.images().size).toBe(0);
  });

  it("applies root-frame edits by replacing or blending a rectangle", () => {
    const store = new KittyImageStore({ budget: budget() });
    const base = Buffer.alloc(2 * 2 * 4, 0);
    store.apply(
      parseKittyCommand(`Ga=t,f=32,o=z,s=2,v=2,i=302,q=2;${deflateSync(base).toString("base64")}`)!,
      null,
    );
    const before = store.images().get(302)!.digest;
    const patch = Buffer.from([10, 20, 30, 255]);
    store.apply(
      parseKittyCommand(`Ga=f,f=32,i=302,r=1,X=1,x=1,y=1,s=1,v=1,q=2;${patch.toString("base64")}`)!,
      null,
    );
    const edited = store.images().get(302)!;
    expect(edited.digest).not.toBe(before);
    const pixels = inflateSync(edited.data);
    expect([...pixels.subarray(12, 16)]).toEqual([10, 20, 30, 255]);
    expect([...pixels.subarray(0, 12)]).toEqual(Array(12).fill(0));
    // New animation frames (no r) are not modelled and leave the image alone.
    store.apply(
      parseKittyCommand(`Ga=f,f=32,i=302,s=1,v=1,q=2;${patch.toString("base64")}`)!,
      null,
    );
    expect(store.images().get(302)!.digest).toBe(edited.digest);
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
    // A capture reseed with the same coordinate basis keeps cursor placements.
    await interpreter.enqueue({
      type: "reseed",
      cols: 20,
      rows: 6,
      chunks: [Buffer.from(`ab\r\n${ESC}[38;5;9m  ${row(0)}\r\n  ${row(1)}`, "utf8")],
      cursor: { x: 0, y: 3 },
      bootstrap: "painted-capture",
    });
    const after = interpreter.currentGraphics()!;
    expect(after.placements).toEqual([
      expect.objectContaining({ digest, row: 0, column: 2, rows: 1, columns: 2 }),
    ]);
    expect(resolveKittyPlacements(interpreter.currentSnapshot().grid, after)).toEqual([
      expect.objectContaining({ digest, row: 1, column: 2, rows: 2, columns: 3 }),
      expect.objectContaining({ digest, row: 0, column: 2, rows: 1, columns: 2 }),
    ]);
  });
});

describe("chunked image transmissions through %output-sized writes", () => {
  const rowText = (row: { cells: readonly { grapheme: string }[] }) =>
    row.cells
      .map((cell) => cell.grapheme)
      .join("")
      .trimEnd();
  // An m=1 transmission in 4 KiB APC chunks, like real kitty clients send.
  const transmission = (id: number, seed: number) => {
    const raw = Buffer.alloc(30 * 1024);
    for (let i = 0; i < raw.length; i += 1) raw[i] = (i * 31 + seed * 7) & 0xff;
    const payload = raw.toString("base64");
    let wire = "";
    for (let offset = 0; offset < payload.length; offset += 4096) {
      const more = offset + 4096 < payload.length ? 1 : 0;
      const control =
        offset === 0 ? `a=T,f=24,s=128,v=80,i=${id},U=1,c=4,r=2,m=${more}` : `m=${more}`;
      wire += apc(control, payload.slice(offset, offset + 4096));
    }
    return wire;
  };

  it("never forwards image payload as text when tmux splits inside an APC", async () => {
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000002",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000002:0",
      cols: 110,
      rows: 8,
      kittyImageBudget: budget(),
    });
    await interpreter.enqueue({
      type: "reseed",
      cols: 110,
      rows: 8,
      chunks: [],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
    // Several frames, each followed by visible text, cut every 2000 bytes.
    const frames = [1, 2, 3].map((n) => `${transmission(n, n)}${ESC}[H${ESC}[2JFRAME${n}\r\n`);
    for (const frame of frames) {
      const all = bytes(frame);
      for (let start = 0; start < all.length; start += 2000)
        await interpreter.enqueue({ type: "write", data: all.subarray(start, start + 2000) });
      await interpreter.whenIdle();
      const n = frames.indexOf(frame) + 1;
      expect(interpreter.currentSnapshot().grid.map(rowText).filter(Boolean)).toEqual([
        `FRAME${n}`,
      ]);
    }
    await interpreter.enqueue({ type: "write", data: bytes("HELLO\r\n") });
    await interpreter.whenIdle();
    const snapshot = interpreter.currentSnapshot();
    expect([...snapshot.history, ...snapshot.grid].map(rowText).filter(Boolean)).toEqual([
      "FRAME3",
      "HELLO",
    ]);
    expect(interpreter.currentGraphics()!.images).toHaveLength(3);
  });

  it("forwards identical bytes and commands for any chunking", () => {
    let seed = 1;
    const random = (n: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % n;
    const pieces = [
      "text ",
      `${ESC}[1m`,
      `${ESC}${ESC}[0m`,
      apc("a=T,f=100,i=3", PNG.toString("base64")),
      `${ESC}_Xother${ESC}\\`,
      `${ESC}Ptmux;${apc("a=T,f=100,i=4", "QUJD").replaceAll(ESC, ESC + ESC)}${ESC}\\`,
      `${ESC}Pq#0${ESC}\\`,
      "\r\n",
    ];
    for (let round = 0; round < 200; round += 1) {
      const input = bytes(Array.from({ length: 12 }, () => pieces[random(pieces.length)]).join(""));
      const whole = scanAll(new KittyApcScanner(), input, []);
      const cuts = [...new Set(Array.from({ length: 6 }, () => random(input.length + 1)))].sort(
        (a, b) => a - b,
      );
      const split = scanAll(new KittyApcScanner(), input, cuts);
      expect(split.forward).toBe(whole.forward);
      expect(split.commands.map((c) => [c.marker, c.payload])).toEqual(
        whole.commands.map((c) => [c.marker, c.payload]),
      );
    }
  });

  it("returns ordinary output without copying it", () => {
    const scanner = new KittyApcScanner();
    const chunk = bytes(`plain ${ESC}[1mbold${ESC}[0m text\r\n`);
    expect(scanner.scan(chunk).forward).toBe(chunk);
    // A trailing ESC is held for the next chunk, then forwarded with it.
    expect(Buffer.from(scanner.scan(bytes(`x${ESC}`)).forward).toString("latin1")).toBe("x");
    expect(Buffer.from(scanner.scan(bytes("[0my")).forward).toString("latin1")).toBe(`${ESC}[0my`);
  });
});

describe("full-frame kitty-graphics client under tmux (recorded %output)", () => {
  // A client that detects tmux: one image id re-transmitted every frame as a
  // U=1 virtual placement (RGBA, o=z, 4096-byte chunks, each wrapped in
  // DCS tmux;), a placeholder grid with a 24-bit colour id, synchronized
  // output. Recorded from stock tmux 3.7c control mode: 3 frames, 40x12 pane.
  it("resolves the whole grid to the newest frame, kept deflated", async () => {
    const transcript = readFileSync(
      new URL("./__fixtures__/full-frame-client.ctl", import.meta.url),
      "latin1",
    );
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols: 40,
      rows: 12,
      kittyImageBudget: budget(),
    });
    await interpreter.enqueue({
      type: "reseed",
      cols: 40,
      rows: 12,
      chunks: [],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
    const states: TerminalGraphicsState[] = [];
    interpreter.onGraphics((state) => states.push(state));
    for (const line of transcript.split("\n")) {
      const event = parseControlLine(line, false);
      if (event.kind === "output") await interpreter.enqueue({ type: "write", data: event.data });
    }
    await interpreter.whenIdle();
    const state = interpreter.currentGraphics()!;
    expect(state.images).toEqual([
      expect.objectContaining({
        imageId: 0x0a0b0c,
        format: "rgba-zlib",
        width: 320,
        height: 176,
        digest: "9b04b7506552e857ae9345b050de2c4f",
        placeholder: { columns: 40, rows: 11 },
      }),
    ]);
    // Three frames, three distinct digests, the placeholder grid never orphaned.
    expect(new Set(states.map((s) => s.images[0]?.digest)).size).toBe(3);
    expect(states.every((s) => s.images[0]?.placeholder !== null)).toBe(true);
    const placements = resolveKittyPlacements(interpreter.currentSnapshot().grid, state);
    expect(placements).toEqual([
      {
        digest: "9b04b7506552e857ae9345b050de2c4f",
        row: 0,
        column: 0,
        rows: 11,
        columns: 40,
        sourceRow: 0,
        sourceColumn: 0,
        totalRows: 11,
        totalColumns: 40,
      },
    ]);
    // No payload reached the grid as text.
    const text = interpreter
      .currentSnapshot()
      .grid.map((row) => row.cells.map((cell) => cell.grapheme).join(""))
      .join("");
    expect(text).not.toMatch(/[A-Za-z0-9+/]{16}/u);
  });
});

describe("full-frame kitty-graphics client under tmux (real client recording)", () => {
  // Two frames recorded from a real full-frame client through tmux pipe-pane
  // (120x40 cells, 1920x1280 RGBA canvas; media-probe payloads neutralised).
  // Its toolbar, edges and scrollbar are fully transparent pixels.
  it("resolves the placeholder grid and keeps payload out of the grid", async () => {
    const transcript = readFileSync(
      new URL("./__fixtures__/full-frame-client-recorded.ctl", import.meta.url),
      "latin1",
    );
    const interpreter = new TerminalReplicaInterpreter({
      generation: "00000000-0000-4000-8000-000000000001",
      workspaceName: "workspace",
      semanticPaneId: "pane-a",
      incarnation: "00000000-0000-4000-8000-000000000001:0",
      cols: 120,
      rows: 40,
      kittyImageBudget: budget(),
    });
    await interpreter.enqueue({
      type: "reseed",
      cols: 120,
      rows: 40,
      chunks: [],
      cursor: { x: 0, y: 0 },
      bootstrap: "authoritative-stream",
    });
    for (const line of transcript.split("\n")) {
      const event = parseControlLine(line, false);
      if (event.kind === "output") await interpreter.enqueue({ type: "write", data: event.data });
    }
    await interpreter.whenIdle();
    const state = interpreter.currentGraphics()!;
    expect(state.images).toEqual([
      expect.objectContaining({
        imageId: 7424,
        format: "rgba-zlib",
        width: 1920,
        height: 1280,
        placeholder: { columns: 120, rows: 40 },
      }),
    ]);
    const snapshot = interpreter.currentSnapshot();
    expect(snapshot.modes.alternateScreen).toBe(true);
    expect(resolveKittyPlacements(snapshot.grid, state)).toEqual([
      expect.objectContaining({ row: 0, column: 0, rows: 40, columns: 120, totalRows: 40 }),
    ]);
    const pixels = inflateSync(interpreter.kittyImages().images().get(7424)!.data);
    expect(pixels.length).toBe(1920 * 1280 * 4);
    expect(pixels[(20 * 1920 + 300) * 4 + 3]).toBe(0); // transparent toolbar
    const text = snapshot.grid
      .map((row) => row.cells.map((cell) => cell.grapheme).join(""))
      .join("");
    expect(text).not.toMatch(/[A-Za-z0-9+/]{16}/u);
  });
});

describe("cursor placement reseed coordinate safety", () => {
  it.each(["resize", "resize-rows", "live-resize", "history", "alternate", "reset"] as const)(
    "drops cursor anchors on %s",
    async (change) => {
      const interpreter = new TerminalReplicaInterpreter({
        generation: "00000000-0000-4000-8000-000000000001",
        workspaceName: "workspace",
        semanticPaneId: "p",
        incarnation: "00000000-0000-4000-8000-000000000001:0",
        cols: 20,
        rows: 6,
        kittyImageBudget: budget(),
      });
      await interpreter.enqueue({
        type: "write",
        data: bytes(apc("a=T,f=100,i=3,c=2,r=1", PNG.toString("base64"))),
      });
      expect(interpreter.currentGraphics()!.placements).toHaveLength(1);
      if (change === "live-resize")
        await interpreter.enqueue({ type: "resize", cols: 21, rows: 6 });
      await interpreter.enqueue({
        type: "reseed",
        cols: change === "resize" || change === "live-resize" ? 21 : 20,
        rows: change === "resize-rows" ? 7 : 6,
        chunks: [
          bytes(
            change === "history"
              ? "line\r\n".repeat(9)
              : change === "alternate"
                ? "\x1b[?1049h"
                : "",
          ),
        ],
        cursor: { x: 0, y: 0 },
        bootstrap: change === "reset" ? "authoritative-stream" : "painted-capture",
      });
      expect(interpreter.currentGraphics()!.placements).toEqual([]);
      await interpreter.enqueue({ type: "close", reason: "runtime-disposed" });
    },
  );
});

describe("graphics retained resource bounds", () => {
  it("enforces byte quotas after an incompressible root-frame edit", () => {
    const quota = new KittyImageBudget({ perPaneBytes: 1024, globalBytes: 2048 });
    const store = new KittyImageStore({ budget: quota });
    const base = deflateSync(Buffer.alloc(128 * 128 * 4));
    store.apply(
      parseKittyCommand(`Ga=t,i=9,f=32,s=128,v=128,o=z;${base.toString("base64")}`)!,
      null,
    );
    expect(store.images().size).toBe(1);
    let seed = 123456789;
    const patch = Buffer.from(
      Array.from({ length: 128 * 128 * 4 }, () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed & 255;
      }),
    );
    store.apply(
      parseKittyCommand(`Ga=f,i=9,r=1,X=1,f=32,s=128,v=128;${patch.toString("base64")}`)!,
      null,
    );
    expect(store.bytes).toBeLessThanOrEqual(1024);
    expect(quota.totalBytes).toBeLessThanOrEqual(2048);
  });
  it("bounds retained virtual placements and forgets the oldest id", () => {
    const store = new KittyImageStore({ budget: budget() });
    store.apply(parseKittyCommand(`Ga=t,f=100,i=1;${PNG.toString("base64")}`)!, null);
    for (let id = 1; id <= 257; id++)
      store.apply(parseKittyCommand(`Ga=p,U=1,i=1,p=${id},c=2,r=1`)!, null);
    for (let id = 2; id <= 257; id++) store.apply(parseKittyCommand(`Ga=d,d=i,i=1,p=${id}`)!, null);
    expect(store.state(0, 2, 2, false).images[0]!.placeholder).toBeNull();
  });
});
