import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";

export interface AgentAccounting {
  totalTimeMs: number;
  taskCount: number;
  lastTaskId: string | null;
}

export interface AccountingData {
  agents: Record<string, AgentAccounting>;
  sessionStart: string;
  updated: string;
}

function accountingPath(dir: string): string {
  return join(dir, ".tasks", "accounting.json");
}

export function loadAccounting(dir: string): AccountingData {
  const path = accountingPath(dir);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8")) as AccountingData;
    } catch {
      // Corrupted file, start fresh
    }
  }
  return {
    agents: {},
    sessionStart: new Date().toISOString(),
    updated: new Date().toISOString(),
  };
}

export function saveAccounting(dir: string, data: AccountingData): void {
  const tasksDir = join(dir, ".tasks");
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  data.updated = new Date().toISOString();
  const dest = accountingPath(dir);
  const tmpPath = dest + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmpPath, dest);
}

export function recordTaskTime(
  dir: string,
  agentName: string,
  taskId: string,
  elapsedMs: number,
): void {
  const data = loadAccounting(dir);
  if (!data.agents[agentName]) {
    data.agents[agentName] = { totalTimeMs: 0, taskCount: 0, lastTaskId: null };
  }
  const agent = data.agents[agentName]!;
  agent.totalTimeMs += elapsedMs;
  agent.taskCount += 1;
  agent.lastTaskId = taskId;
  saveAccounting(dir, data);
}

export function formatDuration(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}
