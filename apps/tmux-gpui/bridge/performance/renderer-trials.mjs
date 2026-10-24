import { randomBytes } from "node:crypto";
import { ENDPOINT } from "./renderer-probe.mjs";
export function trialManifest(identity) {
  for (const key of ["build", "daemon", "tmux", "route", "cols", "rows"])
    if (identity?.[key] === undefined) throw new Error(`Missing ${key}`);
  const trials = [];
  for (const kind of ["input", "scroll", "output"])
    for (let pair = 0; pair < 5; pair++)
      for (const side of pair % 2 ? ["tui", "gui"] : ["gui", "tui"])
        trials.push({
          id: `${kind}-${pair}-${side}`,
          kind,
          pair,
          side,
          nonce: randomBytes(16).toString("hex"),
        });
  return {
    version: 1,
    endpoint: ENDPOINT,
    identity,
    trials,
    limitations: [
      "Renderer completion is not visible pixels or display vsync",
      "Input, scroll and 2 MiB output are separate cohorts; manual reaction time excluded",
      "Output ends at the final marker; intermediate frames need not all paint",
      "No speedup or parity conclusion without matched successful samples",
    ],
  };
}
function validatePlan(manifest) {
  const invalid = () => {
    throw new Error("Invalid measurement plan");
  };
  if (
    manifest?.version !== 1 ||
    manifest.endpoint !== ENDPOINT ||
    !Array.isArray(manifest.trials) ||
    manifest.trials.length !== 30 ||
    ["build", "daemon", "tmux", "route", "cols", "rows"].some(
      (key) => manifest.identity?.[key] === undefined || manifest.identity[key] === null,
    )
  )
    invalid();
  const nonces = new Set();
  let index = 0;
  // Require the full declared interleaved workload, not just whichever receipts exist.
  for (const kind of ["input", "scroll", "output"])
    for (let pair = 0; pair < 5; pair++)
      for (const side of pair % 2 ? ["tui", "gui"] : ["gui", "tui"]) {
        const trial = manifest.trials[index++];
        if (
          !trial ||
          trial.kind !== kind ||
          trial.pair !== pair ||
          trial.side !== side ||
          trial.id !== `${kind}-${pair}-${side}` ||
          typeof trial.nonce !== "string" ||
          !/^[a-f0-9]{32}$/.test(trial.nonce) ||
          nonces.has(trial.nonce)
        )
          invalid();
        nonces.add(trial.nonce);
      }
}
export function analyzeTrials(manifest, records) {
  validatePlan(manifest);
  const byId = new Map();
  for (const r of records) {
    if (byId.has(r.id)) throw new Error("Duplicate trial receipt");
    byId.set(r.id, r);
  }
  const expected = new Set(manifest.trials.map((t) => t.id));
  if (records.some((r) => !expected.has(r.id))) throw new Error("Unknown trial receipt");
  const outcomes = manifest.trials.map((t) => {
    const r = byId.get(t.id);
    if (!r) return { ...t, status: "missing" };
    if (r.nonce !== t.nonce || r.kind !== t.kind || r.side !== t.side || r.endpoint !== ENDPOINT)
      throw new Error("Receipt identity mismatch");
    if (
      r.status === "completed" &&
      (!Number.isSafeInteger(r.durationMicros) ||
        r.durationMicros < 0 ||
        r.durationMicros > 5_000_000)
    )
      throw new Error("Invalid duration");
    if (!["completed", "failed"].includes(r.status)) throw new Error("Invalid outcome");
    return { ...r, ...t };
  });
  const cohorts = [];
  for (const kind of ["input", "scroll", "output"])
    for (const side of ["gui", "tui"]) {
      const all = outcomes.filter((r) => r.kind === kind && r.side === side),
        ok = all
          .filter((r) => r.status === "completed")
          .map((r) => r.durationMicros / 1000)
          .sort((a, b) => a - b);
      cohorts.push({
        kind,
        side,
        completed: ok.length,
        failed: all.filter((r) => r.status === "failed").length,
        missing: all.filter((r) => r.status === "missing").length,
        medianMs: ok.length ? ok[Math.floor(ok.length / 2)] : null,
        minMs: ok[0] ?? null,
        maxMs: ok.at(-1) ?? null,
      });
    }
  return {
    endpoint: ENDPOINT,
    complete: outcomes.every((r) => r.status === "completed"),
    cohorts,
    outcomes,
    limitations: manifest.limitations,
  };
}
