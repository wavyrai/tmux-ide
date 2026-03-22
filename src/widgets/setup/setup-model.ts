import { IdeConfigSchema, type IdeConfig, type Pane, type Row } from "../../schemas/ide-config.ts";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Layout Presets
// ---------------------------------------------------------------------------

export interface DetectedInfo {
  devCommand: string | null;
  packageManager: string | null;
}

export interface LayoutPreset {
  id: string;
  label: string;
  description: string;
  diagram: string[];
  buildConfig: (name: string, detected?: DetectedInfo) => IdeConfig;
}

function devCmd(detected?: DetectedInfo): string {
  if (detected?.devCommand) return detected.devCommand;
  if (detected?.packageManager) return `${detected.packageManager} dev`;
  return "npm run dev";
}

function testCmd(detected?: DetectedInfo): string {
  if (detected?.packageManager) return `${detected.packageManager} test`;
  return "npm test";
}

export const PRESETS: LayoutPreset[] = [
  {
    id: "dual-claude",
    label: "Dual Claude",
    description: "Two Claude panes on top, dev server and shell on the bottom.",
    diagram: [
      "┌─────────────────┬─────────────────┐",
      "│                 │                 │",
      "│    Claude 1     │    Claude 2     │  70%",
      "│                 │                 │",
      "├─────────────────┼─────────────────┤",
      "│   Dev Server    │     Shell       │  30%",
      "└─────────────────┴─────────────────┘",
    ],
    buildConfig(name: string, detected?: DetectedInfo): IdeConfig {
      return {
        name,
        rows: [
          {
            size: "70%",
            panes: [
              { title: "Claude 1", command: "claude", size: "50%" },
              { title: "Claude 2", command: "claude" },
            ],
          },
          {
            panes: [
              { title: "Dev Server", command: devCmd(detected), size: "50%" },
              { title: "Shell" },
            ],
          },
        ],
      };
    },
  },
  {
    id: "triple-claude",
    label: "Triple Claude",
    description: "Three Claude panes on top for parallel work, dev server and shell below.",
    diagram: [
      "┌───────────┬───────────┬───────────┐",
      "│           │           │           │",
      "│ Claude 1  │ Claude 2  │ Claude 3  │  70%",
      "│           │           │           │",
      "├───────────┴─────┬─────┴───────────┤",
      "│   Dev Server    │     Shell       │  30%",
      "└─────────────────┴─────────────────┘",
    ],
    buildConfig(name: string, detected?: DetectedInfo): IdeConfig {
      return {
        name,
        rows: [
          {
            size: "70%",
            panes: [
              { title: "Claude 1", command: "claude", size: "33%" },
              { title: "Claude 2", command: "claude", size: "34%" },
              { title: "Claude 3", command: "claude" },
            ],
          },
          {
            panes: [
              { title: "Dev Server", command: devCmd(detected), size: "50%" },
              { title: "Shell" },
            ],
          },
        ],
      };
    },
  },
  {
    id: "single-claude",
    label: "Single Claude",
    description: "One wide Claude pane on top, dev server, tests, and shell below.",
    diagram: [
      "┌─────────────────────────────────────┐",
      "│             Claude                  │  60%",
      "├──────────┬──────────┬──────────────┤",
      "│ Dev Srv  │  Tests   │    Shell     │  40%",
      "└──────────┴──────────┴──────────────┘",
    ],
    buildConfig(name: string, detected?: DetectedInfo): IdeConfig {
      return {
        name,
        rows: [
          {
            size: "60%",
            panes: [
              { title: "Claude", command: "claude", focus: true },
            ],
          },
          {
            panes: [
              { title: "Dev Server", command: devCmd(detected), size: "33%" },
              { title: "Tests", command: testCmd(detected), size: "34%" },
              { title: "Shell" },
            ],
          },
        ],
      };
    },
  },
  {
    id: "agent-team",
    label: "Agent Team",
    description: "Lead + 2 teammates on top, warroom/tasks/explorer/preview widgets below with orchestrator.",
    diagram: [
      "┌───────────┬───────────┬───────────┐",
      "│           │           │           │",
      "│   Lead    │ Teammate1 │ Teammate2 │  70%",
      "│           │           │           │",
      "├─────┬─────┼─────┬─────┴───────────┤",
      "│ War │Tasks│Explr│    Preview      │  30%",
      "└─────┴─────┴─────┴─────────────────┘",
    ],
    buildConfig(name: string, _detected?: DetectedInfo): IdeConfig {
      return {
        name,
        team: { name: name },
        rows: [
          {
            size: "70%",
            panes: [
              { title: "Lead", command: "claude", role: "lead", focus: true, size: "33%" },
              { title: "Teammate 1", command: "claude", role: "teammate", size: "34%" },
              { title: "Teammate 2", command: "claude", role: "teammate" },
            ],
          },
          {
            panes: [
              { title: "War Room", type: "warroom", size: "20%" },
              { title: "Tasks", type: "tasks", size: "20%" },
              { title: "Explorer", type: "explorer", size: "20%" },
              { title: "Preview", type: "preview" },
            ],
          },
        ],
        orchestrator: { enabled: true, auto_dispatch: true },
      };
    },
  },
];

export function getPreset(id: string): LayoutPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// Config Tree
// ---------------------------------------------------------------------------

export interface TreeNode {
  path: string[];
  label: string;
  value: string | null;
  depth: number;
  expandable: boolean;
}

function flattenValue(
  obj: unknown,
  path: string[],
  depth: number,
  nodes: TreeNode[],
): void {
  if (Array.isArray(obj)) {
    const label = path[path.length - 1] ?? "";
    nodes.push({ path: [...path], label, value: null, depth, expandable: true });
    for (let i = 0; i < obj.length; i++) {
      flattenValue(obj[i], [...path, String(i)], depth + 1, nodes);
    }
  } else if (obj !== null && typeof obj === "object") {
    const label = path[path.length - 1] ?? "";
    nodes.push({ path: [...path], label, value: null, depth, expandable: true });
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      flattenValue(val, [...path, key], depth + 1, nodes);
    }
  } else {
    const label = path[path.length - 1] ?? "";
    nodes.push({
      path: [...path],
      label,
      value: obj === undefined || obj === null ? null : String(obj),
      depth,
      expandable: false,
    });
  }
}

export function flattenConfigTree(config: IdeConfig): TreeNode[] {
  const nodes: TreeNode[] = [];
  // Flatten top-level keys (skip the root container itself)
  for (const [key, val] of Object.entries(config)) {
    if (val === undefined) continue;
    flattenValue(val, [key], 0, nodes);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Config Mutations
// ---------------------------------------------------------------------------

function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export function updateConfigAtPath(
  config: IdeConfig,
  path: string[],
  value: unknown,
): IdeConfig {
  const cloned = deepClone(config);
  let current: Record<string, unknown> = cloned as unknown as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1]!;
  current[lastKey] = value;
  return cloned;
}

export function addPane(config: IdeConfig, rowIdx: number): IdeConfig {
  const cloned = deepClone(config);
  const row = cloned.rows[rowIdx];
  if (!row) return cloned;
  row.panes.push({ title: "New Pane" });
  return cloned;
}

export function removePane(
  config: IdeConfig,
  rowIdx: number,
  paneIdx: number,
): IdeConfig {
  const cloned = deepClone(config);
  const row = cloned.rows[rowIdx];
  if (!row) return cloned;
  // Don't remove the last pane — rows require at least 1
  if (row.panes.length <= 1) return cloned;
  row.panes.splice(paneIdx, 1);
  return cloned;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSetupConfig(
  config: unknown,
): { valid: true; config: IdeConfig } | { valid: false; errors: string[] } {
  const result = IdeConfigSchema.safeParse(config);
  if (result.success) {
    return { valid: true, config: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    ),
  };
}
