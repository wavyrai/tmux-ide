import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, lstat, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";

/**
 * The CLI versions Home can set up: 2.9.6 up to, but not including, 2.10.0,
 * written as three canonical numbers. It must equal `SETUP_CLI` in
 * upstream/crates/herdr-client/src/tmux_daemon/local_setup.rs; a test reads
 * both. Unknown, newer-minor or prerelease installs are never run.
 */
export const SETUP_CLI_FROM = [2n, 9n, 6n] as const;
export const SETUP_CLI_BELOW = [2n, 10n, 0n] as const;
const U64_MAX = 18_446_744_073_709_551_615n;
function compare(a: readonly bigint[], b: readonly bigint[]) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}
export function setupCli(version: string): boolean {
  const parts = version.split(".");
  if (parts.length !== 3 || !parts.every((part) => /^(?:0|[1-9][0-9]*)$/u.test(part))) return false;
  const numbers = parts.map(BigInt);
  if (numbers.some((part) => part > U64_MAX)) return false;
  return compare(numbers, SETUP_CLI_FROM) >= 0 && compare(numbers, SETUP_CLI_BELOW) < 0;
}
export type LocalSetupInstallation = Readonly<{
  node: string;
  cli: string;
  release: string;
  version: string;
}>;
export type LocalSetupResolution =
  | { kind: "available"; installation: LocalSetupInstallation }
  | { kind: "missing" | "invalid" | "unsupported-version" };
export type LocalSetupResult = {
  kind: "ready" | "stopped-waiting" | "failed" | "invalid-response" | "installation-changed";
};
/**
 * The phase the bridge publishes when setup isn't available. A broken
 * installation is "unrecognized"; only a version outside the range is
 * "unsupported". The names match `Phase` in browser_local_setup.rs.
 */
export function unavailablePhase(
  kind: "missing" | "invalid" | "unsupported-version",
): "missing" | "unrecognized" | "unsupported" {
  return kind === "missing" ? "missing" : kind === "invalid" ? "unrecognized" : "unsupported";
}
type Run = (
  executable: string,
  args: readonly string[],
  options: { signal: AbortSignal; timeout: number; maxBuffer: number; cwd: string },
) => Promise<string>;
const proofs = new WeakMap<LocalSetupInstallation, { home: string; fingerprint: string }>();

async function regular(path: string, limit?: number) {
  const info = await lstat(path);
  if (!info.isFile() || (limit !== undefined && info.size > limit)) throw new Error("Invalid file");
  if ((await realpath(path)) !== path) throw new Error("Redirected file");
  return [info.dev, info.ino, info.size, info.mtimeMs];
}
async function inspect(home: string) {
  if (!isAbsolute(home)) throw new Error("Invalid home");
  home = await realpath(home);
  const root = join(home, ".local/share/tmux-ide");
  if ((await realpath(root)) !== root) throw new Error("Redirected installation");
  const marker = join(root, "installer-v1");
  const markerIdentity = await regular(marker, 16);
  if ((await readFile(marker, "utf8")) !== "1\n") throw new Error("Invalid marker");
  const releases = join(root, "releases");
  if ((await realpath(releases)) !== releases) throw new Error("Redirected releases");
  const release = await realpath(join(root, "current"));
  if (dirname(release) !== releases || !/^install-[A-Za-z0-9]+$/.test(basename(release)))
    throw new Error("Invalid release");
  if (!(await stat(release)).isDirectory()) throw new Error("Invalid release");
  const releaseMarker = join(release, ".installer-release-v1");
  const releaseIdentity = await regular(releaseMarker, 16);
  if ((await readFile(releaseMarker, "utf8")) !== "1\n") throw new Error("Invalid release marker");
  const node = join(release, "node/bin/node");
  const pkg = join(release, "npm/lib/node_modules/tmux-ide");
  const cli = join(pkg, "bin/cli.js");
  const nodeIdentity = await regular(node);
  const cliIdentity = await regular(cli);
  await access(node, constants.X_OK);
  await access(cli, constants.R_OK);
  const packagePath = join(pkg, "package.json");
  const packageIdentity = await regular(packagePath, 65536);
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  if (
    metadata.name !== "tmux-ide" ||
    metadata.bin?.["tmux-ide"] !== "bin/cli.js" ||
    typeof metadata.version !== "string"
  )
    throw new Error("Invalid package");
  const installation = Object.freeze({ node, cli, release, version: metadata.version as string });
  return {
    installation,
    home,
    fingerprint: JSON.stringify([
      installation,
      markerIdentity,
      releaseIdentity,
      nodeIdentity,
      cliIdentity,
      packageIdentity,
    ]),
  };
}

/** Read-only fixed managed installation lookup. Never PATH search, installation or startup. */
export async function resolveLocalSetup(
  options: { home?: string } = {},
): Promise<LocalSetupResolution> {
  const home = options.home ?? homedir();
  try {
    await lstat(join(home, ".local/share/tmux-ide"));
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  }
  try {
    const proof = await inspect(home);
    if (!setupCli(proof.installation.version)) return { kind: "unsupported-version" };
    proofs.set(proof.installation, proof);
    return { kind: "available", installation: proof.installation };
  } catch {
    return { kind: "invalid" };
  }
}
class StoppedWaiting extends Error {}
const run: Run = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        ...options,
        encoding: "utf8",
        killSignal: "SIGKILL",
        windowsHide: true,
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !["NODE_OPTIONS", "NODE_PATH"].includes(key),
          ),
        ),
      },
      (error, stdout) =>
        error
          ? reject(error.killed ? new StoppedWaiting() : new Error("Setup process failed"))
          : resolve(stdout),
    );
  });
const responseSchema = z
  .object({
    ok: z.literal(true),
    status: z.literal("ready"),
    productVersion: z.string(),
    instanceId: z.string().min(1).max(512),
  })
  .strict();

/** Explicit user action only. Abort stops waiting; an elected detached daemon may remain running. */
export async function runLocalSetup(
  installation: LocalSetupInstallation,
  options: { signal?: AbortSignal; run?: Run } = {},
): Promise<LocalSetupResult> {
  if (options.signal?.aborted) return { kind: "stopped-waiting" };
  const proof = proofs.get(installation);
  if (!proof) return { kind: "installation-changed" };
  const current = async () => {
    try {
      return (await inspect(proof.home)).fingerprint === proof.fingerprint;
    } catch {
      return false;
    }
  };
  const signal = AbortSignal.any([
    options.signal ?? new AbortController().signal,
    AbortSignal.timeout(20000),
  ]);
  const execute = options.run ?? run;
  try {
    if (!(await current())) return { kind: "installation-changed" };
    const limits = { signal, timeout: 15000, maxBuffer: 4096, cwd: proof.home };
    const version = await execute(installation.node, [installation.cli, "--version"], limits);
    if (signal.aborted) return { kind: "stopped-waiting" };
    if (version.length > 4096 || version.trim() !== `tmux-ide v${installation.version}`)
      return { kind: "invalid-response" };
    if (!(await current())) return { kind: "installation-changed" };
    signal.throwIfAborted();
    const stdout = await execute(
      installation.node,
      [installation.cli, "update", "--daemon", "--json"],
      limits,
    );
    if (signal.aborted) return { kind: "stopped-waiting" };
    if (stdout.length > 4096) return { kind: "invalid-response" };
    let value: unknown;
    try {
      value = JSON.parse(stdout);
    } catch {
      return { kind: "invalid-response" };
    }
    const response = responseSchema.safeParse(value);
    return {
      kind:
        response.success && response.data.productVersion === installation.version
          ? "ready"
          : "invalid-response",
    };
  } catch (error) {
    return {
      kind: signal.aborted || error instanceof StoppedWaiting ? "stopped-waiting" : "failed",
    };
  }
}
