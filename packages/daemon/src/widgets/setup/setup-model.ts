import type { IdeConfig } from "../../schemas/ide-config.ts";

// Re-export shared config model utilities
export {
  type TreeNode,
  flattenConfigTree,
  updateConfigAtPath,
  addPane,
  removePane,
  addRow,
  removeRow,
  deepClone,
  validateSetupConfig,
} from "../lib/config-model.ts";

// ---------------------------------------------------------------------------
// Layout Presets (setup-specific)
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
            panes: [{ title: "Claude", command: "claude", focus: true }],
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
    description:
      "Lead + 2 teammates on top, mission control/explorer/preview widgets below with orchestrator.",
    diagram: [
      "┌───────────┬───────────┬───────────┐",
      "│           │           │           │",
      "│   Lead    │ Teammate1 │ Teammate2 │  70%",
      "│           │           │           │",
      "├───────────┼───────────┴───────────┤",
      "│  Mission  │  Explorer  │ Preview  │  30%",
      "│  Control  │            │          │",
      "└───────────┴────────────┴──────────┘",
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
              { title: "Mission Control", type: "mission-control", size: "40%" },
              { title: "Explorer", type: "explorer", size: "30%" },
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
