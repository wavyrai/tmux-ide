import { WorkspacePromotionFailureCodeSchemaZ } from "@tmux-ide/contracts";
/** Explicit manager diagnostics. Never imported by rendering or terminal delivery. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { DevelopmentInstance } from "./development-instance.ts";
import { validateDevelopmentDirectory } from "./development-instance.ts";
import { developmentSourceSnapshot } from "./development-build-manager.ts";
import { readDevelopmentBuild, type DevelopmentBuildManifest } from "./development-build.ts";
import { statusDevelopmentInstance } from "./development-lifecycle.ts";
import {
  cleanManagerEnvironment,
  readDevelopmentIdentity,
  readDevelopmentOwner,
  ownerBuildEnvironment,
  readPrivateDevelopmentRecord,
} from "./development-state.ts";
import { inspectCanonicalDaemonInfoPath } from "./canonical-daemon.ts";

const execute = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const BUILD = /^build-[a-f0-9-]{36}$/u;
const FAILURE_CODES = new Set<string>(WorkspacePromotionFailureCodeSchemaZ.options);
const FAILURE_REASONS = new Set([
  "admission_queue_full",
  "authority_disposed",
  "daemon-unavailable",
  "daemon-generation-changed",
  "promotion-rejected",
  "promotion-unconfirmed",
]);
const COMPONENTS = new Set([
  "auth",
  "daemon",
  "server",
  "fleet",
  "workspace",
  "terminal",
  "lifecycle",
]);
/** Same bearer/query/key vocabulary as product-test-rig-lib; redact before truncating. */
export function safeDevelopmentText(
  value: string,
  secrets: readonly string[] = [],
  limit = 1024,
): string {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join("[REDACTED]");
  return (
    text
      .replace(/Bearer\s+[^\s"',;]+/giu, "Bearer [REDACTED]")
      .replace(
        /([?&](?:token|ticket|lease|capability|password|secret|auth)[^=\s]*=)[^&#\s]*/giu,
        "$1[REDACTED]",
      )
      .replace(
        /((?:authorization|capability|password|secret|token|ticket|lease)\s*[:=]\s*)[^\s,;"'}]+/giu,
        "$1[REDACTED]",
      )
      // Terminal controls must never enter a support label.
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x1f\x7f-\x9f]/gu, "_")
      .slice(0, limit)
  );
}
async function diagnosticSecrets(instance: DevelopmentInstance): Promise<string[]> {
  const identity = await readDevelopmentIdentity(instance, { allowOrphan: true, allowReset: true });
  const info = inspectCanonicalDaemonInfoPath(join(instance.stateHome, "daemon.json"));
  return [identity?.capability, info.status === "valid" ? info.info.authToken : null].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}
/** No free-form message/data/component passes into a support export. */
export function projectDevelopmentLogRecords(text: string, secrets: readonly string[] = []) {
  const records: Record<string, unknown>[] = [];
  let skipped = 0;
  const lines = text.split("\n");
  // The caller only supplies complete lines; standalone callers also lose unfinished tails.
  if (lines.pop()) skipped++;
  for (const line of lines) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.ts !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(entry.ts) ||
        !["debug", "info", "warn", "error"].includes(String(entry.level))
      ) {
        skipped++;
        continue;
      }
      const record: Record<string, unknown> = {
        ts: entry.ts,
        level: entry.level,
        message: "[omitted]",
      };
      if (typeof entry.component === "string" && COMPONENTS.has(entry.component))
        record.component = entry.component;
      if (typeof entry.code === "string" && FAILURE_CODES.has(entry.code)) record.code = entry.code;
      if (typeof entry.reason === "string" && FAILURE_REASONS.has(entry.reason))
        record.reason = entry.reason;
      for (const key of ["operationId", "daemonGeneration"] as const) {
        const value = entry[key];
        if (
          typeof value === "string" &&
          UUID.test(value) &&
          !secrets.some((secret) => secret && value.includes(secret))
        )
          record[key] = value;
      }
      if (records.length === 128) {
        records.shift();
        skipped++;
      }
      records.push(record);
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}
export async function developmentLogs(instance: DevelopmentInstance) {
  const secrets = await diagnosticSecrets(instance);
  validateDevelopmentDirectory(join(instance.root, "logs"), instance.store);
  let handle;
  try {
    handle = await open(
      join(instance.root, "logs/owner.log"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.nlink !== 1)
      throw new Error("Unsafe log file");
    const length = Math.min(stat.size, 64 * 1024);
    const offset = stat.size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    let partialFragments = 0;
    if (offset > 0) {
      const end = text.indexOf("\n");
      text = end < 0 ? "" : text.slice(end + 1);
      partialFragments++;
    }
    if (!text.endsWith("\n")) {
      text = text.slice(0, text.lastIndexOf("\n") + 1);
      partialFragments++;
    }
    return {
      version: 1,
      instanceId: instance.id,
      scope: "owner",
      rawMessagesIncluded: false,
      readBytes: bytesRead,
      truncated: offset > 0,
      partialFragments,
      ...projectDevelopmentLogRecords(text, secrets),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        version: 1,
        instanceId: instance.id,
        scope: "owner",
        rawMessagesIncluded: false,
        records: [],
        skipped: 0,
        unavailable: "missing",
      };
    throw new Error("Development log unavailable or unsafe", { cause: error });
  } finally {
    await handle?.close();
  }
}
function describeBuild(
  build: DevelopmentBuildManifest,
  digest: string | null,
  secrets: readonly string[],
) {
  return {
    generation: build.generation,
    commit: build.source.commit,
    sourceDigest: build.source.digest,
    dirtyAtBuild: build.source.dirty,
    sourceStale: digest === null ? null : digest !== build.source.digest,
    versions: {
      cli: build.packageVersion,
      tui: build.packageVersion,
      daemon: build.packageVersion,
      node: build.host.nodeVersion,
      nodeAbi: build.host.nodeAbi,
      bun: build.host.bunVersion,
      platform: build.host.platform,
      arch: build.host.arch,
    },
    native: build.native
      .slice(0, 32)
      .map((item) => ({ path: safeDevelopmentText(item.path, secrets, 256), sha256: item.sha256 })),
    signature: build.qualification.signature,
  };
}
export async function developmentDiagnostics(instance: DevelopmentInstance) {
  const secrets = await diagnosticSecrets(instance);
  const status = await statusDevelopmentInstance(instance, { allowOrphan: true });
  let source: Awaited<ReturnType<typeof developmentSourceSnapshot>> | null = null;
  let branch: string | null = null;
  try {
    // A recorded orphan must not attribute a replacement tree at the same path to this build.
    await readDevelopmentIdentity(instance, { allowReset: true });
    source = await developmentSourceSnapshot(instance.worktree, AbortSignal.timeout(10_000));
    const result = await execute("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: instance.worktree,
      env: cleanManagerEnvironment(),
      timeout: 1000,
      killSignal: "SIGKILL",
      maxBuffer: 8192,
    });
    branch = safeDevelopmentText(result.stdout.trim(), secrets, 256);
  } catch {
    /* Missing/moved worktree, detached branch, or snapshot failure is explicit below. */
  }
  const buildDescription = (env: NodeJS.ProcessEnv) => {
    try {
      return describeBuild(readDevelopmentBuild(instance, env), source?.digest ?? null, secrets);
    } catch {
      return null;
    }
  };
  const owner = readDevelopmentOwner(instance);
  const selected = buildDescription({});
  const active =
    status.activeBuild && owner ? buildDescription(ownerBuildEnvironment(owner)) : null;
  const apps: { pid: number | null; generation: string }[] = [];
  let appInventory: "complete" | "truncated" | "unavailable" = "complete";
  validateDevelopmentDirectory(join(instance.root, "apps"), instance.store);
  try {
    const directory = await opendir(join(instance.root, "apps"));
    for await (const entry of directory) {
      if (apps.length >= 32) {
        appInventory = "truncated";
        break;
      }
      if (!/^[a-f0-9-]{36}\.json$/.test(entry.name)) throw new Error("Invalid app inventory");
      const app = readPrivateDevelopmentRecord<{ pid: number | null; generation: string }>(
        join(instance.root, "apps", entry.name),
      );
      if (
        !app ||
        !BUILD.test(app.generation) ||
        (app.pid !== null && (!Number.isSafeInteger(app.pid) || app.pid <= 0))
      )
        throw new Error("Invalid app record");
      apps.push({ pid: app.pid, generation: app.generation });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") appInventory = "unavailable";
  }
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    manager: {
      node: process.version,
      nodeAbi: process.versions.modules,
      bun: process.versions.bun ?? null,
      platform: process.platform,
      arch: process.arch,
    },
    instance: {
      id: instance.id,
      worktree: safeDevelopmentText(instance.worktree, secrets),
      name: safeDevelopmentText(instance.name, secrets, 128),
    },
    state: status.state,
    reason: status.reason,
    daemon: status.daemon
      ? { pid: status.daemon.pid, runtimeGeneration: status.daemon.instanceId }
      : null,
    source: source
      ? { commit: source.commit, digest: source.digest, dirtyNow: source.dirty, branch }
      : null,
    sourceUnavailable: source === null,
    selected,
    active,
    tui: { recordedLaunches: apps, inventory: appInventory, livenessVerified: false },
    readiness: {
      identity: status.readiness.identity,
      health: status.readiness.health,
      ownerAuthenticated: status.readiness.ownerAuthenticated,
    },
    rawLogsIncluded: false,
    guidance:
      "DEV * means dirty at build. sourceStale compares relevant source content now. Runtime generation is not build generation. TUI receipts describe admitted launches, not current liveness.",
  };
}
