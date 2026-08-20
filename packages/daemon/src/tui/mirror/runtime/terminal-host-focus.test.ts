import { describe, expect, it, vi } from "vitest";

import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";

function client() {
  const authority = {
    generation: "generation-1",
    revision: 11,
    owners: { input: "tui", focus: "tui", geometry: "tui" },
  };
  return {
    getSnapshot: vi.fn(() => ({
      generation: 7,
      phase: "live",
      target: {
        daemon: { instanceId: "daemon-1" },
        workspaceName: "workspace-1",
      },
      authority,
    })),
    setPresence: vi.fn(),
    noteActivity: vi.fn(),
    requestAuthority: vi.fn(async () => null),
    releaseAuthority: vi.fn(async () => authority),
  };
}

describe("OpenTuiTerminalHostFocus", () => {
  it("claims on focused adoption and yields every authority on blur", () => {
    const runtime = client();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(runtime as never);

    expect(runtime.setPresence).toHaveBeenLastCalledWith("foreground");
    expect(runtime.noteActivity).toHaveBeenCalledWith("focus");
    expect(runtime.requestAuthority.mock.calls.map(([kind]) => kind)).toEqual([
      "input",
      "focus",
      "geometry",
    ]);

    focus.blur();
    expect(runtime.releaseAuthority.mock.calls.map(([kind]) => kind)).toEqual([
      "input",
      "focus",
      "geometry",
    ]);
    expect(runtime.setPresence).toHaveBeenLastCalledWith("background");
  });

  it("keeps a replacement background until the renderer regains focus", () => {
    const first = client();
    const second = client();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(first as never);
    focus.blur();
    focus.adopt(second as never);

    expect(second.setPresence).toHaveBeenCalledTimes(1);
    expect(second.setPresence).toHaveBeenCalledWith("background");
    expect(second.requestAuthority).not.toHaveBeenCalled();
    focus.focus();
    expect(second.setPresence).toHaveBeenLastCalledWith("foreground");
    expect(second.requestAuthority).toHaveBeenCalledTimes(3);
  });

  it("records ordered renderer boundaries and settled authority receipts", async () => {
    const runtime = client();
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) => {
      events.push({ phase, details });
    });
    focus.adopt(runtime as never);

    expect(focus.rendererBlur()).toBe(1);
    await vi.waitFor(() => expect(events.at(-1)?.phase).toBe("blur-authority-settled"));
    expect(events.map(({ phase }) => phase)).toEqual([
      "renderer-blur-event",
      "blur-presence",
      "blur-authority-settled",
    ]);
    expect(events[0]?.details).toMatchObject({
      clientGeneration: 7,
      daemonInstanceId: "daemon-1",
      diagnosticEpoch: 1,
      workspaceName: "workspace-1",
    });

    events.length = 0;
    expect(focus.rendererFocus()).toBe(2);
    await vi.waitFor(() => expect(events.at(-1)?.phase).toBe("focus-authority-settled"));
    expect(events.map(({ phase }) => phase)).toEqual([
      "renderer-focus-event",
      "focus-presence",
      "focus-activity",
      "focus-authority-settled",
    ]);
    expect(events.at(-1)?.details).toMatchObject({
      diagnosticEpoch: 2,
      receipts: [
        { authority: "input", granted: false, revision: null },
        { authority: "focus", granted: false, revision: null },
        { authority: "geometry", granted: false, revision: null },
      ],
      status: "fulfilled",
    });
  });

  it("returns one monotonic presentation epoch per accepted renderer transition", () => {
    const focus = new OpenTuiTerminalHostFocus(true, () => undefined);
    focus.adopt(client() as never);
    expect(focus.rendererFocus()).toBeNull();
    expect(focus.rendererBlur()).toBe(1);
    expect(focus.rendererBlur()).toBeNull();
    expect(focus.rendererFocus()).toBe(2);
    expect(focus.rendererBlur()).toBe(3);
    expect(focus.rendererFocus()).toBe(4);
  });

  it("keeps rapid blur and focus settlements causally separated by epoch", async () => {
    let resolveRelease!: (snapshot: {
      generation: string;
      revision: number;
      owners: { input: string | null; focus: string | null; geometry: string | null };
    }) => void;
    let resolveClaim!: () => void;
    const release = new Promise<{
      generation: string;
      revision: number;
      owners: { input: string | null; focus: string | null; geometry: string | null };
    }>((resolve) => {
      resolveRelease = resolve;
    });
    const claim = new Promise<null>((resolve) => {
      resolveClaim = () => resolve(null);
    });
    const runtime = client();
    runtime.releaseAuthority.mockImplementation(() => release);
    runtime.requestAuthority.mockImplementationOnce(async () => null);
    runtime.requestAuthority.mockImplementationOnce(async () => null);
    runtime.requestAuthority.mockImplementationOnce(async () => null);
    runtime.requestAuthority.mockImplementation(() => claim);
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) => {
      events.push({ phase, details });
    });
    focus.adopt(runtime as never);

    focus.rendererBlur();
    focus.rendererFocus();
    resolveClaim();
    await vi.waitFor(() =>
      expect(events.some(({ phase }) => phase === "focus-authority-settled")).toBe(true),
    );
    runtime.getSnapshot.mockReturnValue({
      generation: 8,
      phase: "live",
      target: {
        daemon: { instanceId: "daemon-2" },
        workspaceName: "workspace-2",
      },
      authority: {
        generation: "generation-2",
        revision: 99,
        owners: { input: "replacement", focus: "replacement", geometry: "replacement" },
      },
    });
    resolveRelease({
      generation: "generation-1",
      revision: 12,
      owners: { input: null, focus: null, geometry: null },
    });
    await vi.waitFor(() =>
      expect(events.some(({ phase }) => phase === "blur-authority-settled")).toBe(true),
    );

    const settlements = events.filter(({ phase }) => phase.endsWith("authority-settled"));
    expect(settlements.map(({ phase, details }) => [phase, details.diagnosticEpoch])).toEqual([
      ["focus-authority-settled", 2],
      ["blur-authority-settled", 1],
    ]);
    expect(settlements[0]?.details).toMatchObject({
      clientGeneration: 7,
      daemonInstanceId: "daemon-1",
      workspaceName: "workspace-1",
    });
    expect(settlements[1]?.details).toMatchObject({
      clientGeneration: 7,
      daemonInstanceId: "daemon-1",
      receipts: [
        { authority: "input", generation: "generation-1", revision: 12 },
        { authority: "focus", generation: "generation-1", revision: 12 },
        { authority: "geometry", generation: "generation-1", revision: 12 },
      ],
      workspaceName: "workspace-1",
    });
  });

  it("keeps diagnostics fail-open and does not inspect snapshots when disabled", async () => {
    const runtime = client();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(runtime as never);
    focus.rendererBlur();
    focus.rendererFocus();
    await Promise.resolve();
    expect(runtime.getSnapshot).not.toHaveBeenCalled();

    const throwing = new OpenTuiTerminalHostFocus(false, () => {
      throw new Error("diagnostic sink failed");
    });
    expect(() => throwing.adopt(runtime as never)).not.toThrow();
    expect(runtime.setPresence).toHaveBeenLastCalledWith("background");
  });

  it("reports partial authority settlement and fences a retired client binding", async () => {
    let resolveRelease!: (value: never) => void;
    const pending = new Promise<never>((resolve) => {
      resolveRelease = resolve;
    });
    const first = client();
    first.releaseAuthority.mockImplementationOnce(async () => {
      throw new Error("input release failed");
    });
    first.releaseAuthority.mockImplementationOnce(() => pending);
    first.releaseAuthority.mockImplementationOnce(() => pending);
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) =>
      events.push({ phase, details }),
    );
    focus.adopt(first as never);
    focus.rendererBlur();
    focus.adopt(client() as never);
    resolveRelease({
      generation: "generation-1",
      session: "session-1",
      revision: 12,
      owners: { input: null, focus: null, geometry: null },
    } as never);
    await vi.waitFor(() =>
      expect(events.some(({ phase }) => phase === "blur-authority-settled")).toBe(true),
    );
    expect(events.find(({ phase }) => phase === "blur-authority-settled")?.details).toMatchObject({
      status: "partial",
      bindingCurrent: false,
      receipts: [
        { authority: "input", status: "rejected" },
        { authority: "focus", status: "fulfilled" },
        { authority: "geometry", status: "fulfilled" },
      ],
    });
  });
});
