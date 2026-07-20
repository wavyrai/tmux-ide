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
import type { Pane, Row, IdeConfig } from "../schemas/ide-config.ts";
import { resolveProject, type ProjectResolution } from "./project-resolver.ts";

export class OnboardConflictError extends Error {
  readonly code: string;
  constructor(path: string, code = "IDE_YML_EXISTS") {
    super(`project config already exists at ${path}`);
    this.name = "OnboardConflictError";
    this.code = code;
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
 *   - Row 0 (70%): N Claude panes, first focused.
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
    const fallback = agentsCount > 1 ? (i === 0 ? "Lead" : `Teammate ${i}`) : `Claude ${i + 1}`;
    const customTitle = customNames?.[i]?.trim();
    const pane: Pane = {
      id: `agent-${i + 1}`,
      title: customTitle && customTitle.length > 0 ? customTitle : fallback,
      command: "claude",
    };
    if (i === 0) {
      pane.focus = true;
    }
    topPanes.push(pane);
  }

  const bottomPanes: Pane[] = [];
  const devCommand = input.devCommand?.trim();
  if (devCommand) {
    bottomPanes.push({ id: "dev", title: "Dev", command: devCommand });
  }
  bottomPanes.push({ id: "shell", title: "Shell" });

  const rows: Row[] = [{ size: "70%", panes: topPanes }, { panes: bottomPanes }];

  const config: IdeConfig = {
    name: cleanName,
    rows,
  };

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
export async function assertNoExistingIdeYml(
  dir: string,
  resolver: (dir: string) => Promise<ProjectResolution> = resolveProject,
): Promise<void> {
  const resolution = await resolver(dir);
  if (resolution.config.kind === "legacy") {
    throw new OnboardConflictError(resolution.config.path, "IDE_YML_EXISTS");
  }
  if (resolution.config.kind === "workspace") {
    throw new OnboardConflictError(resolution.config.path, "WORKSPACE_CONFIG_EXISTS");
  }
}
