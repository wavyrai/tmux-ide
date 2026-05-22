import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import {
  deleteTask,
  ensureTasksDir,
  loadTasks,
  replayTaskStoreWal,
  saveTask,
  type Task,
} from "../src/lib/task-store.ts";

const durationMs = Number.parseInt(process.env.TMUX_IDE_STRESS_MS ?? "60000", 10);
const writerCount = Number.parseInt(process.env.TMUX_IDE_STRESS_WRITERS ?? "10", 10);
const daemonCommand = process.env.TMUX_IDE_STRESS_DAEMON_CMD;

function makeTask(id: string, title: string): Task {
  const now = new Date().toISOString();
  return {
    id,
    title,
    description: "stress task",
    goal: null,
    status: "todo",
    assignee: null,
    priority: 1,
    created: now,
    updated: now,
    tags: ["stress"],
    proof: null,
    retryCount: 0,
    maxRetries: 5,
    lastError: null,
    nextRetryAt: null,
    depends_on: [],
    milestone: null,
    specialty: null,
    fulfills: [],
    discoveredIssues: [],
    salientSummary: null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertJsonFilesParse(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      assertJsonFilesParse(path);
      continue;
    }
    if (!entry.name.endsWith(".json")) continue;
    JSON.parse(readFileSync(path, "utf-8"));
  }
}

function startDaemon(dir: string): ChildProcess | null {
  if (!daemonCommand) return null;
  const [command, ...args] = daemonCommand.split(" ").filter(Boolean);
  if (!command) return null;
  return spawn(command, args, { cwd: dir, stdio: "ignore", detached: true });
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "tmux-ide-stress-"));
  let daemon = startDaemon(dir);
  const stopAt = Date.now() + durationMs;
  let writes = 0;
  let deletes = 0;

  try {
    ensureTasksDir(dir);
    const writers = Array.from({ length: writerCount }, async (_, writer) => {
      let index = 0;
      while (Date.now() < stopAt) {
        const id = `${writer + 1}`.padStart(2, "0") + `${index}`.padStart(4, "0");
        saveTask(dir, makeTask(id, `Stress ${id}`));
        writes++;
        if (index % 3 === 0) {
          saveTask(dir, { ...makeTask(id, `Stress ${id} updated`), status: "review" });
          writes++;
        }
        if (index % 5 === 0) {
          deleteTask(dir, id);
          deletes++;
        }
        index++;
        await sleep(5);
      }
    });

    const killer = (async () => {
      while (Date.now() < stopAt) {
        await sleep(10_000);
        if (!daemon) continue;
        try {
          process.kill(-daemon.pid!, "SIGKILL");
        } catch {
          // process may have exited between checks
        }
        replayTaskStoreWal(dir);
        daemon = startDaemon(dir);
      }
    })();

    await Promise.all([...writers, killer]);
    replayTaskStoreWal(dir);
    assertJsonFilesParse(join(dir, ".tasks"));
    for (const task of loadTasks(dir)) {
      if (!task.id || !task.title) throw new Error(`invalid task after stress: ${task.id}`);
    }
    console.log(
      JSON.stringify({
        ok: true,
        durationMs,
        writerCount,
        writes,
        deletes,
        remaining: loadTasks(dir).length,
      }),
    );
  } finally {
    if (daemon?.pid) {
      try {
        process.kill(-daemon.pid, "SIGKILL");
      } catch {
        // best-effort cleanup
      }
    }
    if (!process.env.TMUX_IDE_STRESS_KEEP_DIR) rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
