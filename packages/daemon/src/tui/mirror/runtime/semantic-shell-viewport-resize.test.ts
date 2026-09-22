import { describe, expect, it, vi } from "vitest";

import { createSemanticShellViewportResizeOwner } from "./semantic-shell-viewport-resize.ts";

function live(resize: ReturnType<typeof vi.fn>, overrides = {}) {
  return {
    status: "live",
    rendererEpoch: 1,
    daemonGeneration: "00000000-0000-4000-8000-000000000001",
    connection: null,
    client: null,
    authorityClient: null,
    adapter: null,
    fastLane: {
      lane: { resize },
      causalCellLedger: null,
      resourceSampler: null,
      dispose: () => undefined,
    },
    ...overrides,
  } as never;
}

describe("semantic shell viewport resize owner", () => {
  it("replays the applied size when a pending resize reverses back to it", async () => {
    let settleMiddle!: (value: { status: "applied" }) => void;
    const resize = vi
      .fn()
      .mockResolvedValueOnce({ status: "applied" })
      .mockImplementationOnce(
        () => new Promise<{ status: "applied" }>((resolve) => (settleMiddle = resolve)),
      )
      .mockResolvedValue({ status: "applied" });
    const generation = live(resize);
    const owner = createSemanticShellViewportResizeOwner();
    const semantic = {} as never;
    owner.adopt({ width: 160, height: 44 }, semantic, generation);
    await Promise.resolve();
    owner.adopt({ width: 180, height: 44 }, semantic, generation);
    owner.adopt({ width: 160, height: 44 }, semantic, generation);
    expect(resize).toHaveBeenCalledTimes(3);
    expect(resize).toHaveBeenLastCalledWith({ cols: 132, rows: 41 });
    await Promise.resolve();
    // A late receipt for the intermediate size must not replace final truth.
    settleMiddle({ status: "applied" });
    await Promise.resolve();
    owner.adopt({ width: 160, height: 44 }, semantic, generation);
    expect(resize).toHaveBeenCalledTimes(3);
    owner.dispose();
  });

  it("reserves an outer header row only when tmux has no pane status row", async () => {
    let status: "top" | "off" | "bottom" = "off";
    const resize = vi.fn(async () => ({ status: "applied" as const }));
    const owner = createSemanticShellViewportResizeOwner(() => ({
      current: { paneBorderStatus: status },
    }));
    const generation = live(resize);
    owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    expect(resize).toHaveBeenLastCalledWith({ cols: 132, rows: 40 });
    await Promise.resolve();
    status = "top";
    owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    expect(resize).toHaveBeenLastCalledWith({ cols: 132, rows: 41 });
    await Promise.resolve();
    status = "bottom";
    owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    expect(resize).toHaveBeenCalledTimes(2);
    owner.dispose();
  });
  it("waits for semantic authority, dedupes dimensions, and fences generation replacement", () => {
    const firstResize = vi.fn(async () => ({ status: "applied" as const }));
    const secondResize = vi.fn(async () => ({ status: "applied" as const }));
    const first = live(firstResize);
    const second = live(secondResize, {
      rendererEpoch: 2,
      daemonGeneration: "00000000-0000-4000-8000-000000000002",
    });
    const semantic = {} as never;
    const owner = createSemanticShellViewportResizeOwner();

    owner.adopt({ width: 160, height: 44 }, null, first);
    expect(firstResize).not.toHaveBeenCalled();

    owner.adopt({ width: 160, height: 44 }, semantic, first);
    expect(firstResize).toHaveBeenCalledOnce();
    expect(firstResize).toHaveBeenLastCalledWith({ cols: 132, rows: 41 });
    owner.adopt({ width: 160, height: 44 }, semantic, first);
    expect(firstResize).toHaveBeenCalledOnce();

    owner.adopt({ width: 161, height: 44 }, semantic, first);
    expect(firstResize).toHaveBeenCalledTimes(2);
    expect(firstResize).toHaveBeenLastCalledWith({ cols: 133, rows: 41 });

    owner.adopt({ width: 161, height: 44 }, semantic, {
      ...first,
      status: "rebinding",
    } as never);
    expect(firstResize).toHaveBeenCalledTimes(2);
    owner.adopt({ width: 161, height: 44 }, semantic, second);
    expect(firstResize).toHaveBeenCalledTimes(2);
    expect(secondResize).toHaveBeenCalledOnce();
    expect(secondResize).toHaveBeenLastCalledWith({ cols: 133, rows: 41 });

    owner.dispose();
    owner.adopt({ width: 162, height: 44 }, semantic, second);
    expect(secondResize).toHaveBeenCalledOnce();
  });

  it("requires semantic authority again after it disappears", () => {
    const resize = vi.fn(async () => ({ status: "applied" as const }));
    const generation = live(resize);
    const owner = createSemanticShellViewportResizeOwner();
    owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    owner.adopt({ width: 160, height: 44 }, null, generation);
    owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    expect(resize).toHaveBeenCalledTimes(2);
  });

  it("dedupes an in-flight fit but retries the final geometry after a transient refusal", async () => {
    let settleFirst!: (value: { status: "failed" }) => void;
    const resize = vi
      .fn()
      .mockImplementationOnce(
        () => new Promise<{ status: "failed" }>((resolve) => (settleFirst = resolve)),
      )
      .mockResolvedValue({ status: "applied" });
    const generation = live(resize);
    const semantic = {} as never;
    const owner = createSemanticShellViewportResizeOwner();

    owner.adopt({ width: 160, height: 44 }, semantic, generation);
    owner.adopt({ width: 160, height: 44 }, semantic, generation);
    expect(resize).toHaveBeenCalledOnce();

    settleFirst({ status: "failed" });
    await Promise.resolve();
    owner.adopt({ width: 160, height: 44 }, semantic, generation);
    expect(resize).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    owner.adopt({ width: 160, height: 44 }, semantic, generation);
    expect(resize).toHaveBeenCalledTimes(2);
  });
});

describe("scoped semantic shell viewport reconciliation", () => {
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  function setup(resize = vi.fn(async () => ({ status: "applied" as const }))) {
    const windows = [
      { semanticWindowId: "window.top", paneBorderStatus: "top" as const },
      { semanticWindowId: "window.off", paneBorderStatus: "off" as const },
      { semanticWindowId: "window.bottom", paneBorderStatus: "bottom" as const },
    ];
    const layout = { current: windows[0]!, windows: [...windows] };
    const owner = createSemanticShellViewportResizeOwner(() => layout);
    const generation = live(resize);
    const adopt = (width = 160, active = generation) =>
      owner.adopt({ width, height: 44 }, {} as never, active);
    return { owner, layout, resize, generation, adopt };
  }

  it("fits every window once and switches mixed border policies without geometry churn", async () => {
    const rig = setup();
    rig.adopt();
    await settle();
    expect(rig.resize.mock.calls.map(([target]) => target)).toEqual([
      { cols: 132, rows: 40 },
      { semanticWindowId: "window.top", cols: 132, rows: 41 },
      { semanticWindowId: "window.off", cols: 132, rows: 40 },
      { semanticWindowId: "window.bottom", cols: 132, rows: 41 },
    ]);
    for (let i = 0; i < 30; i++) {
      rig.layout.current = rig.layout.windows[i % 3]!;
      rig.adopt();
      await settle();
    }
    expect(rig.resize).toHaveBeenCalledTimes(4);
    rig.owner.dispose();
  });

  it("serializes complete latest geometry through a delayed scoped fit and A B A reversal", async () => {
    let release!: (value: { status: "applied" }) => void;
    const rig = setup();
    rig.adopt();
    await settle();
    rig.resize.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    rig.adopt(180);
    rig.adopt(160);
    expect(rig.resize).toHaveBeenCalledTimes(5);
    release({ status: "applied" });
    await settle();
    expect(rig.resize.mock.calls.slice(5).map(([target]) => target)).toEqual([
      { cols: 132, rows: 40 },
      { semanticWindowId: "window.top", cols: 132, rows: 41 },
      { semanticWindowId: "window.off", cols: 132, rows: 40 },
      { semanticWindowId: "window.bottom", cols: 132, rows: 41 },
    ]);
    rig.owner.dispose();
  });

  it("fits newly known windows without globally resizing resident ones and prunes removed IDs", async () => {
    const rig = setup();
    rig.adopt();
    await settle();
    rig.layout.windows = [{ semanticWindowId: "window.new", paneBorderStatus: "top" }];
    rig.adopt();
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(5);
    expect(rig.resize).toHaveBeenLastCalledWith({
      semanticWindowId: "window.new",
      cols: 132,
      rows: 41,
    });
    rig.layout.windows.push({ semanticWindowId: "window.top", paneBorderStatus: "top" });
    rig.adopt();
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(6);
    rig.owner.dispose();
  });

  it("stops on authority refusal and fences pending continuation across retirement", async () => {
    let release!: (value: { status: "applied" }) => void;
    const rig = setup();
    rig.resize.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    rig.adopt();
    rig.adopt(180, { ...rig.generation, status: "rebinding" } as never);
    release({ status: "applied" });
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(1);
    rig.resize.mockResolvedValueOnce({ status: "geometry-authority-conflict" } as never);
    rig.adopt();
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(2);
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(2);
    rig.adopt();
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(6);
    rig.owner.dispose();
  });

  it("continues newer topology after a removed-window failure and stops after disposal", async () => {
    let release!: (value: { status: "applied" }) => void;
    const rig = setup();
    rig.resize
      .mockResolvedValueOnce({ status: "applied" })
      .mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    rig.adopt();
    await settle();
    rig.layout.windows = [rig.layout.windows[1]!];
    rig.adopt();
    release({ status: "failed" } as never);
    await settle();
    expect(rig.resize).toHaveBeenLastCalledWith({
      semanticWindowId: "window.off",
      cols: 132,
      rows: 40,
    });
    rig.resize.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    rig.adopt(180);
    const count = rig.resize.mock.calls.length;
    rig.owner.dispose();
    release({ status: "applied" });
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(count);
  });
  it("reapplies all scoped fits after same-runtime geometry authority handoff", async () => {
    const rig = setup();
    let listener: ((snapshot: never) => void) | null = null;
    const stop = vi.fn();
    const snapshot = (geometry: string | null) =>
      ({ generation: "00000000-0000-4000-8000-000000000001", owners: { geometry } }) as never;
    const generation = live(rig.resize, {
      authorityClient: {
        authorityIdentity: { clientId: "host" },
        getAuthoritySnapshot: () => snapshot("host"),
        onAuthority: (next: typeof listener) => {
          listener = next;
          return stop;
        },
      },
    });
    rig.adopt(160, generation);
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(4);
    listener!(snapshot("other"));
    rig.adopt(180, generation);
    await settle();
    expect(rig.resize).toHaveBeenCalledTimes(4);
    listener!(snapshot("host"));
    await settle();
    expect(rig.resize.mock.calls.slice(4).map(([target]) => target)).toEqual([
      { cols: 152, rows: 40 },
      { semanticWindowId: "window.top", cols: 152, rows: 41 },
      { semanticWindowId: "window.off", cols: 152, rows: 40 },
      { semanticWindowId: "window.bottom", cols: 152, rows: 41 },
    ]);
    rig.owner.dispose();
    expect(stop).toHaveBeenCalledOnce();
    listener!(snapshot(null));
    expect(rig.resize).toHaveBeenCalledTimes(8);
  });

  it("retires removed scoped targets when an in-flight layout becomes empty", async () => {
    let release!: (value: { status: "applied" }) => void;
    const rig = setup();
    rig.resize.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    rig.adopt();
    rig.layout.windows = [];
    rig.adopt();
    release({ status: "applied" });
    await settle();
    expect(rig.resize.mock.calls.map(([target]) => target)).toEqual([{ cols: 132, rows: 40 }]);
    rig.owner.dispose();
  });
  it("invalidates scoped and fallback caches when layout identity availability changes", async () => {
    let release!: (value: { status: "applied" }) => void;
    let windows: { semanticWindowId: string; paneBorderStatus: "top" }[] | undefined = [
      { semanticWindowId: "window.top", paneBorderStatus: "top" },
    ];
    const resize = vi.fn(async () => ({ status: "applied" as const }));
    resize.mockImplementationOnce(() => new Promise((resolve) => (release = resolve)));
    const owner = createSemanticShellViewportResizeOwner(() => ({
      current: { paneBorderStatus: "top" },
      windows,
    }));
    const generation = live(resize);
    const adopt = () => owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    adopt();
    windows = undefined;
    adopt();
    release({ status: "applied" });
    await settle();
    expect(resize.mock.calls.map(([target]) => target)).toEqual([
      { cols: 132, rows: 40 },
      { cols: 132, rows: 41 },
    ]);
    windows = [{ semanticWindowId: "window.top", paneBorderStatus: "top" }];
    adopt();
    await settle();
    expect(resize.mock.calls.slice(2).map(([target]) => target)).toEqual([
      { cols: 132, rows: 40 },
      { semanticWindowId: "window.top", cols: 132, rows: 41 },
    ]);
    owner.dispose();
  });
});
