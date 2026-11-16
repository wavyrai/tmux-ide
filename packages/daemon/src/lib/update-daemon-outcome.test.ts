import { describe, expect, it } from "vitest";

import { daemonUpdateOutcome } from "./update-daemon-outcome.ts";

const daemon = (productVersion: string, how: "manual" | "supervised" | "embedded" = "manual") => ({
  productVersion,
  pid: 42,
  supervised: how === "supervised",
  embedded: how === "embedded",
});

describe("tmux-ide update --daemon after a rollback (bug sweep, group I)", () => {
  it("says that a newer daemon was left running and how to run this version's", () => {
    const manual = daemonUpdateOutcome(daemon("2.9.24"), "2.9.20");
    expect(manual.status).toBe("kept-newer");
    expect(manual.message).toMatch(/v2\.9\.24.*newer than this CLI \(v2\.9\.20\).*left running/su);
    expect(manual.message).toContain("stop it (pid 42), then run tmux-ide update --daemon again");
  });

  it("does not promise which version a service restart loads (review of #406)", () => {
    const supervised = daemonUpdateOutcome(daemon("2.9.24", "supervised"), "2.9.20");
    expect(supervised.status).toBe("kept-newer");
    expect(supervised.message).toContain("tmux-ide daemon service restart");
    expect(supervised.message).toContain("the installation it was set up with");
    expect(supervised.message).not.toMatch(/restart its service:/u);
  });

  it("says when the daemon runs inside another process (review of #406)", () => {
    const embedded = daemonUpdateOutcome(daemon("2.9.24", "embedded"), "2.9.20");
    expect(embedded.message).toContain("inside another tmux-ide process (pid 42)");
    expect(embedded.message).not.toContain("stop it (pid 42)");
  });

  it("compares versions numerically and by pre-release, not as text", () => {
    expect(daemonUpdateOutcome(daemon("2.10.0"), "2.9.20").status).toBe("kept-newer");
    expect(daemonUpdateOutcome(daemon("2.9.21-rc.1"), "2.9.20").status).toBe("kept-newer");
    expect(daemonUpdateOutcome(daemon("2.9.20-rc.1"), "2.9.20").status).toBe("ready");
  });

  it("reports ready for the same or an older running version, and for versions it cannot compare", () => {
    for (const running of ["2.9.20", "2.9.19", "dev-build"])
      expect(daemonUpdateOutcome(daemon(running), "2.9.20")).toEqual({
        status: "ready",
        message: `Daemon ready: ${running}`,
      });
  });
});
