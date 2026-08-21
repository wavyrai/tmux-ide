import { describe, expect, it, vi } from "vitest";
import type { SessionRuntimeAuthorityLease } from "@tmux-ide/contracts";

import { dispatchTerminalInputWithAuthority } from "./terminal-authority-input.ts";

const lease: SessionRuntimeAuthorityLease = {
  generation: "11111111-1111-4111-8111-111111111111",
  session: "alpha",
  clientId: "opentui:test",
  authority: "input",
  token: "22222222-2222-4222-8222-222222222222",
  revision: 1,
};

describe("dispatchTerminalInputWithAuthority", () => {
  it("delivers the immediate key after the explicit focus authority receipt", async () => {
    let resolve!: (value: SessionRuntimeAuthorityLease | null) => void;
    let owned = false;
    const lane = {
      get ownsInput() {
        return owned;
      },
      requestAuthority: vi.fn(
        () => new Promise<SessionRuntimeAuthorityLease | null>((r) => (resolve = r)),
      ),
      noteActivity: vi.fn(),
    };
    const dispatch = vi.fn();
    expect(dispatchTerminalInputWithAuthority({ lane, isCurrent: () => true, dispatch })).toBe(
      "queued",
    );
    expect(dispatch).not.toHaveBeenCalled();
    owned = true;
    resolve(lease);
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(lane.noteActivity).toHaveBeenCalledWith("input");
  });

  it("drops a late receipt after generation replacement", async () => {
    let current = true;
    const lane = {
      ownsInput: false,
      requestAuthority: vi.fn(async () => lease),
      noteActivity: vi.fn(),
    };
    const dispatch = vi.fn();
    dispatchTerminalInputWithAuthority({ lane, isCurrent: () => current, dispatch });
    current = false;
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("preserves a rapid input burst with one authority request", async () => {
    let resolve!: (value: SessionRuntimeAuthorityLease | null) => void;
    let owned = false;
    const lane = {
      get ownsInput() {
        return owned;
      },
      requestAuthority: vi.fn(
        () => new Promise<SessionRuntimeAuthorityLease | null>((r) => (resolve = r)),
      ),
      noteActivity: vi.fn(),
    };
    const received: string[] = [];
    for (const value of ["a", "b", "c", "Enter"]) {
      dispatchTerminalInputWithAuthority({
        lane,
        isCurrent: () => true,
        dispatch: () => received.push(value),
      });
    }
    expect(lane.requestAuthority).toHaveBeenCalledOnce();
    owned = true;
    resolve(lease);
    await Promise.resolve();
    expect(received).toEqual(["a", "b", "c", "Enter"]);
  });

  it("generation-fences a queued burst and ignores disposal failure", async () => {
    let current = true;
    let reject!: (reason?: unknown) => void;
    const lane = {
      ownsInput: false,
      requestAuthority: vi.fn(
        () => new Promise<SessionRuntimeAuthorityLease | null>((_resolve, r) => (reject = r)),
      ),
      noteActivity: vi.fn(),
    };
    const first = vi.fn();
    const repeated = vi.fn();
    const onRejected = vi.fn();
    dispatchTerminalInputWithAuthority({
      lane,
      isCurrent: () => current,
      dispatch: first,
      onRejected,
    });
    dispatchTerminalInputWithAuthority({
      lane,
      isCurrent: () => current,
      dispatch: repeated,
      onRejected,
    });
    expect(lane.requestAuthority).toHaveBeenCalledOnce();
    current = false;
    reject(new Error("retired"));
    await Promise.resolve();
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(repeated).not.toHaveBeenCalled();
    expect(onRejected).not.toHaveBeenCalled();
  });

  it("does not drain when another client wins input before receipt processing", async () => {
    let owned = false;
    const lane = {
      get ownsInput() {
        return owned;
      },
      requestAuthority: vi.fn(async () => lease),
      noteActivity: vi.fn(),
    };
    const dispatch = vi.fn();
    const onRejected = vi.fn();
    dispatchTerminalInputWithAuthority({ lane, isCurrent: () => true, dispatch, onRejected });
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(onRejected).toHaveBeenCalledOnce();
    expect(owned).toBe(false);
  });
});
