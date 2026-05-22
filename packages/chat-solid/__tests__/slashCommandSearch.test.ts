import { describe, expect, it } from "vitest";
import { searchSlashCommands } from "../src/lib/slashCommandSearch";
import type { AvailableCommand } from "../src/types";

const commands: AvailableCommand[] = [
  { name: "commit", description: "Create a commit" },
  { name: "copy", description: "Copy text" },
  { name: "recommit", description: "Commit again" },
  { name: "gh-fix-ci", description: "Fix CI with GitHub" },
  { name: "deploy", description: "Deploy app" },
  { name: "/compact", description: "Compact context" },
];

describe("searchSlashCommands", () => {
  it("returns all commands for an empty query with shortest names first", () => {
    expect(searchSlashCommands(commands, "").map((result) => result.command.name)).toEqual([
      "copy",
      "commit",
      "deploy",
      "/compact",
      "recommit",
      "gh-fix-ci",
    ]);
  });

  it("ranks exact and prefix matches above substring matches", () => {
    expect(searchSlashCommands(commands, "co").map((result) => result.command.name)).toEqual([
      "copy",
      "commit",
      "/compact",
      "recommit",
    ]);
  });

  it("matches subsequences but ranks them below substrings", () => {
    const results = searchSlashCommands(commands, "mit");
    expect(results.map((result) => result.command.name)).toEqual(["commit", "recommit"]);
    expect(searchSlashCommands(commands, "cmt").map((result) => result.command.name)).toEqual([
      "commit",
      "/compact",
      "recommit",
    ]);
  });

  it("matches case-insensitively", () => {
    expect(searchSlashCommands(commands, "CO").map((result) => result.command.name)).toContain(
      "commit",
    );
  });

  it("excludes non-matches", () => {
    expect(searchSlashCommands(commands, "xyz")).toEqual([]);
  });

  it("returns matched indices for highlighting", () => {
    expect(searchSlashCommands(commands, "com")[0]?.matched).toEqual([0, 1, 2]);
    expect(searchSlashCommands(commands, "com")[1]?.matched).toEqual([1, 2, 3]);
  });
});
