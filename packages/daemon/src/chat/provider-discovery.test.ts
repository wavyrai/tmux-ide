import { beforeEach, describe, expect, it } from "bun:test";
import {
  _resetCodexModelsCacheForTests,
  discoverProviders,
  parseCodexModelListResponse,
  type ProviderDiscoveryOptions,
  type ProviderModelInfo,
} from "./provider-discovery.ts";

beforeEach(() => {
  _resetCodexModelsCacheForTests();
});

function lookup(
  map: Record<string, string | null>,
): NonNullable<ProviderDiscoveryOptions["pathLookup"]> {
  return async (binary) => map[binary] ?? null;
}

function execVersion(
  versions: Record<string, string>,
): NonNullable<ProviderDiscoveryOptions["exec"]> {
  return async (cmd) => ({
    stdout: versions[cmd] ? `${versions[cmd]}\n` : "",
    stderr: "",
    code: versions[cmd] ? 0 : 1,
  });
}

describe("discoverProviders", () => {
  it("marks claude-code available when claude-code-acp is on PATH", async () => {
    const { providers } = {
      providers: await discoverProviders({
        pathLookup: lookup({ "claude-code-acp": "/bin/claude-code-acp" }),
        exec: execVersion({ "/bin/claude-code-acp": "claude-code-acp 1.2.3" }),
      }),
    };

    expect(providers[0]).toMatchObject({
      kind: "claude-code",
      available: true,
      binary: "/bin/claude-code-acp",
      version: "claude-code-acp 1.2.3",
    });
  });

  it("falls back to npx for claude-code when claude-code-acp is missing", async () => {
    const providers = await discoverProviders({
      pathLookup: lookup({ "claude-code-acp": null, npx: "/bin/npx" }),
      exec: execVersion({}),
    });

    expect(providers[0]).toMatchObject({
      kind: "claude-code",
      available: true,
      binary: "/bin/npx",
    });
    expect(providers[0]?.description).toContain("via npx");
  });

  it("marks claude-code unavailable when neither claude-code-acp nor npx are on PATH", async () => {
    const providers = await discoverProviders({
      pathLookup: lookup({ "claude-code-acp": null, npx: null }),
      exec: execVersion({}),
    });

    expect(providers[0]).toMatchObject({
      kind: "claude-code",
      available: false,
      error: "neither claude-code-acp nor npx on PATH",
    });
  });

  it("populates codex version when codex --version succeeds", async () => {
    const providers = await discoverProviders({
      pathLookup: lookup({ codex: "/bin/codex" }),
      exec: execVersion({ "/bin/codex": "codex 0.1.0" }),
    });

    expect(providers[1]).toMatchObject({
      kind: "codex",
      available: true,
      binary: "/bin/codex",
      version: "codex 0.1.0",
    });
  });

  it("keeps codex available without a version when codex --version times out", async () => {
    const providers = await discoverProviders({
      pathLookup: lookup({ codex: "/bin/codex" }),
      exec: async () => {
        throw new Error("timeout");
      },
    });

    expect(providers[1]).toMatchObject({
      kind: "codex",
      available: true,
      binary: "/bin/codex",
    });
    expect(providers[1]?.version).toBeUndefined();
  });

  it("marks codex unavailable when codex is not on PATH", async () => {
    const providers = await discoverProviders({
      pathLookup: lookup({ codex: null }),
      exec: execVersion({}),
    });

    expect(providers[1]).toMatchObject({
      kind: "codex",
      available: false,
      error: "codex not on PATH",
    });
  });
});

// ---------------------------------------------------------------------------
// Dynamic Codex model discovery via app-server `model/list` (parse + cache
// + fallback). The default `defaultProbeCodexModels` spawns a real `codex
// app-server` and is exercised manually — the unit suite stubs the probe.
// ---------------------------------------------------------------------------

describe("parseCodexModelListResponse", () => {
  it("maps `model/list` response → ProviderModelInfo[] and filters to *-codex slugs", () => {
    const parsed = parseCodexModelListResponse({
      data: [
        // Should be filtered out: bare gpt-5 is rejected by ChatGPT-account
        // auth — only codex-suffixed slugs are surfaced.
        {
          model: "gpt-5",
          displayName: "gpt-5",
          description: "General purpose",
          hidden: false,
          isDefault: false,
        },
        {
          model: "gpt-5-codex",
          displayName: "gpt-5-codex",
          description: "Code-tuned",
          hidden: false,
          isDefault: true,
        },
        {
          model: "gpt-5.3-codex",
          displayName: "gpt-5.3-codex",
          description: "Newer code-tuned",
          hidden: false,
          isDefault: false,
        },
        // Hidden entries should not surface.
        {
          model: "gpt-internal-codex",
          displayName: "gpt-internal-codex",
          hidden: true,
          isDefault: false,
        },
      ],
    });

    expect(parsed.map((m) => m.slug)).toEqual(["gpt-5-codex", "gpt-5.3-codex"]);
    // displayName gets light prettification (gpt → GPT, dash-uppercases).
    expect(parsed[0]).toMatchObject({ slug: "gpt-5-codex", name: "GPT-5-Codex" });
    expect(parsed[0]?.description).toBe("Code-tuned");
  });

  it("hoists the default-flagged model to index 0 when it survives the filter", () => {
    const parsed = parseCodexModelListResponse({
      data: [
        { model: "gpt-5.3-codex", displayName: "gpt-5.3-codex", hidden: false, isDefault: false },
        { model: "gpt-5-codex", displayName: "gpt-5-codex", hidden: false, isDefault: true },
      ],
    });
    expect(parsed.map((m) => m.slug)).toEqual(["gpt-5-codex", "gpt-5.3-codex"]);
  });

  it("returns [] on a malformed response (defensive parse)", () => {
    expect(parseCodexModelListResponse({} as never)).toEqual([]);
    expect(parseCodexModelListResponse({ data: [{ displayName: "no slug" }] } as never)).toEqual(
      [],
    );
  });

  it("surfaces supportedReasoningEfforts + defaultReasoningEffort + fast-mode capabilities", () => {
    const parsed = parseCodexModelListResponse({
      data: [
        {
          model: "gpt-5.4-codex",
          displayName: "gpt-5.4-codex",
          hidden: false,
          isDefault: false,
          // Newer object-array shape (`{reasoningEffort: ...}`).
          supportedReasoningEfforts: [
            { reasoningEffort: "low" },
            { reasoningEffort: "medium" },
            { reasoningEffort: "high" },
            { reasoningEffort: "xhigh" },
          ],
          defaultReasoningEffort: "medium",
          additionalSpeedTiers: ["fast"],
        },
      ],
    } as never);
    expect(parsed[0]?.capabilities).toEqual({
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "medium",
      supportsFastMode: true,
    });
  });

  it("also accepts the older string-array supportedReasoningEfforts shape", () => {
    const parsed = parseCodexModelListResponse({
      data: [
        {
          model: "gpt-5.3-codex",
          displayName: "gpt-5.3-codex",
          hidden: false,
          isDefault: false,
          supportedReasoningEfforts: ["low", "medium", "high"],
          defaultReasoningEffort: "medium",
        },
      ],
    } as never);
    expect(parsed[0]?.capabilities?.reasoningEfforts).toEqual(["low", "medium", "high"]);
    expect(parsed[0]?.capabilities?.supportsFastMode).toBeUndefined();
  });

  it("omits the capabilities surface when the model advertises neither", () => {
    const parsed = parseCodexModelListResponse({
      data: [
        {
          model: "gpt-5-codex",
          displayName: "gpt-5-codex",
          hidden: false,
          isDefault: false,
        },
      ],
    } as never);
    expect(parsed[0]?.capabilities).toBeUndefined();
  });
});

describe("discoverProviders — dynamic codex models", () => {
  const codexBinary = "/bin/codex";

  it("surfaces the dynamically-probed model list when the probe succeeds", async () => {
    const probed: ProviderModelInfo[] = [
      { slug: "gpt-5-codex", name: "GPT-5 Codex", description: "Code-tuned" },
      { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
    ];
    const providers = await discoverProviders({
      pathLookup: lookup({ codex: codexBinary }),
      exec: execVersion({ [codexBinary]: "codex 0.1.0" }),
      probeCodexModels: async () => probed,
      now: () => 1_000,
    });

    expect(providers[1]?.kind).toBe("codex");
    expect(providers[1]?.models).toEqual(probed);
  });

  it("falls back to the static catalog when the probe returns null (timeout/error)", async () => {
    const providers = await discoverProviders({
      pathLookup: lookup({ codex: codexBinary }),
      exec: execVersion({ [codexBinary]: "codex 0.1.0" }),
      probeCodexModels: async () => null,
      now: () => 1_000,
    });

    // CODEX-FULL #4: static fallback now includes gpt-5.4 (the new
    // default in t3) and gpt-5.3-codex-spark — see CODEX_MODELS in
    // provider-discovery.ts.
    const slugs = providers[1]?.models.map((m) => m.slug) ?? [];
    expect(slugs).toEqual(["gpt-5.4", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5-codex"]);
  });

  it("caches the probed model list across calls (skips re-probe within TTL)", async () => {
    let probeCalls = 0;
    const probe: NonNullable<ProviderDiscoveryOptions["probeCodexModels"]> = async () => {
      probeCalls += 1;
      return [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }];
    };

    await discoverProviders({
      pathLookup: lookup({ codex: codexBinary }),
      exec: execVersion({ [codexBinary]: "codex 0.1.0" }),
      probeCodexModels: probe,
      now: () => 1_000,
    });
    await discoverProviders({
      pathLookup: lookup({ codex: codexBinary }),
      exec: execVersion({ [codexBinary]: "codex 0.1.0" }),
      probeCodexModels: probe,
      now: () => 1_000 + 30_000, // still inside the 60s TTL
    });
    expect(probeCalls).toBe(1);

    await discoverProviders({
      pathLookup: lookup({ codex: codexBinary }),
      exec: execVersion({ [codexBinary]: "codex 0.1.0" }),
      probeCodexModels: probe,
      now: () => 1_000 + 120_000, // TTL expired → re-probe
    });
    expect(probeCalls).toBe(2);
  });

  it("re-probes when the codex binary path changes (cache key includes binary)", async () => {
    let probeCalls = 0;
    const probe: NonNullable<ProviderDiscoveryOptions["probeCodexModels"]> = async () => {
      probeCalls += 1;
      return [{ slug: "gpt-5-codex", name: "GPT-5 Codex" }];
    };

    await discoverProviders({
      pathLookup: lookup({ codex: codexBinary }),
      exec: execVersion({ [codexBinary]: "codex 0.1.0" }),
      probeCodexModels: probe,
      now: () => 1_000,
    });
    await discoverProviders({
      pathLookup: lookup({ codex: "/opt/homebrew/bin/codex" }),
      exec: execVersion({ "/opt/homebrew/bin/codex": "codex 0.2.0" }),
      probeCodexModels: probe,
      now: () => 1_001,
    });

    expect(probeCalls).toBe(2);
  });
});
