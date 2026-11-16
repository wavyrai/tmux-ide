import { describe, expect, it } from "vitest";

import { daemonUpdateOutcome } from "./update-daemon-outcome.ts";

describe("tmux-ide update --daemon after a rollback (bug sweep, group I)", () => {
  it("says that a newer daemon was left running and how to run this version's", () => {
    const supervised = daemonUpdateOutcome(
      { productVersion: "2.9.24", pid: 42, supervised: true },
      "2.9.20",
    );
    expect(supervised.status).toBe("kept-newer");
    expect(supervised.message).toMatch(
      /v2\.9\.24.*newer than this CLI \(v2\.9\.20\).*left running/su,
    );
    expect(supervised.message).toContain("tmux-ide daemon service restart");
    const unsupervised = daemonUpdateOutcome(
      { productVersion: "2.9.24", pid: 42, supervised: false },
      "2.9.20",
    );
    expect(unsupervised.status).toBe("kept-newer");
    expect(unsupervised.message).toContain("pid 42");
    expect(unsupervised.message).toContain("tmux-ide update --daemon");
  });

  it("reports ready for the same or an older running version, and for versions it cannot compare", () => {
    for (const running of ["2.9.20", "2.9.19", "dev-build"])
      expect(
        daemonUpdateOutcome({ productVersion: running, pid: 1, supervised: false }, "2.9.20"),
      ).toEqual({
        status: "ready",
        message: `Daemon ready: ${running}`,
      });
  });
});
