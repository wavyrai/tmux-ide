import { expect, it } from "vitest";
import { PaneStreamClientFrameSchemaZ, PaneStreamServerFrameSchemaZ } from "../pane-stream.ts";
const generation = "12345678-1234-4234-8234-123456789abc";
const frame = {
  type: "terminal-graphics-local",
  pane: "pane.one",
  generation,
  leaseId: generation,
  path: `/private/local-images-${generation}/local-images-abcdef/${"a".repeat(64)}`,
  expiresAt: 1000,
  blob: { digest: "a".repeat(32), format: "png", width: 1, height: 1, total: 3, offset: 0 },
};
it("local descriptor metadata is bounded, strict, and carries no image bytes", () => {
  expect(PaneStreamServerFrameSchemaZ.parse(frame)).toEqual(frame);
  for (const patch of [
    { path: "relative" },
    { path: "/a\0b" },
    { path: "/".repeat(4097) },
    { generation: "bad" },
    { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
    { data: "pixels" },
    { blob: { ...frame.blob, offset: 1 } },
    { blob: { ...frame.blob, total: 0 } },
  ])
    expect(PaneStreamServerFrameSchemaZ.safeParse({ ...frame, ...patch }).success).toBe(false);
});
it("release identity and bounded inline retry use ordinary client validation", () => {
  const release = {
    type: "terminal-graphics-local-release",
    pane: "pane.one",
    generation,
    leaseId: generation,
  };
  expect(PaneStreamClientFrameSchemaZ.parse(release)).toEqual(release);
  expect(PaneStreamClientFrameSchemaZ.safeParse({ ...release, path: "/arbitrary" }).success).toBe(
    false,
  );
  const request = {
    type: "terminal-graphics-request",
    pane: "pane.one",
    digests: ["a".repeat(32)],
    preferInline: true,
  };
  expect(PaneStreamClientFrameSchemaZ.parse(request)).toEqual(request);
  expect(PaneStreamClientFrameSchemaZ.safeParse({ ...request, preferInline: "yes" }).success).toBe(
    false,
  );
});
