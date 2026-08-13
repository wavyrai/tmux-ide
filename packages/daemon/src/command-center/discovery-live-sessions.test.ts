import { describe, expect, it } from "vitest";

import { discoverLiveSessionSummaries } from "./discovery.ts";

describe("live tmux session summaries", () => {
  it("keeps ordinary sessions independent from durable workspace intent", () => {
    expect(
      discoverLiveSessionSummaries(() =>
        [
          "ordinary",
          "ordinary",
          "ordinary",
          "second",
          "_tmux-ide-chrome",
          "zz-scratch",
          "zz-scratch",
        ].join("\n"),
      ),
    ).toEqual([
      { sessionName: "ordinary", paneCount: 3 },
      { sessionName: "second", paneCount: 1 },
    ]);
  });

  it("degrades an unavailable tmux server to an empty observed collection", () => {
    expect(
      discoverLiveSessionSummaries(() => {
        throw new Error("no server");
      }),
    ).toEqual([]);
  });
});
