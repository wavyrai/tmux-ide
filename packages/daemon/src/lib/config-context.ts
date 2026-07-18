import { basename, dirname, resolve } from "node:path";
import {
  resolveConfig,
  type ResolveConfigOptions,
  type ResolvedConfig,
  type ResolvedConfigKind,
} from "./resolved-config.ts";

export interface ConfigFacts {
  configExists: boolean;
  hasWorkspaceConfig: boolean;
  hasIdeYml: boolean;
  configKind: ResolvedConfigKind;
  configPath: string | null;
  ideConfigPath: string | null;
}

export interface ProjectConfigContext extends ConfigFacts {
  inputDir: string;
  projectRoot: string;
  configWriteRoot: string;
  sessionName: string;
  sessionNameSource: "config" | "fallback";
  resolved: ResolvedConfig | null;
}

function configWriteRootForResolved(resolved: ResolvedConfig, projectRoot: string): string {
  if (!resolved.path) return projectRoot;
  if (resolved.kind === "legacy") return dirname(resolved.path);
  if (resolved.kind === "workspace") {
    const configDir = dirname(resolved.path);
    return basename(configDir) === ".tmux-ide" ? dirname(configDir) : configDir;
  }
  return projectRoot;
}

export async function resolveProjectConfigContext(
  targetDir: string,
  options: ResolveConfigOptions = {},
): Promise<ProjectConfigContext> {
  const inputDir = resolve(targetDir);
  const resolved = await resolveConfig(inputDir, options);
  const projectRoot = resolved.resolution.projectRoot;
  const configWriteRoot = configWriteRootForResolved(resolved, projectRoot);
  const configName = resolved.launchConfig?.name ?? undefined;
  return {
    inputDir,
    projectRoot,
    configWriteRoot,
    sessionName: configName ?? basename(projectRoot),
    sessionNameSource: configName ? "config" : "fallback",
    resolved,
    configExists: resolved.kind !== "none",
    hasWorkspaceConfig:
      resolved.kind === "workspace" || resolved.resolution.workspaceConfigPath !== null,
    hasIdeYml: resolved.kind === "legacy" || resolved.resolution.legacyConfigPath !== null,
    configKind: resolved.kind,
    configPath: resolved.path,
    ideConfigPath: resolved.resolution.legacyConfigPath,
  };
}
