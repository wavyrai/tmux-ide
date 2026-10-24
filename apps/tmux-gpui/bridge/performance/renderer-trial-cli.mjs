// File preparation/analysis only. Never launches or controls a desktop app.
import process from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { trialManifest, analyzeTrials } from "./renderer-trials.mjs";
const [mode, input, output, receipts] = process.argv.slice(2);
if (!["prepare", "analyze"].includes(mode) || !input || !output)
  throw new Error(
    "prepare identity.json manifest.json | analyze manifest.json summary.json receipts.jsonl",
  );
const source = JSON.parse(await readFile(input, "utf8"));
const result =
  mode === "prepare"
    ? trialManifest(source)
    : analyzeTrials(
        source,
        (await readFile(receipts, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      );
await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 });
