import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PaneInfo } from "../widgets/lib/pane-comms.ts";

// ---------------------------------------------------------------------------
// Factory: PaneInfo
// ---------------------------------------------------------------------------

export function makePane(overrides: Partial<PaneInfo> = {}): PaneInfo {
  return {
    id: "%1",
    index: 0,
    title: "Agent 1",
    currentCommand: "zsh",
    width: 80,
    height: 24,
    active: false,
    role: null,
    name: null,
    type: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TestProject: scratch temp directory
// ---------------------------------------------------------------------------

export class TestProject {
  readonly dir: string;

  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), "tmux-ide-test-"));
  }

  cleanup(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
