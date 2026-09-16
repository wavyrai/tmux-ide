import { expect, it } from "vitest";
import { WorkspaceAdmissionSnapshotSchemaZ } from "./workspace-admission.ts";
const snapshot = {
  pending: 0,
  limit: 128,
  disposed: false,
  retained: 128,
  retentionLimit: 128,
  retentionMayBlock: false,
};
it("keeps admission separate from retained history and validates bounded diagnostic fields", () => {
  expect(WorkspaceAdmissionSnapshotSchemaZ.parse(snapshot)).toEqual(snapshot);
  for (const invalid of [
    { ...snapshot, pending: -1 },
    { ...snapshot, pending: Number.POSITIVE_INFINITY },
    { ...snapshot, retained: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, limit: 0 },
    { ...snapshot, authToken: "secret" },
  ])
    expect(WorkspaceAdmissionSnapshotSchemaZ.safeParse(invalid).success).toBe(false);
});
