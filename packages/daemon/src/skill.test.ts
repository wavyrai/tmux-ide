import { describe, it, beforeEach, afterEach, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills, loadSkill } from "./lib/skill-registry.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "tmux-ide-skill-cli-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("skill list", () => {
  it("returns loaded skills from project directory", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "frontend.md"),
      `---\nname: frontend\nspecialties: [react, css]\nrole: teammate\ndescription: Frontend dev\n---\nBuild UIs.\n`,
    );
    writeFileSync(
      join(skillsDir, "backend.md"),
      `---\nname: backend\nspecialties: [api]\nrole: teammate\ndescription: Backend dev\n---\nBuild APIs.\n`,
    );

    const skills = loadSkills(tmpDir);
    expect(skills.length).toBe(2);
    const names = skills.map((s) => s.name).sort();
    expect(names).toEqual(["backend", "frontend"]);
  });
});

describe("skill show", () => {
  it("returns full skill detail by name", () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "test.md"),
      `---\nname: my-skill\nspecialties: [testing]\nrole: validator\ndescription: Test validator\n---\nRun all tests.\n`,
    );

    const skill = loadSkill(tmpDir, "my-skill");
    expect(skill).not.toBeNull();
    expect(skill!.name).toBe("my-skill");
    expect(skill!.role).toBe("validator");
    expect(skill!.body).toBe("Run all tests.");
  });
});

describe("skill create", () => {
  it("scaffolds a new skill file from template", async () => {
    const { skillCommand } = await import("./skill.ts");
    await skillCommand(tmpDir, { sub: "create", args: ["my-agent"], json: true });

    const filePath = join(tmpDir, ".tmux-ide", "skills", "my-agent.md");
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content.includes("name: my-agent")).toBe(true);
  });
});

describe("skill validate", () => {
  it("detects unresolved skill references", async () => {
    // Create ide.yml with a skill reference
    writeFileSync(
      join(tmpDir, "ide.yml"),
      `name: test\nrows:\n  - panes:\n      - title: Agent\n        skill: nonexistent-skill\n`,
    );

    const { skillCommand } = await import("./skill.ts");

    // Capture console output
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    await skillCommand(tmpDir, { sub: "validate", args: [], json: false });

    console.log = origLog;

    expect(logs.some((l) => l.includes("unresolved"))).toBe(true);
    expect(logs.some((l) => l.includes("nonexistent-skill"))).toBe(true);
  });

  it("reports all references resolved when skills exist", async () => {
    const skillsDir = join(tmpDir, ".tmux-ide", "skills");
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(
      join(skillsDir, "worker.md"),
      `---\nname: worker\nspecialties: []\nrole: teammate\ndescription: Worker\n---\nWork.\n`,
    );
    writeFileSync(
      join(tmpDir, "ide.yml"),
      `name: test\nrows:\n  - panes:\n      - title: Agent\n        skill: worker\n`,
    );

    const { skillCommand } = await import("./skill.ts");

    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));

    await skillCommand(tmpDir, { sub: "validate", args: [], json: false });

    console.log = origLog;

    expect(logs.some((l) => l.includes("All pane skill references resolve"))).toBe(true);
  });
});
