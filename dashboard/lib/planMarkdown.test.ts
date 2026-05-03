import { describe, expect, it } from "vitest";
import { diffStats, parseFrontmatter, parsePlanDocument } from "./planMarkdown";

describe("planMarkdown", () => {
  it("parses simple frontmatter keys", () => {
    const parsed = parseFrontmatter(`---
title: Ship Plans v2
status: in progress
owner: Agent 1
effort: M
due: 2026-05-05
related: task-001, task-002
tags: [ui, polish]
---
# Body
`);

    expect(parsed.frontmatter).toEqual({
      title: "Ship Plans v2",
      status: "in-progress",
      owner: "Agent 1",
      effort: "M",
      due: "2026-05-05",
      related: ["task-001", "task-002"],
      tags: ["ui", "polish"],
    });
    expect(parsed.content.trim()).toBe("# Body");
  });

  it("extracts a stable toc from headings", () => {
    const parsed = parsePlanDocument(`# Intro
## Work
### Details
## Work
#### Ignored
`);

    expect(parsed.toc).toEqual([
      { id: "intro", text: "Intro", level: 1 },
      { id: "work", text: "Work", level: 2 },
      { id: "details", text: "Details", level: 3 },
      { id: "work-2", text: "Work", level: 2 },
    ]);
  });

  it("counts additions and deletions in diff blocks", () => {
    expect(
      diffStats(`--- a/file.ts
+++ b/file.ts
 unchanged
-old line
+new line
+another line`),
    ).toEqual({ additions: 2, deletions: 1 });
  });
});
