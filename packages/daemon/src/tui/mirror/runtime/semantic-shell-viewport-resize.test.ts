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
  it("waits for semantic authority, dedupes dimensions, and fences generation replacement", () => {
    const firstResize = vi.fn(async () => "ok" as const);
    const secondResize = vi.fn(async () => "ok" as const);
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
    const resize = vi.fn(async () => "ok" as const);
    const generation = live(resize);
    const owner = createSemanticShellViewportResizeOwner();
    owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    owner.adopt({ width: 160, height: 44 }, null, generation);
    owner.adopt({ width: 160, height: 44 }, {} as never, generation);
    expect(resize).toHaveBeenCalledTimes(2);
  });
});
