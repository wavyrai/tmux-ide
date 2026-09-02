import { describe, expect, it } from "vitest";

import { discoverLiveSessionSummaries } from "./discovery.ts";

describe("live tmux session summaries", () => {
  it("keeps ordinary sessions independent from durable workspace intent", () => {
    expect(
      discoverLiveSessionSummaries(() =>
        [
          "41\t$0\t100\tordinary",
          "41\t$0\t100\tordinary",
          "41\t$0\t100\tordinary",
          "41\t$1\t101\tsecond",
          "41\t$2\t102\t_tmux-ide-chrome",
          "41\t$3\t103\tzz-scratch",
          "41\t$3\t103\tzz-scratch",
        ].join("\n"),
      ),
    ).toEqual([
      expect.objectContaining({ sessionName: "ordinary", paneCount: 3 }),
      expect.objectContaining({ sessionName: "second", paneCount: 1 }),
    ]);
  });

  it("keeps an identity across rename and replaces it across recreation", () => {
    const read = (row: string) => discoverLiveSessionSummaries(() => row)[0]!.liveSessionId;
    expect(read("41\t$0\t100\tbefore")).toBe(read("41\t$0\t100\tafter"));
    expect(read("41\t$0\t100\tbefore")).not.toBe(read("41\t$1\t101\tbefore"));
    expect(read("41\t$0\t100\tbefore")).not.toBe(read("42\t$0\t100\tbefore"));
  });

  it("degrades an unavailable tmux server to an empty observed collection", () => {
    expect(
      discoverLiveSessionSummaries(() => {
        throw new Error("no server");
      }),
    ).toEqual([]);
  });
});
