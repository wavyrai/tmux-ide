import { describe, expect, it } from "vitest";
import { readerOption } from "./reader-option.ts";

const alive = (pid: number) => pid === 4242;
const pane = "4242";
const raw = (value: unknown) => JSON.stringify(value);
const good = { version: 1, pid: 4242, path: "/repo/docs/Release-Notes.MD" };

describe("reader pane option", () => {
  it("names a live reader's Markdown file", () => {
    expect(readerOption(raw(good), pane, alive)).toEqual({
      name: "Release-Notes.MD",
      path: "/repo/docs/Release-Notes.MD",
      pid: 4242,
    });
    expect(readerOption(raw({ ...good, path: "/a/b.markdown" }), pane, alive)?.name).toBe("b.markdown");
  });
  it("refuses dead, malformed, relative, non-Markdown and control-character options", () => {
    for (const value of [
      "",
      "not json",
      raw(null),
      raw([good]),
      raw({ ...good, pid: 7 }),
      raw({ ...good, pid: 0 }),
      raw({ ...good, pid: "4242" }),
      raw({ ...good, pid: 4242.5 }),
      raw({ ...good, version: 2 }),
      raw({ pid: 4242, path: good.path }),
      raw({ ...good, path: "docs/notes.md" }),
      raw({ ...good, path: "/repo/notes.txt" }),
      raw({ ...good, path: "/repo/notes.md.sh" }),
      raw({ ...good, path: "/repo/.md" }),
      raw({ ...good, path: "/repo/no\u0000tes.md" }),
      raw({ ...good, path: "/repo/no\ntes.md" }),
      raw({ ...good, path: `/${"a".repeat(4096)}.md` }),
      raw({ ...good, path: `/repo/${"a".repeat(256)}.md` }),
      raw({ ...good, extra: true }),
      // C1 controls, refused as the app refuses them (#353 round 2).
      raw({ ...good, path: "/repo/no\u0085tes.md" }),
      raw({ ...good, path: "/repo/\u009bdocs/notes.md" }),
      raw({ ...good, path: "/repo/notes\u0080.md" }),
    ])
      expect(readerOption(value, pane, alive), value.slice(0, 80)).toBeNull();
  });
  it("belongs to the pane only when the pane's own process set it", () => {
    // The CLI starts `tmux-ide show` by tmux's direct exec, so the pane's
    // process is the reader and pane_pid is the pid it recorded.
    expect(readerOption(raw(good), "4242", alive)).not.toBeNull();
    for (const other of ["4243", "", "0", "x", " 4242", "4242\n"])
      expect(readerOption(raw(good), other, () => true), other).toBeNull();
  });
});
