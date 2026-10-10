import { expect, it, vi } from "vitest";
import { SessionRuntimeRegistry } from "./registry.ts";

const generation = "11111111-1111-4111-8111-111111111111";

it("asserts exact geometry ownership without acquiring input, attaching or fitting", async () => {
  const createIo = vi.fn(() => {
    throw new Error("must not attach");
  });
  const registry = new SessionRuntimeRegistry({ generation, mirror: { createIo } });
  try {
    const owner = registry.connect("proof", "web", "client:owner");
    owner.updatePresence("foreground");
    const lease = owner.acquireAuthority("geometry")!;
    expect(lease).not.toBeNull();
    const before = owner.authoritySnapshot();
    owner.assertGeometryAuthority(lease);
    expect(owner.authoritySnapshot()).toEqual(before);
    expect(before.owners.input).toBeNull();
    expect(createIo).not.toHaveBeenCalled();
    const other = registry.connect("proof", "web", "client:other");
    expect(() => other.assertGeometryAuthority(lease)).toThrow(
      expect.objectContaining({ code: "invalid-client-capability" }),
    );
    owner.releaseAuthority("geometry");
    const replacement = owner.acquireAuthority("geometry")!;
    expect(() => owner.assertGeometryAuthority(lease)).toThrow(
      expect.objectContaining({ code: "stale-controller-lease" }),
    );
    owner.assertGeometryAuthority(replacement);
    registry.noteNativeGeometryActivity("proof");
    expect(() => owner.assertGeometryAuthority(replacement)).toThrow(
      expect.objectContaining({ code: "stale-controller-lease" }),
    );
  } finally {
    await registry.dispose();
  }
});

it("rejects a current input grant and disposed consumers/runtime", async () => {
  const registry = new SessionRuntimeRegistry({ generation });
  const owner = registry.connect("proof", "web", "client:owner");
  try {
    owner.updatePresence("foreground");
    owner.acquireController();
    const input = owner.acquireAuthority("input")!;
    expect(input).not.toBeNull();
    expect(() => owner.assertGeometryAuthority(input)).toThrow(
      expect.objectContaining({ code: "invalid-client-capability" }),
    );
    const geometry = owner.acquireAuthority("geometry")!;
    owner.assertGeometryAuthority(geometry);
    await registry.dispose();
    expect(() => owner.assertGeometryAuthority(geometry)).toThrow();
  } finally {
    await registry.dispose();
  }
});

it("rechecks shared-window refusal before accepting an otherwise current grant", async () => {
  const { MirrorService } = await import("../mirror/mirror-service.ts");
  const registry = new SessionRuntimeRegistry({ generation });
  const owner = registry.connect("proof", "web", "client:owner");
  owner.updatePresence("foreground");
  const lease = owner.acquireAuthority("geometry")!;
  const ownership = vi
    .spyOn(MirrorService.prototype, "windowOwnershipMessage")
    .mockReturnValue("Shared window conflict");
  try {
    expect(() => owner.assertGeometryAuthority(lease)).toThrow(
      expect.objectContaining({ code: "controller-conflict" }),
    );
  } finally {
    ownership.mockRestore();
    await registry.dispose();
  }
});
