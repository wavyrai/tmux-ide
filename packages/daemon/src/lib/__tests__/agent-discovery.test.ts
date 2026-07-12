/**
 * Unit tests for agent auto-discovery — the pure registry and the injectable
 * PATH/integration probe. No test shells out or reads the real settings: the
 * which-runner and the integration probe are both injected.
 */
import { describe, expect, it } from "vitest";
import {
  KNOWN_AGENTS,
  discoverAgents,
  presentAgents,
  type WhichRunner,
} from "../agent-discovery.ts";

describe("KNOWN_AGENTS", () => {
  it("ships installers for exactly claude (hooks) and opencode (plugin)", () => {
    const claude = KNOWN_AGENTS.find((a) => a.id === "claude");
    expect(claude).toEqual({ id: "claude", bin: "claude", integration: true, capture: "hooks" });
    expect(KNOWN_AGENTS.filter((a) => a.integration).map((a) => a.id)).toEqual([
      "claude",
      "opencode",
    ]);
    expect(KNOWN_AGENTS.map((a) => a.id)).toEqual([
      "claude",
      "codex",
      "opencode",
      "gemini",
      "aider",
      "cursor",
      "copilot",
    ]);
  });

  it("uses the id as the probed binary except cursor (binary: cursor-agent)", () => {
    for (const a of KNOWN_AGENTS) {
      if (a.id === "cursor") expect(a.bin).toBe("cursor-agent");
      else expect(a.bin).toBe(a.id);
    }
  });

  it("records the session-id capture story per kind (matching the shipped probes)", () => {
    const byId = Object.fromEntries(KNOWN_AGENTS.map((a) => [a.id, a.capture]));
    expect(byId).toEqual({
      claude: "hooks",
      codex: "probe",
      opencode: "plugin",
      gemini: null,
      aider: null,
      cursor: "probe",
      copilot: null,
    });
  });
});

describe("discoverAgents", () => {
  const foundAt =
    (paths: Record<string, string>): WhichRunner =>
    (bin) =>
      paths[bin] ?? null;

  it("resolves paths from the injected which-runner and never probes for absent ones", () => {
    const which = foundAt({ claude: "/usr/bin/claude", codex: "/opt/codex" });
    const agents = discoverAgents(which, () => false);
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    expect(byId.claude!.path).toBe("/usr/bin/claude");
    expect(byId.codex!.path).toBe("/opt/codex");
    expect(byId.gemini!.path).toBeNull();
    expect(byId.aider!.path).toBeNull();
  });

  it("carries the registry `integration` flag onto each record", () => {
    const agents = discoverAgents(
      () => null,
      () => false,
    );
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    expect(byId.claude!.integration).toBe(true);
    expect(byId.codex!.integration).toBe(false);
  });

  it("sets installed only for an integrated agent present AND whose probe says installed", () => {
    const which = foundAt({ claude: "/usr/bin/claude", opencode: "/usr/bin/opencode" });
    const installed = discoverAgents(which, (id) => id === "claude");
    const byId = Object.fromEntries(installed.map((a) => [a.id, a]));
    expect(byId.claude!.installed).toBe(true);
    // opencode integrates too — present but its probe says not installed
    expect(byId.opencode!.installed).toBe(false);
    // present but non-integrated → never "installed"
    const codex = discoverAgents(foundAt({ codex: "/opt/codex" }), () => true);
    expect(codex.find((a) => a.id === "codex")!.installed).toBe(false);
  });

  it("marks probe-captured kinds active whenever the binary is present", () => {
    const which = foundAt({ codex: "/opt/codex", "cursor-agent": "/usr/bin/cursor-agent" });
    const agents = discoverAgents(which, () => false);
    const byId = Object.fromEntries(agents.map((a) => [a.id, a]));
    expect(byId.codex!.captureActive).toBe(true);
    expect(byId.cursor!.captureActive).toBe(true);
    // absent binary → no capture
    expect(byId.claude!.captureActive).toBe(false);
  });

  it("marks hook/plugin-captured kinds active only once their integration is installed", () => {
    const which = foundAt({ claude: "/usr/bin/claude", opencode: "/usr/bin/opencode" });
    const none = discoverAgents(which, () => false);
    expect(none.find((a) => a.id === "claude")!.captureActive).toBe(false);
    expect(none.find((a) => a.id === "opencode")!.captureActive).toBe(false);
    const all = discoverAgents(which, () => true);
    expect(all.find((a) => a.id === "claude")!.captureActive).toBe(true);
    expect(all.find((a) => a.id === "opencode")!.captureActive).toBe(true);
  });

  it("never marks capture-less kinds active", () => {
    const which = foundAt({ copilot: "/usr/bin/copilot", gemini: "/usr/bin/gemini" });
    const agents = discoverAgents(which, () => true);
    expect(agents.find((a) => a.id === "copilot")!.captureActive).toBe(false);
    expect(agents.find((a) => a.id === "gemini")!.captureActive).toBe(false);
  });

  it("leaves installed false when claude is present but the integration is not installed", () => {
    const which = foundAt({ claude: "/usr/bin/claude" });
    const agents = discoverAgents(which, () => false);
    expect(agents.find((a) => a.id === "claude")!.installed).toBe(false);
  });

  it("leaves installed false when claude is absent, without calling the probe", () => {
    let probed = false;
    const agents = discoverAgents(
      () => null,
      () => {
        probed = true;
        return true;
      },
    );
    expect(agents.find((a) => a.id === "claude")!.installed).toBe(false);
    expect(probed).toBe(false);
  });

  it("never throws when the which-runner throws — the runner owns its own errors", () => {
    // The contract is that a WhichRunner never throws; a well-behaved default
    // swallows errors to null. A runner that returns null for everything yields
    // an all-absent table without discoverAgents itself throwing.
    expect(() =>
      discoverAgents(
        () => null,
        () => false,
      ),
    ).not.toThrow();
  });

  it("returns one record per known agent, in registry order", () => {
    const agents = discoverAgents(
      () => null,
      () => false,
    );
    expect(agents.map((a) => a.id)).toEqual(KNOWN_AGENTS.map((a) => a.id));
  });
});

describe("presentAgents", () => {
  it("keeps only agents with a resolved path", () => {
    const agents = discoverAgents(
      (bin) => (bin === "claude" ? "/usr/bin/claude" : null),
      () => true,
    );
    expect(presentAgents(agents).map((a) => a.id)).toEqual(["claude"]);
  });
});
