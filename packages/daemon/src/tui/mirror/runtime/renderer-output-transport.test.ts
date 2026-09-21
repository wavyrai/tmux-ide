import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const writeSyncMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeSync: writeSyncMock,
}));
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
afterEach(() => {
  if (originalIsTTY) Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  else Reflect.deleteProperty(process.stdout, "isTTY");
  writeSyncMock.mockReset();
});

import { createRendererOutputTransport } from "./renderer-output-transport.ts";

function fixture() {
  const chunks: Buffer[] = [];
  const callbacks: ((error?: Error | null) => void)[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callbacks.push(callback);
    },
  });
  const destination = Object.assign(sink, { columns: 120, rows: 40, isTTY: true });
  return { destination, chunks, callbacks };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("renderer frame output transport", () => {
  it("forwards frame bytes unchanged and waits for the destination before releasing each frame", async () => {
    const { destination, chunks, callbacks } = fixture();
    const { stdout, dispose } = createRendererOutputTransport(destination as NodeJS.WriteStream);
    const accepted = vi.fn();
    const first = Buffer.from("\x1b[?2026hfirst\x1b[?2026l");
    const second = Buffer.from("\x1b[?2026hsecond\x1b[?2026l");
    stdout.write(first, accepted);
    stdout.write(second, accepted);
    expect(chunks).toEqual([first]);
    expect(accepted).not.toHaveBeenCalled();
    callbacks[0]!();
    await tick();
    expect(chunks).toEqual([first, second]);
    expect(accepted).toHaveBeenCalledTimes(1);
    callbacks[1]!();
    await tick();
    expect(accepted).toHaveBeenCalledTimes(2);
    dispose();
  });

  it("propagates backpressure for large frames until the destination completes", async () => {
    const { destination, callbacks } = fixture();
    const { stdout, dispose } = createRendererOutputTransport(destination as NodeJS.WriteStream);
    const drained = vi.fn();
    stdout.on("drain", drained);
    expect(stdout.write(Buffer.alloc(1024 * 1024))).toBe(false);
    expect(drained).not.toHaveBeenCalled();
    callbacks[0]!();
    await tick();
    expect(drained).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("tracks live TTY dimensions and removes only its own listeners without closing host output", async () => {
    const { destination, callbacks } = fixture();
    const otherResize = vi.fn();
    destination.on("resize", otherResize);
    const { stdout, dispose } = createRendererOutputTransport(destination as NodeJS.WriteStream);
    const resized = vi.fn();
    stdout.on("resize", resized);
    destination.columns = 90;
    destination.rows = 30;
    destination.emit("resize");
    expect([stdout.columns, stdout.rows, stdout.isTTY]).toEqual([90, 30, true]);
    expect(resized).toHaveBeenCalledTimes(1);
    // Shutdown output may still be pending when renderer destruction returns.
    const accepted = vi.fn();
    stdout.write("shutdown", accepted);
    dispose();
    dispose();
    expect(destination.destroyed).toBe(false);
    expect(stdout.destroyed).toBe(false);
    callbacks[0]!();
    await tick();
    expect(accepted).toHaveBeenCalledTimes(1);
    destination.emit("resize");
    expect(resized).toHaveBeenCalledTimes(1);
    expect(otherResize).toHaveBeenCalledTimes(2);
    expect(destination.listenerCount("resize")).toBe(1);
    expect(destination.listenerCount("error")).toBe(0);
    stdout.end();
    await tick();
    expect(destination.writableEnded).toBe(false);
  });

  it("preserves write failures instead of acknowledging a lost frame", async () => {
    const { destination, callbacks } = fixture();
    const { stdout, dispose } = createRendererOutputTransport(destination as NodeJS.WriteStream);
    const error = new Error("terminal closed");
    const observed = vi.fn();
    const accepted = vi.fn();
    stdout.on("error", observed);
    stdout.write("frame", accepted);
    callbacks[0]!(error);
    await tick();
    expect(accepted).toHaveBeenCalledWith(error);
    expect(observed).toHaveBeenCalledWith(error);
    dispose();
  });
});

describe("local TTY synchronous frame output", () => {
  function fixtureHost() {
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    return createRendererOutputTransport(process.stdout);
  }

  it("finishes partial writes before acknowledging a frame without writing to real stdout", async () => {
    const written: Buffer[] = [];
    writeSyncMock.mockImplementation(
      (fd: number, bytes: Uint8Array, offset: number, length: number) => {
        expect(fd).toBe(process.stdout.fd);
        const count = Math.min(length, 3);
        written.push(Buffer.from(bytes.subarray(offset, offset + count)));
        return count;
      },
    );
    const { stdout, dispose } = fixtureHost();
    try {
      const frame = Buffer.from("\x1b[?2026hhello\x1b[?2026l");
      const accepted = vi.fn();
      stdout.write(frame, accepted);
      await tick();
      expect(Buffer.concat(written)).toEqual(frame);
      expect(writeSyncMock.mock.calls.length).toBe(Math.ceil(frame.length / 3));
      expect(accepted).toHaveBeenCalledExactlyOnceWith(null);
    } finally {
      dispose();
    }
  });

  it.each(["zero progress", "write error"])("propagates %s and stops writing", async (failure) => {
    const error = new Error("TTY write failed");
    writeSyncMock.mockImplementation(() => {
      if (failure === "write error") throw error;
      return 0;
    });
    const { stdout, dispose } = fixtureHost();
    try {
      const observed = vi.fn();
      const accepted = vi.fn();
      stdout.on("error", observed);
      stdout.write("frame", accepted);
      await tick();
      expect(writeSyncMock).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledTimes(1);
      const reported = accepted.mock.calls[0]![0] as Error;
      expect(observed).toHaveBeenCalledExactlyOnceWith(reported);
      if (failure === "write error") expect(reported).toBe(error);
      else expect(reported.message).toBe("Terminal output made no progress");
    } finally {
      dispose();
    }
  });

  it("writes fewer bytes for repeated styles while retaining cursor motion and synchronization markers", async () => {
    const output: Buffer[] = [];
    writeSyncMock.mockImplementation(
      (_fd: number, bytes: Uint8Array, offset: number, length: number) => {
        output.push(Buffer.from(bytes.subarray(offset, offset + length)));
        return length;
      },
    );
    const { stdout, dispose } = fixtureHost();
    try {
      const style = "\x1b[38;2;222;222;230m\x1b[48;2;11;11;16m";
      const prefix = "\x1b[?2026h\x1b[0m\x1b[1;1H";
      const suffix = "\x1b[0m\x1b[?2026l";
      const original = Buffer.from(
        prefix + style + "first\x1b[0m\x1b[2;1H" + style + "second" + suffix,
      );
      stdout.write(original);
      await tick();
      expect(Buffer.concat(output).toString()).toBe(
        prefix + style + "first\x1b[2;1Hsecond" + suffix,
      );
      expect(Buffer.concat(output).length).toBeLessThan(original.length);
    } finally {
      dispose();
    }
  });
});
