import { describe, expect, it } from "vitest";

import { ControlModeOwnershipRegistry, controlModeAuthorityKey } from "./control-mode-ownership.ts";

describe("ControlModeOwnershipRegistry", () => {
  it("allows exactly one owner for a server session until release", () => {
    const registry = new ControlModeOwnershipRegistry();
    const authority = controlModeAuthorityKey("workspace", { socketName: "test" });
    const release = registry.claim(authority, Symbol("first"));

    expect(() => registry.claim(authority, Symbol("second"))).toThrow(
      /control-mode authority already exists/,
    );

    release();
    const releaseSuccessor = registry.claim(authority, Symbol("successor"));
    expect(() => releaseSuccessor()).not.toThrow();
  });

  it("isolates distinct sessions and socket selectors", () => {
    const registry = new ControlModeOwnershipRegistry();
    const releases = [
      registry.claim(controlModeAuthorityKey("one", { socketName: "test" }), Symbol("one")),
      registry.claim(controlModeAuthorityKey("two", { socketName: "test" }), Symbol("two")),
      registry.claim(
        controlModeAuthorityKey("one", { socketPath: "/tmp/tmux-test" }),
        Symbol("path"),
      ),
    ];

    for (const release of releases) release();
  });
});
