#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  developmentCiIdentity,
  developmentCiPlan,
  runDevelopmentCi,
  finalizeDevelopmentCi,
} from "./lib/development-ci.mjs";
const source = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
const [lane, parent, action] = process.argv.slice(2);
if (!parent || !["fast", "installed"].includes(lane) || (action && action !== "--finalize"))
  throw new Error("Usage: development-ci.mjs fast|installed <evidence-parent> [--finalize]");
const root = join(resolve(parent), developmentCiIdentity(process.env, lane));
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: source,
  encoding: "utf8",
}).trim();
if (
  !action &&
  process.env.DEVELOPMENT_CANDIDATE_SHA &&
  sourceCommit !== process.env.DEVELOPMENT_CANDIDATE_SHA
)
  throw new Error("Candidate commit mismatch");
if (action === "--finalize") {
  const receipt = finalizeDevelopmentCi(root);
  console.log(JSON.stringify({ root, status: receipt.status, cleanup: receipt.cleanup.confirmed }));
  process.exitCode = receipt.status === "passed" && receipt.cleanup.confirmed ? 0 : 1;
} else {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const receipt = await runDevelopmentCi({
      root,
      commands: developmentCiPlan(source, lane),
      signal: controller.signal,
    });
    receipt.sourceCommit = sourceCommit;
    receipt.node = process.version;
    writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({ root, status: receipt.status, cleanup: receipt.cleanup.confirmed }),
    );
    process.exitCode = receipt.status === "passed" ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
