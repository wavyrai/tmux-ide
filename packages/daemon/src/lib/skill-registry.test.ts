import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, loadSkill } from "./skill-registry.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-skill-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadSkills", () => {
  it("returns empty array when skills dir does not exist", () => {
    expect(loadSkills(tmpDir)).toEqual([]);
  });

  it("loads skill from markdown file with YAML frontmatter", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "frontend.md"),
      `---
name: frontend
specialties: [react, css, typescript]
role: teammate
description: Frontend component specialist
---
You are a frontend developer. Focus on React components and CSS.
`,
    );

    const skills = loadSkills(tmpDir);
    expect(skills.length).toBe(1);
    expect(skills[0]!.name).toBe("frontend");
    expect(skills[0]!.specialties).toEqual(["react", "css", "typescript"]);
    expect(skills[0]!.role).toBe("teammate");
    expect(skills[0]!.description).toBe("Frontend component specialist");
    expect(skills[0]!.body).toBe(
      "You are a frontend developer. Focus on React components and CSS.",
    );
  });

  it("loads multiple skills", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "backend.md"),
      `---
name: backend
specialties: api, database
role: teammate
description: Backend API specialist
---
Backend instructions.
`,
    );
    writeFileSync(
      join(skillsDir, "qa.md"),
      `---
name: qa
role: validator
description: QA validator
---
QA instructions.
`,
    );

    const skills = loadSkills(tmpDir);
    expect(skills.length).toBe(2);
  });

  it("parses comma-separated specialties string", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "test.md"),
      `---
name: test
specialties: api, database, auth
---
Body.
`,
    );

    const skills = loadSkills(tmpDir);
    expect(skills[0]!.specialties).toEqual(["api", "database", "auth"]);
  });

  it("skips files without valid frontmatter", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "bad.md"), "No frontmatter here");

    expect(loadSkills(tmpDir)).toEqual([]);
  });

  it("skips non-md files", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, "readme.txt"), "not a skill");

    expect(loadSkills(tmpDir)).toEqual([]);
  });
});

describe("loadSkill", () => {
  it("returns skill by name", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "test.md"),
      `---
name: test-skill
role: teammate
description: A test skill
---
Instructions.
`,
    );

    const skill = loadSkill(tmpDir, "test-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("test-skill");
  });

  it("returns null for unknown skill", () => {
    expect(loadSkill(tmpDir, "nonexistent")).toBeNull();
  });
});
