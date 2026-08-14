import { describe, expect, it } from "bun:test";

import {
  initialWorkspaceCatalogV2State,
  replaceWorkspaceCatalogV2,
} from "./workspace-catalog-v2.ts";

const daemon = (instanceId: string) => ({
  protocolVersion: 1,
  productVersion: "test",
  instanceId,
  startedAt: "2026-08-12T00:00:00.000Z",
});
const retiredFleetSessionId = "session.aaaaaaaaaaaaaaaaaaaa";
const sameFleetSessionId = "session.bbbbbbbbbbbbbbbbbbbb";

describe("workspace catalog V2 state", () => {
  it("keeps stopped durable intent separate from observed live tmux sessions", () => {
    const state = replaceWorkspaceCatalogV2(initialWorkspaceCatalogV2State(), {
      version: 2,
      daemon: daemon("11111111-1111-4111-8111-111111111111"),
      intents: [
        {
          workspaceName: "saved-workspace",
          sessionName: "saved-session",
          source: "workspace",
          availability: "live",
        },
      ],
      liveSessions: [],
    });

    expect(state.intents).toEqual([
      expect.objectContaining({ workspaceName: "saved-workspace", availability: "stopped" }),
    ]);
    expect(state.liveSessions).toEqual([]);
  });

  it("replaces rather than merges state across daemon generations", () => {
    const first = replaceWorkspaceCatalogV2(initialWorkspaceCatalogV2State(), {
      version: 2,
      daemon: daemon("11111111-1111-4111-8111-111111111111"),
      intents: [
        {
          workspaceName: "retired",
          sessionName: "retired",
          source: "project",
          availability: "live",
        },
      ],
      liveSessions: [
        { sessionName: "retired", fleetSessionId: retiredFleetSessionId, paneCount: 2 },
      ],
    });
    const replacement = replaceWorkspaceCatalogV2(first, {
      version: 2,
      daemon: daemon("22222222-2222-4222-8222-222222222222"),
      intents: [],
      liveSessions: [],
    });

    expect(replacement).toEqual({
      daemonInstanceId: "22222222-2222-4222-8222-222222222222",
      intents: [],
      liveSessions: [],
    });
  });

  it("rejects duplicate observed session identities", () => {
    expect(() =>
      replaceWorkspaceCatalogV2(initialWorkspaceCatalogV2State(), {
        version: 2,
        daemon: daemon("11111111-1111-4111-8111-111111111111"),
        intents: [],
        liveSessions: [
          { sessionName: "same", fleetSessionId: sameFleetSessionId, paneCount: 1 },
          { sessionName: "same", fleetSessionId: sameFleetSessionId, paneCount: 2 },
        ],
      }),
    ).toThrow("duplicate live session");
  });

  it("retains the opaque promotion identity on the exact live route", () => {
    const state = replaceWorkspaceCatalogV2(initialWorkspaceCatalogV2State(), {
      version: 2,
      daemon: daemon("11111111-1111-4111-8111-111111111111"),
      intents: [],
      liveSessions: [{ sessionName: "alpha", fleetSessionId: retiredFleetSessionId, paneCount: 1 }],
    });

    expect(state.liveSessions).toEqual([
      { sessionName: "alpha", fleetSessionId: retiredFleetSessionId, paneCount: 1 },
    ]);
  });

  it("rejects one opaque promotion identity assigned to two routing names", () => {
    expect(() =>
      replaceWorkspaceCatalogV2(initialWorkspaceCatalogV2State(), {
        version: 2,
        daemon: daemon("11111111-1111-4111-8111-111111111111"),
        intents: [],
        liveSessions: [
          { sessionName: "alpha", fleetSessionId: sameFleetSessionId, paneCount: 1 },
          { sessionName: "beta", fleetSessionId: sameFleetSessionId, paneCount: 1 },
        ],
      }),
    ).toThrow("duplicate fleet session");
  });
});
