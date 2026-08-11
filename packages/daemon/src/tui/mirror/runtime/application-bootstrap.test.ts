import { describe, expect, it, vi } from "vitest";

import { startTuiApplication } from "./application-bootstrap.ts";
import { TuiApplicationLifecycle } from "./application-lifecycle.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

describe("thin OpenTUI bootstrap", () => {
  it("keeps args, config, renderer, root and readiness behind ordered seams", async () => {
    const calls: string[] = [];
    const ready = deferred();
    const mounted = deferred();
    const renderer = { destroy: () => calls.push("destroy-renderer") };
    const startup = startTuiApplication({
      argv: ["--target", "alpha"],
      parseArgs: (argv) => {
        calls.push("parse");
        return { target: argv[1]! };
      },
      loadConfig: (args) => {
        calls.push(`config:${args.target}`);
        return { theme: "dark" };
      },
      createRenderer: () => {
        calls.push("renderer");
        return renderer;
      },
      createLifecycle: (owner) =>
        new TuiApplicationLifecycle({ destroyRenderer: () => owner.destroy() }),
      mountRoot: ({ args, config }) => {
        calls.push(`mount:${args.target}:${config.theme}`);
        mounted.resolve();
        return {
          root: { id: "root" },
          ready: ready.promise,
          close: () => calls.push("close-root"),
        };
      },
      publishReady: ({ root }) => calls.push(`ready:${root.id}`),
    });

    await mounted.promise;
    expect(calls).toEqual(["parse", "config:alpha", "renderer", "mount:alpha:dark"]);
    ready.resolve();
    const app = await startup;
    expect(calls).toEqual(["parse", "config:alpha", "renderer", "mount:alpha:dark", "ready:root"]);

    const first = app.shutdown();
    const second = app.shutdown();
    expect(first).toBe(second);
    await first;
    expect(calls.slice(-2)).toEqual(["close-root", "destroy-renderer"]);
  });

  it("closes the mounted root and destroys the renderer when readiness fails", async () => {
    const calls: string[] = [];
    const startupFailure = new Error("input owner failed");

    await expect(
      startTuiApplication({
        argv: [],
        parseArgs: () => ({}),
        loadConfig: () => ({}),
        createRenderer: () => ({ destroy: () => calls.push("destroy") }),
        createLifecycle: (renderer) =>
          new TuiApplicationLifecycle({ destroyRenderer: renderer.destroy }),
        mountRoot: () => ({
          root: {},
          ready: Promise.reject(startupFailure),
          close: () => calls.push("close"),
        }),
        publishReady: vi.fn(),
      }),
    ).rejects.toBe(startupFailure);

    expect(calls).toEqual(["close", "destroy"]);
  });
});
