#!/usr/bin/env node
/** Opt-in real systemd qualification; no host service, bind mount or image mutation. */
import { execFile, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  lstatSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { exportDevelopmentContainerContext } from "./lib/development-container-context.mjs";
import {
  systemdFixtureDefinition,
  systemdContainerArguments,
  inspectSystemdContainer,
  systemdFixtureImage,
  sha256,
  systemdFailureDiagnostic,
  systemdPreparationDiagnostic,
  privateSystemdJournal,
} from "./lib/owned-systemd-fixture.mjs";
import { settlePackedChildren } from "./lib/packed-install-cleanup.mjs";
const source = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const evidence = process.argv[2] && resolve(process.argv[2]);
if (!evidence || process.argv.length !== 3)
  throw new Error("Usage: node scripts/qualify-systemd.mjs <fresh-evidence-directory>");
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: source,
    encoding: "utf8",
  }).trim()
)
  throw new Error("clean-committed-source-required");
process.umask(0o077);
mkdirSync(evidence, { mode: 0o700 });
const d = systemdFixtureDefinition(randomBytes(16).toString("hex"));
const receipt = {
  ok: false,
  definition: d,
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: source,
    encoding: "utf8",
  }).trim(),
  image: systemdFixtureImage,
  phases: {},
  cleanup: {},
};
const controller = new AbortController(),
  children = [],
  exits = new Map();
const cancel = () => controller.abort();
process.on("SIGINT", cancel);
process.on("SIGTERM", cancel);
let cleaning = false,
  creationAttempted = false,
  id,
  temporary,
  temporaryWitness,
  before,
  stage = "inventory";
const whole = setTimeout(cancel, 480000);
function run(executable, args, { timeout = 30000, maxBuffer = 1048576 } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = execFile(
      executable,
      args,
      {
        cwd: source,
        env: { ...process.env, DOCKER_CONTEXT: "desktop-linux" },
        encoding: "utf8",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer,
        ...(!cleaning ? { signal: controller.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          receipt.commandFailures ??= [];
          if (receipt.commandFailures.length < 30)
            receipt.commandFailures.push({
              stage,
              operation: executable === "docker" ? args[0] : "local",
              exitCode: Number.isInteger(error.code) ? error.code : null,
              terminated: Boolean(error.killed),
              cancelled: error.name === "AbortError",
              diagnostic: systemdPreparationDiagnostic(stdout, stderr),
            });
          // These fixed commands run before any daemon reservation or service.
          // Preserve bounded private tool output so an unfamiliar native-build
          // error does not require another run merely to recover its message.
          if (
            [
              "prepare-dependency-inputs",
              "prepare-offline-install-and-native-rebuild",
              "prepare-runtime-link",
            ].includes(stage)
          ) {
            try {
              for (const [stream, text] of [
                ["stdout", stdout],
                ["stderr", stderr],
              ]) {
                writeFileSync(
                  join(evidence, `${stage}.${stream}.private.log`),
                  Buffer.from(text).subarray(-131072),
                  { mode: 0o600 },
                );
              }
            } catch {
              receipt.privateDiagnosticWriteFailed = true;
            }
          }
        }
        if (error) reject(new Error("fixture-command-refused"));
        else resolveRun(stdout);
      },
    );
    children.push(child);
    exits.set(child, new Promise((r) => child.once("close", r)));
  });
}
const docker = (...args) => run("docker", args);
const inventory = async () =>
  (await docker("ps", "-q", "--no-trunc")).trim().split("\n").filter(Boolean).sort();
async function inspect() {
  const raw = JSON.parse(await docker("inspect", id));
  if (!Array.isArray(raw) || raw.length !== 1) throw new Error("container-inspection-refused");
  return inspectSystemdContainer(raw[0], d, id);
}
async function checkedExec(args, { user = "0:0", timeout = 30000 } = {}) {
  await inspect();
  return run("docker", ["exec", "--user", user, id, ...args], { timeout });
}
async function phase(name) {
  stage = name;
  let failed = false;
  try {
    await checkedExec(
      ["/usr/local/bin/node", "/qualification/source/scripts/qualify-systemd-inner.mjs", name],
      { user: "1000:1000", timeout: name === "journey" ? 120000 : 40000 },
    );
  } catch {
    failed = true;
  }
  // Read only the bounded credential-free phase receipt, even after a failed stage.
  const text = await checkedExec(["/usr/bin/head", "-c", "1048577", `/qualification/${name}.json`]);
  if (Buffer.byteLength(text) > 1048576) throw new Error("phase-receipt-bound");
  receipt.phases[name] = JSON.parse(text);
  writeFileSync(join(evidence, `${name}.json`), text);
  if (failed || receipt.phases[name].ok !== true) throw new Error("candidate-phase-refused");
}
async function systemctl(...args) {
  return checkedExec(["/bin/systemctl", ...args]);
}
async function waitForSystemd() {
  const readyDeadline = Date.now() + 30000;
  while (true) {
    try {
      const state = (
        await checkedExec(["/bin/systemctl", "show", "--property=SystemState", "--value"])
      ).trim();
      if (["running", "degraded"].includes(state)) return;
    } catch {
      /* PID1 may not have opened its control socket yet. */
    }
    if (Date.now() > readyDeadline || controller.signal.aborted)
      throw new Error("systemd-readiness-timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  before = await inventory();
  receipt.unrelatedBefore = before;
  receipt.engine = JSON.parse(await docker("info", "--format", "{{json .}}"));
  // Retain only capacity, never engine configuration or unrelated container metadata.
  receipt.engine = { memoryBytes: receipt.engine.MemTotal, cpus: receipt.engine.NCPU };
  const names = (await docker("ps", "-a", "--format", "{{.Names}}")).trim().split("\n");
  if (names.includes(d.name)) throw new Error("container-name-collision");
  const image = JSON.parse(await docker("image", "inspect", systemdFixtureImage));
  if (image.length !== 1 || image[0].Id !== systemdFixtureImage) throw new Error("image-mismatch");
  receipt.imageCreated = image[0].Created;
  temporary = realpathSync(mkdtempSync(join(tmpdir(), "ti-systemd-export-")));
  temporaryWitness = lstatSync(temporary);
  const context = join(temporary, "context");
  exportDevelopmentContainerContext(source, context);
  const manifest = JSON.parse(
    readFileSync(join(context, ".development-container-source.json"), "utf8"),
  );
  if (manifest.sourceDirty !== false || manifest.sourceCommit !== receipt.sourceCommit)
    throw new Error("source-export-mismatch");
  receipt.snapshotDigest = manifest.snapshotDigest;
  receipt.manifestSha256 = sha256(
    readFileSync(join(context, ".development-container-source.json")),
  );
  receipt.sourceExport = {
    sourceCommit: manifest.sourceCommit,
    sourceDirty: manifest.sourceDirty,
    files: manifest.files.length,
    bytes: manifest.bytes,
  };
  writeFileSync(join(evidence, "source-manifest.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(evidence, "descriptor.json"), JSON.stringify(receipt, null, 2));
  stage = "create";
  creationAttempted = true;
  id = (await docker(...systemdContainerArguments(d))).trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("container-id-refused");
  receipt.containerId = id;
  await inspect();
  await docker("start", id);
  await waitForSystemd();
  stage = "prepare-directories";
  await checkedExec([
    "/bin/mkdir",
    "-p",
    "/qualification/source",
    "/qualification/home",
    "/qualification/cache",
    "/qualification/input",
  ]);
  stage = "prepare-source-copy";
  await inspect();
  await docker("cp", `${context}/.`, `${id}:/qualification/input`);
  writeFileSync(
    join(temporary, "descriptor.json"),
    JSON.stringify({
      nonce: d.nonce,
      sourceCommit: receipt.sourceCommit,
      snapshotDigest: receipt.snapshotDigest,
    }),
  );
  stage = "prepare-descriptor-copy";
  await inspect();
  await docker("cp", join(temporary, "descriptor.json"), `${id}:/qualification/descriptor.json`);
  stage = "prepare-ownership";
  await checkedExec(["/bin/chown", "-R", "1000:1000", "/qualification"]);
  stage = "prepare-dependency-inputs";
  await checkedExec(
    [
      "/usr/local/bin/node",
      "--input-type=module",
      "-e",
      "import {verifySystemdDependencyInputs} from '/qualification/input/scripts/lib/owned-systemd-fixture.mjs'; verifySystemdDependencyInputs('/qualification/input','/opt/source-snapshot');",
    ],
    { user: "1000:1000" },
  );
  stage = "prepare-offline-install-and-native-rebuild";
  await checkedExec(
    [
      "/usr/bin/env",
      "HOME=/qualification/home",
      "XDG_CACHE_HOME=/qualification/cache",
      "npm_config_child_concurrency=1",
      "GOMAXPROCS=2",
      "/usr/local/bin/node",
      "/qualification/input/docker/development/prepare-source.mjs",
      "/qualification/input",
      "/qualification/source",
    ],
    { user: "1000:1000", timeout: 180000 },
  );
  stage = "prepare-runtime-link";
  await checkedExec(
    ["/bin/ln", "-s", "/qualification/source/node_modules", "/qualification/node_modules"],
    { user: "1000:1000" },
  );
  await phase("prepare");
  writeFileSync(join(temporary, d.unit), d.unitText);
  await inspect();
  await docker("cp", join(temporary, d.unit), `${id}:/etc/systemd/system/${d.unit}`);
  await checkedExec(["/bin/chmod", "644", `/etc/systemd/system/${d.unit}`]);
  await systemctl("daemon-reload");
  await systemctl("enable", d.unit);
  await systemctl("start", d.unit);
  await phase("journey");
  stage = "cold-stop";
  await inspect();
  await docker("stop", "-t", "20", id);
  receipt.beforeCold = await inspect();
  if (receipt.beforeCold.running || receipt.beforeCold.pid !== 0 || receipt.beforeCold.oomKilled)
    throw new Error("cold-stop-refused");
  stage = "cold-start";
  await docker("start", id);
  await inspect();
  await waitForSystemd();
  await phase("cold");
  await systemctl("disable", "--now", d.unit);
  await phase("cleanup");
  receipt.ok = true;
} catch (error) {
  receipt.failure = {
    stage,
    code:
      error instanceof Error && /^[a-z-]+$/.test(error.message) ? error.message : "fixture-refused",
  };
  if (id) {
    try {
      const current = await inspect();
      if (current.running) {
        const token = await checkedExec(
          [
            "/usr/local/bin/node",
            "-e",
            `const fs=require('node:fs');try{const p='/qualification/state/daemon.json';const s=fs.lstatSync(p);if(s.isFile()&&s.uid===1000&&!(s.mode&0o077)&&s.size<=16384){const v=JSON.parse(fs.readFileSync(p,'utf8'));if(typeof v.authToken==='string'&&v.authToken.length<=4096)process.stdout.write(v.authToken);}}catch{}`,
          ],
          { timeout: 5000 },
        );
        const journal = privateSystemdJournal(
          await checkedExec(
            ["/bin/journalctl", "--unit", d.unit, "--no-pager", "--output=cat", "--lines=200"],
            { timeout: 5000 },
          ),
          token,
        );
        const file = "service-journal.private.log";
        writeFileSync(join(evidence, file), journal, { mode: 0o600 });
        receipt.serviceJournal = {
          file,
          bytes: Buffer.byteLength(journal),
          sha256: sha256(journal),
          currentTokenRedacted: Boolean(token),
        };
        receipt.serviceDiagnostic = systemdFailureDiagnostic(journal);
      }
    } catch {
      receipt.serviceDiagnostic = { unavailable: true };
    }
  }
} finally {
  cleaning = true;
  clearTimeout(whole);
  receipt.cleanup.commands = await settlePackedChildren(children, exits);
  if (creationAttempted && !id) {
    // A cancelled docker-create client can lose its reply after creation. Only
    // the exact fresh nonce and complete declared scope can authorize cleanup.
    try {
      const candidates = (await docker("ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}"))
        .split("\n")
        .filter((line) => line.endsWith(" " + d.name));
      if (candidates.length === 1) {
        const raw = JSON.parse(await docker("inspect", candidates[0].split(" ")[0]));
        if (raw.length === 1) id = inspectSystemdContainer(raw[0], d).id;
      }
      receipt.cleanup.creationResolved = candidates.length === 0 || Boolean(id);
    } catch {
      receipt.cleanup.creationResolved = false;
    }
  }
  if (id) {
    try {
      const current = await inspect();
      receipt.cleanup.oomKilled = current.oomKilled;
      if (current.running) await docker("stop", "-t", "20", id);
      const stopped = await inspect();
      receipt.cleanup.container = stopped;
      receipt.cleanup.oomKilled ||= stopped.oomKilled;
      receipt.cleanup.stopped = !stopped.running && stopped.pid === 0;
      if (receipt.cleanup.stopped) await docker("rm", id);
      receipt.cleanup.removed = !(
        await docker("ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}}")
      )
        .split("\n")
        .some((line) => line.startsWith(id + " ") || line.endsWith(" " + d.name));
    } catch {
      receipt.cleanup.removed = false;
    }
  } else receipt.cleanup.removed = !creationAttempted || receipt.cleanup.creationResolved === true;
  try {
    receipt.unrelatedAfter = await inventory();
    receipt.cleanup.unrelatedUnchanged =
      JSON.stringify(before) === JSON.stringify(receipt.unrelatedAfter);
  } catch {
    receipt.cleanup.unrelatedUnchanged = false;
  }
  try {
    if (temporary) {
      const stat = lstatSync(temporary);
      if (
        stat.dev === temporaryWitness.dev &&
        stat.ino === temporaryWitness.ino &&
        stat.uid === process.getuid()
      ) {
        rmSync(temporary, { recursive: true });
        receipt.cleanup.exportRemoved = true;
      }
    }
  } catch {
    receipt.cleanup.exportRemoved = false;
  }
  receipt.cleanup.commands = await settlePackedChildren(children, exits);
  receipt.commandPids = children.map((c) => c.pid).filter(Boolean);
  receipt.ok &&=
    receipt.cleanup.removed &&
    receipt.cleanup.exportRemoved &&
    receipt.cleanup.unrelatedUnchanged &&
    receipt.cleanup.commands.confirmed &&
    !receipt.cleanup.oomKilled;
  writeFileSync(join(evidence, "qualification.json"), JSON.stringify(receipt, null, 2) + "\n");
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
console.log(JSON.stringify({ ok: receipt.ok, evidence }));
if (!receipt.ok) process.exitCode = 1;
