import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyOpenTarget, createReaderPane } from "./open-reader.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function project() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "open-reader-")));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "docs", "notes.md"), "# Notes");
  writeFileSync(join(root, "NOTES.MARKDOWN"), "# Notes");
  writeFileSync(join(root, "page.html"), "<p>");
  writeFileSync(join(root, "plain.txt"), "x");
  mkdirSync(join(root, "folder.md"));
  symlinkSync(join(root, "plain.txt"), join(root, "fake.md"));
  return root;
}

describe("open target classification", () => {
  it("sends URLs, addresses and other files to the browser", () => {
    const root = project();
    for (const arg of [
      undefined,
      "https://x",
      "http://example.com/readme.md",
      "file:///tmp/notes.md",
      "localhost:3000",
      "page.html",
      "plain.txt",
    ])
      expect(classifyOpenTarget(arg, root)).toEqual({ kind: "browser" });
  });
  it("reads existing Markdown files in any case, by their real path", () => {
    const root = project();
    expect(classifyOpenTarget("docs/notes.md", root)).toEqual({
      kind: "reader",
      path: join(root, "docs", "notes.md"),
      display: "docs/notes.md",
    });
    expect(classifyOpenTarget("NOTES.MARKDOWN", root)).toMatchObject({
      kind: "reader",
      path: join(root, "NOTES.MARKDOWN"),
    });
    expect(classifyOpenTarget(join(root, "docs", "notes.md"), "/")).toMatchObject({
      kind: "reader",
    });
  });
  it("refuses a missing file, a folder and a link to a non-Markdown file", () => {
    const root = project();
    for (const arg of ["missing.md", "docs/missing.markdown", "folder.md"])
      expect(() => classifyOpenTarget(arg, root)).toThrow(
        expect.objectContaining({ code: "FILE_NOT_FOUND" }),
      );
    expect(() => classifyOpenTarget("fake.md", root)).toThrow(
      expect.objectContaining({ code: "NOT_MARKDOWN" }),
    );
  });
});

describe("reader pane creation", () => {
  it("splits beside the caller, runs the TUI renderer and stamps the reader option", () => {
    const calls: string[][] = [];
    const result = createReaderPane(
      (args) => {
        calls.push([...args]);
        if (args[0] === "display-message") return "$2\t@4\t%8\t123";
        if (args[0] === "split-window") return "$2\t@4\t%9\t4242";
        return "";
      },
      ["/usr/bin/node", "/opt/tmux-ide/bin/cli.js"],
      "/repo/docs/notes.md",
      { split: "down", size: "40" },
      { TMUX: "/tmp/socket,123,2", TMUX_PANE: "%8", PATH: "/usr/bin" },
      "/repo",
      {},
    );
    expect(result).toEqual({
      pane: "%9",
      session: "$2",
      window: "@4",
      status: "created",
      kind: "reader",
    });
    const split = calls[1]!;
    expect(split).toEqual(expect.arrayContaining(["split-window", "-v", "40%", "$2:@4.%8"]));
    expect(split.slice(-4)).toEqual([
      "/usr/bin/node",
      "/opt/tmux-ide/bin/cli.js",
      "show",
      "/repo/docs/notes.md",
    ]);
    expect(calls[2]).toEqual([
      "set-option",
      "-p",
      "-t",
      "%9",
      "@tmux_ide_reader",
      JSON.stringify({ version: 1, pid: 4242, path: "/repo/docs/notes.md" }),
    ]);
  });
  it("refuses a split that reports no pane pid", () => {
    expect(() =>
      createReaderPane(
        (args) => (args[0] === "display-message" ? "$2\t@4\t%8\t123" : "$2\t@4\t%9\t"),
        ["/usr/bin/node", "/cli.js"],
        "/repo/notes.md",
        {},
        { TMUX: "/tmp/socket,123,2", TMUX_PANE: "%8" },
        "/repo",
        {},
      ),
    ).toThrow(expect.objectContaining({ code: "READER_CREATE_FAILED" }));
  });
});
