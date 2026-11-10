import { describe, expect, it } from "vitest";
import { readerOption } from "./reader-option.ts";

const alive = (pid: number) => pid === 4242;
const raw = (value: unknown) => JSON.stringify(value);
const good = { version: 1, pid: 4242, path: "/repo/docs/Release-Notes.MD" };

describe("reader pane option", () => {
  it("names a live reader's Markdown file", () => {
    expect(readerOption(raw(good), alive)).toEqual({
      name: "Release-Notes.MD",
      path: "/repo/docs/Release-Notes.MD",
    });
    expect(readerOption(raw({ ...good, path: "/a/b.markdown" }), alive)?.name).toBe("b.markdown");
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
    ])
      expect(readerOption(value, alive), value.slice(0, 80)).toBeNull();
  });
});
