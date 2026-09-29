import { requireSuccessfulExit } from "./cleanup-witnesses.mjs";
import { execFileSync } from "node:child_process";
execFileSync(process.execPath,[new URL("./verify.mjs",import.meta.url).pathname],{stdio:"inherit"});
import { runTarget } from "./comparative.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
const binary = resolve(process.argv[2]);
const output = resolve(process.argv[3]);
const profile=process.argv[4]??'qualification';if(!['qualification','smoke'].includes(profile))throw Error('Unknown workload profile');
if (existsSync(output)) throw new Error("Choose a fresh output directory");
mkdirSync(output, { recursive: true });
const report = { binary, sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"), startedAt: new Date().toISOString(), load: loadavg(), runs: [] };
const reference=JSON.parse(readFileSync(new URL("./reference.json",import.meta.url),"utf8"));
if(createHash("sha256").update(readFileSync(reference.binary)).digest("hex")!==reference.sha256)throw Error("Reference hash mismatch");
const modes = ["reference", "disabled", "enabled", "reader-0", "reader-16", "reader-32"];
for (let round = 0; round < 3; round++) {
  for (const mode of [...modes.slice(round), ...modes.slice(0, round)]) {
    const selectedBinary=mode==="reference"?reference.binary:binary;
    const directory = resolve(output, `${round}-${mode}`);
    const options = {
      cols: 100, rows: 30, samples: profile==='smoke'?2:200, resizeSamples: profile==='smoke'?1:10,
      inputMode: "key", resources: true, binaries: { tmux: selectedBinary },
      async setupObservation({ tmux, tmuxPid, socket, own }) {
        if (mode === "disabled" || mode === "reference") return;
        await tmux("tmux-ide-events", "-e");
        if (!mode.startsWith("reader-")) return;
        const readyPath = resolve(directory, "reader-ready.json");
        const startTime = (await tmux("display-message", "-p", "#{start_time}")).trim();
        const child = own(process.execPath, [fileURLToPath(new URL("./candidate.mjs", import.meta.url)), binary, socket, String(tmuxPid), startTime, mode.split("-")[1], "echo", readyPath]);
        const deadline = Date.now() + 10000;
        while (!existsSync(readyPath)) {
          if (child.exitCode !== null || Date.now() > deadline) throw new Error("Reader startup failed");
          await new Promise(r => setTimeout(r, 20));
        }
        return async () => {
          await child.qualificationSignal("SIGTERM");
          const deadline = Date.now() + 5000;
          while (child.exitCode === null && child.signalCode === null) {
            if (Date.now() > deadline) throw new Error("Reader failed to retire");
            await new Promise(r => setTimeout(r, 20));
          }
          requireSuccessfulExit(child);
          const result = JSON.parse(readFileSync(`${readyPath}.result.json`, "utf8"));
          if (result.gaps || result.enricherPending) throw new Error("Reader lost history during echo test");
        };
      },
    };
    const result = await runTarget("tmux", options, directory);
    report.runs.push({ round, mode, binary:selectedBinary, ...result });
    writeFileSync(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ round, mode, status: result.status }));
    if (result.status !== "passed" || result.cleanupFailed) throw new Error("Qualification run failed; retained evidence");
  }
}

execFileSync(process.execPath,[new URL("./verify.mjs",import.meta.url).pathname],{stdio:"inherit"});
