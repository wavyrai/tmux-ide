import { resolve } from "node:path";
import { outputError } from "./lib/output.ts";
import { listPlans, markPlanDone, getPlan, type PlanStatus } from "./lib/plan-store.ts";

const STATUS_ICONS: Record<PlanStatus, string> = {
  pending: "○",
  "in-progress": "●",
  done: "✓",
  archived: "▪",
};

const STATUS_COLORS: Record<PlanStatus, string> = {
  pending: "\x1b[2m", // dim
  "in-progress": "\x1b[33m", // yellow
  done: "\x1b[32m", // green
  archived: "\x1b[2m", // dim
};

const RESET = "\x1b[0m";

export async function planCommand(
  targetDir: string | undefined,
  {
    json = false,
    sub,
    args = [],
    values = {},
  }: {
    json?: boolean;
    sub?: string;
    args?: string[];
    values?: { status?: string };
  },
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  switch (sub) {
    case "list":
    case undefined: {
      const statusFilter = values.status as PlanStatus | undefined;
      const plans = listPlans(dir, statusFilter ? { status: statusFilter } : undefined);

      if (json) {
        console.log(JSON.stringify(plans, null, 2));
        return;
      }

      if (plans.length === 0) {
        console.log("No plans found.");
        return;
      }

      // Group by status
      const groups: Record<string, typeof plans> = {};
      for (const p of plans) {
        (groups[p.status] ??= []).push(p);
      }

      for (const status of ["in-progress", "pending", "done", "archived"] as PlanStatus[]) {
        const group = groups[status];
        if (!group?.length) continue;
        const color = STATUS_COLORS[status];
        console.log(`\n${color}${status.toUpperCase()}${RESET}`);
        for (const p of group) {
          const icon = STATUS_ICONS[p.status];
          const completed = p.completed ? ` (${p.completed})` : "";
          console.log(`  ${color}${icon}${RESET} ${p.name}  ${p.title}${completed}`);
        }
      }
      console.log();
      break;
    }

    case "show": {
      const name = args[0];
      if (!name) outputError("Usage: tmux-ide plan show <name|number>", "USAGE");
      const plan = getPlan(dir, name);
      if (!plan) outputError(`Plan not found: ${name}`, "NOT_FOUND");

      if (json) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }

      const icon = STATUS_ICONS[plan.status];
      const color = STATUS_COLORS[plan.status];
      console.log(`${color}${icon} ${plan.title}${RESET}`);
      console.log(`  Status: ${plan.status}`);
      if (plan.effort) console.log(`  Effort: ${plan.effort}`);
      if (plan.gate) console.log(`  Gate: ${plan.gate}`);
      if (plan.completed) console.log(`  Completed: ${plan.completed}`);
      console.log(`  File: ${plan.path}`);
      break;
    }

    case "done": {
      const name = args[0];
      if (!name) outputError("Usage: tmux-ide plan done <name|number>", "USAGE");
      const result = markPlanDone(dir, name);
      if (!result) outputError(`Plan not found: ${name}`, "NOT_FOUND");

      if (json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(`✓ Plan marked done: ${result.title} (${result.completed})`);
      break;
    }

    default:
      outputError(
        `Unknown plan subcommand: ${sub}\nUsage: tmux-ide plan [list|show|done] [--status pending|in-progress|done]`,
        "USAGE",
      );
  }
}
