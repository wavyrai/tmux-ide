import { basename } from "node:path";

const MIN_COMMAND_BUDGET_MS = 25;

function boundedCount(value, maximum = 512) {
  return Number.isSafeInteger(value) ? Math.max(0, Math.min(value, maximum)) : 0;
}

function parseSample(stdout, expectedPaneId, expectedCommand) {
  const lines = typeof stdout === "string" ? stdout.trimEnd().split("\n").filter(Boolean) : [];
  const fields = lines.length === 1 ? lines[0].split("\t") : [];
  const [
    paneId,
    windowId,
    borderStatus,
    windowCols,
    windowRows,
    left,
    top,
    cols,
    rows,
    pid,
    command,
  ] = fields;
  const numeric = [windowCols, windowRows, left, top, cols, rows, pid].map(Number);
  const facts = Object.freeze({
    singleRow: lines.length === 1 && fields.length === 11,
    paneIdentityExact: paneId === expectedPaneId && /^%[0-9]+$/u.test(paneId ?? ""),
    windowIdentityValid: /^@[0-9]+$/u.test(windowId ?? ""),
    borderExact: borderStatus === "top",
    commandExact: command === expectedCommand,
    numericExact: numeric.every(Number.isSafeInteger) && Number(pid) >= 1,
    windowGeometryExact: Number(windowCols) === 132 && Number(windowRows) === 41,
    paneGeometryExact:
      Number(left) === 0 && Number(top) === 1 && Number(cols) === 132 && Number(rows) === 40,
  });
  if (Object.values(facts).some((value) => value !== true)) return { facts, sample: null };
  return {
    facts,
    sample: Object.freeze({
      windowId,
      paneId,
      pid: Number(pid),
      command,
      windowCols: 132,
      windowRows: 41,
      paneLeft: 0,
      paneTop: 1,
      paneCols: 132,
      paneRows: 40,
    }),
  };
}

function commandOutcome(operation, error) {
  if (error?.ansiTmuxDeadline === true) return `${operation}-deadline`;
  if (error?.code === "ETIMEDOUT" || error?.killed === true || typeof error?.signal === "string")
    return `${operation}-timeout`;
  return `${operation}-exit`;
}

export async function conditionAnsiTmuxFixture({
  run,
  paneId,
  marker,
  executable,
  now = () => performance.now(),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 5_000,
}) {
  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let prior = null;
  let exactSamples = 0;
  let listAttempts = 0;
  let captureAttempts = 0;
  let markerCount = 0;
  let lastFacts = null;
  let outcome = "deadline";
  let activeOperation = "setup";
  const boundedRun = async (operation, args) => {
    activeOperation = operation;
    if (deadline - now() <= MIN_COMMAND_BUDGET_MS) {
      const error = new Error("ANSI tmux precondition command had no reserved deadline");
      error.ansiTmuxDeadline = true;
      throw error;
    }
    if (operation === "list") listAttempts += 1;
    if (operation === "capture") captureAttempts += 1;
    const result = await run(args, deadline);
    if (now() > deadline) {
      const error = new Error("ANSI tmux precondition command crossed its deadline");
      error.ansiTmuxDeadline = true;
      throw error;
    }
    activeOperation = null;
    return result;
  };
  const fail = (failureOutcome) => {
    const error = new Error("ANSI tmux fixture did not reach exact stable geometry before daemon");
    error.observation = Object.freeze({
      stage: "ansi-tmux-precondition",
      outcome: failureOutcome,
      exactSamples: boundedCount(exactSamples, 2),
      listAttempts: boundedCount(listAttempts),
      captureAttempts: boundedCount(captureAttempts),
      markerCount: boundedCount(markerCount, 2),
      remainingMs: boundedCount(Math.floor(deadline - now()), Math.max(0, timeoutMs)),
      singleRow: lastFacts?.singleRow === true,
      paneIdentityExact: lastFacts?.paneIdentityExact === true,
      windowIdentityValid: lastFacts?.windowIdentityValid === true,
      borderExact: lastFacts?.borderExact === true,
      commandExact: lastFacts?.commandExact === true,
      numericExact: lastFacts?.numericExact === true,
      windowGeometryExact: lastFacts?.windowGeometryExact === true,
      paneGeometryExact: lastFacts?.paneGeometryExact === true,
      markerExact: markerCount === 1,
      stable: false,
    });
    throw error;
  };

  try {
    await boundedRun("set-border", ["set-option", "-w", "-t", paneId, "pane-border-status", "top"]);
    await boundedRun("resize", ["resize-window", "-t", paneId, "-x", "132", "-y", "41"]);
    while (deadline - now() > MIN_COMMAND_BUDGET_MS) {
      const stdout = await boundedRun("list", [
        "list-panes",
        "-t",
        paneId,
        "-F",
        "#{pane_id}\t#{window_id}\t#{pane-border-status}\t#{window_width}\t#{window_height}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_pid}\t#{pane_current_command}",
      ]);
      const parsed = parseSample(stdout, paneId, basename(executable));
      lastFacts = parsed.facts;
      const sample = parsed.sample;
      const capture = sample
        ? await boundedRun("capture", ["capture-pane", "-p", "-J", "-t", paneId])
        : "";
      markerCount = capture.split(marker).length - 1;
      const exact = sample !== null && markerCount === 1;
      exactSamples = exact ? exactSamples + 1 : 0;
      if (
        exact &&
        prior &&
        prior.paneId === sample.paneId &&
        prior.windowId === sample.windowId &&
        prior.pid === sample.pid &&
        prior.command === sample.command
      )
        return Object.freeze({ ...sample, stableSamples: 2, markerCount: 1 });
      prior = exact ? sample : null;
      await wait(Math.min(25, Math.max(0, deadline - now() - MIN_COMMAND_BUDGET_MS)));
    }
  } catch (error) {
    outcome = commandOutcome(activeOperation ?? "setup", error);
  }
  fail(outcome);
}
