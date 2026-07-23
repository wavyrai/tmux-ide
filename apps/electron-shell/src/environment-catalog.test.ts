import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canonicalDaemonPreflight } from "./daemon-preflight.ts";
import {
  KnownEnvironmentCatalog,
  createCatalogBackedPreflight,
  resolvePreflightForEndpoint,
} from "./environment-catalog.ts";

const ENVIRONMENT_A = "0f4e9a7c-2f4a-4d55-9d2e-1f6cf3a3b210";
const ENVIRONMENT_B = "7be9d0aa-51c3-4a4e-8f6a-2a0d78c58f01";

let stateDir: string;
let catalogPath: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "env-catalog-"));
  catalogPath = join(stateDir, "known-environments.json");
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("KnownEnvironmentCatalog", () => {
  it("seeds exactly one local-canonical entry when no state exists", async () => {
    const catalog = new KnownEnvironmentCatalog(catalogPath);
    await catalog.load();
    expect(catalog.entries()).toHaveLength(1);
    expect(catalog.localCanonical()).toMatchObject({
      environmentId: null,
      endpoint: { kind: "local-canonical" },
      lastConnectedAt: null,
    });
  });

  it("reseeds when the persisted catalog is malformed", async () => {
    await writeFile(catalogPath, "{ not json");
    const catalog = new KnownEnvironmentCatalog(catalogPath);
    await catalog.load();
    expect(catalog.localCanonical().environmentId).toBeNull();
  });

  it("records the environment id on first reconcile and persists it", async () => {
    const catalog = new KnownEnvironmentCatalog(catalogPath);
    await catalog.load();
    expect(catalog.reconcileLocalCanonical(ENVIRONMENT_A)).toBe("recorded");
    await catalog.flush();

    const raw = JSON.parse(await readFile(catalogPath, "utf8")) as {
      version: number;
      environments: Array<{ environmentId: string | null; lastConnectedAt: string | null }>;
    };
    expect(raw.version).toBe(1);
    expect(raw.environments).toHaveLength(1);
    expect(raw.environments[0]?.environmentId).toBe(ENVIRONMENT_A);
    expect(Number.isFinite(Date.parse(raw.environments[0]?.lastConnectedAt ?? ""))).toBe(true);

    const reloaded = new KnownEnvironmentCatalog(catalogPath);
    await reloaded.load();
    expect(reloaded.localCanonical().environmentId).toBe(ENVIRONMENT_A);
  });

  it("treats the same id as unchanged and a different id as a replacement", async () => {
    const catalog = new KnownEnvironmentCatalog(catalogPath);
    await catalog.load();
    catalog.reconcileLocalCanonical(ENVIRONMENT_A);
    expect(catalog.reconcileLocalCanonical(ENVIRONMENT_A)).toBe("unchanged");
    // A different minted id means the daemon home was reset: the endpoint is
    // the durable key locally, so the recorded id is replaced.
    expect(catalog.reconcileLocalCanonical(ENVIRONMENT_B)).toBe("replaced");
    expect(catalog.localCanonical().environmentId).toBe(ENVIRONMENT_B);
    await catalog.flush();

    const reloaded = new KnownEnvironmentCatalog(catalogPath);
    await reloaded.load();
    expect(reloaded.localCanonical().environmentId).toBe(ENVIRONMENT_B);
    expect(reloaded.entries()).toHaveLength(1);
  });

  it("ignores a malformed environment id without disturbing the catalog", async () => {
    const catalog = new KnownEnvironmentCatalog(catalogPath);
    await catalog.load();
    catalog.reconcileLocalCanonical(ENVIRONMENT_A);
    expect(catalog.reconcileLocalCanonical("not-a-uuid")).toBe("unchanged");
    expect(catalog.localCanonical().environmentId).toBe(ENVIRONMENT_A);
  });

  it("survives an unwritable state path as pure bookkeeping", async () => {
    // A regular file where a parent directory is needed makes every write fail.
    await writeFile(join(stateDir, "blocker"), "");
    const catalog = new KnownEnvironmentCatalog(join(stateDir, "blocker", "catalog.json"));
    await catalog.load();
    expect(catalog.reconcileLocalCanonical(ENVIRONMENT_A)).toBe("recorded");
    await expect(catalog.flush()).resolves.toBeUndefined();
    expect(catalog.localCanonical().environmentId).toBe(ENVIRONMENT_A);
  });
});

describe("endpoint resolution", () => {
  it("maps the local-canonical endpoint onto the existing secure preflight", () => {
    expect(resolvePreflightForEndpoint({ kind: "local-canonical" })).toBe(canonicalDaemonPreflight);
  });

  it("fails loudly for an endpoint kind this build does not support", () => {
    expect(() => resolvePreflightForEndpoint({ kind: "ssh-tunnel" } as never)).toThrow(
      /unsupported environment endpoint kind/u,
    );
  });

  it("resolves the catalog entry at probe time and delegates the probe", async () => {
    // Point canonical discovery at the empty temp state dir so the delegated
    // probe is hermetic: the local-canonical path reports a missing record.
    const previous = process.env.TMUX_IDE_DAEMON_INFO_DIR;
    process.env.TMUX_IDE_DAEMON_INFO_DIR = stateDir;
    try {
      const catalog = new KnownEnvironmentCatalog(catalogPath);
      const preflight = createCatalogBackedPreflight(catalog);
      const result = await preflight.probe(new AbortController().signal);
      expect(result).toMatchObject({ status: "unavailable", code: "record-missing" });
      // load() ran implicitly and seeded the single local entry.
      expect(catalog.entries()).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.TMUX_IDE_DAEMON_INFO_DIR;
      else process.env.TMUX_IDE_DAEMON_INFO_DIR = previous;
    }
  });
});
