import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillCreateHandler, skillDeleteHandler, skillUpdateHandler } from "./skill-actions.ts";

let dir: string;
let broadcasts: string[];

const skillContent = (name = "reviewer") => `---
name: ${name}
role: teammate
specialties: [review]
description: Reviews code
---
Review code carefully.
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tmux-ide-skill-actions-"));
  broadcasts = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("skill actions", () => {
  it("creates, updates, and deletes project skills", () => {
    const deps = {
      cwd: dir,
      broadcastSkillsChanged: (sessionName: string) => broadcasts.push(sessionName),
    };

    const created = skillCreateHandler({ name: "reviewer", content: skillContent() }, deps);
    expect(created.skill.name).toBe("reviewer");

    const updated = skillUpdateHandler(
      { name: "reviewer", content: skillContent("reviewer").replace("carefully", "deeply") },
      deps,
    );
    expect(updated.skill.body).toContain("deeply");

    expect(skillDeleteHandler({ name: "reviewer" }, deps)).toEqual({ deleted: true });
    expect(broadcasts.length).toBe(3);
  });

  it("raises skill_not_found for missing updates", () => {
    expect(() =>
      skillUpdateHandler({ name: "missing", content: skillContent("missing") }, { cwd: dir }),
    ).toThrow(/Skill "missing" not found/);
  });

  it("raises skill_invalid for mismatched frontmatter", () => {
    expect(() =>
      skillCreateHandler({ name: "reviewer", content: skillContent("other") }, { cwd: dir }),
    ).toThrow(/does not match/);
  });
});
