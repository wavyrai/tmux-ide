import { describe, expect, it, vi } from "vitest";
import { MonotonicPtyInput, validatePtyInputLimits } from "../MonotonicPtyInput.ts";
import { PtyInputRejectedError, type PtyInputLimits } from "../PtyAdapter.ts";

const limits: PtyInputLimits = {
  maxFrameBytes: 4,
  maxAcceptedBytes: 6,
  maxAcceptedFrames: 3,
};

function rejection(run: () => unknown): PtyInputRejectedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PtyInputRejectedError);
    return error as PtyInputRejectedError;
  }
  throw new Error("expected bounded PTY input rejection");
}

describe("MonotonicPtyInput", () => {
  it("snapshots each frame before reserving it and crossing the opaque boundary", () => {
    const held: Buffer[] = [];
    const input = new MonotonicPtyInput(limits, (frame) => held.push(frame));
    const source = Uint8Array.from([0x00, 0x80, 0xff]);

    const receipt = input.write(source);
    source.fill(0x41);

    expect(held).toEqual([Buffer.from([0x00, 0x80, 0xff])]);
    expect(receipt).toMatchObject({
      status: "accepted",
      byteLength: 3,
      snapshot: { state: "open", acceptedBytes: 3, acceptedFrames: 1 },
    });
  });

  it("bounds a fake backend that never drains by monotonic bytes and never calls it after refusal", () => {
    const sink = vi.fn();
    const input = new MonotonicPtyInput(limits, sink);

    input.write(Uint8Array.of(1, 2, 3, 4));
    input.write(Uint8Array.of(5, 6));
    expect(input.snapshot()).toMatchObject({
      state: "exhausted",
      acceptedBytes: 6,
      acceptedFrames: 2,
      remainingBytes: 0,
    });

    const error = rejection(() => input.write(Uint8Array.of(7)));
    expect(error.reason).toBe("lifetime_bytes_exhausted");
    expect(error.snapshot.acceptedBytes).toBe(6);
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("reserves a backend-throwing frame permanently and fails the capability closed", () => {
    const backendError = new Error("opaque writer failed");
    const sink = vi.fn(() => {
      throw backendError;
    });
    const input = new MonotonicPtyInput(limits, sink);

    const first = rejection(() => input.write(Uint8Array.of(1, 2, 3)));
    expect(first.reason).toBe("backend_write_failed");
    expect(first.cause).toBe(backendError);
    expect(first.snapshot).toMatchObject({
      state: "failed",
      acceptedBytes: 3,
      acceptedFrames: 1,
      remainingBytes: 3,
    });

    const second = rejection(() => input.write(Uint8Array.of(4)));
    expect(second.reason).toBe("process_closed");
    expect(second.snapshot.acceptedBytes).toBe(3);
    expect(sink).toHaveBeenCalledOnce();
  });

  it("caps task metadata independently with a lifetime frame count", () => {
    const frameLimits: PtyInputLimits = {
      maxFrameBytes: 4,
      maxAcceptedBytes: 20,
      maxAcceptedFrames: 2,
    };
    const sink = vi.fn();
    const input = new MonotonicPtyInput(frameLimits, sink);

    input.write(Uint8Array.of(1));
    input.write(Uint8Array.of(2));
    const error = rejection(() => input.write(Uint8Array.of(3)));

    expect(error.reason).toBe("lifetime_frames_exhausted");
    expect(error.snapshot).toMatchObject({
      state: "exhausted",
      acceptedBytes: 2,
      acceptedFrames: 2,
      remainingFrames: 0,
    });
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("rejects an oversized frame before copying it into the opaque writer", () => {
    const sink = vi.fn();
    const input = new MonotonicPtyInput(limits, sink);

    const error = rejection(() => input.write(new Uint8Array(5)));

    expect(error.reason).toBe("frame_too_large");
    expect(error.snapshot).toMatchObject({ acceptedBytes: 0, acceptedFrames: 0 });
    expect(sink).not.toHaveBeenCalled();
    expect(rejection(() => input.write(Uint8Array.of(1))).reason).toBe("frame_too_large");
  });

  it("ignores zero bytes without spending byte or frame capacity", () => {
    const sink = vi.fn();
    const input = new MonotonicPtyInput(limits, sink);

    expect(input.write(new Uint8Array())).toMatchObject({ status: "ignored", reason: "empty" });
    expect(input.snapshot()).toMatchObject({ acceptedBytes: 0, acceptedFrames: 0 });
    expect(sink).not.toHaveBeenCalled();
  });

  it("closes permanently without releasing any accepted capacity", () => {
    const input = new MonotonicPtyInput(limits, () => undefined);
    input.write(Uint8Array.of(1, 2));
    input.close();

    const error = rejection(() => input.write(Uint8Array.of(3)));
    expect(error.reason).toBe("process_closed");
    expect(error.snapshot).toMatchObject({
      state: "closed",
      acceptedBytes: 2,
      acceptedFrames: 1,
    });
  });

  it("validates daemon-owned limits before accepting any input", () => {
    expect(() =>
      validatePtyInputLimits({
        maxFrameBytes: 5,
        maxAcceptedBytes: 4,
        maxAcceptedFrames: 1,
      }),
    ).toThrow(/maxFrameBytes/u);
    expect(() => validatePtyInputLimits({ ...limits, maxAcceptedFrames: 0 })).toThrow(
      /maxAcceptedFrames/u,
    );
    expect(() =>
      validatePtyInputLimits({
        maxFrameBytes: 1,
        maxAcceptedBytes: 1,
        maxAcceptedFrames: 16_385,
      }),
    ).toThrow(/maxAcceptedFrames/u);
    expect(validatePtyInputLimits(limits)).toEqual(limits);
  });
});
