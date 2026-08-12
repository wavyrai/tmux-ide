import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  OptionalFeatureRegistry,
  OptionalFeatureRegistryDisposedError,
} from "./optional-feature-registry.ts";

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Value>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

type Features = { files: { names: string[] }; palette: { actions: number }; absent: never };

describe("OptionalFeatureRegistry", () => {
  it("retains pre-admission intent without evaluating a loader and single-flights callers", async () => {
    const pending = deferred<Features["files"]>();
    const loader = vi.fn(() => pending.promise);
    const registry = new OptionalFeatureRegistry<Features>({ files: loader });

    const first = registry.request("files");
    const second = registry.request("files");
    expect(first).toBe(second);
    expect(loader).not.toHaveBeenCalled();
    expect(registry.getMetrics()).toMatchObject({
      requests: 2,
      retainedIntents: 1,
      joinedRequests: 1,
      loadsStarted: 0,
    });

    expect(registry.admit()).toBe(true);
    expect(registry.admit()).toBe(false);
    expect(loader).toHaveBeenCalledTimes(1);
    pending.resolve({ names: ["README.md"] });
    await expect(first).resolves.toEqual({ names: ["README.md"] });
    expect(registry.peek("files")).toEqual({ names: ["README.md"] });
    expect(registry.getMetrics()).toMatchObject({
      loadsStarted: 1,
      loadsSucceeded: 1,
      activeLoads: 0,
      publications: 1,
    });
  });

  it("loads immediately after admission and serves the published module from cache", async () => {
    const value = { actions: 3 };
    const loader = vi.fn(async () => value);
    const registry = new OptionalFeatureRegistry<Features>({ palette: loader });
    registry.admit();

    await expect(registry.request("palette")).resolves.toBe(value);
    await expect(registry.request("palette")).resolves.toBe(value);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(registry.getMetrics()).toMatchObject({ requests: 2, cacheHits: 1, publications: 1 });
  });

  it("reports unavailable optional modules without creating retained work", async () => {
    const registry = new OptionalFeatureRegistry<Features>({});
    await expect(registry.request("absent")).resolves.toBeUndefined();
    expect(registry.getMetrics()).toMatchObject({
      unavailableRequests: 1,
      retainedIntents: 0,
      loadsStarted: 0,
    });
  });

  it("does not cache failures and permits an explicit retry", async () => {
    const loader = vi
      .fn<() => Promise<Features["files"]>>()
      .mockRejectedValueOnce(new Error("chunk unavailable"))
      .mockResolvedValueOnce({ names: ["retry.ts"] });
    const registry = new OptionalFeatureRegistry<Features>({ files: loader });
    registry.admit();

    await expect(registry.request("files")).rejects.toThrow("chunk unavailable");
    await expect(registry.request("files")).resolves.toEqual({ names: ["retry.ts"] });
    expect(loader).toHaveBeenCalledTimes(2);
    expect(registry.getMetrics()).toMatchObject({
      loadsStarted: 2,
      loadsFailed: 1,
      loadsSucceeded: 1,
      publications: 1,
    });
  });

  it("rejects retained intent on disposal without ever starting its loader", async () => {
    const loader = vi.fn(async () => ({ names: [] }));
    const registry = new OptionalFeatureRegistry<Features>({ files: loader });
    const request = registry.request("files");
    registry.dispose();

    await expect(request).rejects.toBeInstanceOf(OptionalFeatureRegistryDisposedError);
    expect(loader).not.toHaveBeenCalled();
    expect(registry.admit()).toBe(false);
    await expect(registry.request("files")).rejects.toBeInstanceOf(
      OptionalFeatureRegistryDisposedError,
    );
    expect(registry.getMetrics()).toMatchObject({ disposed: true, generation: 2 });
  });

  it("owns preload rejection observation while preserving rejecting request semantics", async () => {
    const registry = new OptionalFeatureRegistry<Features>({
      files: async () => {
        throw new Error("preload failed");
      },
    });
    registry.admit();
    registry.preload("files");
    await Promise.resolve();
    await Promise.resolve();
    expect(registry.getMetrics()).toMatchObject({
      preloadRequests: 1,
      preloadRejectionsObserved: 1,
      loadsFailed: 1,
    });

    await expect(registry.request("files")).rejects.toThrow("preload failed");
  });

  it.each([
    {
      runtime: "node",
      command: process.execPath,
      args: ["--experimental-strip-types", "--unhandled-rejections=strict", "--input-type=module"],
    },
    {
      runtime: "bun",
      command: "bun",
      args: ["--unhandled-rejections=strict"],
    },
  ])(
    "keeps fire-and-forget preload disposal handled under strict $runtime",
    ({ command, args }) => {
      const moduleUrl = new URL("./optional-feature-registry.ts", import.meta.url).href;
      const script = `
      import { OptionalFeatureRegistry } from ${JSON.stringify(moduleUrl)};
      let resolve;
      const physicalLoad = new Promise((accept) => { resolve = accept; });
      const registry = new OptionalFeatureRegistry({ files: () => physicalLoad });
      registry.admit();
      registry.preload("files");
      registry.dispose();
      resolve({ names: [] });
      await new Promise((accept) => setTimeout(accept, 10));
      if (registry.getMetrics().lateResultsDiscarded !== 1) process.exitCode = 2;
    `;
      const result = spawnSync(command, [...args, "--eval", script], {
        cwd: fileURLToPath(new URL("../../../../../../", import.meta.url)),
        encoding: "utf8",
      });
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    },
  );

  it("generation-fences a late successful load and never publishes it", async () => {
    const pending = deferred<Features["files"]>();
    const registry = new OptionalFeatureRegistry<Features>({ files: () => pending.promise });
    registry.admit();
    const request = registry.request("files");
    registry.dispose();
    await expect(request).rejects.toBeInstanceOf(OptionalFeatureRegistryDisposedError);

    pending.resolve({ names: ["too-late.ts"] });
    await pending.promise;
    await Promise.resolve();
    expect(registry.peek("files")).toBeUndefined();
    expect(registry.getMetrics()).toMatchObject({
      loadsSucceeded: 1,
      publications: 0,
      activeLoads: 0,
      lateResultsDiscarded: 1,
    });
  });

  it("generation-fences a late rejected load without double-rejecting callers", async () => {
    const pending = deferred<Features["palette"]>();
    const registry = new OptionalFeatureRegistry<Features>({ palette: () => pending.promise });
    registry.admit();
    const request = registry.request("palette");
    registry.dispose();
    await expect(request).rejects.toBeInstanceOf(OptionalFeatureRegistryDisposedError);

    pending.reject(new Error("late failure"));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();
    expect(registry.getMetrics()).toMatchObject({
      loadsFailed: 1,
      activeLoads: 0,
      lateResultsDiscarded: 1,
    });
  });

  it("turns a synchronous loader throw into a counted asynchronous failure", async () => {
    const registry = new OptionalFeatureRegistry<Features>({
      files: () => {
        throw new Error("sync loader failure");
      },
    });
    registry.admit();
    await expect(registry.request("files")).rejects.toThrow("sync loader failure");
    expect(registry.getMetrics()).toMatchObject({
      loadsStarted: 1,
      loadsFailed: 1,
      activeLoads: 0,
    });
  });
});
