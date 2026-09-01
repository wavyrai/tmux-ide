import { describe, expect, it } from "vitest";

import { friendlySessionLabel } from "../terminal-text.ts";

describe("friendlySessionLabel", () => {
  it("hides daemon route suffixes without changing ordinary tmux names", () => {
    expect(friendlySessionLabel("tmux-ide-local-bc4922493e0123456789")).toBe("tmux-ide-local");
    expect(friendlySessionLabel("my-project")).toBe("my-project");
    expect(friendlySessionLabel("release-deadbeef")).toBe("release-deadbeef");
  });
});
