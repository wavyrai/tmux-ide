import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultProvidersFilePath,
  makeProviderStore,
  ProviderStoreError,
} from "./provider-store.ts";
import type { ProviderInstance } from "@tmux-ide/contracts";

let tmpDir = "";
let filePath = "";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-providers-"));
  filePath = join(tmpDir, "providers.json");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function anthropic(id: string, overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id,
    kind: "anthropic",
    displayName: id,
    config: {
      kind: "anthropic",
      apiKey: "sk-abc",
      model: "claude-opus-4-7",
    },
    createdAt: "2026-05-11T10:00:00.000Z",
    ...overrides,
  };
}

describe("provider-store", () => {
  it("starts empty when the file does not exist", () => {
    const store = makeProviderStore({ filePath });
    expect(store.list()).toEqual([]);
    expect(store.summaries()).toEqual([]);
  });

  it("add persists a record and assigns createdAt when omitted", () => {
    const store = makeProviderStore({
      filePath,
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    });
    const seed = anthropic("ant-1");
    delete (seed as Partial<ProviderInstance>).createdAt;
    const added = store.add(seed);
    expect(added.id).toBe("ant-1");
    expect(added.createdAt).toBe("2027-01-01T00:00:00.000Z");
    expect(store.get("ant-1")).toEqual(added);

    const onDisk = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: number;
      providers: ProviderInstance[];
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.providers).toHaveLength(1);
    expect(onDisk.providers[0]!.id).toBe("ant-1");
  });

  it("add rejects an invalid config via Zod parse", () => {
    const store = makeProviderStore({ filePath });
    expect(() =>
      store.add({
        id: "bad",
        kind: "anthropic",
        displayName: "bad",
        config: { kind: "anthropic", apiKey: "", model: "m" },
      } as ProviderInstance),
    ).toThrow(ProviderStoreError);
  });

  it("add rejects a duplicate id", () => {
    const store = makeProviderStore({ filePath });
    store.add(anthropic("dup"));
    expect(() => store.add(anthropic("dup"))).toThrow(/already exists/);
  });

  it("update mutates an existing record and re-validates the config", () => {
    const store = makeProviderStore({ filePath });
    store.add(anthropic("ant-1"));
    const next = store.update("ant-1", {
      displayName: "renamed",
      config: { kind: "anthropic", apiKey: "sk-new", model: "claude-haiku-4-5" },
    });
    expect(next.displayName).toBe("renamed");
    expect(next.config.kind).toBe("anthropic");
    expect((next.config as { model: string }).model).toBe("claude-haiku-4-5");
  });

  it("update rejects a bad patch", () => {
    const store = makeProviderStore({ filePath });
    store.add(anthropic("ant-1"));
    expect(() =>
      store.update("ant-1", {
        config: { kind: "anthropic", apiKey: "", model: "m" },
      } as never),
    ).toThrow(ProviderStoreError);
  });

  it("update throws not_found for unknown id", () => {
    const store = makeProviderStore({ filePath });
    expect(() => store.update("missing", { displayName: "x" })).toThrow(/not found/);
  });

  it("remove returns true and persists the deletion", () => {
    const store = makeProviderStore({ filePath });
    store.add(anthropic("ant-1"));
    expect(store.remove("ant-1")).toBe(true);
    expect(store.remove("ant-1")).toBe(false);
    expect(store.list()).toEqual([]);
  });

  it("summaries redact apiKey but expose hasApiKey + model + baseUrl", () => {
    const store = makeProviderStore({ filePath });
    store.add(anthropic("ant-1"));
    const summary = store.summaries()[0]!;
    expect(summary).toMatchObject({
      id: "ant-1",
      kind: "anthropic",
      model: "claude-opus-4-7",
      hasApiKey: true,
    });
    expect(summary).not.toHaveProperty("apiKey");
    expect(summary).not.toHaveProperty("config");
  });

  it("loads an existing valid file on construction", () => {
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        providers: [anthropic("preloaded")],
      }),
      "utf8",
    );
    const store = makeProviderStore({ filePath });
    expect(store.list().map((p) => p.id)).toEqual(["preloaded"]);
  });

  it("throws ProviderStoreError on a malformed file", () => {
    writeFileSync(filePath, "{not-json", "utf8");
    expect(() => makeProviderStore({ filePath })).toThrow(ProviderStoreError);
  });

  it("throws ProviderStoreError on a schema-invalid file", () => {
    writeFileSync(filePath, JSON.stringify({ version: 1, providers: [{ id: "x" }] }), "utf8");
    expect(() => makeProviderStore({ filePath })).toThrow(ProviderStoreError);
  });

  it("defaultProvidersFilePath honors TMUX_IDE_PROVIDERS_FILE env override", () => {
    const prev = process.env.TMUX_IDE_PROVIDERS_FILE;
    process.env.TMUX_IDE_PROVIDERS_FILE = "/tmp/override-providers.json";
    try {
      expect(defaultProvidersFilePath()).toBe("/tmp/override-providers.json");
    } finally {
      if (prev === undefined) delete process.env.TMUX_IDE_PROVIDERS_FILE;
      else process.env.TMUX_IDE_PROVIDERS_FILE = prev;
    }
  });
});
