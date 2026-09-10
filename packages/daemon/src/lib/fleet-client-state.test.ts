import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FleetClientStateChangeSchema } from "@tmux-ide/contracts/fleet-client-state";
import { loadFleetClientState, updateFleetClientState } from "./fleet-client-state.ts";

describe("daemon-owned fleet view persistence", () => {
  it("merges independent preferences, bounds recent history, and writes privately", () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-view-"));
    const path = join(directory, "view.json");
    try {
      updateFleetClientState({ type: "favorite", key: "env-session", enabled: true }, path);
      updateFleetClientState({ type: "collapse", key: "machine", enabled: true }, path);
      for (let i = 0; i < 80; i++) updateFleetClientState({ type: "visit", key: String(i) }, path);
      const saved = loadFleetClientState(path);
      expect(saved.favorites).toEqual(["env-session"]);
      expect(saved.collapsed).toEqual(["machine"]);
      expect(saved.recent).toHaveLength(64);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("preserves invalid files and rejects credential-bearing cache payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "fleet-view-"));
    const path = join(directory, "view.json");
    try {
      writeFileSync(path, "broken");
      expect(() => updateFleetClientState({ type: "visit", key: "x" }, path)).toThrow("preserved");
      expect(readFileSync(path, "utf8")).toBe("broken");
      expect(
        FleetClientStateChangeSchema.safeParse({
          type: "cache",
          route: {
            routeId: "local",
            environmentId: null,
            generation: null,
            seenAt: 1,
            sessions: [],
            authToken: "secret",
          },
        }).success,
      ).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
