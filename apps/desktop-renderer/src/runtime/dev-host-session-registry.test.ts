import { describe, expect, it } from "vitest";

import { DevelopmentHostSessionRegistry } from "./dev-host-session-registry.ts";

describe("DevelopmentHostSessionRegistry", () => {
  it("gives same-origin documents distinct stable generations", () => {
    let serial = 0;
    const registry = new DevelopmentHostSessionRegistry({
      now: () => 1_000,
      createToken: () => `token-${++serial}`,
      createHostClientId: () => `host-${serial}`,
      ttlMs: 1_000,
      limit: 8,
    });
    const first = registry.mint();
    const second = registry.mint();
    expect(first).not.toEqual(second);
    expect(registry.resolve(first.token)).toBe(first.session);
    expect(registry.resolve(second.token)).toBe(second.session);
    expect(registry.resolve("missing-document-token")).toBeUndefined();
  });

  it("retires stale document tokens instead of reviving their host identity", () => {
    let now = 1_000;
    let serial = 0;
    const registry = new DevelopmentHostSessionRegistry({
      now: () => now,
      createToken: () => `token-${++serial}`,
      createHostClientId: () => `host-${serial}`,
      ttlMs: 100,
      limit: 8,
    });
    const stale = registry.mint();
    now = 1_100;
    expect(registry.resolve(stale.token)).toBeUndefined();
    const replacement = registry.mint();
    expect(replacement.session.hostClientId).not.toBe(stale.session.hostClientId);
  });
});
