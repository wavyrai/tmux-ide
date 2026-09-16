import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  open,
  readFile,
  realpath,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  readEditorFile,
  saveEditorFile,
  MAX_PREVIEW_BYTES,
  MAX_EDITOR_LINES,
} from "./editor-file-io.ts";
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "editor-file-io-"));
  roots.push(root);
  return { root, path: join(root, "file") };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
it("reads a huge sparse file as a bounded explicitly truncated preview", async () => {
  const { path } = await fixture();
  const fd = await open(path, "w");
  await fd.truncate(2 * 1024 * 1024 * 1024);
  await fd.close();
  const result = await readEditorFile(path, new AbortController().signal);
  expect(result.bytesRead).toBe(MAX_PREVIEW_BYTES);
  expect(result.reason).toBe("preview");
  expect(result.truncated).toBe(true);
  expect(result.text.length).toBeLessThanOrEqual(MAX_PREVIEW_BYTES);
});
it("caps actual reads when a small preflight file grows and bounds pathological line allocation", async () => {
  const { path } = await fixture();
  await writeFile(path, "x".repeat(100_000));
  const handle = await open(path, "r");
  const original = await handle.stat();
  const spy = vi
    .spyOn(handle, "stat")
    .mockResolvedValue({ ...original, size: 16, isFile: () => true } as never);
  const result = await readEditorFile(path, new AbortController().signal, {
    open: async () => handle,
    realpath,
    stat,
  } as never);
  expect(result.bytesRead).toBe(17);
  expect(result.truncated).toBe(true);
  expect(spy).toHaveBeenCalledOnce();
  await writeFile(path, "\n".repeat(100_000));
  const lines = await readEditorFile(path, new AbortController().signal);
  expect(lines.lineCount).toBe(MAX_EDITOR_LINES);
  expect(lines.reason).toBe("preview");
});
it("rejects a private FIFO without opening/blocking and closes descriptors after cancellation", async () => {
  const { path } = await fixture();
  execFileSync("mkfifo", [path]);
  const openSpy = vi.fn();
  await expect(
    readEditorFile(path, new AbortController().signal, { open: openSpy, realpath, stat }),
  ).rejects.toThrow("regular");
  expect(openSpy).not.toHaveBeenCalled();
  await unlink(path);
  await writeFile(path, "content");
  const fd = await open(path, "r");
  const close = vi.spyOn(fd, "close");
  const controller = new AbortController();
  vi.spyOn(fd, "read").mockImplementation(async () => {
    controller.abort();
    return { bytesRead: 1, buffer: Buffer.alloc(1) } as never;
  });
  await expect(
    readEditorFile(path, controller.signal, { open: async () => fd, realpath, stat } as never),
  ).rejects.toThrow();
  expect(close).toHaveBeenCalledOnce();
});
it("saves atomically through the loaded symlink target, preserving mode and cleaning failed temps", async () => {
  const { root, path } = await fixture();
  await writeFile(path, "original", { mode: 0o640 });
  const alias = join(root, "alias");
  await symlink(path, alias);
  const loaded = await readEditorFile(alias, new AbortController().signal);
  await saveEditorFile(loaded.path, "saved", new AbortController().signal, () => true);
  expect(await readFile(alias, "utf8")).toBe("saved");
  expect(await realpath(alias)).toBe(await realpath(path));
  expect((await stat(path)).mode & 0o777).toBe(0o640);
  const moves: string[] = [];
  await expect(
    saveEditorFile(path, "failed", new AbortController().signal, () => true, {
      open,
      stat,
      unlink,
      rename: async (from) => {
        moves.push(String(from));
        throw new Error("fixture rename failure");
      },
    }),
  ).rejects.toThrow("fixture rename failure");
  expect(await readdir(root)).toEqual(expect.arrayContaining(["file", "alias"]));
  expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(await readFile(path, "utf8")).toBe("saved");
  expect(moves[0]).toContain(".file.tmux-ide-");
});
it("refuses a stale save before rename and cleans its exclusively owned temp", async () => {
  const { root, path } = await fixture();
  await writeFile(path, "old");
  let checks = 0;
  const move = vi.fn(rename);
  await expect(
    saveEditorFile(path, "new", new AbortController().signal, () => ++checks === 1, {
      open,
      stat,
      rename: move,
      unlink,
    }),
  ).rejects.toThrow("cancelled");
  expect(move).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("old");
  expect(await readdir(root)).toEqual(["file"]);
});

it("bounds UTF-8 replacement expansion before constructing native text", async () => {
  const { path } = await fixture();
  await writeFile(path, Buffer.alloc(800_000, 0xff));
  const result = await readEditorFile(path, new AbortController().signal);
  expect(result.reason).toBe("preview");
  expect(Buffer.byteLength(result.text)).toBeLessThan(1024 * 1024);
});
it("never cleans up a temp whose exclusive creation failed", async () => {
  const { path } = await fixture();
  await writeFile(path, "original");
  const remove = vi.fn(unlink);
  await expect(
    saveEditorFile(path, "new", new AbortController().signal, () => true, {
      open: async () => {
        throw new Error("exclusive create refused");
      },
      stat,
      rename,
      unlink: remove,
    } as never),
  ).rejects.toThrow("exclusive create refused");
  expect(remove).not.toHaveBeenCalled();
  expect(await readFile(path, "utf8")).toBe("original");
});
