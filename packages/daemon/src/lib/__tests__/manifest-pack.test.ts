/**
 * Unit tests for the remote manifest pack (M25.4): the pure validator + URL
 * policy, and the io flow driven entirely through `file://` fixtures and a
 * `TMUX_IDE_HOME`/`TMUX_IDE_CONFIG` scratch (never the network, never real
 * user state).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchManifestPack,
  installManifestPack,
  isAllowedPackUrl,
  manifestPackUrl,
  maybeRefreshManifestPack,
  packPath,
  updateManifestPack,
  validateManifestPack,
  MANIFEST_PACK_URL_ENV,
} from "../manifest-pack.ts";
import {
  readPackManifests,
  _resetForTests as resetLoader,
} from "../../tui/detect/manifest-loader.ts";
import { _resetForTests as resetConfig } from "../app-config.ts";

const VALID_PACK = {
  schema: 1,
  pack: "2026.07.12",
  manifests: [
    {
      id: "droid",
      commands: ["droid"],
      confidence: "conservative",
      states: { working: { any: [{ contains: "esc to interrupt" }] } },
    },
  ],
};

describe("validateManifestPack (pure)", () => {
  it("accepts a well-formed pack", () => {
    const v = validateManifestPack(VALID_PACK);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.pack.manifests[0]?.id).toBe("droid");
  });

  it("rejects a wrong schema version, loudly naming it", () => {
    const v = validateManifestPack({ ...VALID_PACK, schema: 2 });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain("schema");
  });

  it("rejects a missing pack version, an empty manifest list, and a bad entry", () => {
    expect(validateManifestPack({ ...VALID_PACK, pack: "" }).ok).toBe(false);
    expect(validateManifestPack({ ...VALID_PACK, manifests: [] }).ok).toBe(false);
    const bad = validateManifestPack({ ...VALID_PACK, manifests: [{ id: "nope" }] });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("manifests[0]");
  });

  it("rejects non-objects", () => {
    expect(validateManifestPack(null).ok).toBe(false);
    expect(validateManifestPack("[]").ok).toBe(false);
  });
});

describe("isAllowedPackUrl (pure)", () => {
  it("allows https anywhere, file, and loopback http only", () => {
    expect(isAllowedPackUrl("https://github.com/x/y/releases/download/v1/a.json")).toBe(true);
    expect(isAllowedPackUrl("file:///tmp/pack.json")).toBe(true);
    expect(isAllowedPackUrl("http://127.0.0.1:8080/pack.json")).toBe(true);
    expect(isAllowedPackUrl("http://localhost:8080/pack.json")).toBe(true);
  });

  it("rejects remote http, other schemes, and garbage", () => {
    expect(isAllowedPackUrl("http://example.com/pack.json")).toBe(false);
    expect(isAllowedPackUrl("ftp://example.com/pack.json")).toBe(false);
    expect(isAllowedPackUrl("not a url")).toBe(false);
  });
});

describe("manifestPackUrl (pure)", () => {
  it("constructs the release-asset URL like the TUI binary does", () => {
    expect(manifestPackUrl("2.7.0")).toBe(
      "https://github.com/wavyrai/tmux-ide/releases/download/v2.7.0/agent-manifests.json",
    );
    // A leading v is normalized, not doubled.
    expect(manifestPackUrl("v2.7.0")).toContain("/v2.7.0/");
  });
});

describe("fetch + install + loader pickup (file:// fixtures, scratch home)", () => {
  let home: string;
  let fixtures: string;
  const prevHome = process.env.TMUX_IDE_HOME;
  const prevUrl = process.env[MANIFEST_PACK_URL_ENV];
  const prevConfig = process.env.TMUX_IDE_CONFIG;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tmux-ide-pack-home-"));
    fixtures = mkdtempSync(join(tmpdir(), "tmux-ide-pack-fixtures-"));
    process.env.TMUX_IDE_HOME = home;
    resetLoader();
    resetConfig();
  });
  afterEach(() => {
    for (const [key, val] of [
      ["TMUX_IDE_HOME", prevHome],
      [MANIFEST_PACK_URL_ENV, prevUrl],
      ["TMUX_IDE_CONFIG", prevConfig],
    ] as const) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(fixtures, { recursive: true, force: true });
    resetLoader();
    resetConfig();
  });

  const writeFixture = (name: string, content: unknown): string => {
    const path = join(fixtures, name);
    writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
    return pathToFileURL(path).href;
  };

  it("fetches a valid pack from file:// and installs it where the loader reads", async () => {
    const url = writeFixture("pack.json", VALID_PACK);
    const pack = await fetchManifestPack(url);
    const dest = installManifestPack(pack);
    expect(dest).toBe(packPath());
    expect(dest.startsWith(home)).toBe(true);
    // The loader picks it up (same TMUX_IDE_HOME).
    expect(readPackManifests().map((m) => m.id)).toEqual(["droid"]);
  });

  it("updateManifestPack honors the env URL override and reports what it did", async () => {
    process.env[MANIFEST_PACK_URL_ENV] = writeFixture("pack.json", VALID_PACK);
    const r = await updateManifestPack();
    expect(r.count).toBe(1);
    expect(r.packVersion).toBe("2026.07.12");
    expect(JSON.parse(readFileSync(r.path, "utf8")).manifests[0].id).toBe("droid");
  });

  it("rejects a schema-invalid pack loudly and installs nothing", async () => {
    const url = writeFixture("bad.json", { ...VALID_PACK, schema: 99 });
    await expect(fetchManifestPack(url)).rejects.toThrow(/rejected: unsupported schema/);
    expect(readPackManifests()).toEqual([]);
  });

  it("rejects malformed JSON and disallowed URLs", async () => {
    const url = writeFixture("garbage.json", "{ nope");
    await expect(fetchManifestPack(url)).rejects.toThrow(/not valid JSON/);
    await expect(fetchManifestPack("http://example.com/pack.json")).rejects.toThrow(/https only/);
  });

  it("maybeRefreshManifestPack is OFF by default (updates.manifests: false)", async () => {
    process.env[MANIFEST_PACK_URL_ENV] = writeFixture("pack.json", VALID_PACK);
    // Default config — the gate is closed, so nothing installs.
    process.env.TMUX_IDE_CONFIG = join(fixtures, "missing-config.json");
    resetConfig();
    await maybeRefreshManifestPack();
    expect(readPackManifests()).toEqual([]);
  });

  it("maybeRefreshManifestPack installs when updates.manifests is opted in — and never throws on failure", async () => {
    process.env[MANIFEST_PACK_URL_ENV] = writeFixture("pack.json", VALID_PACK);
    const configPath = join(fixtures, "config.json");
    writeFileSync(configPath, JSON.stringify({ updates: { check: true, manifests: true } }));
    process.env.TMUX_IDE_CONFIG = configPath;
    resetConfig();
    await maybeRefreshManifestPack();
    expect(readPackManifests().map((m) => m.id)).toEqual(["droid"]);

    // A later broken source degrades silently, keeping the installed pack.
    process.env[MANIFEST_PACK_URL_ENV] = writeFixture("bad.json", "{ nope");
    await expect(maybeRefreshManifestPack()).resolves.toBeUndefined();
    expect(readPackManifests().map((m) => m.id)).toEqual(["droid"]);
  });

  it("user override files still beat an installed pack (precedence, end to end)", async () => {
    const url = writeFixture("pack.json", {
      schema: 1,
      pack: "t",
      manifests: [
        {
          id: "claude",
          commands: ["claude"],
          states: { working: { any: [{ contains: "PACK-WINS" }] } },
        },
      ],
    });
    installManifestPack(await fetchManifestPack(url));
    const detect = join(home, "agent-detection");
    mkdirSync(detect, { recursive: true });
    writeFileSync(
      join(detect, "claude.json"),
      JSON.stringify({
        id: "claude",
        commands: ["claude"],
        states: { working: { any: [{ contains: "USER-WINS" }] } },
      }),
    );
    resetLoader();
    const { loadManifests } = await import("../../tui/detect/manifest-loader.ts");
    const claude = loadManifests().find((m) => m.id === "claude")!;
    expect(claude.states.working?.any?.[0]?.contains).toBe("USER-WINS");
  });
});
