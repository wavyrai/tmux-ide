import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PANE_READER_ASSET_MAX_BYTES,
  PANE_READER_MAX_BYTES,
  PANE_READER_PAGE_BYTES,
} from "@tmux-ide/contracts";
import {
  isInside,
  readReaderAssetPage,
  readReaderPage,
  type ReaderFileSeams,
} from "./pane-reader-files.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pane-reader-")));
  roots.push(root);
  return root;
}
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

/** repo/.git, repo/docs/notes.md, repo/images/a.png, repo/docs/b.png, outside/secret.png */
function repo() {
  const root = temp();
  const repoDir = join(root, "repo");
  mkdirSync(join(repoDir, ".git"), { recursive: true });
  mkdirSync(join(repoDir, "docs"));
  mkdirSync(join(repoDir, "images"));
  mkdirSync(join(root, "repo2"));
  mkdirSync(join(root, "outside"));
  const md = join(repoDir, "docs", "notes.md");
  writeFileSync(md, "# Notes\n");
  writeFileSync(join(repoDir, "images", "a.png"), PNG);
  writeFileSync(join(repoDir, "docs", "b.png"), PNG);
  writeFileSync(join(repoDir, "docs", "notes.txt"), "text");
  writeFileSync(join(root, "repo2", "c.png"), PNG);
  writeFileSync(join(root, "outside", "secret.png"), PNG);
  return { root, repoDir, md };
}

function assemble(read: (page: { revision: string; offset: number } | null) => unknown) {
  const first = read(null) as { state: string; revision: string; size: number; chunk: string };
  expect(first.state).toBe("ok");
  const parts = [Buffer.from(first.chunk, "base64")];
  let offset = parts[0]!.length;
  while (offset < first.size) {
    const next = read({ revision: first.revision, offset }) as {
      state: string;
      offset: number;
      chunk: string;
    };
    expect(next.state).toBe("ok");
    expect(next.offset).toBe(offset);
    const bytes = Buffer.from(next.chunk, "base64");
    expect(bytes.length).toBeGreaterThan(0);
    expect(bytes.length).toBeLessThanOrEqual(PANE_READER_PAGE_BYTES);
    parts.push(bytes);
    offset += bytes.length;
  }
  return { bytes: Buffer.concat(parts), revision: first.revision };
}

describe("reader document pages", () => {
  it("pages exact bytes, including a non-UTF-8 file, under the response budget", () => {
    const { md } = repo();
    const bytes = Buffer.alloc(PANE_READER_PAGE_BYTES * 2 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) % 256;
    bytes[3] = 0xff;
    writeFileSync(md, bytes);
    const result = assemble((page) => readReaderPage(md, null, page));
    expect(result.bytes.equals(bytes)).toBe(true);
    const first = readReaderPage(md, null, null);
    expect(JSON.stringify(first).length).toBeLessThan(1024 * 1024);
  });
  it("answers unchanged for the held revision and changed for a stale page", () => {
    const { md } = repo();
    const first = readReaderPage(md, null, null);
    if (first.state !== "ok") throw new Error(first.state);
    expect(readReaderPage(md, first.revision, null)).toEqual({
      state: "unchanged",
      revision: first.revision,
    });
    writeFileSync(md, "# Changed and longer\n");
    expect(readReaderPage(md, null, { revision: first.revision, offset: 0 }).state).toBe("changed");
    const next = readReaderPage(md, first.revision, null);
    expect(next.state).toBe("ok");
  });
  it("reports too large and missing files", () => {
    const { md } = repo();
    truncateSync(md, PANE_READER_MAX_BYTES + 1);
    expect(readReaderPage(md, null, null)).toMatchObject({
      state: "too_large",
      size: PANE_READER_MAX_BYTES + 1,
    });
    truncateSync(md, PANE_READER_MAX_BYTES);
    expect(readReaderPage(md, null, null).state).toBe("ok");
    unlinkSync(md);
    expect(readReaderPage(md, null, null)).toEqual({ state: "missing" });
  });
  it("serves a symlinked document only when its real path is Markdown", () => {
    const { repoDir, md } = repo();
    const link = join(repoDir, "link.md");
    symlinkSync(join(repoDir, "docs", "notes.txt"), link);
    expect(readReaderPage(link, null, null)).toEqual({ state: "missing" });
    const good = join(repoDir, "good.md");
    symlinkSync(md, good);
    expect(readReaderPage(good, null, null).state).toBe("ok");
    expect(readReaderPage(join(repoDir, "docs"), null, null)).toEqual({ state: "missing" });
  });
});

describe("reader image assets", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchSpy = vi.fn(() => Promise.reject(new Error("network is off in tests")));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  const state = (md: string, src: string) => readReaderAssetPage(md, src, null).state;

  it("allows images in the file's folder and anywhere in its git repository", () => {
    const { md } = repo();
    const ok = readReaderAssetPage(md, "b.png", null);
    expect(ok).toMatchObject({ state: "ok", mime: "image/png", size: PNG.length, offset: 0 });
    if (ok.state !== "ok") throw new Error();
    expect(Buffer.from(ok.chunk, "base64").equals(PNG)).toBe(true);
    expect(state(md, "../images/a.png")).toBe("ok");
    expect(state(md, "./../images/a.png?v=2#top")).toBe("ok");
    expect(state(md, "..%2Fimages%2Fa.png")).toBe("ok");
    expect(state(md, "../images/missing.png")).toBe("missing");
  });
  it("refuses escapes: dot-dot, absolute, home, sibling prefix and symlinks out of the root", () => {
    const { root, repoDir, md } = repo();
    expect(state(md, "../../outside/secret.png")).toBe("refused");
    expect(state(md, "../../repo2/c.png")).toBe("refused");
    expect(state(md, "..%2F..%2Foutside%2Fsecret.png")).toBe("refused");
    expect(state(md, join(root, "outside", "secret.png"))).toBe("refused");
    expect(state(md, join(repoDir, "images", "a.png"))).toBe("refused");
    expect(state(md, "~/secret.png")).toBe("refused");
    expect(state(md, "a%00.png")).toBe("refused");
    expect(state(md, "%E0%A4%A.png")).toBe("refused");
    symlinkSync(join(root, "outside", "secret.png"), join(repoDir, "images", "escape.png"));
    expect(state(md, "../images/escape.png")).toBe("refused");
    symlinkSync(join(root, "outside"), join(repoDir, "images", "outdir"));
    expect(state(md, "../images/outdir/secret.png")).toBe("refused");
    symlinkSync(join(repoDir, "docs", "notes.txt"), join(repoDir, "images", "text.png"));
    expect(state(md, "../images/text.png")).toBe("refused");
  });
  it("confines to the file's folder when there is no git repository", () => {
    const root = temp();
    mkdirSync(join(root, "notes"));
    mkdirSync(join(root, "shared"));
    const md = join(root, "notes", "a.md");
    writeFileSync(md, "x");
    writeFileSync(join(root, "notes", "in.png"), PNG);
    writeFileSync(join(root, "shared", "out.png"), PNG);
    expect(state(md, "in.png")).toBe("ok");
    expect(state(md, "../shared/out.png")).toBe("refused");
  });
  it("refuses non-image extensions and oversize images", () => {
    const { repoDir, md } = repo();
    expect(state(md, "notes.txt")).toBe("refused");
    expect(state(md, "notes.md")).toBe("refused");
    writeFileSync(join(repoDir, "docs", "big.png"), Buffer.alloc(0));
    truncateSync(join(repoDir, "docs", "big.png"), PANE_READER_ASSET_MAX_BYTES + 1);
    expect(state(md, "big.png")).toBe("too_large");
    truncateSync(join(repoDir, "docs", "big.png"), PANE_READER_ASSET_MAX_BYTES);
    expect(state(md, "big.png")).toBe("ok");
    for (const name of ["x.JPG", "x.jpeg", "x.gif", "x.webp", "x.svg"]) {
      writeFileSync(join(repoDir, "docs", name), PNG);
      expect(state(md, name)).toBe("ok");
    }
  });
  it("never fetches a URL", () => {
    const { md } = repo();
    for (const src of [
      "http://example.com/a.png",
      "https://cdn.example.com/diagram.png",
      "HTTPS://x/a.png",
      "file:///etc/passwd.png",
      "data:image/png;base64,iVBORw0KGgo=",
      "//cdn.example.com/a.png",
      "javascript:alert(1).png",
      "\\\\host\\share\\a.png",
    ])
      expect(state(md, src), src).toBe("refused");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it("pages a large image and reports a change mid-way", () => {
    const { repoDir, md } = repo();
    const big = Buffer.alloc(PANE_READER_PAGE_BYTES + 9, 7);
    writeFileSync(join(repoDir, "docs", "large.webp"), big);
    const result = assemble((page) => readReaderAssetPage(md, "large.webp", page));
    expect(result.bytes.equals(big)).toBe(true);
    writeFileSync(join(repoDir, "docs", "large.webp"), PNG);
    expect(
      readReaderAssetPage(md, "large.webp", { revision: result.revision, offset: 1 }).state,
    ).toBe("changed");
  });
});

describe("reader file guards (#353 round 2)", () => {
  it("D02: the parent of the root is not inside it", () => {
    expect(isInside("/repo/docs", "/repo")).toBe(false);
    expect(isInside("/repo", "/repo")).toBe(true);
    expect(isInside("/repo", "/repo/a/b")).toBe(true);
    expect(isInside("/repo", "/repo2/a")).toBe(false);
  });

  it("D07: a directory or a FIFO named like Markdown is missing, never read", () => {
    const root = temp();
    mkdirSync(join(root, "dir.md"));
    expect(readReaderPage(join(root, "dir.md"), null, null)).toEqual({ state: "missing" });
    const fifo = join(root, "pipe.md");
    execFileSync("mkfifo", [fifo]);
    expect(readReaderPage(fifo, null, null)).toEqual({ state: "missing" });
    mkdirSync(join(root, "img.png"));
    writeFileSync(join(root, "notes.md"), "# x\n");
    expect(readReaderAssetPage(join(root, "notes.md"), "img.png", null)).toEqual({
      state: "missing",
    });
  });

  it("D09: a file changed during the read is reported changed, not served", () => {
    const { md } = repo();
    const first = readReaderPage(md, null, null);
    if (first.state !== "ok") throw new Error(first.state);
    const read: ReaderFileSeams["read"] = (fd, offset, size, real) => {
      const bytes = real(fd, offset, size);
      // Same length, new metadata: only the revision after the read shows it.
      utimesSync(md, new Date(1_000), new Date(2_000));
      return bytes;
    };
    expect(readReaderPage(md, null, { revision: first.revision, offset: 0 }, { read })).toEqual({
      state: "changed",
    });
  });

  it("D10: a short read is reported changed, not served as a short page", () => {
    const { md } = repo();
    const first = readReaderPage(md, null, null);
    if (first.state !== "ok") throw new Error(first.state);
    const read: ReaderFileSeams["read"] = (fd, offset, size, real) =>
      real(fd, offset, size).subarray(0, 3);
    expect(readReaderPage(md, null, { revision: first.revision, offset: 0 }, { read })).toEqual({
      state: "changed",
    });
  });

  it("D19: a path outside the root is refused before the file system is asked", () => {
    const { md } = repo();
    // Neither exists: the answer must not say so.
    for (const src of ["../../outside/nope.png", "../../repo2/nope.png", "../../../x/y.png"])
      expect(readReaderAssetPage(md, src, null), src).toEqual({ state: "refused" });
    // Inside the root, a missing image is just missing.
    expect(readReaderAssetPage(md, "../images/nope.png", null)).toEqual({ state: "missing" });
  });

  it("D22: a file swapped for another after it was opened is refused", () => {
    const { md, repoDir } = repo();
    const image = join(repoDir, "docs", "b.png");
    const afterOpen = () => {
      // Replace the opened file by a different inode at the same path.
      unlinkSync(image);
      writeFileSync(image, PNG);
    };
    expect(readReaderAssetPage(md, "b.png", null, { afterOpen })).toEqual({ state: "refused" });
  });

  it("E05: a folder on the path swapped for a symlink after the open is refused", () => {
    const { md, root, repoDir } = repo();
    const images = join(repoDir, "images");
    const afterOpen = () => {
      // The opened picture's folder now leads outside the repository.
      execFileSync("mv", [images, join(root, "images-moved")]);
      writeFileSync(join(root, "outside", "a.png"), PNG);
      symlinkSync(join(root, "outside"), images);
    };
    expect(readReaderAssetPage(md, "../images/a.png", null, { afterOpen })).toEqual({
      state: "refused",
    });
  });
});
