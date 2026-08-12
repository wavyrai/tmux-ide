import { describe, expect, it } from "vitest";

import { projectWorkspaceCatalogV2 } from "./workspace-catalog-resource.ts";

const daemon = {
  protocolVersion: 1,
  productVersion: "2.8.0",
  instanceId: "9bcf33b0-c837-4a94-b5e8-c0977f54464f",
  startedAt: "2026-07-21T00:00:00.000Z",
};

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
      [{ sessionName: "alpha-live", paneCount: 2 }],
    );
    expect(result.intents.map(({ availability }) => availability)).toEqual(["live", "stopped"]);
    expect(result.liveSessions).toEqual([{ sessionName: "alpha-live", paneCount: 2 }]);
  });
});
