import {
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_FAVICON_CANDIDATES,
  createSessionFaviconResolver,
  defaultSessionFaviconIo,
} from "./session-favicon.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tmux-ide-favicon-"));
  directories.push(dir);
  return dir;
}
function counted() {
  const io = {
    lstat: vi.fn(defaultSessionFaviconIo.lstat),
    readNoFollow: vi.fn(defaultSessionFaviconIo.readNoFollow),
  };
  return io;
}
const svg = "<svg/>";
const b64 = (value: string | Buffer) => Buffer.from(value).toString("base64");

describe("session favicon lookup", () => {
  it("returns the first candidate in priority order with its mime type", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "favicon.png"), "png");
    writeFileSync(join(dir, "icon.svg"), "late");
    writeFileSync(join(dir, "favicon.ico"), "ico");
    const resolve = createSessionFaviconResolver();
    expect(await resolve(dir)).toEqual({ mime: "image/x-icon", data: b64("ico"), size: 3 });
    rmSync(join(dir, "favicon.ico"));
    expect(await createSessionFaviconResolver()(dir)).toEqual({
      mime: "image/png",
      data: b64("png"),
      size: 3,
    });
  });

  it("knows every candidate the card lists, in order", () => {
    expect(SESSION_FAVICON_CANDIDATES).toEqual([
      "favicon.svg",
      "favicon.png",
      "favicon.ico",
      "public/favicon.svg",
      "public/favicon.png",
      "public/favicon.ico",
      "app/icon.svg",
      "app/icon.png",
      "app/favicon.ico",
      "src/app/icon.svg",
      "src/app/icon.png",
      "src/app/favicon.ico",
      "static/favicon.svg",
      "static/favicon.png",
      "static/favicon.ico",
      "assets/favicon.svg",
      "assets/favicon.png",
      "assets/favicon.ico",
      "apple-touch-icon.png",
      "public/apple-touch-icon.png",
      "icon.svg",
      "icon.png",
    ]);
  });

  it("finds a nested candidate two directories deep", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src", "app"), { recursive: true });
    writeFileSync(join(dir, "src", "app", "icon.svg"), svg);
    expect(await createSessionFaviconResolver()(dir)).toEqual({
      mime: "image/svg+xml",
      data: b64(svg),
      size: svg.length,
    });
  });

  it("ignores files whose name is not a listed candidate or whose extension has no image mime", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "favicon.bmp"), "bmp");
    writeFileSync(join(dir, "favicon.txt"), "txt");
    writeFileSync(join(dir, "favicon.jpg"), "jpg");
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "logo.png"), "png");
    expect(await createSessionFaviconResolver()(dir)).toBeNull();
  });

  it("accepts exactly 32 KiB and skips a larger file for the next candidate", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "favicon.svg"), Buffer.alloc(32_769, 1));
    writeFileSync(join(dir, "favicon.png"), Buffer.alloc(32_768, 2));
    expect(await createSessionFaviconResolver()(dir)).toEqual({
      mime: "image/png",
      data: b64(Buffer.alloc(32_768, 2)),
      size: 32_768,
    });
  });

  it("never follows a symlinked file out of the project", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.svg"), svg);
    const dir = tempDir();
    symlinkSync(join(outside, "secret.svg"), join(dir, "favicon.svg"));
    expect(await createSessionFaviconResolver()(dir)).toBeNull();
  });

  it("never follows a symlinked directory out of the project", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "favicon.svg"), svg);
    const dir = tempDir();
    symlinkSync(outside, join(dir, "public"));
    const io = counted();
    expect(await createSessionFaviconResolver({ io })(dir)).toBeNull();
    expect(io.readNoFollow).not.toHaveBeenCalled();
  });

  it("refuses a symlink even if the lstat check is bypassed", async () => {
    const outside = tempDir();
    writeFileSync(join(outside, "secret.svg"), svg);
    const dir = tempDir();
    symlinkSync(join(outside, "secret.svg"), join(dir, "favicon.svg"));
    expect(await defaultSessionFaviconIo.readNoFollow(join(dir, "favicon.svg"), 32_768)).toBeNull();
    expect(await defaultSessionFaviconIo.readNoFollow(join(outside, "secret.svg"), 32_768)).toEqual(
      Buffer.from(svg),
    );
    expect(await defaultSessionFaviconIo.readNoFollow(join(outside, "secret.svg"), 5)).toBeNull();
  });

  it("treats an empty, relative or unreadable session path as no favicon", async () => {
    const resolve = createSessionFaviconResolver();
    expect(await resolve("")).toBeNull();
    expect(await resolve("relative/dir")).toBeNull();
    expect(await resolve(join(tempDir(), "missing"))).toBeNull();
    expect(await resolve("/dev/null")).toBeNull();
  });

  it("never touches the filesystem for an empty or relative session path", async () => {
    const io = counted();
    const resolve = createSessionFaviconResolver({ io });
    expect(await resolve("")).toBeNull();
    expect(await resolve(".")).toBeNull();
    expect(await resolve("relative/dir")).toBeNull();
    expect(await resolve("/tmp/a\0b")).toBeNull();
    expect(io.lstat).not.toHaveBeenCalled();
    expect(io.readNoFollow).not.toHaveBeenCalled();
  });

  it("serves a cache hit from memory without reading the file again, and re-reads on change", async () => {
    const dir = tempDir();
    const file = join(dir, "favicon.svg");
    writeFileSync(file, svg);
    utimesSync(file, 1_000, 1_000);
    const io = counted();
    const resolve = createSessionFaviconResolver({ io });
    expect((await resolve(dir))?.data).toBe(b64(svg));
    expect((await resolve(dir))?.data).toBe(b64(svg));
    expect((await resolve(dir))?.data).toBe(b64(svg));
    expect(io.readNoFollow).toHaveBeenCalledTimes(1);
    writeFileSync(file, "<svg>new</svg>");
    utimesSync(file, 2_000, 2_000);
    expect((await resolve(dir))?.data).toBe(b64("<svg>new</svg>"));
    expect(io.readNoFollow).toHaveBeenCalledTimes(2);
    rmSync(file);
    expect(await resolve(dir)).toBeNull();
  });

  it("drops a cached hit whose file became a symlink with the same mtime and size", async () => {
    const outside = tempDir();
    const target = join(outside, "secret.svg");
    writeFileSync(target, svg);
    const dir = tempDir();
    const file = join(dir, "favicon.svg");
    writeFileSync(file, "x".repeat(target.length));
    utimesSync(file, 1_000, 1_000);
    const resolve = createSessionFaviconResolver();
    expect((await resolve(dir))?.size).toBe(target.length);
    rmSync(file);
    symlinkSync(target, file);
    lutimesSync(file, 1_000, 1_000);
    expect(lstatSync(file).size).toBe(target.length);
    expect(await resolve(dir)).toBeNull();
  });

  it("re-reads when only the size changes or only the mtime changes", async () => {
    const dir = tempDir();
    const file = join(dir, "favicon.svg");
    writeFileSync(file, "aaaa");
    utimesSync(file, 1_000, 1_000);
    const io = counted();
    const resolve = createSessionFaviconResolver({ io });
    await resolve(dir);
    writeFileSync(file, "bbbbbbbb");
    utimesSync(file, 1_000, 1_000);
    expect((await resolve(dir))?.data).toBe(b64("bbbbbbbb"));
    writeFileSync(file, "cccccccc");
    utimesSync(file, 3_000, 3_000);
    expect((await resolve(dir))?.data).toBe(b64("cccccccc"));
    expect(io.readNoFollow).toHaveBeenCalledTimes(3);
  });

  it("caches a miss for 30 seconds, then looks again", async () => {
    const dir = tempDir();
    let now = 100_000;
    const io = counted();
    const resolve = createSessionFaviconResolver({ io, now: () => now });
    expect(await resolve(dir)).toBeNull();
    const scanned = io.lstat.mock.calls.length;
    expect(scanned).toBeGreaterThan(0);
    writeFileSync(join(dir, "favicon.svg"), svg);
    now += 29_999;
    expect(await resolve(dir)).toBeNull();
    expect(io.lstat.mock.calls.length).toBe(scanned);
    now += 1;
    expect((await resolve(dir))?.mime).toBe("image/svg+xml");
  });

  it("bounds the cache and evicts the least recently used path", async () => {
    const dirs = [tempDir(), tempDir(), tempDir()];
    for (const dir of dirs) writeFileSync(join(dir, "favicon.svg"), svg);
    const io = counted();
    const resolve = createSessionFaviconResolver({ io, maxEntries: 2 });
    await resolve(dirs[0]!);
    await resolve(dirs[1]!);
    await resolve(dirs[0]!);
    await resolve(dirs[2]!);
    expect(io.readNoFollow).toHaveBeenCalledTimes(3);
    await resolve(dirs[0]!);
    expect(io.readNoFollow).toHaveBeenCalledTimes(3);
    await resolve(dirs[1]!);
    expect(io.readNoFollow).toHaveBeenCalledTimes(4);
  });
});
