// Turns the soak's events into per-fault numbers. Kept apart from the harness
// so it can be tested without a daemon.

const percentile = (sorted, p) =>
  sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];

/**
 * @param {{events: any[], injected: any[], inactive: boolean, seconds: number, exit: any}} run
 * A disconnect belongs to the fault whose tag the app read when it began
 * ("name#n"), or to "idle" when none was being injected.
 */
export function summarise({ events, injected, inactive, seconds, exit }) {
  const name = (tag) => (tag ?? "").split("#")[0] || "idle";
  const expectedEnd = new Set(injected.filter((f) => f.expectedEnd).map((f) => f.tag));
  const rows = new Map();
  const row = (fault) => {
    if (!rows.has(fault))
      rows.set(fault, {
        fault,
        injected: 0,
        disconnects: 0,
        recovered: 0,
        ms: [],
        stuck: 0,
        needs: new Set(),
        ended: 0,
        unexpectedEnds: 0,
        keyLostTold: 0,
        silentKeyLoss: 0,
        frozen: 0,
      });
    return rows.get(fault);
  };
  for (const fault of injected) row(fault.name).injected += 1;
  for (const event of events) {
    const entry = row(name(event.fault));
    if (event.event === "down") {
      entry.disconnects += 1;
      if (event.frozen) entry.frozen += 1;
    } else if (event.event === "up") {
      // A recovery that needed the user is counted as stuck, not as recovered.
      if ((event.manual ?? []).length === 0) {
        entry.recovered += 1;
        // From the end of the fault: a daemon frozen for 50 s cannot answer sooner.
        entry.ms.push(event.msAfterFault ?? event.ms);
      }
    } else if (event.event === "stuck") {
      if (event.needs === "activate" || !entry.needs.size) entry.stuck += 1;
      entry.needs.add(event.needs);
    } else if (event.event === "ended") {
      entry.ended += 1;
      if (!expectedEnd.has(event.fault)) entry.unexpectedEnds += 1;
    } else if (event.event === "key-lost") {
      if (event.dropped) entry.keyLostTold += event.told ? 1 : 0;
      else entry.silentKeyLoss += 1;
    }
  }
  const faults = [...rows.values()].map((entry) => {
    const sorted = entry.ms.toSorted((a, b) => a - b);
    return {
      ...entry,
      needs: [...entry.needs],
      ms: undefined,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1) ?? null,
    };
  });
  const sum = (key) => faults.reduce((total, entry) => total + entry[key], 0);
  const stopped = events.findLast((event) => event.event === "stopped");
  return {
    inactive,
    seconds,
    exit,
    faults,
    totals: {
      injected: sum("injected"),
      disconnects: sum("disconnects"),
      recovered: sum("recovered"),
      stuck: sum("stuck"),
      ended: sum("ended"),
      unexpectedEnds: sum("unexpectedEnds"),
      silentKeyLoss: sum("silentKeyLoss"),
      frozen: sum("frozen"),
      downAtStop: stopped?.down ?? null,
    },
  };
}

export function table(report) {
  const head =
    "| fault | injected | disconnects | recovered by itself | p50 ms after the fault | p95 ms | max ms | stuck (needs) | ended | keys lost silently |";
  const rule = "|---|---|---|---|---|---|---|---|---|---|";
  const lines = report.faults.map(
    (f) =>
      `| ${f.fault} | ${f.injected} | ${f.disconnects} | ${f.recovered} | ${f.p50 ?? "-"} | ${f.p95 ?? "-"} | ${f.max ?? "-"} | ${f.stuck}${f.needs.length ? ` (${f.needs.join(", ")})` : ""} | ${f.ended}${f.unexpectedEnds ? ` (${f.unexpectedEnds} unexpected)` : ""} | ${f.silentKeyLoss} |`,
  );
  return [
    `window: ${report.inactive ? "inactive" : "active"}; faults for ${report.seconds} s`,
    head,
    rule,
    ...lines,
  ].join("\n");
}
