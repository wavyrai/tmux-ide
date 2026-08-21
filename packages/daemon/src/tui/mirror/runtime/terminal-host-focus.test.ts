import { describe, expect, it, vi } from "vitest";

import { OpenTuiTerminalHostFocus } from "./terminal-host-focus.ts";

function client() {
  const authority = {
    generation: "generation-1",
    session: "session-1",
    revision: 11,
    owners: { input: "tui", focus: "tui", geometry: "tui" },
    nativeGeometryYieldUntilMs: 0,
    clients: [
      {
        clientId: "tui",
        surface: "opentui" as const,
        state: "foreground" as const,
        connectedRevision: 1,
        activityRevision: 11,
      },
    ],
  };
  return {
    authorityIdentity: {
      generation: "generation-1",
      session: "session-1",
      clientId: "tui",
    },
    getAuthoritySnapshot: vi.fn(() => authority),
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
    requestAuthority: vi.fn(async (kind: "input" | "focus" | "geometry") => ({
      generation: "generation-1",
      session: "session-1",
      clientId: "tui",
      authority: kind,
      revision: 11,
    })),
    releaseAuthority: vi.fn(async () => authority),
    onAuthority: vi.fn((listener: (snapshot: typeof authority) => void) => {
      listener(authority);
      return () => undefined;
    }),
  };
}

describe("OpenTuiTerminalHostFocus", () => {
  it("claims on focused adoption and yields every authority on blur", async () => {
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
    await vi.waitFor(() => expect(runtime.releaseAuthority).toHaveBeenCalledTimes(3));
    expect(runtime.releaseAuthority.mock.calls.map(([kind]) => kind)).toEqual([
      "input",
      "focus",
      "geometry",
    ]);
    expect(runtime.setPresence).toHaveBeenLastCalledWith("background");
  });

  it("keeps a replacement background until the renderer regains focus", async () => {
    const first = client();
    const second = client();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(first as never);
    focus.blur();
    focus.adopt(second as never);

    await vi.waitFor(() => expect(second.setPresence).toHaveBeenCalledTimes(1));
    expect(second.setPresence).toHaveBeenCalledTimes(1);
    expect(second.setPresence).toHaveBeenCalledWith("background");
    expect(second.requestAuthority).not.toHaveBeenCalled();
    focus.focus();
    expect(second.setPresence).toHaveBeenLastCalledWith("foreground");
    expect(second.requestAuthority).toHaveBeenCalledTimes(3);
  });

  it("replays focused authority intent only after the prior runtime releases settle", async () => {
    const runtime = client();
    const operations: string[] = [];
    const releaseResolvers: Array<() => void> = [];
    runtime.releaseAuthority.mockImplementation(
      (authority) =>
        new Promise((resolve) => {
          operations.push(`release:${authority}`);
          releaseResolvers.push(() => resolve(runtime.getSnapshot().authority));
        }),
    );
    runtime.requestAuthority.mockImplementation(async (authority) => {
      operations.push(`claim:${authority}`);
      return {
        generation: "generation-1",
        session: "session-1",
        clientId: "tui",
        authority,
        revision: 11,
      };
    });
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(runtime as never);
    operations.length = 0;

    focus.adopt(null);
    focus.adopt(runtime as never);
    await vi.waitFor(() => expect(releaseResolvers).toHaveLength(3));
    expect(operations).toEqual(["release:input", "release:focus", "release:geometry"]);
    for (const resolve of releaseResolvers) resolve();
    await vi.waitFor(() => expect(runtime.requestAuthority).toHaveBeenCalledTimes(6));
    operations.push("resize");
    operations.push("select");

    expect(operations).toEqual([
      "release:input",
      "release:focus",
      "release:geometry",
      "claim:input",
      "claim:focus",
      "claim:geometry",
      "resize",
      "select",
    ]);
    expect(runtime.requestAuthority).toHaveBeenCalledTimes(6);
  });

  it("applies only the latest replacement after a release-delayed supersession", async () => {
    const first = client();
    const second = client();
    const third = client();
    let settleReleases!: () => void;
    const releases = new Promise<never>((resolve) => {
      settleReleases = () => resolve(first.getSnapshot().authority as never);
    });
    first.releaseAuthority.mockImplementation(() => releases);
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(first as never);

    focus.adopt(null);
    focus.adopt(second as never);
    focus.adopt(third as never);
    expect(second.requestAuthority).not.toHaveBeenCalled();
    expect(third.requestAuthority).not.toHaveBeenCalled();
    settleReleases();

    await vi.waitFor(() => expect(third.requestAuthority).toHaveBeenCalledTimes(3));
    expect(second.requestAuthority).not.toHaveBeenCalled();
    expect(second.setPresence).not.toHaveBeenCalled();
  });

  it("does not reclaim after disposal while replacement releases are pending", async () => {
    const runtime = client();
    let settleReleases!: () => void;
    const releases = new Promise<never>((resolve) => {
      settleReleases = () => resolve(runtime.getSnapshot().authority as never);
    });
    runtime.releaseAuthority.mockImplementation(() => releases);
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(runtime as never);
    const claimsBeforeReplacement = runtime.requestAuthority.mock.calls.length;

    focus.adopt(null);
    focus.adopt(runtime as never);
    focus.dispose();
    settleReleases();
    await Promise.resolve();
    await Promise.resolve();

    expect(runtime.requestAuthority).toHaveBeenCalledTimes(claimsBeforeReplacement);
  });

  it("continues to the current replacement after prior releases reject", async () => {
    const first = client();
    const second = client();
    first.releaseAuthority.mockRejectedValue(new Error("retired runtime closed"));
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(first as never);

    focus.adopt(null);
    focus.adopt(second as never);

    await vi.waitFor(() => expect(second.requestAuthority).toHaveBeenCalledTimes(3));
    expect(second.setPresence).toHaveBeenCalledWith("foreground");
  });

  it("retains the exact renderer-focus diagnostic through a pending runtime handoff", async () => {
    const first = client();
    const second = client();
    let settleReleases!: () => void;
    const releases = new Promise<never>((resolve) => {
      settleReleases = () => resolve(first.getSnapshot().authority as never);
    });
    first.releaseAuthority.mockImplementation(() => releases);
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(false, (phase, details) =>
      events.push({ phase, details }),
    );
    focus.adopt(first as never);
    focus.adopt(null);
    focus.adopt(second as never);

    expect(focus.rendererFocus()).toBe(1);
    expect(second.requestAuthority).not.toHaveBeenCalled();
    expect(events.map(({ phase }) => phase)).toEqual(["renderer-focus-event"]);
    settleReleases();

    await vi.waitFor(() =>
      expect(events.map(({ phase }) => phase)).toEqual([
        "renderer-focus-event",
        "focus-presence",
        "focus-activity",
        "focus-authority-reconcile",
        "focus-authority-settled",
      ]),
    );
    expect(second.requestAuthority.mock.calls.map(([authority]) => authority)).toEqual([
      "input",
      "focus",
      "geometry",
    ]);
    expect(events.at(-1)?.details).toMatchObject({ diagnosticEpoch: 1, bindingCurrent: true });
  });

  it("fences a pending replacement focus diagnostic when blur supersedes it", async () => {
    const first = client();
    const second = client();
    let settleReleases!: () => void;
    const releases = new Promise<never>((resolve) => {
      settleReleases = () => resolve(first.getSnapshot().authority as never);
    });
    first.releaseAuthority.mockImplementation(() => releases);
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(false, (phase, details) =>
      events.push({ phase, details }),
    );
    focus.adopt(first as never);
    focus.adopt(null);
    focus.adopt(second as never);
    expect(focus.rendererFocus()).toBe(1);
    expect(focus.rendererBlur()).toBe(2);
    settleReleases();

    await vi.waitFor(() => expect(second.setPresence).toHaveBeenCalledWith("background"));
    expect(second.requestAuthority).not.toHaveBeenCalled();
    expect(events.map(({ phase }) => phase)).toEqual([
      "renderer-focus-event",
      "renderer-blur-event",
      "blur-presence",
    ]);
  });

  it("keeps a same-client runtime replacement background without claiming authority", async () => {
    const runtime = client();
    const focus = new OpenTuiTerminalHostFocus(true);
    focus.adopt(runtime as never);
    focus.blur();
    const claimsBeforeReplacement = runtime.requestAuthority.mock.calls.length;

    focus.adopt(null);
    focus.adopt(runtime as never);

    await vi.waitFor(() => expect(runtime.setPresence).toHaveBeenLastCalledWith("background"));
    expect(runtime.setPresence).toHaveBeenLastCalledWith("background");
    expect(runtime.requestAuthority).toHaveBeenCalledTimes(claimsBeforeReplacement);
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
      "focus-authority-reconcile",
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
      "focus-authority-reconcile",
      "focus-authority-settled",
    ]);
    expect(events.at(-1)?.details).toMatchObject({
      diagnosticEpoch: 2,
      receipts: [
        { authority: "input", granted: true, revision: 11 },
        { authority: "focus", granted: true, revision: 11 },
        { authority: "geometry", granted: true, revision: 11 },
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
    const release = new Promise<{
      generation: string;
      revision: number;
      owners: { input: string | null; focus: string | null; geometry: string | null };
    }>((resolve) => {
      resolveRelease = resolve;
    });
    const runtime = client();
    runtime.releaseAuthority.mockImplementation(() => release);
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) => {
      events.push({ phase, details });
    });
    focus.adopt(runtime as never);
    await vi.waitFor(() =>
      expect(events.some(({ phase }) => phase === "focus-authority-reconcile")).toBe(true),
    );
    events.length = 0;

    focus.rendererBlur();
    focus.rendererFocus();
    expect(runtime.requestAuthority).toHaveBeenCalledTimes(3);
    resolveRelease({
      generation: "generation-1",
      revision: 12,
      owners: { input: null, focus: null, geometry: null },
    });
    await vi.waitFor(() => expect(runtime.requestAuthority).toHaveBeenCalledTimes(6));
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
    await vi.waitFor(() =>
      expect(events.some(({ phase }) => phase === "blur-authority-settled")).toBe(true),
    );

    const settlements = events.filter(({ phase }) => phase.endsWith("authority-settled"));
    expect(settlements.map(({ phase, details }) => [phase, details.diagnosticEpoch])).toEqual([
      ["blur-authority-settled", 1],
      ["focus-authority-settled", 2],
    ]);
    expect(settlements[0]?.details).toMatchObject({
      clientGeneration: 7,
      daemonInstanceId: "daemon-1",
      bindingCurrent: false,
      receipts: [
        { authority: "input", generation: "generation-1", revision: 12 },
        { authority: "focus", generation: "generation-1", revision: 12 },
        { authority: "geometry", generation: "generation-1", revision: 12 },
      ],
      workspaceName: "workspace-1",
    });
    expect(settlements[1]?.details).toMatchObject({
      clientGeneration: 7,
      daemonInstanceId: "daemon-1",
      bindingCurrent: true,
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

  it("does not apply a partial claim and recovers only after all three exact leases", async () => {
    const runtime = client();
    runtime.requestAuthority.mockImplementation(async (authority) => {
      const attempt = Math.floor((runtime.requestAuthority.mock.calls.length - 1) / 3) + 1;
      if (attempt === 1 && authority !== "geometry") return null;
      return {
        generation: "generation-1",
        session: "session-1",
        clientId: "tui",
        authority,
        revision: 11 + attempt,
      };
    });
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) =>
      events.push({ phase, details }),
    );

    focus.adopt(runtime as never);
    await vi.waitFor(() => expect(runtime.requestAuthority).toHaveBeenCalledTimes(6));

    expect(
      events
        .filter(({ phase }) => phase === "focus-authority-reconcile")
        .map(({ details }) => details.status),
    ).toEqual(["retrying", "applied"]);
    expect(events.filter(({ phase }) => phase === "focus-authority-settled")).toHaveLength(0);
    focus.blur();
    await vi.waitFor(() => expect(runtime.releaseAuthority).toHaveBeenCalledTimes(3));
  });

  it("publishes one bounded failed outcome when every current claim remains partial", async () => {
    const runtime = client();
    runtime.requestAuthority.mockImplementation(async (authority) =>
      authority === "geometry"
        ? {
            generation: "generation-1",
            session: "session-1",
            clientId: "tui",
            authority,
            revision: 12,
          }
        : null,
    );
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) =>
      events.push({ phase, details }),
    );

    focus.adopt(runtime as never);
    await vi.waitFor(() => expect(runtime.requestAuthority).toHaveBeenCalledTimes(9));

    const outcomes = events.filter(({ phase }) => phase === "focus-authority-reconcile");
    expect(outcomes).toHaveLength(3);
    expect(outcomes.at(-1)?.details).toMatchObject({ attempt: 3, status: "failed" });
    expect(events.some(({ phase }) => phase === "focus-authority-settled")).toBe(false);
  });

  it("recovers from one rejected claim without applying the partial attempt", async () => {
    const runtime = client();
    runtime.requestAuthority.mockImplementation(async (authority) => {
      const attempt = Math.floor((runtime.requestAuthority.mock.calls.length - 1) / 3) + 1;
      if (attempt === 1 && authority === "input") throw new Error("authority request timed out");
      return {
        generation: "generation-1",
        session: "session-1",
        clientId: "tui",
        authority,
        revision: 11 + attempt,
      };
    });
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) =>
      events.push({ phase, details }),
    );

    focus.adopt(runtime as never);
    await vi.waitFor(() => expect(runtime.requestAuthority).toHaveBeenCalledTimes(6));

    const outcomes = events.filter(({ phase }) => phase === "focus-authority-reconcile");
    expect(outcomes.map(({ details }) => details.status)).toEqual(["retrying", "applied"]);
    expect(outcomes[0]?.details).toMatchObject({
      receipts: [
        { authority: "input", status: "rejected", granted: false, exact: false },
        { authority: "focus", status: "fulfilled", granted: true, exact: true },
        { authority: "geometry", status: "fulfilled", granted: true, exact: true },
      ],
    });
  });

  it("reconciles an exact authority loss on the same runtime binding", async () => {
    const runtime = client();
    let authorityListener!: Parameters<typeof runtime.onAuthority>[0];
    runtime.onAuthority.mockImplementation((listener) => {
      authorityListener = listener;
      listener(runtime.getSnapshot().authority!);
      return () => undefined;
    });
    const events: Array<{ phase: string; details: Readonly<Record<string, unknown>> }> = [];
    const focus = new OpenTuiTerminalHostFocus(true, (phase, details) =>
      events.push({ phase, details }),
    );
    focus.adopt(runtime as never);
    await vi.waitFor(() =>
      expect(
        events.filter(({ phase }) => phase === "focus-authority-reconcile").at(-1)?.details,
      ).toMatchObject({ status: "applied" }),
    );

    authorityListener({
      generation: "generation-1",
      session: "session-1",
      revision: 12,
      owners: { input: null, focus: "tui", geometry: "tui" },
      nativeGeometryYieldUntilMs: 0,
      clients: [],
    });
    authorityListener(runtime.getSnapshot().authority!);

    await vi.waitFor(() => expect(runtime.requestAuthority).toHaveBeenCalledTimes(6));
    expect(
      events.filter(({ phase }) => phase === "focus-authority-reconcile").at(-1)?.details,
    ).toMatchObject({ status: "applied" });
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
