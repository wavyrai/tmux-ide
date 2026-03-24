import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type PlanStatus = "pending" | "in-progress" | "done" | "archived";

export interface PlanMeta {
  name: string; // filename without .md
  path: string; // relative path from project root
  title: string; // first # heading
  status: PlanStatus;
  effort?: string;
  gate?: string;
  completed?: string; // ISO date when marked done
}

/**
 * Parse plan status from the **Status:** `xxx` pattern used in plan files.
 */
function parseInlineStatus(content: string): PlanStatus {
  const match = content.match(/\*\*Status:\*\*\s*`([^`]+)`/);
  if (!match) return "pending";
  const raw = match[1]!.toLowerCase().trim();
  if (raw === "done" || raw === "completed") return "done";
  if (raw === "in-progress" || raw === "in progress" || raw === "active") return "in-progress";
  if (raw === "archived") return "archived";
  return "pending";
}

function parseInlineField(content: string, field: string): string | undefined {
  const re = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+?)\\s*$`, "m");
  const match = content.match(re);
  return match ? match[1]!.replace(/^`|`$/g, "").trim() : undefined;
}

function parseTitle(content: string): string {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1]!.trim() : "(untitled)";
}

/**
 * Load all plan files from plans/ directory.
 */
export function loadPlans(dir: string): PlanMeta[] {
  const plansDir = join(dir, "plans");
  if (!existsSync(plansDir)) return [];

  return readdirSync(plansDir)
    .filter((f) => f.endsWith(".md") && f !== "ROADMAP.md")
    .sort()
    .map((f) => {
      const content = readFileSync(join(plansDir, f), "utf-8");
      return {
        name: f.replace(/\.md$/, ""),
        path: `plans/${f}`,
        title: parseTitle(content),
        status: parseInlineStatus(content),
        effort: parseInlineField(content, "Effort"),
        gate: parseInlineField(content, "Gate"),
        completed: parseInlineField(content, "Completed"),
      };
    });
}

/**
 * List plans filtered by status.
 */
export function listPlans(dir: string, filter?: { status?: PlanStatus }): PlanMeta[] {
  const plans = loadPlans(dir);
  if (filter?.status) {
    return plans.filter((p) => p.status === filter.status);
  }
  return plans;
}

/**
 * Mark a plan as done. Updates the **Status:** line and adds **Completed:** date.
 */
export function markPlanDone(dir: string, nameOrNumber: string): PlanMeta | null {
  const plansDir = join(dir, "plans");
  if (!existsSync(plansDir)) return null;

  // Find the plan file — match by name, number prefix, or full filename
  const files = readdirSync(plansDir).filter((f) => f.endsWith(".md"));
  const target = files.find(
    (f) =>
      f === `${nameOrNumber}.md` ||
      f.replace(/\.md$/, "") === nameOrNumber ||
      f.startsWith(`${nameOrNumber}-`),
  );

  if (!target) return null;

  const filePath = join(plansDir, target);
  let content = readFileSync(filePath, "utf-8");
  const today = new Date().toISOString().split("T")[0]!;

  // Update status
  if (content.match(/\*\*Status:\*\*\s*`[^`]+`/)) {
    content = content.replace(/\*\*Status:\*\*\s*`[^`]+`/, "**Status:** `done`");
  }

  // Add or update completed date
  if (content.match(/\*\*Completed:\*\*/)) {
    content = content.replace(/\*\*Completed:\*\*\s*.+/, `**Completed:** ${today}`);
  } else {
    // Insert after the Status line
    content = content.replace(/(\*\*Status:\*\*\s*`done`)/, `$1\n**Completed:** ${today}`);
  }

  writeFileSync(filePath, content);

  return {
    name: target.replace(/\.md$/, ""),
    path: `plans/${target}`,
    title: parseTitle(content),
    status: "done",
    effort: parseInlineField(content, "Effort"),
    gate: parseInlineField(content, "Gate"),
    completed: today,
  };
}

/**
 * Get a single plan by name or number.
 */
export function getPlan(dir: string, nameOrNumber: string): PlanMeta | null {
  const plans = loadPlans(dir);
  return (
    plans.find((p) => p.name === nameOrNumber || p.name.startsWith(`${nameOrNumber}-`)) ?? null
  );
}
