/**
 * Read-only, bounded adapter for the pure project-readiness classifier.
 *
 * Every effect is injectable. Built-in commands are probed only with known
 * version/read-only argv; custom harness launch argv are never executed.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, basename, resolve, sep } from "node:path";
import {
  classifyProjectReadiness,
  type AuthenticationReadiness,
  type Availability,
  type CommandReadiness,
  type HarnessKind,
  type ProjectReadinessHarnessProbe,
  type ProjectReadinessProbe,
  type ProjectReadinessResult,
  type ProjectRegistrationState,
} from "./project-readiness.ts";
import { sanitizeName } from "./project-probe.ts";
import { resolveProject } from "./project-resolver.ts";

const DEFAULT_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type ReadinessPathKind = "directory" | "other" | "missing" | "unknown";

export type ReadinessCommandStatus = "success" | "failure" | "timeout" | "not-found" | "unknown";

export interface ReadinessCommandResult {
  status: ReadinessCommandStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

export interface ReadinessCommandOptions {
  cwd: string;
  env: Readonly<NodeJS.ProcessEnv>;
  timeoutMs: number;
}

export interface ProjectReadinessProbeIo {
  cwd(): string;
  environment(): Readonly<NodeJS.ProcessEnv>;
  platform(): { os: NodeJS.Platform; arch: string };
  inspectPath(path: string): ReadinessPathKind;
  exists(path: string): boolean;
  realpath(path: string): string;
  isExecutable(path: string): Availability;
  runCommand(
    executable: string,
    argv: readonly string[],
    options: ReadinessCommandOptions,
  ): Promise<ReadinessCommandResult>;
}

export interface CustomReadinessHarnessProfile {
  id: string;
  label: string;
  /** Launch argv is preserved for the plan but never executed by this probe. */
  command: readonly string[];
  source?: "workspace" | "user";
  authentication?: AuthenticationReadiness;
  commandReadiness?: CommandReadiness;
  version?: string | null;
}

export interface ProjectReadinessProbeOptions {
  io?: Partial<ProjectReadinessProbeIo>;
  timeoutMs?: number;
  registration?: ProjectRegistrationState;
  projectRootHint?: string | null;
  shellCommand?: readonly string[];
  customHarnesses?: readonly CustomReadinessHarnessProfile[];
  preferredHarnessId?: string | null;
  /** Trusted facts from a separate, non-interactive credential surface. */
  authentication?: Readonly<Record<string, AuthenticationReadiness | undefined>>;
}

interface LocatedExecutable {
  availability: Availability;
  path: string | null;
}

interface HarnessSpec {
  id: string;
  kind: HarnessKind;
  label: string;
  command: readonly string[];
  source: "detected" | "workspace" | "user";
  versionArgv: readonly string[] | null;
  authentication: AuthenticationReadiness;
  declaredCommandReadiness?: CommandReadiness;
  declaredVersion?: string | null;
}

const BUILTIN_HARNESSES: readonly Omit<
  HarnessSpec,
  "authentication" | "declaredCommandReadiness" | "declaredVersion"
>[] = [
  {
    id: "codex",
    kind: "codex",
    label: "Codex",
    command: ["codex"],
    source: "detected",
    versionArgv: ["--version"],
  },
  {
    id: "claude",
    kind: "claude",
    label: "Claude Code",
    command: ["claude"],
    source: "detected",
    versionArgv: ["--version"],
  },
  {
    id: "opencode",
    kind: "opencode",
    label: "OpenCode",
    command: ["opencode"],
    source: "detected",
    versionArgv: ["--version"],
  },
];

function errorCode(error: unknown): string | number | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : undefined;
}

const defaultIo: ProjectReadinessProbeIo = {
  cwd: () => process.cwd(),
  environment: () => process.env,
  platform: () => ({ os: process.platform, arch: process.arch }),
  inspectPath: (path) => {
    try {
      return statSync(path).isDirectory() ? "directory" : "other";
    } catch (error) {
      const code = errorCode(error);
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
    }
  },
  exists: existsSync,
  realpath: realpathSync,
  isExecutable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return "available";
    } catch (error) {
      const code = errorCode(error);
      return code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" ? "missing" : "unknown";
    }
  },
  runCommand: (executable, argv, options) =>
    new Promise((resolveResult) => {
      execFile(
        executable,
        [...argv],
        {
          cwd: options.cwd,
          env: { ...options.env },
          encoding: "utf-8",
          maxBuffer: MAX_OUTPUT_BYTES,
          timeout: options.timeoutMs,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolveResult({ status: "success", stdout, stderr, exitCode: 0 });
            return;
          }
          const code = errorCode(error);
          if (code === "ENOENT") {
            resolveResult({ status: "not-found", stdout, stderr, exitCode: null });
            return;
          }
          if (code === "ETIMEDOUT" || ("killed" in error && error.killed)) {
            resolveResult({ status: "timeout", stdout, stderr, exitCode: null });
            return;
          }
          resolveResult({
            status: "failure",
            stdout,
            stderr,
            exitCode: typeof code === "number" ? code : null,
          });
        },
      );
    }),
};

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS);
}

function safeCall<T>(operation: () => T, fallback: T): T {
  try {
    return operation();
  } catch {
    return fallback;
  }
}

function isValidAbsolutePath(path: string): boolean {
  return (
    isAbsolute(path) && path.trim().length > 0 && !path.includes("\0") && !/[\r\n]/u.test(path)
  );
}

function normalizeCommandResult(value: unknown): ReadinessCommandResult {
  if (!value || typeof value !== "object" || !("status" in value)) {
    return { status: "unknown" };
  }
  const candidate = value as ReadinessCommandResult;
  if (!["success", "failure", "timeout", "not-found", "unknown"].includes(candidate.status)) {
    return { status: "unknown" };
  }
  return {
    status: candidate.status,
    stdout: typeof candidate.stdout === "string" ? candidate.stdout : undefined,
    stderr: typeof candidate.stderr === "string" ? candidate.stderr : undefined,
    exitCode:
      typeof candidate.exitCode === "number" || candidate.exitCode === null
        ? candidate.exitCode
        : undefined,
  };
}

async function runBounded(
  io: ProjectReadinessProbeIo,
  executable: string,
  argv: readonly string[],
  options: ReadinessCommandOptions,
): Promise<ReadinessCommandResult> {
  return new Promise((resolveResult) => {
    let settled = false;
    const settle = (result: ReadinessCommandResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(result);
    };
    const timer = setTimeout(() => settle({ status: "timeout" }), options.timeoutMs);
    void Promise.resolve()
      .then(() => io.runCommand(executable, [...argv], options))
      .then((result) => settle(normalizeCommandResult(result)))
      .catch(() => settle({ status: "unknown" }));
  });
}

function environmentPath(environment: Readonly<NodeJS.ProcessEnv>): string | null {
  const value = environment.PATH ?? environment.Path ?? environment.path;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function canonicalExecutable(path: string, io: ProjectReadinessProbeIo): string {
  const canonical = safeCall(() => io.realpath(path), path);
  return isValidAbsolutePath(canonical) ? canonical : path;
}

function locateExecutable(
  executable: string,
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  io: ProjectReadinessProbeIo,
): LocatedExecutable {
  const clean = executable.trim();
  if (clean.length === 0 || clean.includes("\0") || /[\r\n]/u.test(clean)) {
    return { availability: "missing", path: null };
  }

  if (isAbsolute(clean) || clean.includes(sep) || clean.includes("/") || clean.includes("\\")) {
    const candidate = isAbsolute(clean) ? clean : resolve(cwd, clean);
    const availability = safeCall(() => io.isExecutable(candidate), "unknown" as Availability);
    return {
      availability,
      path: availability === "available" ? canonicalExecutable(candidate, io) : null,
    };
  }

  const pathValue = environmentPath(environment);
  if (pathValue === null) return { availability: "unknown", path: null };
  let sawUnknown = false;
  for (const entry of pathValue.split(delimiter)) {
    if (entry.trim().length === 0) continue;
    const candidate = resolve(entry, clean);
    const availability = safeCall(() => io.isExecutable(candidate), "unknown" as Availability);
    if (availability === "available") {
      return { availability, path: canonicalExecutable(candidate, io) };
    }
    if (availability === "unknown") sawUnknown = true;
  }
  return { availability: sawUnknown ? "unknown" : "missing", path: null };
}

function versionFrom(result: ReadinessCommandResult): string | null {
  if (result.status !== "success") return null;
  const line = (result.stdout ?? "")
    .replaceAll("\0", "")
    .split(/\r?\n/u)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ? line.slice(0, 256) : null;
}

async function probeVersion(
  io: ProjectReadinessProbeIo,
  located: LocatedExecutable,
  argv: readonly string[],
  commandOptions: ReadinessCommandOptions,
): Promise<{ version: string | null; commandReadiness: CommandReadiness }> {
  if (located.availability !== "available" || located.path === null) {
    return { version: null, commandReadiness: "unknown" };
  }
  const result = await runBounded(io, located.path, argv, commandOptions);
  const version = versionFrom(result);
  return {
    version,
    commandReadiness: result.status === "success" && version !== null ? "ready" : "unknown",
  };
}

function customHarnessSpecs(profiles: readonly CustomReadinessHarnessProfile[]): HarnessSpec[] {
  return profiles.map((profile) => ({
    id: profile.id,
    kind: "custom",
    label: profile.label,
    command: [...profile.command],
    source: profile.source ?? "user",
    versionArgv: null,
    authentication: profile.authentication ?? "unknown",
    declaredCommandReadiness: profile.commandReadiness,
    declaredVersion: profile.version,
  }));
}

async function probeHarness(
  spec: HarnessSpec,
  io: ProjectReadinessProbeIo,
  cwd: string,
  environment: Readonly<NodeJS.ProcessEnv>,
  commandOptions: ReadinessCommandOptions,
): Promise<ProjectReadinessHarnessProbe> {
  const executable = spec.command[0]?.trim() ?? "";
  const located = locateExecutable(executable, cwd, environment, io);
  const versionProbe =
    spec.versionArgv === null
      ? { version: spec.declaredVersion ?? null, commandReadiness: "unknown" as const }
      : await probeVersion(io, located, spec.versionArgv, commandOptions);
  const commandReadiness =
    executable.length === 0
      ? "invalid"
      : (spec.declaredCommandReadiness ?? versionProbe.commandReadiness);

  return {
    id: spec.id,
    kind: spec.kind,
    label: spec.label,
    command: [...spec.command],
    installation: located.availability,
    commandReadiness,
    authentication: spec.authentication,
    source: spec.source,
    version: located.availability === "available" ? versionProbe.version : null,
  };
}

function nonRepositoryFailure(result: ReadinessCommandResult): boolean {
  if (result.status !== "failure") return false;
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.toLowerCase();
  return output.includes("not a git repository") || output.includes("not a work tree");
}

/** Build normalized, conservative facts for the pure readiness classifier. */
export async function probeProjectReadiness(
  requestedPath: string,
  options: ProjectReadinessProbeOptions = {},
): Promise<ProjectReadinessProbe> {
  const io: ProjectReadinessProbeIo = { ...defaultIo, ...options.io };
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const environment = safeCall(() => io.environment(), {} as Readonly<NodeJS.ProcessEnv>);
  const platform = safeCall(() => io.platform(), {
    os: process.platform,
    arch: process.arch,
  } as const);
  const baseCwd = safeCall(() => io.cwd(), process.cwd());
  const absoluteRequestedPath = isAbsolute(requestedPath)
    ? requestedPath
    : resolve(baseCwd, requestedPath);
  const pathKind = safeCall(() => io.inspectPath(absoluteRequestedPath), "unknown" as const);
  const exists = pathKind === "directory" || pathKind === "other";
  const isDirectory = pathKind === "directory";
  const canonicalInput = isDirectory
    ? safeCall(() => io.realpath(absoluteRequestedPath), null as string | null)
    : null;
  const validCanonicalInput =
    canonicalInput !== null && isValidAbsolutePath(canonicalInput) ? canonicalInput : null;
  const commandCwd = validCanonicalInput ?? baseCwd;
  const commandOptions: ReadinessCommandOptions = {
    cwd: commandCwd,
    env: environment,
    timeoutMs,
  };

  const gitLocated = locateExecutable("git", commandCwd, environment, io);
  const tmuxLocated = locateExecutable("tmux", commandCwd, environment, io);
  const shellCommand =
    options.shellCommand && options.shellCommand.length > 0
      ? [...options.shellCommand]
      : [environment.SHELL?.trim() || "/bin/sh"];
  const shellLocated = locateExecutable(shellCommand[0] ?? "", commandCwd, environment, io);

  const gitRun = async (argv: readonly string[], cwd: string): Promise<ReadinessCommandResult> => {
    if (gitLocated.availability !== "available" || gitLocated.path === null) {
      return { status: gitLocated.availability === "missing" ? "not-found" : "unknown" };
    }
    return runBounded(io, gitLocated.path, ["-C", cwd, ...argv], {
      ...commandOptions,
      cwd,
    });
  };

  let resolution: Awaited<ReturnType<typeof resolveProject>> | null = null;
  if (validCanonicalInput !== null) {
    try {
      resolution = await resolveProject(validCanonicalInput, {
        projectRootHint: options.projectRootHint,
        io: {
          exists: (path) => safeCall(() => io.exists(path), false),
          realpath: (path) => io.realpath(path),
          runGit: async (args, cwd) => {
            const result = await gitRun(args, cwd);
            return result.status === "success" ? (result.stdout ?? "").trim() || null : null;
          },
        },
      });
    } catch {
      resolution = null;
    }
  }

  const validResolution =
    resolution !== null && isValidAbsolutePath(resolution.projectRoot) ? resolution : null;
  const projectRoot = validResolution?.projectRoot ?? null;
  const identityKey = validResolution?.identityKey ?? null;
  const identitySource = validResolution?.identitySource ?? null;
  const projectNameSource = projectRoot ?? validCanonicalInput ?? absoluteRequestedPath;
  const sanitizedName = sanitizeName(basename(projectNameSource));

  const [gitVersion, tmuxVersion, repositoryResult, ...harnesses] = await Promise.all([
    probeVersion(io, gitLocated, ["--version"], commandOptions),
    probeVersion(io, tmuxLocated, ["-V"], commandOptions),
    validCanonicalInput === null
      ? Promise.resolve({ status: "unknown" } as ReadinessCommandResult)
      : gitRun(["rev-parse", "--is-inside-work-tree"], validCanonicalInput),
    ...[
      ...BUILTIN_HARNESSES.map((spec) => ({
        ...spec,
        authentication: options.authentication?.[spec.id] ?? "unknown",
      })),
      ...customHarnessSpecs(options.customHarnesses ?? []),
    ].map((spec) => probeHarness(spec, io, commandCwd, environment, commandOptions)),
  ]);

  let repository: boolean | null = null;
  if (repositoryResult.status === "success") {
    const output = (repositoryResult.stdout ?? "").trim().toLowerCase();
    repository = output === "true" ? true : output === "false" ? false : null;
  } else if (nonRepositoryFailure(repositoryResult)) {
    repository = false;
  }

  const requestedRegistration = options.registration ?? "unregistered";
  const registration =
    pathKind === "missing" && requestedRegistration === "current" ? "stale" : requestedRegistration;

  return {
    project: {
      requestedPath: absoluteRequestedPath,
      root: projectRoot,
      name: sanitizedName || "project",
      identityKey,
      identitySource,
      exists,
      isDirectory,
      registration,
    },
    platform,
    git: {
      availability: gitLocated.availability,
      version: gitVersion.version,
      repository,
    },
    tmux: {
      availability: tmuxLocated.availability,
      version: tmuxVersion.version,
    },
    shell: {
      availability: shellLocated.availability,
      command: shellCommand,
      version: null,
    },
    harnesses: harnesses as ProjectReadinessHarnessProbe[],
    preferredHarnessId: options.preferredHarnessId,
  };
}

/** Probe and classify in one public, read-only call. */
export async function assessProjectReadiness(
  requestedPath: string,
  options: ProjectReadinessProbeOptions = {},
): Promise<ProjectReadinessResult> {
  return classifyProjectReadiness(await probeProjectReadiness(requestedPath, options));
}
