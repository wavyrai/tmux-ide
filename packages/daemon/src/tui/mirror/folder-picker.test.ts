import { describe, expect, it } from "vitest";
import {
  PICKER_DIR_PREFIX,
  PICKER_HIDDEN_ID,
  PICKER_OPEN_ID,
  PICKER_TYPE_ID,
  PICKER_UP_ID,
  expandUserPath,
  filterDirs,
  isPickerRoot,
  pathKindHint,
  pickerBreadcrumb,
  pickerDirName,
  pickerParent,
  pickerRows,
} from "./folder-picker.ts";

const HOME = "/Users/dev";

describe("expandUserPath", () => {
  it("expands a bare ~ and ~/…", () => {
    expect(expandUserPath("~", HOME, "/tmp")).toBe(HOME);
    expect(expandUserPath("~/code/app", HOME, "/tmp")).toBe(`${HOME}/code/app`);
  });

  it("resolves relative paths against the base", () => {
    expect(expandUserPath("sub", HOME, "/tmp/here")).toBe("/tmp/here/sub");
    expect(expandUserPath("../up", HOME, "/tmp/here")).toBe("/tmp/up");
  });

  it("passes absolute paths through and defaults blanks to the base", () => {
    expect(expandUserPath("/etc/x", HOME, "/tmp")).toBe("/etc/x");
    expect(expandUserPath("   ", HOME, "/tmp/here")).toBe("/tmp/here");
  });
});

describe("pickerParent / isPickerRoot", () => {
  it("ascends and stops at the root", () => {
    expect(pickerParent("/a/b/c")).toBe("/a/b");
    expect(pickerParent("/")).toBe("/");
    expect(isPickerRoot("/")).toBe(true);
    expect(isPickerRoot("/a")).toBe(false);
  });
});

describe("filterDirs", () => {
  it("hides dotfolders unless asked, drops . and .., sorts case-insensitively", () => {
    const names = ["src", ".git", "Docs", "apps", ".", ".."];
    expect(filterDirs(names, false)).toEqual(["apps", "Docs", "src"]);
    expect(filterDirs(names, true)).toEqual([".git", "apps", "Docs", "src"]);
  });
});

describe("pickerBreadcrumb", () => {
  it("collapses the home prefix to ~", () => {
    expect(pickerBreadcrumb(HOME, HOME)).toBe("~");
    expect(pickerBreadcrumb(`${HOME}/code/app`, HOME)).toBe("~ › code › app");
  });

  it("shows the root as / and elides a deep path", () => {
    expect(pickerBreadcrumb("/", HOME)).toBe("/");
    expect(pickerBreadcrumb("/a/b/c/d/e/f", HOME)).toBe("… › c › d › e › f");
  });
});

describe("pickerRows", () => {
  it("puts open + hidden-toggle first, up (not at root), the dirs, then type-a-path", () => {
    const rows = pickerRows("/a/b", ["one", "two"], false);
    expect(rows.map((r) => r.id)).toEqual([
      PICKER_OPEN_ID,
      PICKER_HIDDEN_ID,
      PICKER_UP_ID,
      `${PICKER_DIR_PREFIX}one`,
      `${PICKER_DIR_PREFIX}two`,
      PICKER_TYPE_ID,
    ]);
    expect(rows[0]!.detail).toBe("b"); // the folder basename
    expect(rows[3]!.label).toBe("one/");
  });

  it("labels the hidden toggle by state", () => {
    expect(pickerRows("/a", [], false)[1]!.label).toBe("Show hidden folders");
    expect(pickerRows("/a", [], true)[1]!.label).toBe("Hide hidden folders");
  });

  it("omits the up row at the filesystem root", () => {
    const rows = pickerRows("/", ["etc"], false);
    expect(rows.map((r) => r.id)).toEqual([
      PICKER_OPEN_ID,
      PICKER_HIDDEN_ID,
      `${PICKER_DIR_PREFIX}etc`,
      PICKER_TYPE_ID,
    ]);
  });
});

describe("pickerDirName", () => {
  it("extracts the descend target and ignores other ids", () => {
    expect(pickerDirName(`${PICKER_DIR_PREFIX}sub`)).toBe("sub");
    expect(pickerDirName(PICKER_OPEN_ID)).toBeNull();
    expect(pickerDirName(PICKER_UP_ID)).toBeNull();
  });
});

describe("pathKindHint", () => {
  it("explains a file vs a missing path in plain language", () => {
    expect(pathKindHint("file")).toMatch(/file, not a folder/);
    expect(pathKindHint("missing")).toMatch(/No folder there/);
  });
});
