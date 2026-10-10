#!/usr/bin/env node
// Explicit local-app or authenticated release entry: no launch/stop or signing bypass.
// Ordinary-file bundles only. Policy is independently trusted caller input, never app metadata.
import { open, realpath, lstat, mkdtemp, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve, relative, sep, dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { fetchReleaseOffer } from "./preview-release-offer.mjs";
import { installRelease } from "./preview-release-install.mjs";
import { fileURLToPath } from "node:url";
import { installApp, rollbackApp, uninstallApp, recoverApp } from "./install-transaction.mjs";
import { verifyMacApp } from "./mac-app-verifier.mjs";

const HELP = {
  commands: [
    "install|update --prefix ABSOLUTE_PRIVATE_ROOT --policy TRUSTED_JSON --app STAGED_APP --version ID",
    "install|update --prefix ABSOLUTE_PRIVATE_ROOT --policy TRUSTED_RELEASE_JSON --version ID",
    "recover --prefix ABSOLUTE_PRIVATE_ROOT --policy TRUSTED_JSON --disposition keep-current|restore-previous",
    "rollback --prefix ABSOLUTE_PRIVATE_ROOT --policy TRUSTED_JSON",
    "detach|uninstall --prefix ABSOLUTE_PRIVATE_ROOT",
  ],
  policy: ["teamId", "bundleId", "architecture", "minimumMacOS"],
  releasePolicyAdditional: ["releasePublicKey", "releaseBaseUrl", "redirectOrigins"],
  limits:
    "Local signed staging or explicit authenticated release. Detach retains versions/configuration and stops no processes. Explicit recovery supports journaled interrupted install/update only; pre-journal, repeat-install, legacy or uncertain locks refuse. A recovery operation that is itself interrupted requires manual inspection, as do interrupted rollback/detach operations. Power-loss durability, signed-release qualification and version ordering remain unqualified.",
};
const within = (parent, child) => {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
};
function parse(args) {
  if (args.length === 1 && ["--help", "help"].includes(args[0])) return { help: true };
  const [command, ...rest] = args;
  if (!["install", "update", "rollback", "detach", "uninstall", "recover"].includes(command))
    throw new Error("arguments");
  const allowed = [
    "--prefix",
    ...(command === "install" || command === "update"
      ? ["--policy", "--app", "--version"]
      : command === "recover"
        ? ["--policy", "--disposition"]
        : command === "rollback"
          ? ["--policy"]
          : []),
  ];
  const values = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
    if (
      !allowed.includes(key) ||
      Object.hasOwn(values, key) ||
      !value ||
      value.startsWith("--") ||
      value.includes("\0")
    )
      throw new Error("arguments");
    values[key] = value;
  }
  if (allowed.some((key) => key !== "--app" && !Object.hasOwn(values, key)))
    throw new Error("arguments");
  if (!isAbsolute(values["--prefix"])) throw new Error("arguments");
  for (const key of ["--prefix", "--policy", "--app"]) {
    if (values[key] && values[key].length > 4096) throw new Error("arguments");
  }
  if (
    values["--version"] &&
    (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(values["--version"]) ||
      values["--version"].includes(".."))
  )
    throw new Error("arguments");
  if (
    command === "recover" &&
    !["keep-current", "restore-previous"].includes(values["--disposition"])
  )
    throw new Error("arguments");
  return { command, values };
}
function trustedHttps(value, originOnly) {
  if (typeof value !== "string" || value.length > 4096) return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      (originOnly ? u.pathname === "/" : u.pathname.endsWith("/"))
    );
  } catch {
    return false;
  }
}
async function readPolicy(path, prefix, app) {
  if ((await realpath(path)) !== path || within(prefix, path) || (app && within(app, path)))
    throw new Error("policy");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 2 || stat.size > 8192) throw new Error("policy");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error("policy");
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    if (
      !value ||
      Array.isArray(value) ||
      ![
        "architecture,bundleId,minimumMacOS,teamId",
        "architecture,bundleId,minimumMacOS,redirectOrigins,releaseBaseUrl,releasePublicKey,teamId",
      ].includes(Object.keys(value).sort().join()) ||
      typeof value.teamId !== "string" ||
      !/^[A-Z0-9]{10}$/.test(value.teamId) ||
      typeof value.bundleId !== "string" ||
      value.bundleId.length > 255 ||
      !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value.bundleId) ||
      !["arm64", "x86_64"].includes(value.architecture) ||
      typeof value.minimumMacOS !== "string" ||
      !/^\d{1,3}\.\d{1,3}(?:\.\d{1,3})?$/.test(value.minimumMacOS)
    )
      throw new Error("policy");
    if (Object.hasOwn(value, "releasePublicKey")) {
      if (
        typeof value.releasePublicKey !== "string" ||
        !/^[0-9a-f]{64}$/.test(value.releasePublicKey) ||
        !trustedHttps(value.releaseBaseUrl, false) ||
        !Array.isArray(value.redirectOrigins) ||
        value.redirectOrigins.length > 16 ||
        !value.redirectOrigins.every((origin) => trustedHttps(origin, true))
      )
        throw new Error("policy");
      Object.freeze(value.redirectOrigins);
    }
    return Object.freeze(value);
  } finally {
    await file.close();
  }
}
const errors = {
  arguments: "Invalid arguments. Use --help; an explicit private prefix is required.",
  platform: "This app installer requires macOS.",
  policy: "Trusted policy is unavailable or invalid. Supply a separate bounded policy JSON file.",
  locked:
    "Installation is locked. Inspect the prior transaction; stale locks are not removed automatically.",
  verification:
    "App verification denied. Supply a compatible Developer ID signed app and trusted policy.",
  offer:
    "Authenticated release metadata could not be obtained. Check trusted policy and explicit version.",
  release: "Release installation failed. Inspect activation state; rollback is not implied.",
  cancelled:
    "Release operation cancelled. Inspect activation state; completed activation is not rolled back.",
  cleanup:
    "Release staging cleanup is uncertain; owned temporary data was retained for inspection.",
  transaction:
    "Transaction failed. Inspect the private prefix before retrying; no automatic recovery was attempted.",
};
/** Dependency injection is for tests; the executable entry always uses real system verification. */
export async function main(
  args,
  {
    verify = verifyMacApp,
    platform = process.platform,
    fetchImpl = fetch,
    releaseInstaller = installRelease,
    signal,
  } = {},
) {
  let phase = "arguments",
    activationState,
    stagingRetained = false,
    priorFailure = false;
  try {
    const parsed = parse(args);
    if (parsed.help) return { exitCode: 0, output: { ok: true, help: HELP } };
    phase = "platform";
    if (platform !== "darwin") throw new Error("platform");
    const { command, values } = parsed;
    phase = "transaction";
    const requestedPrefix = resolve(values["--prefix"]);
    try {
      if ((await lstat(requestedPrefix)).isSymbolicLink()) throw new Error("redirected root");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const prefix = resolve(await realpath(dirname(requestedPrefix)), basename(requestedPrefix));
    if (values["--app"]) values["--app"] = await realpath(resolve(values["--app"]));
    let policy;
    if (values["--policy"]) {
      phase = "policy";
      policy = await readPolicy(
        await realpath(resolve(values["--policy"])),
        prefix,
        values["--app"],
      );
    }
    phase = "transaction";
    if (command !== "recover")
      try {
        await lstat(`${prefix}/.transaction-lock`);
        phase = "locked";
        throw new Error("locked");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    phase = "transaction";
    const applePolicy =
      policy &&
      Object.freeze(
        Object.fromEntries(
          ["teamId", "bundleId", "architecture", "minimumMacOS"].map((key) => [key, policy[key]]),
        ),
      );
    if (["install", "update"].includes(command) && !values["--app"]) {
      phase = "policy";
      if (!policy.releasePublicKey) throw new Error("release policy required");
      phase = "offer";
      const offer = await fetchReleaseOffer(
        {
          publicKey: Buffer.from(policy.releasePublicKey, "hex"),
          expectedVersion: values["--version"],
          baseUrl: policy.releaseBaseUrl,
          redirectOrigins: policy.redirectOrigins,
          signal,
        },
        { fetchImpl },
      );
      phase = "release";
      if (signal?.aborted) throw new Error("cancelled");
      const parent = await realpath(tmpdir());
      const staging = await mkdtemp(join(parent, "tmux-gpui-release-"));
      let identity, result, failure;
      activationState = "not-attempted";
      try {
        identity = await lstat(staging);
        activationState = "unknown";
        result = await releaseInstaller(
          { ...offer, applePolicy, installRoot: prefix, destinationRoot: staging, signal },
          { fetchImpl },
        );
        activationState = "confirmed";
      } catch (error) {
        activationState = ["not-attempted", "unknown", "confirmed"].includes(error?.activationState)
          ? error.activationState
          : activationState;
        failure = error;
      } finally {
        try {
          const current = await lstat(staging);
          if (
            !identity ||
            !current.isDirectory() ||
            current.isSymbolicLink() ||
            current.dev !== identity.dev ||
            current.ino !== identity.ino
          )
            throw new Error("changed staging");
          await rmdir(staging); // Empty only: never recursively erase unknown leftovers.
        } catch {
          phase = "cleanup";
          stagingRetained = true;
          const cleanup = new Error("staging cleanup uncertain");
          priorFailure = !!failure;
          failure = failure
            ? new AggregateError([failure, cleanup], "release and cleanup failed")
            : cleanup;
        }
      }
      if (failure) throw failure;
      if (signal?.aborted) throw new Error("cancelled after installation");
      return { exitCode: 0, output: { ok: true, command, mode: "release", result } };
    }
    const verifyCopy = async (copy) => {
      try {
        const accepted = await verify(copy, applePolicy);
        if (accepted !== true) throw new Error("denied");
        return true;
      } catch {
        phase = "verification";
        throw new Error("verification denied");
      }
    };
    const result =
      command === "recover"
        ? await recoverApp({
            installRoot: prefix,
            verify: verifyCopy,
            disposition: values["--disposition"],
          })
        : command === "rollback"
          ? await rollbackApp({ installRoot: prefix, verify: verifyCopy })
          : ["detach", "uninstall"].includes(command)
            ? await uninstallApp({ installRoot: prefix })
            : await installApp({
                installRoot: prefix,
                stagedApp: values["--app"],
                version: values["--version"],
                verify: verifyCopy,
              });
    return {
      exitCode: 0,
      output: {
        ok: true,
        command,
        result,
        ...(["detach", "uninstall"].includes(command)
          ? { message: "Detached; versions retained. No processes stopped." }
          : {}),
      },
    };
  } catch {
    return {
      exitCode: 1,
      output: {
        ok: false,
        error: {
          code: signal?.aborted ? "cancelled" : phase,
          message: errors[signal?.aborted ? "cancelled" : phase],
          ...(activationState ? { activationState } : {}),
          ...(stagingRetained ? { stagingRetained: true } : {}),
          ...(priorFailure ? { priorFailure: "release" } : {}),
        },
      },
    };
  }
}
if (
  process.argv[1] &&
  (await realpath(resolve(process.argv[1])).catch(() => null)) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  let releaseMode = false;
  try {
    const parsed = parse(args);
    releaseMode = ["install", "update"].includes(parsed.command) && !parsed.values["--app"];
  } catch {
    /* main returns the fixed argument error without installing signal handlers. */
  }
  const controller = releaseMode ? new AbortController() : undefined;
  const abort = () => controller.abort();
  if (controller) {
    process.on("SIGINT", abort);
    process.on("SIGTERM", abort);
  }
  try {
    const result = await main(args, controller ? { signal: controller.signal } : {});
    process.stdout.write(JSON.stringify(result.output) + "\n");
    process.exitCode = result.exitCode;
  } finally {
    if (controller) {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    }
  }
}
