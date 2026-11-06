import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WindowLinkTarget, WindowSplitLayoutResource } from "@tmux-ide/contracts";
import { createStockSplitProbe } from "../../lib/native-split-capability.ts";
import { parseStockSplitOptions } from "../protocol/stock-split-resize.ts";
import { createServerGenerationFencedTmuxRunner } from "../../lib/tmux-server-generation-runner.ts";
import { MirrorControlChannel } from "./control-channel.ts";
import { MirrorService } from "./mirror-service.ts";
import type { MirrorLayoutAuthoritySnapshot } from "./events.ts";

/** Real tmux only. TMUX_IDE_TEST_STOCK_TMUX lists more binaries, separated by `:`. */
function stockBinaries(): string[] {
  const listed = process.env.TMUX_IDE_TEST_STOCK_TMUX?.split(":").filter(Boolean) ?? [];
  const candidates =
    listed.length > 0
      ? listed
      : [spawnSync("which", ["tmux"], { encoding: "utf8" }).stdout?.trim() ?? ""].filter(Boolean);
  return candidates.filter((binary) => {
    const root = mkdtempSync("/tmp/tmi-stock-");
    const socket = join(root, "s");
    try {
      spawnSync(binary, ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "p"]);
      const probe = spawnSync(binary, ["-S", socket, "tmux-ide-resize-split", "-V"], {
        encoding: "utf8",
      });
      spawnSync(binary, ["-S", socket, "kill-server"]);
      return /unknown command/u.test(probe.stderr ?? "");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function server(binary: string) {
  const root = mkdtempSync("/tmp/tmi-stock-");
  const socketPath = join(root, "s");
  const env = { ...process.env, TMUX: "" };
  const tmux = (...args: string[]) =>
    execFileSync(binary, ["-S", socketPath, "-f", "/dev/null", ...args], {
      encoding: "utf8",
      env,
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  tmux("new-session", "-d", "-s", "zz-stock", "-x", "120", "-y", "40", "sleep 300");
  const first = tmux("display-message", "-p", "-t", "zz-stock", "#{pane_id}");
  // The runner the daemon gives its mirror, so its errors have their real shape.
  const pinned = createServerGenerationFencedTmuxRunner({
    executablePath: binary,
    socketSelector: { kind: "path", path: socketPath },
  } as Parameters<typeof createServerGenerationFencedTmuxRunner>[0]);
  const mirror = new MirrorService({
    socketPath,
    executable: binary,
    splitLayoutPrepare: async () => false,
    splitLayoutStock: createStockSplitProbe({ runPinnedTmux: pinned }),
    createIo: (session, handlers) =>
      new MirrorControlChannel({
        session,
        handlers,
        socketPath,
        configFile: "/dev/null",
        executable: binary,
      }),
  } as ConstructorParameters<typeof MirrorService>[0]);
  cleanups.push(async () => {
    mirror.dispose();
    try {
      tmux("kill-server");
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { tmux, mirror, first, pinned };
}

async function open(rig: Awaited<ReturnType<typeof server>>) {
  const identity = await rig.mirror.describeSessionAuthority("zz-stock");
  await rig.mirror.retainSession("zz-stock");
  const snapshots: MirrorLayoutAuthoritySnapshot[] = [];
  await rig.mirror.subscribeLayout("zz-stock", () => {}, {
    expectedRuntimeSessionId: identity.runtimeSessionId,
    expectedSemanticPaneIds: identity.description.panes.map((pane) => pane.semanticPaneId),
    onAuthority: (snapshot) => snapshots.push(snapshot),
  });
  const target = (): WindowLinkTarget => {
    const topology = snapshots.at(-1)!.windowLinks;
    const link = topology.links[0]!;
    return {
      liveSessionId: topology.liveSessionId,
      linkId: link.linkId,
      linkRevision: topology.linkRevision,
      expectedSemanticWindowId: link.semanticWindowId,
    };
  };
  return { target };
}

const geometry = (rig: Awaited<ReturnType<typeof server>>, flag: "left" | "top" = "left") =>
  rig
    .tmux(
      "list-panes",
      "-t",
      "zz-stock",
      "-F",
      flag === "left"
        ? "#{pane_id}:#{pane_left}+#{pane_width}"
        : "#{pane_id}:#{pane_top}+#{pane_height}",
    )
    .split("\n");

function split(resource: WindowSplitLayoutResource, axis: "cols" | "rows", boundary?: number) {
  const found = resource.splits.find(
    (row) => row.axis === axis && (boundary === undefined || row.boundary === boundary),
  );
  expect(found).toBeDefined();
  return found!;
}

const binaries = stockBinaries();
it.skipIf(binaries.length > 0)("needs a stock tmux on PATH or in TMUX_IDE_TEST_STOCK_TMUX", () => {
  expect(binaries).toEqual([]);
});
describe.skipIf(binaries.length === 0).each(binaries)("stock tmux %s", (binary) => {
  it("reads the layout and moves one boundary, with a successor from the published layout", async () => {
    const rig = await server(binary);
    rig.tmux("split-window", "-d", "-h", "-t", rig.first, "sleep 300");
    const { target } = await open(rig);
    let window = target();
    await vi.waitFor(async () => {
      window = target();
      expect(await rig.mirror.readWindowSplitLayout("zz-stock", window)).toBeDefined();
    });
    const resource = await rig.mirror.readWindowSplitLayout("zz-stock", window);
    expect(resource.panes).toHaveLength(2);
    const edge = split(resource, "cols");
    const authorized = vi.fn();
    const result = await rig.mirror.resizeWindowSplit(
      "zz-stock",
      { window, layoutId: resource.layoutId, splitId: edge.splitId, boundary: 40 },
      "11111111-1111-4111-8111-111111111111",
      authorized,
      async () => {
        throw new Error("a stock server must not reach the native runner");
      },
    );
    expect(result).toMatchObject({ status: "applied", boundary: 40, changed: true });
    expect(authorized).toHaveBeenCalled();
    expect(geometry(rig).map((row) => row.split(":")[1])).toEqual(["0+40", "41+79"]);
    expect(result.successor?.resource.splits[0]?.boundary).toBe(40);
  });

  it("moves only the addressed boundary in a nested layout, and stops at its neighbours", async () => {
    const rig = await server(binary);
    // first | middle | (top / bottom)
    const last = rig.tmux(
      "split-window",
      "-d",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      rig.first,
      "sleep 300",
    );
    rig.tmux("split-window", "-d", "-v", "-t", last, "sleep 300");
    rig.tmux("split-window", "-d", "-h", "-t", rig.first, "sleep 300");
    const { target } = await open(rig);
    const window = target();
    const op = "22222222-2222-4222-8222-222222222222";
    const run = async (axis: "cols" | "rows", pick: (r: WindowSplitLayoutResource) => number) => {
      const resource = await rig.mirror.readWindowSplitLayout("zz-stock", target());
      const edge =
        axis === "rows"
          ? split(resource, "rows")
          : [...resource.splits]
              .filter((row) => row.axis === "cols")
              .sort((a, b) => a.boundary - b.boundary)[0]!;
      return rig.mirror.resizeWindowSplit(
        "zz-stock",
        {
          window: target(),
          layoutId: resource.layoutId,
          splitId: edge.splitId,
          boundary: pick(resource),
        },
        op,
        () => {},
        async () => {
          throw new Error("native runner");
        },
      );
    };
    expect(window).toBeDefined();
    const rows = await run("rows", () => 10);
    expect(rows).toMatchObject({ status: "applied", boundary: 10 });
    await vi.waitFor(() => expect(rows.successor).toBeTruthy());
    const before = geometry(rig);
    // Far past the middle pane: only the first boundary moves, and it stops there.
    await vi.waitFor(async () => {
      const far = await run("cols", () => 110);
      expect(far.status).toBe("applied");
    });
    const after = geometry(rig);
    expect(after.at(-1)).toBe(before.at(-1));
    const widths = after.map((row) => Number(row.split("+")[1]));
    expect(widths[1]).toBe(1);
  });

  it("moves a boundary through the last cell when the leading cell has no target", async () => {
    const rig = await server(binary);
    // rows[cols[a, b], cols[c, d]] | x
    const x = rig.tmux(
      "split-window",
      "-d",
      "-h",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      rig.first,
      "sleep 300",
    );
    const c = rig.tmux(
      "split-window",
      "-d",
      "-v",
      "-P",
      "-F",
      "#{pane_id}",
      "-t",
      rig.first,
      "sleep 300",
    );
    rig.tmux("split-window", "-d", "-h", "-t", rig.first, "sleep 300");
    rig.tmux("split-window", "-d", "-h", "-t", c, "sleep 300");
    const { target } = await open(rig);
    const window = target();
    const resource = await rig.mirror.readWindowSplitLayout("zz-stock", window);
    const root = [...resource.splits]
      .filter((row) => row.axis === "cols")
      .sort((a, b) => b.length - a.length)[0]!;
    expect(root.length).toBe(40);
    const result = await rig.mirror.resizeWindowSplit(
      "zz-stock",
      { window, layoutId: resource.layoutId, splitId: root.splitId, boundary: 80 },
      "44444444-4444-4444-8444-444444444444",
      () => {},
      async () => {
        throw new Error("native runner");
      },
    );
    expect(result).toMatchObject({ status: "applied", boundary: 80 });
    expect(rig.tmux("display-message", "-p", "-t", x, "#{pane_left}+#{pane_width}")).toBe("81+39");
  });

  it("refuses without changing anything after a change from outside", async () => {
    const rig = await server(binary);
    rig.tmux("split-window", "-d", "-h", "-t", rig.first, "sleep 300");
    const { target } = await open(rig);
    const window = target();
    const resource = await rig.mirror.readWindowSplitLayout("zz-stock", window);
    const edge = split(resource, "cols");
    // The mirror has not seen this yet, because the resize is sent in the same tick.
    const resize = rig.mirror.resizeWindowSplit(
      "zz-stock",
      { window, layoutId: resource.layoutId, splitId: edge.splitId, boundary: 90 },
      "33333333-3333-4333-8333-333333333333",
      () => rig.tmux("resize-pane", "-t", rig.first, "-x", "30"),
      async () => {
        throw new Error("native runner");
      },
    );
    await expect(resize).resolves.toMatchObject({ status: "refused", reason: "stale-layout" });
    expect(geometry(rig).map((row) => row.split(":")[1])).toEqual(["0+30", "31+89"]);
  });

  it("issues no handles while a floating pane is open", async () => {
    const rig = await server(binary);
    rig.tmux("split-window", "-d", "-h", "-t", rig.first, "sleep 300");
    const { target } = await open(rig);
    await rig.mirror.readWindowSplitLayout("zz-stock", target());
    try {
      rig.tmux("new-pane", "-t", rig.first, "sleep 300");
    } catch {
      return; // Floating panes need tmux 3.8.
    }
    await vi.waitFor(async () => {
      await expect(rig.mirror.readWindowSplitLayout("zz-stock", target())).rejects.toThrow();
    });
  });

  it("answers the probe as stock", async () => {
    const rig = await server(binary);
    const probe = createStockSplitProbe({ runPinnedTmux: rig.pinned });
    await expect(probe()).resolves.toBe(true);
  });

  it.each(["off", "top", "bottom"])(
    "moves each boundary exactly, both ways, with pane-border-status %s",
    async (status) => {
      const rig = await server(binary);
      rig.tmux("set-option", "-g", "pane-border-status", status);
      const right = rig.tmux(
        "split-window",
        "-d",
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        rig.first,
        "sleep 300",
      );
      const low = rig.tmux(
        "split-window",
        "-d",
        "-v",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        right,
        "sleep 300",
      );
      rig.tmux("split-window", "-d", "-v", "-t", low, "sleep 300");
      rig.tmux("select-layout", "-t", "zz-stock", "-E");
      const { target } = await open(rig);
      const noNative = async () => {
        throw new Error("native runner");
      };
      const move = async (
        pick: (rows: WindowSplitLayoutResource["splits"]) => (typeof rows)[number],
        by: number,
      ) => {
        let result: Awaited<ReturnType<typeof rig.mirror.resizeWindowSplit>> | undefined;
        await vi.waitFor(async () => {
          const resource = await rig.mirror.readWindowSplitLayout("zz-stock", target());
          const edge = pick(resource.splits);
          result = await rig.mirror.resizeWindowSplit(
            "zz-stock",
            {
              window: target(),
              layoutId: resource.layoutId,
              splitId: edge.splitId,
              boundary: edge.boundary + by,
            },
            "55555555-5555-4555-8555-555555555555",
            () => {},
            noNative,
          );
          expect(result).toMatchObject({ status: "applied", boundary: edge.boundary + by });
        });
        return result!;
      };
      const rowsSorted = (rows: WindowSplitLayoutResource["splits"]) =>
        rows.filter((row) => row.axis === "rows").sort((a, b) => a.boundary - b.boundary);
      const picks = [
        (rows: WindowSplitLayoutResource["splits"]) => rows.find((row) => row.axis === "cols")!,
        (rows: WindowSplitLayoutResource["splits"]) => rowsSorted(rows)[0]!,
        (rows: WindowSplitLayoutResource["splits"]) => rowsSorted(rows)[1]!,
      ];
      for (const pick of picks) for (const by of [3, -1, -2, 1, -3, 2]) await move(pick, by);
    },
  );

  it("moves or withholds every handle in tight layouts, under each border status", async () => {
    for (const status of ["off", "top", "bottom"]) {
      const rig = await server(binary);
      rig.tmux("set-option", "-g", "pane-border-status", status);
      // Three rows with the middle one as small as tmux allows, and a column beside them.
      const side = rig.tmux(
        "split-window",
        "-d",
        "-h",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        rig.first,
        "sleep 300",
      );
      const middle = rig.tmux(
        "split-window",
        "-d",
        "-v",
        "-P",
        "-F",
        "#{pane_id}",
        "-t",
        side,
        "sleep 300",
      );
      rig.tmux("split-window", "-d", "-v", "-t", middle, "sleep 300");
      const bottom = rig
        .tmux("list-panes", "-t", "zz-stock", "-F", "#{pane_id}")
        .split("\n")
        .at(-1)!;
      rig.tmux("resize-pane", "-t", middle, "-y", "1");
      rig.tmux("resize-pane", "-t", bottom, "-y", "2");
      const { target } = await open(rig);
      const noNative = async () => {
        throw new Error("native runner");
      };
      await vi.waitFor(async () => {
        const count = (await rig.mirror.readWindowSplitLayout("zz-stock", target())).splits.length;
        expect(count).toBeGreaterThan(0);
      });
      for (const by of [-100, 100, -1, 1]) {
        const resource = await rig.mirror.readWindowSplitLayout("zz-stock", target());
        for (const edge of resource.splits) {
          const fresh = await rig.mirror.readWindowSplitLayout("zz-stock", target());
          const same = fresh.splits.find(
            (row) =>
              row.axis === edge.axis && row.start === edge.start && row.boundary === edge.boundary,
          );
          if (!same) continue;
          const result = await rig.mirror.resizeWindowSplit(
            "zz-stock",
            {
              window: target(),
              layoutId: fresh.layoutId,
              splitId: same.splitId,
              boundary: Math.max(0, same.boundary + by),
            },
            "66666666-6666-4666-8666-666666666666",
            () => {},
            noNative,
          );
          expect(result.status, `${status} ${same.axis} ${same.boundary} by ${by}`).toBe("applied");
          await vi.waitFor(async () => {
            await rig.mirror.readWindowSplitLayout("zz-stock", target());
          });
        }
      }
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    }
  });

  it("never refuses or misplaces a move across random layouts", async () => {
    let seed = 20261104;
    const random = (limit: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % limit;
    };
    for (const status of ["off", "top", "bottom"]) {
      const rig = await server(binary);
      rig.tmux("set-option", "-g", "pane-border-status", status);
      for (let split = 0; split < 5; split++) {
        const panes = rig.tmux("list-panes", "-t", "zz-stock", "-F", "#{pane_id}").split("\n");
        rig.tmux(
          "split-window",
          "-d",
          random(2) ? "-h" : "-v",
          "-t",
          panes[random(panes.length)]!,
          "sleep 300",
        );
      }
      const { target } = await open(rig);
      const live = () => rig.mirror.readWindowSplitLayout("zz-stock", target());
      await vi.waitFor(async () => expect((await live()).panes).toHaveLength(6));
      for (let round = 0; round < 48; round++) {
        let resource = await live().catch(() => null);
        for (let wait = 0; !resource && wait < 100; wait++) {
          await new Promise((settled) => setTimeout(settled, 10));
          resource = await live().catch(() => null);
        }
        expect(resource).not.toBeNull();
        if (resource!.splits.length === 0) continue;
        const edge = resource!.splits[random(resource!.splits.length)]!;
        const wanted = Math.max(0, edge.boundary + random(13) - 6);
        const result = await rig.mirror.resizeWindowSplit(
          "zz-stock",
          {
            window: target(),
            layoutId: resource!.layoutId,
            splitId: edge.splitId,
            boundary: wanted,
          },
          "77777777-7777-4777-8777-777777777777",
          () => {},
          async () => {
            throw new Error("native runner");
          },
        );
        expect(result.status, `${status} round ${round} ${edge.axis}`).toBe("applied");
        if (result.status === "applied") {
          const low = Math.min(edge.boundary, wanted);
          const high = Math.max(edge.boundary, wanted);
          expect(result.boundary).toBeGreaterThanOrEqual(low);
          expect(result.boundary).toBeLessThanOrEqual(high);
        }
      }
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    }
  });

  it("keeps later replies aligned when the guarded resize itself fails", async () => {
    const rig = await server(binary);
    rig.tmux("split-window", "-d", "-h", "-t", rig.first, "sleep 300");
    await open(rig);
    const channel = (
      rig.mirror as unknown as {
        channels: Map<
          string,
          {
            channel: {
              stockSplitCommand(c: string): Promise<string[]>;
              stockSplitOptions(w: string): Promise<string[]>;
            };
          }
        >;
      }
    ).channels.get("zz-stock")!.channel;
    const windowId = rig.tmux("display-message", "-p", "-t", "zz-stock", "#{window_id}");
    await expect(
      channel.stockSplitCommand(
        `if-shell -F 1 'resize-pane -t %999 -R 1 ; display-message -p skipped' 'display-message -p a ; display-message -p b'`,
      ),
    ).rejects.toThrow("Stock split command failed");
    const options = await channel.stockSplitOptions(windowId);
    expect(parseStockSplitOptions(options[0])).not.toBeNull();
  });

  it("issues no handles for a zoomed window", async () => {
    const rig = await server(binary);
    rig.tmux("split-window", "-d", "-h", "-t", rig.first, "sleep 300");
    const { target } = await open(rig);
    rig.tmux("resize-pane", "-Z", "-t", rig.first);
    await vi.waitFor(async () => {
      await expect(rig.mirror.readWindowSplitLayout("zz-stock", target())).rejects.toThrow();
    });
  });
});
