import { spawnSync } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { Terminal } from "@tmux-ide/xterm-headless";

/** Exercise the shipped dependency, including its actual native output feed. */
describe("renderer presentation backpressure", () => {
  it("holds one committed frame and paints the latest state when output resumes", async () => {
    const entry = import.meta.resolve("@opentui/core");
    const source = `
      import { Writable, PassThrough } from 'node:stream';
      const { CliRenderer, TextRenderable, CliRenderEvents } = await import(${JSON.stringify(entry)});
      const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
      let hold = false, release;
      const chunks = [];
      const stdout = Object.assign(new Writable({write(chunk, encoding, callback) {
        chunks.push(Buffer.from(chunk));
        if (hold) release = callback;
        else callback();
      }}), {columns: 80, rows: 24, isTTY: false});
      const renderer = new CliRenderer(new PassThrough(), stdout, 80, 24, {
        consoleMode: 'disabled', exitOnCtrlC: false, maxFps: Infinity,
      });
      const text = new TextRenderable(renderer, {id: 'counter', content: 'INITIAL'});
      renderer.root.add(text);
      await renderer.idle();
      await delay(20);
      let frames = 0;
      renderer.on(CliRenderEvents.FRAME, () => frames++);
      hold = true;
      text.content = 'FRAME_0001';
      await delay(20);
      const firstBytes = stdout.writableLength;
      for (let i = 2; i <= 10; i++) {
        text.content = 'FRAME_' + String(i).padStart(4, '0');
        await delay(5);
      }
      const blocked = {firstBytes, queuedBytes: stdout.writableLength, frames};
      hold = false;
      release?.();
      await renderer.idle();
      await delay(25);
      const resumed = {frames, bytes: Buffer.concat(chunks).toString('base64')};
      await delay(25);
      const idleFrames = frames;
      renderer.destroy();
      await delay(20);
      process.stdout.write(JSON.stringify({blocked, resumed, idleFrames}));
    `;
    const child = spawnSync(process.execPath, ["--eval", source], {
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, OTUI_DUMP_CAPTURES: "0", SHOW_CONSOLE: "0" },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const receipt = JSON.parse(child.stdout);
    expect(receipt.blocked.firstBytes).toBeGreaterThan(0);
    expect(receipt.blocked.queuedBytes).toBe(receipt.blocked.firstBytes);
    expect(receipt.blocked.frames).toBe(1);
    expect(receipt.resumed.frames).toBe(2);
    expect(receipt.idleFrames).toBe(2);
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    try {
      await new Promise<void>((resolve) =>
        terminal.write(Buffer.from(receipt.resumed.bytes, "base64"), resolve),
      );
      expect(terminal.buffer.active.getLine(0)?.translateToString(true).trimEnd()).toBe(
        "FRAME_0010",
      );
    } finally {
      terminal.dispose();
    }
  });
});
