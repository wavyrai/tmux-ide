/**
 * Project onboard — composes a sensible `ide.yml` from a small set of
 * inputs (project name, agent count, optional dev/test commands) and
 * writes it to disk so the project can be registered.
 *
 * `composeIdeYml` is the pure-logic bit (string in → string out) so the
 * shape of the generated config is exhaustively unit-tested without
 * touching the filesystem. The wrapper around `writeConfig` lives in the
 * server route, which calls this function and then `registerProject`.
 */

import yaml from "js-yaml";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Pane, Row, IdeConfig } from "../schemas/ide-config.ts";

export class OnboardConflictError extends Error {
  readonly code = "IDE_YML_EXISTS";
  constructor(path: string) {
    super(`ide.yml already exists at ${path}`);
    this.name = "OnboardConflictError";
  }
}

export class OnboardInvalidInputError extends Error {
  readonly code = "INVALID_INPUT";
  constructor(message: string) {
    super(message);
    this.name = "OnboardInvalidInputError";
  }
}

export interface ComposeIdeYmlInput {
  /** Final project name written to the `name:` field. */
  name: string;
  /** 1, 2, or 3 — how many Claude panes to put in the top row. */
  agents: number;
  /**
   * Optional per-agent pane titles. When provided, length must equal
   * `agents`; otherwise it's ignored and the canonical defaults are used
   * (`Lead`/`Teammate N` for team layouts, `Claude N` for solo).
   */
  agentNames?: string[];
  /** Dev server command. `null` / undefined → no dev pane. */
  devCommand?: string | null;
  /** Test command. Currently unused in the generated layout but kept for future. */
  testCommand?: string | null;
  /** Lint command. Currently unused in the generated layout but kept for future. */
  lintCommand?: string | null;
}

/**
 * Build the `IdeConfig` value the wizard should write. Pure: same input →
 * same output, no io.
 *
 * Layout shape:
 *   - Row 0 (70%): N Claude panes, first focused. When `agents > 1`, the
 *     `team:` block is added so Claude Code launches with team mode.
 *   - Row 1 (30%): Dev pane (if `devCommand` set) + Shell pane.
 */
export function composeIdeYmlConfig(input: ComposeIdeYmlInput): IdeConfig {
  if (!Number.isInteger(input.agents) || input.agents < 1 || input.agents > 3) {
    throw new OnboardInvalidInputError(
      `agents must be an integer between 1 and 3 (got ${input.agents})`,
    );
  }
  const cleanName = input.name.trim();
  if (!cleanName) {
    throw new OnboardInvalidInputError("name must be a non-empty string");
  }

  const agentsCount = input.agents;
  const useTeam = agentsCount > 1;

  const customNames = input.agentNames;
  if (customNames !== undefined) {
    if (customNames.length !== agentsCount) {
      throw new OnboardInvalidInputError(
        `agentNames length (${customNames.length}) must equal agents (${agentsCount})`,
      );
    }
    for (const name of customNames) {
      if (typeof name !== "string" || name.trim() === "") {
        throw new OnboardInvalidInputError("agentNames entries must be non-empty strings");
      }
    }
  }

  const topPanes: Pane[] = [];
  for (let i = 0; i < agentsCount; i++) {
    const fallback = useTeam ? (i === 0 ? "Lead" : `Teammate ${i}`) : `Claude ${i + 1}`;
    const customTitle = customNames?.[i]?.trim();
    const pane: Pane = {
      title: customTitle && customTitle.length > 0 ? customTitle : fallback,
      command: "claude",
    };
    if (useTeam) {
      pane.role = i === 0 ? "lead" : "teammate";
    }
    if (i === 0) {
      pane.focus = true;
    }
    topPanes.push(pane);
  }

  const bottomPanes: Pane[] = [];
  const devCommand = input.devCommand?.trim();
  if (devCommand) {
    bottomPanes.push({ title: "Dev", command: devCommand });
  }
  bottomPanes.push({ title: "Shell" });

  const rows: Row[] = [{ size: "70%", panes: topPanes }, { panes: bottomPanes }];

  const config: IdeConfig = {
    name: cleanName,
    rows,
  };

  if (useTeam) {
    config.team = { name: cleanName };
  }

  return config;
}

/**
 * Render a composed `IdeConfig` as YAML. Wrapper over `js-yaml` with the
 * same options used elsewhere so the output shape is identical.
 */
export function composeIdeYml(input: ComposeIdeYmlInput): string {
  const config = composeIdeYmlConfig(input);
  return yaml.dump(config, { lineWidth: -1, noRefs: true, quotingType: '"' });
}

/**
 * Reject onboarding when `ide.yml` already exists. The caller writes the
 * file separately via `writeConfig`; this helper exists so the route can
 * 409 cleanly without ever overwriting user content.
 */
export function assertNoExistingIdeYml(
  dir: string,
  exists: (path: string) => boolean = existsSync,
): void {
  const path = join(dir, "ide.yml");
  if (exists(path)) {
    throw new OnboardConflictError(path);
  }
}
