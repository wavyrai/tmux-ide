import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import yaml from "js-yaml";
import { WorkspaceConfigV1SchemaZ, type WorkspaceConfigV1 } from "@tmux-ide/contracts";
import type { IdeConfig } from "../types.ts";
import {
  loadWorkspaceConfig,
  WorkspaceConfigLoadError,
  type LoadedWorkspaceConfig,
  type LoadWorkspaceConfigOptions,
} from "./workspace-config-loader.ts";
import { ConfigError, IdeError } from "./errors.ts";
import {
  resolveProject,
  type ProjectResolution,
  type ResolveProjectOptions,
} from "./project-resolver.ts";
import {
  hasLegacyConfigAt,
  legacyConfigPath,
  readLegacyConfigAt,
  readLegacyConfigFile,
} from "./legacy-config-adapter.ts";
import {
  convertLegacyConfigToWorkspace,
  workspaceConfigToLegacyProjection,
  workspaceConfigToYaml,
  type LegacyMigrationDiagnostic,
} from "./legacy-config-migration.ts";

export type ResolvedConfigKind = "workspace" | "legacy" | "none";

export class WorkspaceConfigWriteError extends IdeError {
  readonly path: string;

  constructor(message: string, code: string, path: string, cause?: unknown) {
    super(message, {
      code,
      exitCode: 1,
      cause:
        cause instanceof Error ? cause : cause === undefined ? undefined : new Error(String(cause)),
    });
    this.name = "WorkspaceConfigWriteError";
    this.path = path;
  }
}

export class UnsupportedLegacyConfigMutationError extends IdeError {
  constructor(
    readonly diagnostics: LegacyMigrationDiagnostic[],
    message = `Legacy ide.yml contains unsupported fields that would be dropped by config mutation. Run \`tmux-ide migrate --dry-run\` and move to .tmux-ide/workspace.yml first.`,
  ) {
    super(message, { code: "LEGACY_CONFIG_MUTATION_UNSUPPORTED", exitCode: 1 });
    this.name = "UnsupportedLegacyConfigMutationError";
  }
}

export interface ResolvedConfig {
  kind: ResolvedConfigKind;
  path: string | null;
  localPath: string | null;
  provenance: "explicit" | "workspace" | "legacy" | "none";
  resolution: ProjectResolution;
  workspace: WorkspaceConfigV1 | null;
  legacy: IdeConfig | null;
  launchConfig: IdeConfig | null;
  diagnostics: LegacyMigrationDiagnostic[];
  migrationHint: string | null;
}

export interface ResolveConfigOptions extends LoadWorkspaceConfigOptions {
  resolveOptions?: ResolveProjectOptions;
}

function loadedWorkspaceToResolved(loaded: LoadedWorkspaceConfig): ResolvedConfig {
  const launchConfig = workspaceConfigToLegacyProjection(loaded.config);
  return {
    kind: "workspace",
    path: loaded.source.basePath,
    localPath: loaded.source.localPath,
    provenance: loaded.source.resolution.config.explicit ? "explicit" : "workspace",
    resolution: loaded.source.resolution,
    workspace: loaded.config,
    legacy: null,
    launchConfig,
    diagnostics: [],
    migrationHint: null,
  };
}

function configReadError(message: string, cause: unknown): ConfigError {
  return new ConfigError(message, "READ_ERROR", {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function configInvalidError(message: string, cause: unknown): ConfigError {
  return new ConfigError(message, "INVALID_CONFIG", {
    cause: cause instanceof Error ? cause : new Error(String(cause)),
  });
}

function mapWorkspaceLoadError(error: WorkspaceConfigLoadError): ConfigError {
  if (error.code.endsWith("_READ_FAILED") || error.code === "RESOLUTION_FAILED") {
    return configReadError(error.message, error);
  }
  return configInvalidError(error.message, error);
}

function readLegacyConfigForResolution(path: string): { config: IdeConfig; raw: string } {
  try {
    return readLegacyConfigFile(path);
  } catch (cause) {
    const name = (cause as Error).name;
    if (name === "YAMLException") {
      throw configInvalidError(
        `Invalid legacy ide.yml YAML at ${path}: ${(cause as Error).message}. Run "tmux-ide validate" for details.`,
        cause,
      );
    }
    if (name === "ZodError") {
      throw configInvalidError(
        `Invalid legacy ide.yml at ${path}: ${(cause as Error).message}. Run "tmux-ide validate" for details.`,
        cause,
      );
    }
    throw configReadError(
      `Cannot read legacy ide.yml at ${path}: ${(cause as Error).message}`,
      cause,
    );
  }
}

export async function resolveConfig(
  dir: string,
  options: ResolveConfigOptions = {},
): Promise<ResolvedConfig> {
  const resolution = await resolveProject(dir, {
    explicitConfigPath: options.explicitConfigPath ?? options.resolveOptions?.explicitConfigPath,
    projectRootHint: options.resolveOptions?.projectRootHint,
    io: options.resolverIo ?? options.resolveOptions?.io,
  });

  if (resolution.config.kind === "workspace") {
    let loaded: LoadedWorkspaceConfig;
    try {
      loaded = await loadWorkspaceConfig(dir, {
        explicitConfigPath: resolution.config.explicit ? resolution.config.path : null,
        resolverIo: options.resolverIo ?? options.resolveOptions?.io,
        io: options.io,
      });
    } catch (error) {
      if (error instanceof WorkspaceConfigLoadError) throw mapWorkspaceLoadError(error);
      throw error;
    }
    return loadedWorkspaceToResolved(loaded);
  }

  if (resolution.config.kind === "legacy") {
    const { config: legacy } = readLegacyConfigForResolution(resolution.config.path);
    const migration = convertLegacyConfigToWorkspace(legacy);
    return {
      kind: "legacy",
      path: resolution.config.path,
      localPath: null,
      provenance: resolution.config.explicit ? "explicit" : "legacy",
      resolution,
      workspace: migration.workspace,
      legacy,
      launchConfig: legacy,
      diagnostics: migration.diagnostics,
      migrationHint:
        "Legacy ide.yml is supported for compatibility. Run `tmux-ide migrate --dry-run` to preview .tmux-ide/workspace.yml.",
    };
  }

  return {
    kind: "none",
    path: null,
    localPath: null,
    provenance: "none",
    resolution,
    workspace: null,
    legacy: null,
    launchConfig: null,
    diagnostics: [],
    migrationHint: null,
  };
}

export function workspaceConfigPath(dir: string): string {
  return resolve(dir, ".tmux-ide", "workspace.yml");
}

export function workspaceLocalConfigPath(dir: string): string {
  return resolve(dir, ".tmux-ide", "workspace.local.yml");
}

export function writeWorkspaceConfig(dir: string, workspace: WorkspaceConfigV1): string {
  const parsed = WorkspaceConfigV1SchemaZ.parse(workspace);
  const configPath = workspaceConfigPath(dir);
  const configDir = dirname(configPath);
  const tempPath = join(
    configDir,
    `.workspace.yml.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(tempPath, workspaceConfigToYaml(parsed), { encoding: "utf-8", flag: "wx" });
    renameSync(tempPath, configPath);
  } catch (cause) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original write/rename failure.
    }
    throw new WorkspaceConfigWriteError(
      `Failed to write workspace config at ${configPath}`,
      "WORKSPACE_WRITE_FAILED",
      configPath,
      cause,
    );
  }
  return configPath;
}

export function createWorkspaceConfig(dir: string, workspace: WorkspaceConfigV1): string {
  const parsed = WorkspaceConfigV1SchemaZ.parse(workspace);
  const configPath = workspaceConfigPath(dir);
  const configDir = dirname(configPath);
  const tempPath = join(
    configDir,
    `.workspace.yml.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(tempPath, workspaceConfigToYaml(parsed), { encoding: "utf-8", flag: "wx" });
    linkSync(tempPath, configPath);
    unlinkSync(tempPath);
  } catch (cause) {
    try {
      unlinkSync(tempPath);
    } catch {
      // Preserve the original write/link failure.
    }
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "EEXIST" && existsSync(configPath)) {
      throw new WorkspaceConfigWriteError(
        `Workspace config already exists at ${configPath}`,
        "CONFIG_EXISTS",
        configPath,
        cause,
      );
    }
    throw new WorkspaceConfigWriteError(
      `Failed to create workspace config at ${configPath}`,
      "WORKSPACE_WRITE_FAILED",
      configPath,
      cause,
    );
  }
  return configPath;
}

function readWorkspaceBaseConfig(dir: string): WorkspaceConfigV1 | null {
  const workspacePath = workspaceConfigPath(dir);
  if (!existsSync(workspacePath)) return null;
  return WorkspaceConfigV1SchemaZ.parse(yaml.load(readFileSync(workspacePath, "utf-8")));
}

const LAUNCH_CONFIG_KEYS = new Set([
  "name",
  "before",
  "rows",
  "theme",
  "team",
  "orchestrator",
  "command_center",
  "dashboard",
  "auth",
  "tunnel",
  "hq",
  "sidebar",
]);
const ROW_KEYS = new Set(["size", "panes"]);
const PANE_KEYS = new Set([
  "id",
  "title",
  "command",
  "type",
  "target",
  "dir",
  "size",
  "focus",
  "env",
  "role",
  "task",
  "specialty",
  "skill",
]);

function unsupportedOutputDiagnostics(config: IdeConfig): LegacyMigrationDiagnostic[] {
  const diagnostics: LegacyMigrationDiagnostic[] = [];
  for (const key of Object.keys(config as Record<string, unknown>)) {
    if (!LAUNCH_CONFIG_KEYS.has(key)) {
      diagnostics.push({
        code: "UNSUPPORTED_UNKNOWN_FIELD",
        path: key,
        message: "unknown top-level config field cannot be represented in WorkspaceConfigV1",
      });
    }
  }
  config.rows?.forEach((row, rowIndex) => {
    for (const key of Object.keys(row as Record<string, unknown>)) {
      if (!ROW_KEYS.has(key)) {
        diagnostics.push({
          code: "UNSUPPORTED_UNKNOWN_FIELD",
          path: `rows.${rowIndex}.${key}`,
          message: "unknown row config field cannot be represented in WorkspaceConfigV1",
        });
      }
    }
    row.panes?.forEach((pane, paneIndex) => {
      for (const key of Object.keys(pane as Record<string, unknown>)) {
        if (!PANE_KEYS.has(key)) {
          diagnostics.push({
            code: "UNSUPPORTED_UNKNOWN_FIELD",
            path: `rows.${rowIndex}.panes.${paneIndex}.${key}`,
            message: "unknown pane config field cannot be represented in WorkspaceConfigV1",
          });
        }
      }
    });
  });
  return diagnostics;
}

export function writeLaunchProjectionConfig(dir: string, config: IdeConfig): string {
  const converted = convertLegacyConfigToWorkspace(config);
  const unsupportedOutput = unsupportedOutputDiagnostics(config);
  const existing = readWorkspaceBaseConfig(dir);
  if (!existing && hasLegacyConfig(dir)) {
    const legacy = readLegacyConfigAt(dir).config;
    const legacyDiagnostics = convertLegacyConfigToWorkspace(legacy).diagnostics;
    if (legacyDiagnostics.length > 0) {
      throw new UnsupportedLegacyConfigMutationError(legacyDiagnostics);
    }
  }
  if (unsupportedOutput.length > 0 || converted.diagnostics.length > 0) {
    throw new UnsupportedLegacyConfigMutationError(
      [...unsupportedOutput, ...converted.diagnostics],
      existing
        ? "Config mutation introduced legacy-only fields that cannot be represented in WorkspaceConfigV1."
        : "New workspace config contains legacy-only fields that cannot be represented in WorkspaceConfigV1.",
    );
  }
  if (!existing) return writeWorkspaceConfig(dir, converted.workspace);

  return writeWorkspaceConfig(dir, {
    ...existing,
    ...(converted.workspace.name === undefined
      ? { name: undefined }
      : { name: converted.workspace.name }),
    ...(converted.workspace.before === undefined
      ? { before: undefined }
      : { before: converted.workspace.before }),
    terminal: converted.workspace.terminal,
  });
}

export function readConfigCompatSync(dir: string): { config: IdeConfig; configPath: string } {
  const workspacePath = workspaceConfigPath(dir);
  if (existsSync(workspacePath)) {
    const parsed = WorkspaceConfigV1SchemaZ.parse(yaml.load(readFileSync(workspacePath, "utf-8")));
    return { config: workspaceConfigToLegacyProjection(parsed), configPath: workspacePath };
  }
  const { config, configPath } = readLegacyConfigAtCompat(dir);
  return { config, configPath };
}

export function getSessionNameCompatSync(dir: string): {
  name: string;
  source: "config" | "fallback";
} {
  try {
    const { config } = readConfigCompatSync(dir);
    return { name: config.name ?? basename(dir), source: config.name ? "config" : "fallback" };
  } catch {
    return { name: basename(dir), source: "fallback" };
  }
}

export function hasWorkspaceConfig(dir: string): boolean {
  return existsSync(workspaceConfigPath(dir));
}

export function hasLegacyConfig(dir: string): boolean {
  return hasLegacyConfigAt(dir);
}

export function hasLaunchConfig(dir: string): boolean {
  return hasWorkspaceConfig(dir) || hasLegacyConfig(dir);
}

export function canonicalConfigPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function readLegacyConfigAtCompat(dir: string): { config: IdeConfig; configPath: string } {
  const configPath = legacyConfigPath(dir);
  const { config } = readLegacyConfigFile(configPath);
  return { config, configPath };
}
