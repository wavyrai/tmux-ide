import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { outputError } from "./lib/output.ts";
import {
  convertLegacyConfigToWorkspace,
  workspaceConfigToYaml,
} from "./lib/legacy-config-migration.ts";
import {
  createWorkspaceConfig,
  workspaceConfigPath,
  WorkspaceConfigWriteError,
} from "./lib/resolved-config.ts";
import { readLegacyConfigFile } from "./lib/legacy-config-adapter.ts";
import { resolveProject } from "./lib/project-resolver.ts";
import { IdeError } from "./lib/errors.ts";

export interface MigrationWarning {
  code: "TMUX_IDE_DIR_IGNORED";
  message: string;
}

function gitIgnoresWorkspace(dir: string): boolean {
  try {
    execFileSync("git", ["-C", dir, "check-ignore", "-q", ".tmux-ide/workspace.yml"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function migrationWarnings(dir: string): MigrationWarning[] {
  if (!gitIgnoresWorkspace(dir)) return [];
  return [
    {
      code: "TMUX_IDE_DIR_IGNORED",
      message:
        "Git ignores .tmux-ide/workspace.yml. Track .tmux-ide/workspace.yml and ignore only .tmux-ide/workspace.local.yml for machine-local overrides.",
    },
  ];
}

function readLegacyForMigration(legacyPath: string): ReturnType<typeof readLegacyConfigFile> {
  try {
    return readLegacyConfigFile(legacyPath);
  } catch (error) {
    const name = (error as Error).name;
    if (name === "YAMLException") {
      outputError(
        `Invalid legacy ide.yml YAML: ${(error as Error).message}`,
        "LEGACY_YAML_INVALID",
      );
    }
    if (name === "ZodError") {
      outputError(
        `Invalid legacy ide.yml schema: ${(error as Error).message}`,
        "LEGACY_SCHEMA_INVALID",
      );
    }
    outputError(`Cannot read legacy ide.yml: ${(error as Error).message}`, "LEGACY_READ_FAILED");
  }
}

export async function migrate(
  targetDir: string | undefined,
  {
    json,
    dryRun,
    write,
    onAfterRead,
  }: {
    json?: boolean;
    dryRun?: boolean;
    write?: boolean;
    /** Test hook for deterministic source-change race coverage. */
    onAfterRead?: () => void | Promise<void>;
  } = {},
): Promise<void> {
  const dir = resolve(targetDir ?? ".");

  if (!dryRun && !write) dryRun = true;
  if (dryRun && write) outputError("Use either --dry-run or --write, not both", "USAGE");

  try {
    const resolution = await resolveProject(dir);
    if (resolution.config.kind === "workspace") {
      outputError(`Workspace config already exists at ${resolution.config.path}`, "CONFIG_EXISTS");
    }
    if (resolution.config.kind !== "legacy" || !resolution.config.path) {
      outputError("No resolved legacy ide.yml found to migrate", "CONFIG_NOT_FOUND");
    }
    const legacyPath = resolution.config.path;
    const writeRoot = dirname(legacyPath);
    const workspacePath = workspaceConfigPath(writeRoot);
    const { raw, config } = readLegacyForMigration(legacyPath);
    await onAfterRead?.();
    const result = convertLegacyConfigToWorkspace(config);
    const workspaceYaml = workspaceConfigToYaml(result.workspace);
    const warnings = migrationWarnings(writeRoot);
    if (raw !== readLegacyForMigration(legacyPath).raw) {
      outputError("Legacy ide.yml changed during migration", "CONFIG_CHANGED");
    }
    const writtenPath = write ? createWorkspaceConfig(writeRoot, result.workspace) : null;

    const payload = {
      ok: true,
      mode: write ? "write" : "dry-run",
      legacyPath,
      workspacePath,
      written: writtenPath,
      diagnostics: result.diagnostics,
      warnings,
      workspace: result.workspace,
      workspaceYaml,
    };

    if (json) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    if (write) console.log(`Created ${workspacePath}`);
    else console.log(workspaceYaml.trimEnd());
    for (const diagnostic of result.diagnostics) {
      console.log(`warning ${diagnostic.code} at ${diagnostic.path}: ${diagnostic.message}`);
    }
    for (const warning of warnings) {
      console.log(`warning ${warning.code}: ${warning.message}`);
    }
  } catch (error) {
    if (error instanceof IdeError) throw error;
    if (error instanceof WorkspaceConfigWriteError) {
      outputError(error.message, error.code);
    }
    if (error instanceof Error && error.name === "ZodError") {
      outputError(`Invalid legacy ide.yml: ${error.message}`, "INVALID_CONFIG");
    }
    throw error;
  }
}
