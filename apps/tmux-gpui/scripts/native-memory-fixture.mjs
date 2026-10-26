// Opt-in owned GUI/daemon RSS qualification; no desktop input automation.
// Node --import tsx. --smoke 1 never launches GUI and is not GUI qualification.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PHASES, limitsFor } from "./native-memory-workload.mjs";
import { sampleOwnedRss, sampleOwnedMemory } from "./native-memory-sampling.mjs";
process.umask(0o077);
const opt = {},
  argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) {
  if (
    ![
      "--repo",
      "--cli",
      "--binary",
      "--tmux",
      "--output",
      "--profile",
      "--smoke",
      "--image-profile",
      "--transport",
    ].includes(argv[i]) ||
    !argv[i + 1] ||
    opt[argv[i]]
  )
    throw Error("Invalid arguments");
  opt[argv[i]] = argv[i + 1];
}
for (const key of ["--repo", "--cli", "--binary", "--tmux", "--output"])
  if (!isAbsolute(opt[key] ?? "")) throw Error(`Explicit absolute ${key} required`);
for (const key of ["--repo", "--cli", "--binary", "--tmux"]) await access(opt[key]);
if (
  !["debug", "release"].includes(opt["--profile"]) ||
  (opt["--smoke"] !== undefined && opt["--smoke"] !== "1")
)
  throw Error("Explicit profile and valid smoke flag required");
const transport = opt["--transport"] ?? "native";
if (!["native", "legacy"].includes(transport)) throw Error("--transport requires native|legacy");
const imageProfile = opt["--image-profile"] ?? "small";
const limits = limitsFor(imageProfile);
const repo = opt["--repo"],
  output = opt["--output"],
  smoke = opt["--smoke"] === "1",
  run = promisify(execFile);
await mkdir(output, { mode: 0o700 });
const load = (p) => import(pathToFileURL(join(repo, p)).href);
const save = (name, data) =>
  writeFile(join(output, name), JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
const { createScratchFleet } = await load("scripts/lib/product-fixtures/scratch-fleet.ts");
const { startDaemon } = await load("scripts/lib/product-fixtures/daemon.ts");
const { stopFixtureChild } = await load("apps/tmux-gpui/bridge/fixture-child.mjs");
const { createMacProcessIdentity } = await load("scripts/lib/owned-ssh-fixture.mjs");
for (const k of Object.keys(process.env))
  if (
    k.startsWith("TMUX_IDE_") ||
    ["TMUX", "TMUX_PANE", "TMUX_TMPDIR", "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(k)
  )
    delete process.env[k];
process.env.PATH = dirname(opt["--tmux"]) + ":" + (process.env.PATH ?? "");
let fleet,
  daemon,
  native,
  broker,
  timer,
  deadline,
  flight,
  kernel,
  armed = false,
  completed = false,
  samplingFailed = false,
  stop;
const allocations = [],
  owned = [];
const stopped = new Promise((r) => {
  stop = r;
});
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  kernel = await createMacProcessIdentity({
    parent: output,
    onAllocated: (a) => allocations.push(a),
  });
  const workload = join(repo, "apps/tmux-gpui/scripts/native-memory-workload.mjs");
  fleet = await createScratchFleet({
    sessions: 1,
    slug: "native-memory",
    windowsPerSession: 1,
    initialPaneCommand: {
      executable: "/usr/bin/env",
      args: [
        "TMUX_IDE_MEMORY_FIXTURE=1",
        process.execPath,
        workload,
        join(output, "workload-arm.json"),
        join(output, "workload.jsonl"),
        smoke ? "smoke" : "full",
        imageProfile,
      ],
    },
  });
  if (fleet.environment.TMUX_IDE_TMUX_BIN !== opt["--tmux"]) throw Error("Explicit tmux mismatch");
  const env = { ...process.env, ...fleet.environment };
  daemon = await startDaemon(fleet, { cliPath: opt["--cli"] });
  for (const name of fleet.sessionNames) await daemon.promote(name);
  if (!smoke) {
    native = spawn(
      opt["--binary"],
      transport === "native" ? ["--tmux-native-local"] : ["--tmux-browser-stdio"],
      {
        cwd: repo,
        env,
        stdio: [transport === "native" ? "ignore" : "pipe", "pipe", "pipe"],
      },
    );
    if (transport === "legacy") {
      broker = spawn(
        process.execPath,
        ["--import", "tsx", join(repo, "apps/tmux-gpui/bridge/browser.ts"), "--local"],
        { cwd: repo, env, stdio: ["pipe", "pipe", "pipe"] },
      );
      native.stdout.pipe(broker.stdin);
      broker.stdout.pipe(native.stdin);
    } else {
      native.stdout.pipe(createWriteStream(join(output, "native-stdout.log"), { mode: 0o600 }));
    }
    for (const [name, child] of [
      ["native", native],
      ["broker", broker],
    ]) {
      if (!child) continue;
      child.stderr.pipe(createWriteStream(join(output, name + ".log"), { mode: 0o600 }));
      child.stdin?.on("error", () => {});
      child.once("error", stop);
      child.once("exit", stop);
    }
  }
  for (const [name, pid] of [
    ["daemon", daemon.record.pid],
    ["native", native?.pid],
    ["broker", broker?.pid],
  ])
    if (pid) {
      const identity = await kernel.identify(pid);
      if (!identity) throw Error("Owned process identity unavailable");
      owned.push({
        name,
        pid,
        identity,
        ...(name === "daemon" ? { instanceId: daemon.record.instanceId } : {}),
      });
    }
  const hashes = {};
  for (const [name, path] of Object.entries({
    node: process.execPath,
    cli: opt["--cli"],
    native: opt["--binary"],
    tmux: opt["--tmux"],
    workload,
    ...(transport === "legacy" ? { broker: join(repo, "apps/tmux-gpui/bridge/browser.ts") } : {}),
    runner: import.meta.filename,
  }))
    hashes[name] = {
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    };
  const git = async (...args) =>
    (await run("git", args, { cwd: repo, maxBuffer: 32 * 1024 * 1024 })).stdout;
  const sourceDiff = await git("diff", "HEAD", "--", "bin", "packages", "apps/tmux-gpui");
  const untracked = {};
  for (const path of (
    await git(
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      "bin",
      "packages",
      "apps/tmux-gpui",
    )
  )
    .split("\n")
    .filter(Boolean))
    untracked[path] = createHash("sha256")
      .update(await readFile(join(repo, path)))
      .digest("hex");
  const manifest = {
    smoke,
    transport,
    profile: opt["--profile"],
    profileVerified: false,
    nodeVersion: process.version,
    hashes,
    commit: (await git("rev-parse", "HEAD")).trim(),
    sourceDiffSha256: createHash("sha256").update(sourceDiff).digest("hex"),
    untracked,
    imageProfile,
    limits,
    phases: smoke ? PHASES.map((p) => ({ ...p, seconds: 1 })) : PHASES,
    owned: owned.map(({ name, pid }) => ({ name, pid })),
    session: fleet.sessionNames[0],
    pane: fleet.initialPanes[0].paneId,
    socket: fleet.socketPath,
    endpoint: "process RSS KiB; not GPU allocation, heap, or visible image completion",
    daemonMemoryEndpoint:
      "owner-gated process.memoryUsage bytes every two seconds; arrayBuffers is included in external",
    limitations: [
      "Manual image/scroll visibility observations required",
      "RSS includes allocator/framework caches; plateau or release is not proof of leak freedom",
      "One bounded workload is not a comparative speed or memory claim",
      "Sampling exact native/broker/daemon roots does not aggregate subprocess or GPU memory",
    ],
  };
  await save("manifest.json", manifest);
  let uptime = "unavailable";
  try {
    uptime = (await run("/usr/bin/uptime", [], { timeout: 2000 })).stdout.trim();
  } catch {
    // Host load is optional context, not a workload result.
  }
  await save("load-before.json", { time: Date.now(), uptime });
  await writeFile(
    join(output, "instructions.txt"),
    [
      `Select GUI session ${manifest.session}, then its only pane. Confirm initial MEMORY FIXTURE READY is visible.`,
      `Write arm.json in this evidence folder with {"guiPid":${native?.pid ?? null},"paneId":${JSON.stringify(manifest.pane)},"cols":ACTUAL_COLS,"rows":ACTUAL_ROWS,"visible":true}. Runner validates against owned pane geometry.`,
      "During images-and-history manually scroll up/down, returning to live before reuse/delete. Record phase/time/visible placements and history, including failures, in manual-observations.json. The harness does not claim scrolling occurred.",
      "After delete, confirm placements disappear. Idle phase observes retained RSS for 90 seconds (beyond the 60-second image-cache idle threshold). Do not run builds simultaneously.",
      "No keys need be sent to the workload. Ctrl-C the runner to stop; evidence remains.",
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  const sample = async () => {
    const { stdout } = await run(
      opt["--tmux"],
      [
        "-S",
        fleet.socketPath,
        "display-message",
        "-p",
        "-t",
        manifest.pane,
        "#{pane_id} #{pane_width} #{pane_height}",
      ],
      { env, timeout: 2000, maxBuffer: 4096 },
    );
    const [paneId, colsRaw, rowsRaw] = stdout.trim().split(/\s+/),
      cols = Number(colsRaw),
      rows = Number(rowsRaw);
    if (paneId !== manifest.pane || !Number.isSafeInteger(cols) || !Number.isSafeInteger(rows))
      throw Error("Owned geometry unavailable");
    if (!armed) {
      let request;
      try {
        request = JSON.parse(await readFile(join(output, "arm.json"), "utf8"));
      } catch {
        // Wait until the user writes a complete arm request.
      }
      if (
        smoke ||
        (request?.visible === true &&
          request.guiPid === native.pid &&
          request.paneId === paneId &&
          request.cols === cols &&
          request.rows === rows)
      ) {
        armed = true;
        await save("armed.json", { time: Date.now(), smoke, paneId, cols, rows });
        await save("workload-arm.json", { armed: true });
      }
    }
    const rss = await sampleOwnedRss(owned, {
      identify: (pid) => kernel.identify(pid),
      readRss: async (pid) =>
        Number(
          (
            await run("/bin/ps", ["-p", String(pid), "-o", "rss="], {
              timeout: 2000,
              maxBuffer: 4096,
            })
          ).stdout.trim(),
        ),
    });
    await appendFile(
      join(output, "rss.jsonl"),
      JSON.stringify({
        time: Date.now(),
        armed,
        geometry: { paneId, cols, rows },
        processes: rss,
      }) + "\n",
    );
    const daemonMemory = await sampleOwnedMemory(
      owned.find((p) => p.name === "daemon"),
      {
        identify: (pid) => kernel.identify(pid),
        readDiagnostics: async () => {
          const response = await fetch(`${daemon.baseUrl}/api/diagnostics`, {
            headers: { Authorization: `Bearer ${daemon.record.authToken}` },
            signal: AbortSignal.timeout(1500),
            redirect: "error",
          });
          if (!response.ok) throw Error("Owned diagnostics unavailable");
          let size = 0;
          const chunks = [];
          for await (const chunk of response.body) {
            size += chunk.length;
            if (size > 16384) throw Error("Diagnostics response exceeded bound");
            chunks.push(chunk);
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
        },
      },
    );
    await appendFile(join(output, "daemon-memory.jsonl"), JSON.stringify(daemonMemory) + "\n");
    if (daemonMemory.status !== "ok") {
      samplingFailed = true;
      stop();
    }
    let events = [];
    try {
      events = (await readFile(join(output, "workload.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
    } catch {
      // The workload may not have created its event log yet.
    }
    if (events.some((e) => e.type === "phase" && e.phase === "complete")) {
      completed = true;
      stop();
    }
  };
  timer = setInterval(() => {
    if (!flight)
      flight = sample()
        .catch(async (error) => {
          samplingFailed = true;
          await save("sampling-error.json", {
            time: Date.now(),
            message: String(error),
            stack: error?.stack?.slice(0, 8192),
          });
          stop();
        })
        .finally(() => {
          flight = undefined;
        });
  }, 2000);
  await sample();
  console.log(
    JSON.stringify({
      prepared: true,
      smoke,
      output,
      session: manifest.session,
      nativePid: native?.pid ?? null,
    }),
  );
  deadline = setTimeout(stop, smoke ? 20000 : 390000);
  await stopped;
} finally {
  clearInterval(timer);
  clearTimeout(deadline);
  await flight;
  if (daemon) await writeFile(join(output, "daemon.log"), daemon.output(), { mode: 0o600 });
  const cleanup = [];
  for (const [name, fn] of [
    ["native", () => stopFixtureChild(native)],
    ["broker", () => stopFixtureChild(broker)],
    ["daemon", () => daemon?.stop()],
    ["fleet", () => fleet?.dispose()],
    [
      "identities",
      async () => {
        for (const a of allocations.reverse()) await a.disposeFiles();
      },
    ],
  ]) {
    try {
      await fn();
      cleanup.push({ name, ok: true });
    } catch {
      cleanup.push({ name, ok: false });
    }
  }
  await save("cleanup.json", {
    time: Date.now(),
    completed,
    armed,
    smoke,
    samplingFailed,
    cleanup,
  });
  if (!completed || samplingFailed || cleanup.some((x) => !x.ok)) process.exitCode = 1;
}
