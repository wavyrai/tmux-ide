import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import {
  ProjectInitFailedError,
  ProjectInitTimeoutError,
  runInit,
  type SpawnFn,
} from "./project-init-runner.ts";

class FakeStream extends EventEmitter {
  setEncoding(): void {}
  push(text: string): void {
    this.emit("data", text);
  }
}

class FakeChildProcess extends EventEmitter {
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

function fakeSpawn(): { spawnFn: SpawnFn; child: FakeChildProcess } {
  const child = new FakeChildProcess();
  const spawnFn: SpawnFn = (() => child) as unknown as SpawnFn;
  return { spawnFn, child };
}

describe("runInit", () => {
  it("resolves on exit code 0 and streams stdout lines through onChunk", async () => {
    const { spawnFn, child } = fakeSpawn();
    const chunks: string[] = [];
    const promise = runInit({
      cwd: "/tmp/proj",
      onChunk: (c) => chunks.push(c),
      spawnFn,
      timeoutMs: 5_000,
    });

    child.stdout.push("Detected pnpm + nextjs.\n");
    child.stdout.push("Created ide.yml\n");
    child.emit("close", 0);

    await expect(promise).resolves.toEqual({ ok: true });
    expect(chunks).toEqual(["Detected pnpm + nextjs.", "Created ide.yml"]);
  });

  it("buffers partial lines until a newline arrives", async () => {
    const { spawnFn, child } = fakeSpawn();
    const chunks: string[] = [];
    const promise = runInit({
      cwd: "/tmp/proj",
      onChunk: (c) => chunks.push(c),
      spawnFn,
      timeoutMs: 5_000,
    });

    child.stdout.push("Created ");
    child.stdout.push("ide.yml\n");
    child.emit("close", 0);

    await promise;
    expect(chunks).toEqual(["Created ide.yml"]);
  });

  it("flushes a trailing partial line on close", async () => {
    const { spawnFn, child } = fakeSpawn();
    const chunks: string[] = [];
    const promise = runInit({
      cwd: "/tmp/proj",
      onChunk: (c) => chunks.push(c),
      spawnFn,
      timeoutMs: 5_000,
    });

    child.stdout.push("no trailing newline");
    child.emit("close", 0);

    await promise;
    expect(chunks).toEqual(["no trailing newline"]);
  });

  it("forwards stderr lines through the same onChunk", async () => {
    const { spawnFn, child } = fakeSpawn();
    const chunks: string[] = [];
    const promise = runInit({
      cwd: "/tmp/proj",
      onChunk: (c) => chunks.push(c),
      spawnFn,
      timeoutMs: 5_000,
    });

    child.stderr.push("warning: stack not detected\n");
    child.stdout.push("Created ide.yml\n");
    child.emit("close", 0);

    await promise;
    expect(chunks).toContain("warning: stack not detected");
    expect(chunks).toContain("Created ide.yml");
  });

  it("rejects with ProjectInitFailedError on non-zero exit", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = runInit({
      cwd: "/tmp/proj",
      onChunk: () => {},
      spawnFn,
      timeoutMs: 5_000,
    });

    child.stderr.push("Error: ide.yml already exists\n");
    child.emit("close", 1);

    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectInitFailedError);
    expect((caught as ProjectInitFailedError).exitCode).toBe(1);
    expect((caught as ProjectInitFailedError).stderr).toContain("ide.yml already exists");
  });

  it("rejects with ProjectInitTimeoutError after timeoutMs and kills the child", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = runInit({
      cwd: "/tmp/proj",
      onChunk: () => {},
      spawnFn,
      timeoutMs: 50,
    });

    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ProjectInitTimeoutError);
    expect(child.killed).toBe(true);
  });

  it("passes --template through when provided", async () => {
    let observedArgs: string[] = [];
    const child = new FakeChildProcess();
    const spawnFn: SpawnFn = ((_cmd: string, args: string[]) => {
      observedArgs = args;
      return child;
    }) as unknown as SpawnFn;

    const promise = runInit({
      cwd: "/tmp/proj",
      template: "nextjs",
      onChunk: () => {},
      spawnFn,
      timeoutMs: 5_000,
    });
    child.emit("close", 0);
    await promise;

    expect(observedArgs).toEqual(["init", "--template", "nextjs"]);
  });

  it("rejects on spawn 'error' event (e.g. ENOENT)", async () => {
    const { spawnFn, child } = fakeSpawn();
    const promise = runInit({
      cwd: "/tmp/proj",
      onChunk: () => {},
      spawnFn,
      timeoutMs: 5_000,
    });

    child.emit("error", new Error("ENOENT: tmux-ide not found"));

    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("ENOENT");
  });
});
