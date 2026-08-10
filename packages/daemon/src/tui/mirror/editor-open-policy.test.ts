import { describe, expect, it } from "vitest";

import { shouldActivateFilesAfterEditorOpen } from "./editor-open-policy.ts";

describe("shouldActivateFilesAfterEditorOpen", () => {
  it("reveals Files for explicit user opens", () => {
    expect(shouldActivateFilesAfterEditorOpen("terminals", "user")).toBe(true);
    expect(shouldActivateFilesAfterEditorOpen("files", "user")).toBe(false);
  });

  it("keeps workspace hydration navigation-neutral", () => {
    expect(shouldActivateFilesAfterEditorOpen("terminals", "workspace-hydration")).toBe(false);
    expect(shouldActivateFilesAfterEditorOpen("home", "workspace-hydration")).toBe(false);
  });
});
