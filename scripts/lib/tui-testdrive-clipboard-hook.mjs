const HOOK = "pane-set-clipboard";
const MAX_HOOK_SLOTS = 8;
const MAX_HOOK_OUTPUT_BYTES = 64 * 1_024;
const LOCK = "tmux-ide-testdrive-clipboard-hook-v1";
const OWNER_OPTION = "@tmux_ide_testdrive_clipboard_owner";
const OWNER_MARKER = "__TMUX_IDE_CLIPBOARD_OWNER__";
const HOOKS_MARKER = "__TMUX_IDE_CLIPBOARD_HOOKS__";
const END_MARKER = "__TMUX_IDE_CLIPBOARD_END__";
const RETIREMENT_STAGES = new Set([
  "not-started",
  "lock",
  "preflight",
  "mutation",
  "verification",
  "unlock",
  "complete",
]);
const exactAcquisitionRollbacks = new WeakSet();
const RETIREMENT_EVIDENCE_KEYS = new Set([
  "candidateAttempts",
  "occupiedCount",
  "retirementExact",
  "retirementStage",
  "retirementElapsedMs",
  "finalOwnerAbsent",
  "finalHookAbsent",
]);

export function isExactClipboardAcquisitionRollback(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    exactAcquisitionRollbacks.has(value) &&
    Object.keys(value).length === RETIREMENT_EVIDENCE_KEYS.size &&
    Object.keys(value).every((key) => RETIREMENT_EVIDENCE_KEYS.has(key)) &&
    Number.isSafeInteger(value.candidateAttempts) &&
    value.candidateAttempts >= 0 &&
    value.candidateAttempts <= MAX_HOOK_SLOTS &&
    Number.isSafeInteger(value.occupiedCount) &&
    value.occupiedCount >= 0 &&
    value.occupiedCount <= MAX_HOOK_SLOTS &&
    value.retirementExact === true &&
    value.retirementStage === "complete" &&
    Number.isSafeInteger(value.retirementElapsedMs) &&
    value.retirementElapsedMs >= 0 &&
    value.retirementElapsedMs <= 5_000 &&
    value.finalOwnerAbsent === true &&
    value.finalHookAbsent === true
  );
}

export function ensureClipboardAcquisitionRollback({ evidence, ...rollback }) {
  if (isExactClipboardAcquisitionRollback(evidence)) return evidence;
  return rollbackClipboardPaneHookAcquisition(rollback);
}

function boundedElapsed(startedAt, now) {
  try {
    return Math.min(5_000, Math.max(0, Math.round(now() - startedAt)));
  } catch {
    return 0;
  }
}

function fail(message, evidence) {
  const error = new Error(message);
  error.clipboardLeaseEvidence = Object.freeze({
    candidateAttempts: Math.min(evidence.candidateAttempts, MAX_HOOK_SLOTS),
    occupiedCount: Math.min(evidence.occupiedCount, MAX_HOOK_SLOTS),
    retirementExact: evidence.retirementExact === true,
    retirementStage: RETIREMENT_STAGES.has(evidence.retirementStage)
      ? evidence.retirementStage
      : "not-started",
    retirementElapsedMs: Number.isSafeInteger(evidence.retirementElapsedMs)
      ? Math.min(5_000, Math.max(0, evidence.retirementElapsedMs))
      : 0,
    finalOwnerAbsent: evidence.finalOwnerAbsent === true,
    finalHookAbsent: evidence.finalHookAbsent === true,
  });
  throw error;
}

function attachEvidence(error, evidence) {
  if (error && typeof error === "object") {
    error.clipboardLeaseEvidence = Object.freeze({
      candidateAttempts: Math.min(evidence.candidateAttempts, MAX_HOOK_SLOTS),
      occupiedCount: Math.min(evidence.occupiedCount, MAX_HOOK_SLOTS),
      retirementExact: evidence.retirementExact === true,
      retirementStage: RETIREMENT_STAGES.has(evidence.retirementStage)
        ? evidence.retirementStage
        : "not-started",
      retirementElapsedMs: Number.isSafeInteger(evidence.retirementElapsedMs)
        ? Math.min(5_000, Math.max(0, evidence.retirementElapsedMs))
        : 0,
      finalOwnerAbsent: evidence.finalOwnerAbsent === true,
      finalHookAbsent: evidence.finalHookAbsent === true,
    });
  }
  return error;
}

function parseHooks(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_HOOK_OUTPUT_BYTES) {
    throw new Error("clipboard hook inventory is malformed or over cap");
  }
  if (source.trim() === HOOK) return [];
  const hooks = [];
  const names = new Set();
  for (const line of source.split("\n").filter(Boolean)) {
    const match = /^(pane-set-clipboard\[[0-9]+\]) (.+)$/u.exec(line);
    if (!match || names.has(match[1])) {
      throw new Error("clipboard hook inventory is malformed");
    }
    names.add(match[1]);
    hooks.push(Object.freeze({ name: match[1], command: match[2] }));
  }
  return hooks;
}

function readHooks(runTmux, paneId, timeout) {
  try {
    return parseHooks(runTmux(["show-hooks", "-p", "-t", paneId, HOOK], { timeout }));
  } catch (error) {
    if (/unknown hook|no such hook/iu.test(String(error?.stderr ?? error?.message ?? "")))
      return [];
    throw error;
  }
}

function readOwner(runTmux, paneId, timeout) {
  try {
    const value = runTmux(["show-options", "-pqv", "-t", paneId, OWNER_OPTION], { timeout });
    return typeof value === "string" ? value.trim() : "";
  } catch (error) {
    if (/unknown option|invalid option/iu.test(String(error?.stderr ?? error?.message ?? "")))
      return "";
    throw error;
  }
}

function parseOwnerAndHooks(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_HOOK_OUTPUT_BYTES) {
    throw new Error("clipboard hook transaction output is malformed or over cap");
  }
  const ownerAt = source.indexOf(OWNER_MARKER);
  const hooksAt = source.indexOf(HOOKS_MARKER);
  const endAt = source.indexOf(END_MARKER);
  if (
    ownerAt !== 0 ||
    hooksAt < 0 ||
    endAt < hooksAt ||
    source.indexOf(END_MARKER, endAt + 1) >= 0
  ) {
    throw new Error("clipboard hook transaction output is malformed");
  }
  const ownerEnd = source.indexOf("\n", OWNER_MARKER.length);
  if (ownerEnd < 0 || hooksAt !== ownerEnd + 1) {
    throw new Error("clipboard hook transaction owner output is malformed");
  }
  const owner = source.slice(OWNER_MARKER.length, ownerEnd);
  const hookSource = source.slice(hooksAt + HOOKS_MARKER.length + 1, endAt).replace(/\n$/u, "");
  return { owner, hooks: parseHooks(hookSource) };
}

function ownerAndHooksCommands(paneId) {
  return [
    "display-message",
    "-p",
    "-t",
    paneId,
    `${OWNER_MARKER}#{${OWNER_OPTION}}`,
    ";",
    "display-message",
    "-p",
    HOOKS_MARKER,
    ";",
    "show-hooks",
    "-p",
    "-t",
    paneId,
    HOOK,
    ";",
    "display-message",
    "-p",
    END_MARKER,
  ];
}

function readOwnerAndHooks(runTmux, paneId, timeout) {
  return parseOwnerAndHooks(runTmux(ownerAndHooksCommands(paneId), { timeout }));
}

function retirementCommands(paneId, hookName) {
  return [
    "set-hook",
    "-pu",
    "-t",
    paneId,
    hookName,
    ";",
    "set-option",
    "-pu",
    "-t",
    paneId,
    OWNER_OPTION,
    ";",
    ...ownerAndHooksCommands(paneId),
  ];
}

function releaseOwnerIfExact(runTmux, paneId, ownerToken, remaining) {
  if (readOwner(runTmux, paneId, remaining()) !== ownerToken) return false;
  runTmux(["set-option", "-pu", "-t", paneId, OWNER_OPTION], { timeout: remaining() });
  return readOwner(runTmux, paneId, remaining()) === "";
}

function withLock(runTmux, remaining, operation, beforeUnlock = () => {}) {
  runTmux(["wait-for", "-L", LOCK], { timeout: remaining() });
  let result;
  let failure;
  try {
    result = operation();
  } catch (error) {
    failure = error;
  }
  try {
    if (!failure) beforeUnlock();
    let unlockTimeout = 1;
    try {
      unlockTimeout = Math.max(1, remaining());
    } catch {
      // The owned lock still needs one bounded release attempt after the work
      // deadline closes, otherwise it could poison a later operation.
    }
    runTmux(["wait-for", "-U", LOCK], { timeout: unlockTimeout });
  } catch (unlockError) {
    if (!failure) failure = unlockError;
  }
  if (failure) throw failure;
  return result;
}

export function acquireClipboardPaneHook({
  paneId,
  ownerToken,
  command,
  runTmux,
  remaining,
  cleanupRemaining,
}) {
  if (
    !/^%[0-9]+$/u.test(paneId ?? "") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(ownerToken ?? "") ||
    typeof command !== "string" ||
    command.length < 1 ||
    Buffer.byteLength(command, "utf8") > 16 * 1_024 ||
    [...command].some((character) => {
      const code = character.codePointAt(0);
      return code === 0 || code === 10 || code === 13;
    })
  ) {
    throw new Error("clipboard hook acquisition identity is malformed");
  }
  try {
    return withLock(runTmux, remaining, () => {
      let ownerAcquired = false;
      try {
        try {
          runTmux(["set-option", "-po", "-t", paneId, OWNER_OPTION, ownerToken], {
            timeout: remaining(),
          });
        } catch (error) {
          if (readOwner(runTmux, paneId, remaining()) !== "") {
            fail("clipboard observation already has an active owner", {
              candidateAttempts: 0,
              occupiedCount: 0,
              retirementExact: false,
            });
          }
          throw error;
        }
        ownerAcquired = readOwner(runTmux, paneId, remaining()) === ownerToken;
        if (!ownerAcquired) {
          fail("clipboard observation already has an active owner", {
            candidateAttempts: 0,
            occupiedCount: 0,
            retirementExact: false,
          });
        }
        const before = readHooks(runTmux, paneId, remaining());
        const occupiedCount = Math.min(before.length, MAX_HOOK_SLOTS);
        if (before.length >= MAX_HOOK_SLOTS) {
          fail("clipboard hook candidates are exhausted", {
            candidateAttempts: MAX_HOOK_SLOTS,
            occupiedCount,
            retirementExact: false,
          });
        }
        runTmux(["set-hook", "-ap", "-t", paneId, HOOK, command], { timeout: remaining() });
        const after = readHooks(runTmux, paneId, remaining());
        const priorNames = new Set(before.map(({ name }) => name));
        const added = after.filter(({ name }) => !priorNames.has(name));
        const owned = added.filter((entry) => entry.command === command);
        if (added.length !== 1 || owned.length !== 1) {
          fail("clipboard hook atomic acquisition could not prove exact ownership", {
            candidateAttempts: occupiedCount + 1,
            occupiedCount,
            retirementExact: false,
          });
        }
        return Object.freeze({
          hookName: owned[0].name,
          ownerToken,
          command,
          candidateAttempts: occupiedCount + 1,
          occupiedCount,
        });
      } catch (error) {
        if (ownerAcquired) {
          try {
            releaseOwnerIfExact(runTmux, paneId, ownerToken, remaining);
          } catch {
            // Preserve the first acquisition failure.
          }
        }
        throw error;
      }
    });
  } catch (error) {
    if (typeof cleanupRemaining === "function") {
      try {
        const rollbackEvidence = rollbackClipboardPaneHookAcquisition({
          paneId,
          ownerToken,
          command,
          runTmux,
          remaining: cleanupRemaining,
        });
        if (error && typeof error === "object") error.clipboardLeaseEvidence = rollbackEvidence;
      } catch (rollbackError) {
        if (rollbackError?.clipboardLeaseEvidence && error && typeof error === "object")
          error.clipboardLeaseEvidence = rollbackError.clipboardLeaseEvidence;
      }
    }
    throw error;
  }
}

export function rollbackClipboardPaneHookAcquisition({
  paneId,
  ownerToken,
  command,
  runTmux,
  remaining,
  now = () => performance.now(),
}) {
  let startedAt = 0;
  try {
    startedAt = now();
  } catch {
    // Timing evidence is best-effort and must not affect owned cleanup.
  }
  const evidence = {
    candidateAttempts: 0,
    occupiedCount: 0,
    retirementExact: false,
    retirementStage: "lock",
    retirementElapsedMs: 0,
    finalOwnerAbsent: false,
    finalHookAbsent: false,
  };
  try {
    withLock(runTmux, remaining, () => {
      evidence.retirementStage = "preflight";
      const before = readOwnerAndHooks(runTmux, paneId, remaining());
      const exactHooks = before.hooks.filter(({ command: current }) => current === command);
      evidence.candidateAttempts = Math.min(exactHooks.length, MAX_HOOK_SLOTS);
      evidence.occupiedCount = Math.min(before.hooks.length, MAX_HOOK_SLOTS);
      if (before.owner !== "" && before.owner !== ownerToken) {
        evidence.finalOwnerAbsent = false;
        evidence.finalHookAbsent = exactHooks.length === 0;
        fail("clipboard acquisition rollback found a foreign owner", evidence);
      }
      evidence.retirementStage = "mutation";
      for (const hook of exactHooks) {
        const current = readOwnerAndHooks(runTmux, paneId, remaining());
        const exact = current.hooks.find(({ name }) => name === hook.name);
        if (!exact || exact.command !== command) continue;
        if (current.owner !== "" && current.owner !== ownerToken) {
          fail("clipboard acquisition rollback ownership changed", evidence);
        }
        runTmux(["set-hook", "-pu", "-t", paneId, hook.name], { timeout: remaining() });
      }
      if (readOwner(runTmux, paneId, remaining()) === ownerToken) {
        runTmux(["set-option", "-pu", "-t", paneId, OWNER_OPTION], { timeout: remaining() });
      }
      evidence.retirementStage = "verification";
      const after = readOwnerAndHooks(runTmux, paneId, remaining());
      evidence.finalOwnerAbsent = after.owner === "";
      evidence.finalHookAbsent = !after.hooks.some(({ command: current }) => current === command);
      if (!evidence.finalOwnerAbsent || !evidence.finalHookAbsent) {
        fail("clipboard acquisition rollback retained owned state", evidence);
      }
    });
    evidence.retirementStage = "complete";
    evidence.retirementExact = true;
    evidence.retirementElapsedMs = boundedElapsed(startedAt, now);
    const exact = Object.freeze({ ...evidence });
    exactAcquisitionRollbacks.add(exact);
    return exact;
  } catch (error) {
    evidence.retirementExact = false;
    evidence.retirementElapsedMs = boundedElapsed(startedAt, now);
    throw attachEvidence(error, evidence);
  }
}

export function retireClipboardPaneHook({
  paneId,
  lease,
  runTmux,
  remaining,
  now = () => performance.now(),
}) {
  let startedAt = 0;
  try {
    startedAt = now();
  } catch {
    // Timing evidence is best-effort and must not affect owned cleanup.
  }
  const evidence = {
    candidateAttempts: lease?.candidateAttempts ?? 0,
    occupiedCount: lease?.occupiedCount ?? 0,
    retirementExact: false,
    retirementStage: "not-started",
    retirementElapsedMs: 0,
    finalOwnerAbsent: false,
    finalHookAbsent: false,
  };
  if (
    !/^%[0-9]+$/u.test(paneId ?? "") ||
    !/^pane-set-clipboard\[[0-9]+\]$/u.test(lease?.hookName ?? "") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(lease?.ownerToken ?? "") ||
    typeof lease?.command !== "string"
  ) {
    fail("clipboard hook retirement identity is malformed", evidence);
  }
  evidence.retirementStage = "lock";
  try {
    withLock(
      runTmux,
      remaining,
      () => {
        evidence.retirementStage = "preflight";
        const before = readOwnerAndHooks(runTmux, paneId, remaining());
        if (before.owner !== lease.ownerToken) {
          fail("clipboard observation ownership changed before retirement", evidence);
        }
        const current = before.hooks.find(({ name }) => name === lease.hookName);
        if (!current || current.command !== lease.command) {
          releaseOwnerIfExact(runTmux, paneId, lease.ownerToken, remaining);
          fail("clipboard hook ownership changed before retirement", evidence);
        }
        evidence.retirementStage = "mutation";
        let after;
        try {
          after = parseOwnerAndHooks(
            runTmux(retirementCommands(paneId, lease.hookName), { timeout: remaining() }),
          );
        } catch (error) {
          try {
            let recovered = readOwnerAndHooks(runTmux, paneId, remaining());
            const recoveredHook = recovered.hooks.find(({ name }) => name === lease.hookName);
            if (recovered.owner === lease.ownerToken && recoveredHook?.command === lease.command) {
              recovered = parseOwnerAndHooks(
                runTmux(retirementCommands(paneId, lease.hookName), { timeout: remaining() }),
              );
            } else if (recovered.owner === "" && recoveredHook?.command === lease.command) {
              runTmux(["set-option", "-po", "-t", paneId, OWNER_OPTION, lease.ownerToken], {
                timeout: remaining(),
              });
              recovered = readOwnerAndHooks(runTmux, paneId, remaining());
            } else if (recovered.owner === lease.ownerToken) {
              releaseOwnerIfExact(runTmux, paneId, lease.ownerToken, remaining);
              recovered = readOwnerAndHooks(runTmux, paneId, remaining());
            }
            evidence.finalOwnerAbsent = recovered.owner === "";
            evidence.finalHookAbsent = !recovered.hooks.some(({ name }) => name === lease.hookName);
          } catch {
            // Preserve the exact mutation failure; a retained owner fences the
            // next operation rather than allowing an unowned stale hook.
          }
          throw error;
        }
        evidence.retirementStage = "verification";
        evidence.finalHookAbsent = !after.hooks.some(({ name }) => name === lease.hookName);
        evidence.finalOwnerAbsent = after.owner === "";
        if (!evidence.finalHookAbsent || !evidence.finalOwnerAbsent) {
          try {
            after = parseOwnerAndHooks(
              runTmux(retirementCommands(paneId, lease.hookName), { timeout: remaining() }),
            );
            evidence.finalHookAbsent = !after.hooks.some(({ name }) => name === lease.hookName);
            evidence.finalOwnerAbsent = after.owner === "";
          } catch {
            // The first verification remains authoritative and the exact final
            // booleans below keep success fail closed.
          }
        }
        if (!evidence.finalHookAbsent) {
          if (evidence.finalOwnerAbsent) {
            try {
              runTmux(["set-option", "-po", "-t", paneId, OWNER_OPTION, lease.ownerToken], {
                timeout: remaining(),
              });
              evidence.finalOwnerAbsent = readOwner(runTmux, paneId, remaining()) === "";
            } catch {
              // A competing owner is also fail-closed; never overwrite it.
            }
          }
          fail("clipboard hook remained installed after retirement", evidence);
        }
        if (!evidence.finalOwnerAbsent) {
          fail("clipboard observation ownership remained after retirement", evidence);
        }
      },
      () => {
        evidence.retirementStage = "unlock";
      },
    );
    evidence.retirementStage = "complete";
    evidence.retirementExact = true;
    evidence.retirementElapsedMs = boundedElapsed(startedAt, now);
    return Object.freeze({ ...evidence });
  } catch (error) {
    evidence.retirementExact = false;
    evidence.retirementElapsedMs = boundedElapsed(startedAt, now);
    throw attachEvidence(error, evidence);
  }
}

export const CLIPBOARD_HOOK_SLOT_LIMIT = MAX_HOOK_SLOTS;
