// Pure judging for the remote-latency job: per-round ratios to plain key echo
// in the same round (runner noise and the link's RTT cancel), the median across
// rounds per profile, and the budget each must stay under.

/** The ratios one round yields, from the plain fixture's and the busy fixture's probe output. */
export function roundRatios({ plain, busy }) {
  const echo = plain?.echo?.p50;
  if (!(echo > 0)) return null;
  return {
    echoMs: echo,
    burst30Last: plain.burst30?.last / echo,
    linesLag: plain.lines?.lag / echo,
    busyEcho: busy?.echo?.p50 / echo,
  };
}

export function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export const RATIO_LABELS = {
  burst30Last: "30-key burst (60 ms apart): last key / echo",
  linesLag: "10 text+Enter lines: lag after last key / echo",
  busyEcho: "echo beside busy neighbours / echo",
};

const budgetFor = (max, profile) => (typeof max === "number" ? max : max?.[profile]);

/**
 * @param {{ profiles: { name: string, oneWayDelayMs: number }[], ratios: Record<string, { max: number | Record<string, number> }>, echoFloor: number }} budgets
 * @param {Record<string, { plain?: any, busy?: any, error?: string }[]>} rounds per profile
 */
export function evaluate(budgets, rounds) {
  const rows = [];
  const failures = [];
  for (const profile of budgets.profiles) {
    const results = rounds[profile.name] ?? [];
    const errors = results.filter((round) => round.error).map((round) => round.error);
    for (const error of errors) failures.push(`${profile.name}: a round failed: ${error}`);
    const ratios = results
      .filter((round) => !round.error)
      .map(roundRatios)
      .filter(Boolean);
    if (!ratios.length) {
      failures.push(`${profile.name}: no round produced a measurement`);
      continue;
    }
    const rtt = 2 * profile.oneWayDelayMs;
    const echo = median(ratios.map((r) => r.echoMs));
    if (echo < budgets.echoFloor * rtt)
      failures.push(
        `${profile.name}: key echo ${echo.toFixed(1)} ms is below ${budgets.echoFloor} × the ${rtt} ms RTT, so the link delay was not applied`,
      );
    rows.push({
      profile: profile.name,
      ratio: "echoMs",
      value: echo,
      max: null,
      rounds: ratios.map((r) => r.echoMs),
    });
    for (const [name, { max }] of Object.entries(budgets.ratios)) {
      const value = median(ratios.map((r) => r[name]));
      const limit = budgetFor(max, profile.name);
      rows.push({
        profile: profile.name,
        ratio: name,
        value,
        max: limit,
        rounds: ratios.map((r) => r[name]),
      });
      if (value === null) failures.push(`${profile.name}: ${name} was not measured`);
      else if (limit !== undefined && value > limit)
        failures.push(
          `${profile.name}: ${RATIO_LABELS[name] ?? name} is ${value.toFixed(2)}, over ${limit}`,
        );
    }
  }
  return { ok: failures.length === 0, rows, failures };
}

export function renderSummary({ ok, rows, failures }, { calibrate = false } = {}) {
  const format = (value) => (value === null || value === undefined ? "–" : value.toFixed(2));
  const lines = [
    `## Remote input latency ${calibrate ? "(calibration, not gated)" : ok ? "passed" : "FAILED"}`,
    "",
    "| Link | Measure | Median | Budget | Rounds |",
    "|---|---|---|---|---|",
    ...rows.map(
      (row) =>
        `| ${row.profile} | ${row.ratio === "echoMs" ? "key echo p50 (ms)" : (RATIO_LABELS[row.ratio] ?? row.ratio)} | ${format(row.value)} | ${row.max ?? "–"} | ${row.rounds.map(format).join(", ")} |`,
    ),
  ];
  if (failures.length) lines.push("", ...failures.map((failure) => `- ${failure}`));
  return `${lines.join("\n")}\n`;
}
