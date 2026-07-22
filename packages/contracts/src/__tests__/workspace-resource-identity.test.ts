import { describe, expect, it } from "vitest";
import {
  WorkspaceChangeResourceIdSchemaZ,
  WorkspaceChangesRevisionSchemaZ,
  WorkspaceFileResourceIdSchemaZ,
  WorkspaceFilesRevisionSchemaZ,
  WorkspaceRelativeDisplayPathSchemaZ,
  WorkspaceResourceNameSchemaZ,
  WorkspaceResourceOpaqueTokenSchemaZ,
  WorkspaceResourceWorkspaceNameSchemaZ,
} from "../workspace-resource-identity.ts";

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const TAB = String.fromCharCode(9);
const DEL = String.fromCharCode(127);

describe("workspace resource identity", () => {
  it("accepts prefixed opaque ids and rejects path-shaped or reserved values", () => {
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("file.0123456789abcdef").success).toBe(true);
    expect(WorkspaceChangeResourceIdSchemaZ.safeParse("change.0123456789abcdef").success).toBe(
      true,
    );
    expect(WorkspaceFilesRevisionSchemaZ.safeParse("files-rev.0123456789abcdef").success).toBe(
      true,
    );
    expect(WorkspaceChangesRevisionSchemaZ.safeParse("changes-rev.0123456789abcdef").success).toBe(
      true,
    );

    // Wrong prefix, missing prefix, and cross-prefix are all rejected.
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("change.0123456789abcdef").success).toBe(false);
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("0123456789abcdef").success).toBe(false);
    // A path separator can never appear inside an opaque id.
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("file.../etc/passwd").success).toBe(false);
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("file.a/b0123456789abcd").success).toBe(false);
    // Reserved record keys cannot masquerade as an id.
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("__proto__").success).toBe(false);
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("file.__proto__").success).toBe(false);
    // Length bounds: too short, and past the 64-char token ceiling.
    expect(WorkspaceFileResourceIdSchemaZ.safeParse("file.short").success).toBe(false);
    expect(WorkspaceFileResourceIdSchemaZ.safeParse(`file.${"a".repeat(65)}`).success).toBe(false);
  });

  it("bounds the bare opaque token", () => {
    expect(WorkspaceResourceOpaqueTokenSchemaZ.safeParse("0123456789abcdef").success).toBe(true);
    expect(WorkspaceResourceOpaqueTokenSchemaZ.safeParse("short").success).toBe(false);
    expect(WorkspaceResourceOpaqueTokenSchemaZ.safeParse("has/slash012345678").success).toBe(
      false,
    );
  });

  it("treats a resource name as a single sanitized path segment", () => {
    expect(WorkspaceResourceNameSchemaZ.safeParse("index.ts").success).toBe(true);
    expect(WorkspaceResourceNameSchemaZ.safeParse(".gitignore").success).toBe(true);

    expect(WorkspaceResourceNameSchemaZ.safeParse(".").success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse("..").success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse("").success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse("a/b").success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse("a\\b").success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse(`a${NUL}b`).success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse(`a${BELL}b`).success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse(`a${DEL}b`).success).toBe(false);
    expect(WorkspaceResourceNameSchemaZ.safeParse("a".repeat(256)).success).toBe(false);
  });

  it("keeps display paths relative, forward-slashed, and control-free", () => {
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("src/index.ts").success).toBe(true);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("README.md").success).toBe(true);

    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("/etc/passwd").success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("../secret").success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("src/../secret").success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("a//b").success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("src\\index.ts").success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("src/.").success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse(`a${TAB}b`).success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse(`a${DEL}b`).success).toBe(false);
    expect(WorkspaceRelativeDisplayPathSchemaZ.safeParse("a".repeat(1_025)).success).toBe(false);
  });

  it("accepts a semantic workspace name but rejects control characters", () => {
    expect(WorkspaceResourceWorkspaceNameSchemaZ.safeParse("tmux-ide").success).toBe(true);
    expect(WorkspaceResourceWorkspaceNameSchemaZ.parse("  spaced name  ")).toBe("spaced name");

    expect(WorkspaceResourceWorkspaceNameSchemaZ.safeParse("").success).toBe(false);
    expect(WorkspaceResourceWorkspaceNameSchemaZ.safeParse(`with${NUL}nul`).success).toBe(false);
    expect(WorkspaceResourceWorkspaceNameSchemaZ.safeParse(`with${DEL}del`).success).toBe(false);
    expect(WorkspaceResourceWorkspaceNameSchemaZ.safeParse("a".repeat(161)).success).toBe(false);
  });
});
