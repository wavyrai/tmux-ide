import { describe, expect, it } from "vitest";

import {
  projectWorkspaceCatalogV2,
  projectWorkspaceCatalogV3,
} from "./workspace-catalog-resource.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};
const alphaFleetSessionId = "session.aaaaaaaaaaaaaaaaaaaa";

describe("projectWorkspaceCatalogV2", () => {
  it("keeps durable intent while publishing zero live sessions", () => {
    expect(
      projectWorkspaceCatalogV2(
        daemon,
        [{ workspaceName: "alpha", sessionName: "alpha", source: "project" }],
        [],
      ),
    ).toEqual({
      version: 2,
      daemon,
      intents: [
        {
          workspaceName: "alpha",
          sessionName: "alpha",
          source: "project",
          availability: "stopped",
        },
      ],
      liveSessions: [],
    });
  });

  it("marks only an exactly observed tmux session live", () => {
    const result = projectWorkspaceCatalogV2(
      daemon,
      [
        { workspaceName: "alpha", sessionName: "alpha-live", source: "workspace" },
        { workspaceName: "beta", sessionName: "beta", source: "project" },
      ],
      [
        {
          sessionName: "alpha-live",
          fleetSessionId: alphaFleetSessionId,
          paneCount: 2,
        },
      ],
    );
    expect(result.intents.map(({ availability }) => availability)).toEqual(["live", "stopped"]);
    expect(result.liveSessions).toEqual([
      {
        sessionName: "alpha-live",
        fleetSessionId: alphaFleetSessionId,
        paneCount: 2,
      },
    ]);
  });

  it("requires a daemon-minted opaque id for every exact live-session route", () => {
    expect(() =>
      projectWorkspaceCatalogV2(
        daemon,
        [],
        [
          // @ts-expect-error Proves the runtime schema rejects the legacy identity-less row.
          { sessionName: "alpha-live", paneCount: 2 },
        ],
      ),
    ).toThrow();
    expect(() =>
      projectWorkspaceCatalogV2(
        daemon,
        [],
        [{ sessionName: "alpha-live", fleetSessionId: "$1", paneCount: 2 }],
      ),
    ).toThrow();
  });
});

describe("projectWorkspaceCatalogV3", () => {
  it("adds a strict tmux-incarnation identity without weakening V2 routing", () => {
    expect(
      projectWorkspaceCatalogV3(
        daemon,
        [],
        [
          {
            liveSessionId: "live-session.bbbbbbbbbbbbbbbbbbbb",
            sessionName: "alpha-live",
            fleetSessionId: alphaFleetSessionId,
            paneCount: 2,
          },
        ],
      ),
    ).toMatchObject({
      version: 3,
      liveSessions: [
        {
          liveSessionId: "live-session.bbbbbbbbbbbbbbbbbbbb",
          sessionName: "alpha-live",
        },
      ],
    });

    expect(() =>
      projectWorkspaceCatalogV3(
        daemon,
        [],
        [
          {
            liveSessionId: "alpha-live",
            sessionName: "alpha-live",
            fleetSessionId: alphaFleetSessionId,
            paneCount: 2,
          },
        ],
      ),
    ).toThrow();

    expect(() =>
      projectWorkspaceCatalogV3(
        daemon,
        [],
        [
          {
            liveSessionId: "live-session.bbbbbbbbbbbbbbbbbbbb",
            sessionName: "alpha-live",
            fleetSessionId: alphaFleetSessionId,
            paneCount: 1,
          },
          {
            liveSessionId: "live-session.bbbbbbbbbbbbbbbbbbbb",
            sessionName: "beta-live",
            fleetSessionId: "session.cccccccccccccccccccc",
            paneCount: 1,
          },
        ],
      ),
    ).toThrow("duplicate live session identity");
  });
});
