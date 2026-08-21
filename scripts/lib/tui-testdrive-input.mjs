const MAX_JSON_BYTES = 96 * 1024;
export const MAX_PASTE_BYTES = 64 * 1024;
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;
export const MAX_CLIPBOARD_CALLBACK_ARTIFACTS = 4;
export const MAX_CLIPBOARD_AUTO_BUFFERS = 2_048;
export const DEFAULT_INPUT_TIMEOUT_MS = 2_000;
export const MAX_INPUT_TIMEOUT_MS = 5_000;
export const TESTDRIVE_INPUT_REPORTING_GRACE_MS = 500;
export const CLIPBOARD_RETIREMENT_RESERVE_MS = 650;
export const POST_INPUT_IDENTITY_RESERVE_MS = 200;
export const CLIPBOARD_OBSERVATION_RESERVE_MS = 400;
// Common-path clipboard arming performs two inventory reads plus seven
// lock/owner/hook operations. Each operation is already bounded at the tmux
// boundary; this aggregate slice prevents arming from consuming the release.
export const CLIPBOARD_ARM_BUDGET_MS = 900;
export const CLIPBOARD_RELEASE_BUDGET_MS = 200;
const CLIPBOARD_OBSERVATION_TIMEOUT = Symbol("clipboard-observation-timeout");
const CLIPBOARD_OBSERVATION_TIMEOUT_CODE = "TMUX_IDE_CLIPBOARD_OBSERVATION_TIMEOUT";

function clipboardObservationTimeoutError() {
  const error = new Error("Clipboard observation deadline elapsed");
  error.code = CLIPBOARD_OBSERVATION_TIMEOUT_CODE;
  Object.defineProperty(error, CLIPBOARD_OBSERVATION_TIMEOUT, { value: true });
  return error;
}

export function isClipboardObservationTimeout(error) {
  return (
    error?.code === CLIPBOARD_OBSERVATION_TIMEOUT_CODE &&
    error?.[CLIPBOARD_OBSERVATION_TIMEOUT] === true
  );
}

export function testdriveInputSupervisorTimeout(timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > MAX_INPUT_TIMEOUT_MS) {
    throw new Error("Test-drive input supervisor timeout is malformed");
  }
  return timeoutMs + TESTDRIVE_INPUT_REPORTING_GRACE_MS;
}

const ESC = "\u001b";
const DOCUMENT_KEYS = new Set(["version", "kind", "timeoutMs"]);
const KEYS_BY_KIND = {
  key: new Set([...DOCUMENT_KEYS, "key"]),
  "modified-key": new Set([...DOCUMENT_KEYS, "key", "modifiers"]),
  "control-key": new Set([...DOCUMENT_KEYS, "key"]),
  paste: new Set([...DOCUMENT_KEYS, "text"]),
  focus: new Set([...DOCUMENT_KEYS, "state"]),
  "application-mouse": new Set([...DOCUMENT_KEYS, "action", "x", "y", "button", "modifiers"]),
  "selection-drag": new Set([...DOCUMENT_KEYS, "from", "to", "contentRect"]),
  "copy-capture": DOCUMENT_KEYS,
};
const POINTER_KEYS = new Set(["x", "y"]);
const RECT_KEYS = new Set(["x", "y", "width", "height"]);
const MODIFIERS = new Set(["shift", "alt", "meta", "ctrl"]);
export const TESTDRIVE_INPUT_OBSERVATION_PREFIX = "TMUX_IDE_TESTDRIVE_OBSERVATION ";
const INPUT_FAILURE_SUBSTAGES = new Set([
  "resolve-identity",
  "preflight-identity",
  "capabilities",
  "select-mode-identity",
  "enter-select-mode",
  "wait-select-mode",
  "capture-before-selection",
  "drag-pre-release-identity",
  "drag-pre-release",
  "selection-style-wait",
  "pre-release-budget",
  "clipboard-arm",
  "release-identity",
  "selection-release",
  "input-delivery",
  "clipboard-wait",
  "clipboard-retirement",
  "post-input-identity",
  "postflight-identity",
]);
const INPUT_FAILURE_CAUSES = new Set([
  "deadline",
  "identity-mismatch",
  "operation-error",
  "timeout",
]);
const INPUT_FAILURE_BASE_KEYS = new Set([
  "operation",
  "kind",
  "substage",
  "completedPhases",
  "totalPhases",
  "completedTransportCalls",
  "totalTransportCalls",
  "completedPhysicalTransportCalls",
  "totalPhysicalTransportCalls",
  "cause",
  "elapsedMs",
  "remainingMs",
]);
const INPUT_FAILURE_CLIPBOARD_KEYS = new Set([
  ...INPUT_FAILURE_BASE_KEYS,
  "candidateAttempts",
  "occupiedCount",
  "retirementExact",
  "retirementStage",
  "retirementElapsedMs",
  "finalOwnerAbsent",
  "finalHookAbsent",
  "priorCopyCount",
  "newCopyCount",
  "clipboardIdentityExact",
  "callbackInvocations",
  "callbackStage",
  "callbackOutcome",
  "callbackInventoryPolls",
  "callbackHookElapsedMs",
  "callbackHookEntryLagMs",
  "callbackInventorySeenElapsedMs",
  "callbackArtifactPublishedElapsedMs",
  "callbackPreSaveElapsedMs",
  "callbackSaveElapsedMs",
  "callbackSaveOutcome",
  "callbackRetirementStage",
  "callbackRetirementElapsedMs",
  "callbackWorkSettled",
  "callbackLeaseInactive",
  "artifactObservedElapsedMs",
  "duplicateSettleElapsedMs",
  "callbackLastScanElapsedMs",
  "clipboardArmElapsedMs",
  "clipboardArmStartedElapsedMs",
  "clipboardArmBudgetAtStartMs",
  "clipboardArmRawRemainingAtStartMs",
  "clipboardReleaseElapsedMs",
  "clipboardWaitStartedElapsedMs",
  "clipboardReleaseBudgetAtStartMs",
  "clipboardReleaseIdentityElapsedMs",
  "clipboardReleaseTransportAttempted",
  "clipboardReleaseEffectOccurred",
  "clipboardReleaseLoadMarkerAcquired",
  "clipboardReleaseCleanupAttempted",
]);
const CLIPBOARD_CALLBACK_STAGES = new Set([
  "not-invoked",
  "hook-invoked",
  "inventory-pending",
  "inventory-seen",
  "save-pending",
  "artifact-published",
]);
const CLIPBOARD_CALLBACK_OUTCOMES = new Set(["pending", "seen", "published", "error"]);

export function clipboardCallbackStageOutcomeExact(stage, outcome) {
  if (!CLIPBOARD_CALLBACK_STAGES.has(stage) || !CLIPBOARD_CALLBACK_OUTCOMES.has(outcome))
    return false;
  if (outcome === "published" || stage === "artifact-published")
    return outcome === "published" && stage === "artifact-published";
  if (outcome === "seen") return stage === "inventory-seen";
  if (outcome === "pending")
    return ["not-invoked", "hook-invoked", "inventory-pending", "save-pending"].includes(stage);
  return [
    "not-invoked",
    "hook-invoked",
    "inventory-pending",
    "inventory-seen",
    "save-pending",
  ].includes(stage);
}

function inputError(message) {
  throw new Error(`Invalid test-drive input: ${message}`);
}

export function parseTestdriveInputFailureObservation(stderr, expectedKind) {
  if (typeof stderr !== "string" || Buffer.byteLength(stderr) > 64 * 1_024) return null;
  const matches = stderr
    .split("\n")
    .filter((line) => line.startsWith(TESTDRIVE_INPUT_OBSERVATION_PREFIX));
  if (matches.length !== 1) return null;
  try {
    const value = JSON.parse(matches[0].slice(TESTDRIVE_INPUT_OBSERVATION_PREFIX.length));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      ![INPUT_FAILURE_BASE_KEYS, INPUT_FAILURE_CLIPBOARD_KEYS].some(
        (keys) =>
          Object.keys(value).length === keys.size &&
          Object.keys(value).every((key) => keys.has(key)),
      ) ||
      value.operation !== "tui-testdrive-input" ||
      value.kind !== expectedKind ||
      !INPUT_FAILURE_SUBSTAGES.has(value.substage) ||
      ![value.completedPhases, value.completedTransportCalls].every(
        (count) => Number.isSafeInteger(count) && count >= 0 && count <= 32,
      ) ||
      ![value.totalPhases, value.totalTransportCalls].every(
        (count) => count === null || (Number.isSafeInteger(count) && count >= 0 && count <= 32),
      ) ||
      !Number.isSafeInteger(value.completedPhysicalTransportCalls) ||
      value.completedPhysicalTransportCalls < 0 ||
      value.completedPhysicalTransportCalls > 32 ||
      (value.totalPhysicalTransportCalls !== null &&
        (!Number.isSafeInteger(value.totalPhysicalTransportCalls) ||
          value.totalPhysicalTransportCalls < 0 ||
          value.totalPhysicalTransportCalls > 32)) ||
      !INPUT_FAILURE_CAUSES.has(value.cause) ||
      ![value.elapsedMs, value.remainingMs].every(
        (duration) =>
          Number.isSafeInteger(duration) && duration >= 0 && duration <= MAX_INPUT_TIMEOUT_MS,
      )
    )
      return null;
    const clipboardEvidence = "candidateAttempts" in value;
    if (
      clipboardEvidence &&
      (!Number.isSafeInteger(value.candidateAttempts) ||
        value.candidateAttempts < 0 ||
        value.candidateAttempts > 8 ||
        !Number.isSafeInteger(value.occupiedCount) ||
        value.occupiedCount < 0 ||
        value.occupiedCount > 8 ||
        typeof value.retirementExact !== "boolean" ||
        ![
          "not-started",
          "lock",
          "preflight",
          "mutation",
          "verification",
          "unlock",
          "complete",
        ].includes(value.retirementStage) ||
        !Number.isSafeInteger(value.retirementElapsedMs) ||
        value.retirementElapsedMs < 0 ||
        value.retirementElapsedMs > MAX_INPUT_TIMEOUT_MS ||
        typeof value.finalOwnerAbsent !== "boolean" ||
        typeof value.finalHookAbsent !== "boolean" ||
        ![value.priorCopyCount, value.newCopyCount].every(
          (count) =>
            count === null || (Number.isSafeInteger(count) && count >= 0 && count <= 2_048),
        ) ||
        typeof value.clipboardIdentityExact !== "boolean" ||
        !Number.isSafeInteger(value.callbackInvocations) ||
        value.callbackInvocations < 0 ||
        value.callbackInvocations > 2 ||
        !clipboardCallbackStageOutcomeExact(value.callbackStage, value.callbackOutcome) ||
        !["not-started", "pending", "complete", "error"].includes(value.callbackSaveOutcome) ||
        !["not-started", "already-exited", "abort-ack", "failed"].includes(
          value.callbackRetirementStage,
        ) ||
        !Number.isSafeInteger(value.callbackRetirementElapsedMs) ||
        value.callbackRetirementElapsedMs < 0 ||
        value.callbackRetirementElapsedMs > MAX_INPUT_TIMEOUT_MS ||
        typeof value.callbackWorkSettled !== "boolean" ||
        typeof value.callbackLeaseInactive !== "boolean" ||
        !Number.isSafeInteger(value.callbackInventoryPolls) ||
        value.callbackInventoryPolls < 0 ||
        value.callbackInventoryPolls > 2_048 ||
        ![
          value.callbackHookElapsedMs,
          value.callbackHookEntryLagMs,
          value.callbackInventorySeenElapsedMs,
          value.callbackArtifactPublishedElapsedMs,
          value.callbackPreSaveElapsedMs,
          value.callbackSaveElapsedMs,
          value.artifactObservedElapsedMs,
          value.duplicateSettleElapsedMs,
          value.callbackLastScanElapsedMs,
          value.clipboardArmElapsedMs,
          value.clipboardArmStartedElapsedMs,
          value.clipboardArmBudgetAtStartMs,
          value.clipboardArmRawRemainingAtStartMs,
          value.clipboardReleaseElapsedMs,
          value.clipboardWaitStartedElapsedMs,
          value.clipboardReleaseBudgetAtStartMs,
          value.clipboardReleaseIdentityElapsedMs,
        ].every(
          (duration) =>
            duration === null ||
            (Number.isSafeInteger(duration) && duration >= 0 && duration <= MAX_INPUT_TIMEOUT_MS),
        ) ||
        (value.clipboardArmStartedElapsedMs === null) !==
          (value.clipboardArmBudgetAtStartMs === null) ||
        (value.clipboardArmStartedElapsedMs === null) !==
          (value.clipboardArmRawRemainingAtStartMs === null) ||
        (value.clipboardArmBudgetAtStartMs !== null &&
          (value.clipboardArmBudgetAtStartMs < 90 ||
            value.clipboardArmBudgetAtStartMs > CLIPBOARD_ARM_BUDGET_MS)) ||
        ![
          value.clipboardReleaseTransportAttempted,
          value.clipboardReleaseLoadMarkerAcquired,
          value.clipboardReleaseCleanupAttempted,
        ].every((flag) => typeof flag === "boolean") ||
        ![true, false, null].includes(value.clipboardReleaseEffectOccurred))
    )
      return null;
    return Object.freeze({
      operation: value.operation,
      kind: value.kind,
      substage: value.substage,
      completedPhases: value.completedPhases,
      totalPhases: value.totalPhases,
      completedTransportCalls: value.completedTransportCalls,
      totalTransportCalls: value.totalTransportCalls,
      completedPhysicalTransportCalls: value.completedPhysicalTransportCalls,
      totalPhysicalTransportCalls: value.totalPhysicalTransportCalls,
      cause: value.cause,
      elapsedMs: value.elapsedMs,
      remainingMs: value.remainingMs,
      ...(clipboardEvidence
        ? {
            candidateAttempts: value.candidateAttempts,
            occupiedCount: value.occupiedCount,
            retirementExact: value.retirementExact,
            retirementStage: value.retirementStage,
            retirementElapsedMs: value.retirementElapsedMs,
            finalOwnerAbsent: value.finalOwnerAbsent,
            finalHookAbsent: value.finalHookAbsent,
            priorCopyCount: value.priorCopyCount,
            newCopyCount: value.newCopyCount,
            clipboardIdentityExact: value.clipboardIdentityExact,
            callbackInvocations: value.callbackInvocations,
            callbackStage: value.callbackStage,
            callbackOutcome: value.callbackOutcome,
            callbackInventoryPolls: value.callbackInventoryPolls,
            callbackHookElapsedMs: value.callbackHookElapsedMs,
            callbackHookEntryLagMs: value.callbackHookEntryLagMs,
            callbackInventorySeenElapsedMs: value.callbackInventorySeenElapsedMs,
            callbackArtifactPublishedElapsedMs: value.callbackArtifactPublishedElapsedMs,
            callbackPreSaveElapsedMs: value.callbackPreSaveElapsedMs,
            callbackSaveElapsedMs: value.callbackSaveElapsedMs,
            callbackSaveOutcome: value.callbackSaveOutcome,
            callbackRetirementStage: value.callbackRetirementStage,
            callbackRetirementElapsedMs: value.callbackRetirementElapsedMs,
            callbackWorkSettled: value.callbackWorkSettled,
            callbackLeaseInactive: value.callbackLeaseInactive,
            artifactObservedElapsedMs: value.artifactObservedElapsedMs,
            duplicateSettleElapsedMs: value.duplicateSettleElapsedMs,
            callbackLastScanElapsedMs: value.callbackLastScanElapsedMs,
            clipboardArmElapsedMs: value.clipboardArmElapsedMs,
            clipboardArmStartedElapsedMs: value.clipboardArmStartedElapsedMs,
            clipboardArmBudgetAtStartMs: value.clipboardArmBudgetAtStartMs,
            clipboardArmRawRemainingAtStartMs: value.clipboardArmRawRemainingAtStartMs,
            clipboardReleaseElapsedMs: value.clipboardReleaseElapsedMs,
            clipboardWaitStartedElapsedMs: value.clipboardWaitStartedElapsedMs,
            clipboardReleaseBudgetAtStartMs: value.clipboardReleaseBudgetAtStartMs,
            clipboardReleaseIdentityElapsedMs: value.clipboardReleaseIdentityElapsedMs,
            clipboardReleaseTransportAttempted: value.clipboardReleaseTransportAttempted,
            clipboardReleaseEffectOccurred: value.clipboardReleaseEffectOccurred,
            clipboardReleaseLoadMarkerAcquired: value.clipboardReleaseLoadMarkerAcquired,
            clipboardReleaseCleanupAttempted: value.clipboardReleaseCleanupAttempted,
          }
        : {}),
    });
  } catch {
    return null;
  }
}

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    inputError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) inputError(`${label} contains unknown field ${JSON.stringify(key)}`);
  }
  return value;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    inputError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function timeout(value) {
  if (value === undefined) return DEFAULT_INPUT_TIMEOUT_MS;
  return integer(value, "timeoutMs", 50, MAX_INPUT_TIMEOUT_MS);
}

function point(value, label) {
  const object = exactObject(value, POINTER_KEYS, label);
  return {
    x: integer(object.x, `${label}.x`, 0, 16_383),
    y: integer(object.y, `${label}.y`, 0, 16_383),
  };
}

function contentRect(value) {
  const object = exactObject(value, RECT_KEYS, "contentRect");
  return {
    x: integer(object.x, "contentRect.x", 0, 16_383),
    y: integer(object.y, "contentRect.y", 0, 16_383),
    width: integer(object.width, "contentRect.width", 1, 16_384),
    height: integer(object.height, "contentRect.height", 1, 16_384),
  };
}

function modifiers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MODIFIERS.size) {
    inputError("modifiers must be an array with at most three entries");
  }
  const result = [];
  for (const modifier of value) {
    if (typeof modifier !== "string" || !MODIFIERS.has(modifier)) {
      inputError(`unsupported modifier ${JSON.stringify(modifier)}`);
    }
    if (result.includes(modifier)) inputError(`duplicate modifier ${JSON.stringify(modifier)}`);
    result.push(modifier);
  }
  return result;
}

export function parseTestdriveInputDocument(source) {
  if (typeof source !== "string") inputError("JSON document must be a string");
  const bytes = Buffer.byteLength(source, "utf8");
  if (bytes === 0 || bytes > MAX_JSON_BYTES) {
    inputError(`JSON document must contain 1 through ${MAX_JSON_BYTES} UTF-8 bytes`);
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch {
    inputError("document is not valid JSON");
  }
  const object = exactObject(
    raw,
    new Set([...DOCUMENT_KEYS, ...Object.values(KEYS_BY_KIND).flatMap((keys) => [...keys])]),
    "document",
  );
  if (object.version !== 1) inputError("version must be 1");
  if (typeof object.kind !== "string") inputError("kind must be a string");
  const allowedKeys = KEYS_BY_KIND[object.kind];
  if (!allowedKeys) inputError(`unsupported kind ${JSON.stringify(object.kind)}`);
  exactObject(object, allowedKeys, `${object.kind} document`);
  const common = { version: 1, kind: object.kind, timeoutMs: timeout(object.timeoutMs) };

  switch (object.kind) {
    case "key": {
      if (typeof object.key !== "string" || !/^[\x20-\x7e]$/u.test(object.key))
        inputError("key must be one printable ASCII character");
      return { ...common, kind: "key", key: object.key };
    }
    case "control-key": {
      if (typeof object.key !== "string" || !/^[a-z]$/u.test(object.key))
        inputError("control-key key must be one lowercase ASCII letter");
      return { ...common, kind: "control-key", key: object.key };
    }
    case "modified-key": {
      if (!["left", "right", "up", "down"].includes(object.key))
        inputError("modified-key key must be left, right, up, or down");
      const requestedModifiers = modifiers(object.modifiers);
      if (requestedModifiers.length !== 1 || requestedModifiers[0] !== "meta")
        inputError("modified-key currently requires exactly the meta modifier");
      return {
        ...common,
        kind: "modified-key",
        key: object.key,
        modifiers: requestedModifiers,
      };
    }
    case "paste": {
      if (typeof object.text !== "string") inputError("paste text must be a string");
      if (object.text.includes(`${ESC}[201~`)) {
        inputError("paste text must not contain a bracketed-paste terminator");
      }
      for (let index = 0; index < object.text.length; index += 1) {
        const code = object.text.charCodeAt(index);
        if (code < 0xd800 || code > 0xdfff) continue;
        if (code <= 0xdbff && index + 1 < object.text.length) {
          const next = object.text.charCodeAt(index + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            index += 1;
            continue;
          }
        }
        inputError("paste text must not contain lone UTF-16 surrogates");
      }
      const textBytes = Buffer.byteLength(object.text, "utf8");
      if (textBytes === 0 || textBytes > MAX_PASTE_BYTES) {
        inputError(`paste text must contain 1 through ${MAX_PASTE_BYTES} UTF-8 bytes`);
      }
      return { ...common, kind: "paste", text: object.text };
    }
    case "focus":
      if (object.state !== "focus" && object.state !== "blur") {
        inputError("focus state must be focus or blur");
      }
      return { ...common, kind: "focus", state: object.state };
    case "application-mouse": {
      if (!["move", "down", "drag", "up", "click"].includes(object.action)) {
        inputError("application-mouse action must be move, down, drag, up, or click");
      }
      const button = object.button ?? "left";
      if (object.action === "move" && object.button !== undefined) {
        inputError("application-mouse move must not specify a button");
      }
      if (!["left", "middle", "right"].includes(button)) {
        inputError("application-mouse button must be left, middle, or right");
      }
      return {
        ...common,
        kind: "application-mouse",
        action: object.action,
        x: integer(object.x, "x", 0, 16_383),
        y: integer(object.y, "y", 0, 16_383),
        button,
        modifiers: modifiers(object.modifiers),
      };
    }
    case "selection-drag": {
      const from = point(object.from, "from");
      const to = point(object.to, "to");
      const rect = contentRect(object.contentRect);
      if (from.x === to.x && from.y === to.y) {
        inputError("selection-drag must span at least two terminal cells");
      }
      for (const [label, candidate] of [
        ["from", from],
        ["to", to],
      ]) {
        if (
          candidate.x < rect.x ||
          candidate.x >= rect.x + rect.width ||
          candidate.y < rect.y ||
          candidate.y >= rect.y + rect.height
        ) {
          inputError(`${label} must be inside contentRect`);
        }
      }
      return {
        ...common,
        kind: "selection-drag",
        from,
        to,
        contentRect: rect,
      };
    }
    case "copy-capture":
      return { ...common, kind: "copy-capture" };
    default:
      inputError(`unsupported kind ${JSON.stringify(object.kind)}`);
  }
}

function requireCapability(capabilities, name, operation) {
  if (capabilities?.[name] !== true) {
    throw new Error(`Terminal does not support ${operation}`);
  }
}

function assertGeometry(pointValue, geometry, label) {
  if (
    !geometry ||
    !Number.isInteger(geometry.cols) ||
    !Number.isInteger(geometry.rows) ||
    geometry.cols < 1 ||
    geometry.rows < 1
  ) {
    throw new Error("Live host geometry is unavailable");
  }
  if (pointValue.x >= geometry.cols || pointValue.y >= geometry.rows) {
    throw new Error(
      `${label} ${pointValue.x},${pointValue.y} is outside host geometry ${geometry.cols}x${geometry.rows}`,
    );
  }
}

function modifierCode(values) {
  return (
    (values.includes("shift") ? 4 : 0) +
    (values.includes("alt") || values.includes("meta") ? 8 : 0) +
    (values.includes("ctrl") ? 16 : 0)
  );
}

function mouseSequence(action, x, y, button = "left", values = []) {
  const buttonCode = { left: 0, middle: 1, right: 2 }[button];
  const code =
    action === "move"
      ? 35 + modifierCode(values)
      : action === "drag"
        ? 32 + buttonCode + modifierCode(values)
        : buttonCode + modifierCode(values);
  return `${ESC}[<${code};${x + 1};${y + 1}${action === "up" ? "m" : "M"}`;
}

function selectionPhases(from, to) {
  const phases = [{ bytes: mouseSequence("down", from.x, from.y), delayMs: 12 }];
  const distance = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  const steps = Math.max(1, Math.min(24, distance));
  for (let step = 1; step <= steps; step += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * step) / steps);
    const y = Math.round(from.y + ((to.y - from.y) * step) / steps);
    phases.push({ bytes: mouseSequence("drag", x, y), delayMs: 4 });
  }
  phases.push({ bytes: mouseSequence("up", to.x, to.y), delayMs: 0 });
  return phases;
}

export function selectionInputPhases(from, to) {
  return selectionPhases(from, to);
}

export function translateTestdriveInput(command, { capabilities, geometry } = {}) {
  switch (command.kind) {
    case "key":
      return { phases: [{ bytes: command.key, delayMs: 0 }] };
    case "control-key":
      return {
        phases: [{ bytes: String.fromCharCode(command.key.charCodeAt(0) - 96), delayMs: 0 }],
      };
    case "modified-key": {
      const final = { up: "A", down: "B", right: "C", left: "D" }[command.key];
      return { phases: [{ bytes: `${ESC}[1;3${final}`, delayMs: 0 }] };
    }
    case "paste":
      requireCapability(capabilities, "bracketedPaste", "bracketed paste");
      return { phases: [{ bytes: `${ESC}[200~${command.text}${ESC}[201~`, delayMs: 0 }] };
    case "focus":
      requireCapability(capabilities, "focusEvents", "host focus events");
      return {
        phases: [{ bytes: command.state === "focus" ? `${ESC}[I` : `${ESC}[O`, delayMs: 0 }],
      };
    case "application-mouse": {
      requireCapability(capabilities, "sgrMouse", "SGR application mouse events");
      assertGeometry(command, geometry, "mouse coordinate");
      const downOrAction = mouseSequence(
        command.action === "click" ? "down" : command.action,
        command.x,
        command.y,
        command.button,
        command.modifiers,
      );
      return {
        phases:
          command.action === "click"
            ? [
                { bytes: downOrAction, delayMs: 12 },
                {
                  bytes: mouseSequence(
                    "up",
                    command.x,
                    command.y,
                    command.button,
                    command.modifiers,
                  ),
                  delayMs: 0,
                },
              ]
            : [{ bytes: downOrAction, delayMs: 0 }],
      };
    }
    case "selection-drag":
      requireCapability(capabilities, "sgrMouse", "SGR selection drag");
      assertGeometry(command.from, geometry, "selection start");
      assertGeometry(command.to, geometry, "selection end");
      if (
        command.contentRect.x + command.contentRect.width > geometry.cols ||
        command.contentRect.y + command.contentRect.height > geometry.rows
      ) {
        throw new Error("selection contentRect is outside live host geometry");
      }
      return { phases: selectionPhases(command.from, command.to) };
    case "copy-capture":
      requireCapability(capabilities, "clipboardCapture", "clipboard capture");
      return { phases: [{ bytes: "\u0003", delayMs: 0 }], captureClipboard: true };
    default:
      throw new Error(`Unsupported parsed test-drive input kind ${JSON.stringify(command.kind)}`);
  }
}

export function fullTerminalCapabilities() {
  return {
    bracketedPaste: true,
    focusEvents: true,
    sgrMouse: true,
    clipboardCapture: true,
  };
}

export function exactPtyPasteBufferArgs(bufferName, target) {
  if (!/^testdrive-input-[A-Za-z0-9-]+$/u.test(bufferName)) {
    throw new Error("Invalid ephemeral test-drive buffer name");
  }
  if (!/^%[0-9]+$/u.test(target)) {
    throw new Error("Invalid exact test-drive host pane target");
  }
  // -S disables vis(3) control-byte sanitizing and -r preserves LF bytes.
  // Deliberately omit -p: the caller already supplied any bracket markers.
  return ["paste-buffer", "-d", "-r", "-S", "-b", bufferName, "-t", target];
}

function applySgr(style, parameters) {
  const next = { ...style };
  const values = parameters.length === 0 ? [0] : parameters;
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index];
    if (code === 0) {
      next.fg = "default";
      next.bg = "default";
    } else if (code === 39) next.fg = "default";
    else if (code === 49) next.bg = "default";
    else if (code >= 30 && code <= 37) next.fg = `palette:${code - 30}`;
    else if (code >= 90 && code <= 97) next.fg = `palette:${code - 90 + 8}`;
    else if (code >= 40 && code <= 47) next.bg = `palette:${code - 40}`;
    else if (code >= 100 && code <= 107) next.bg = `palette:${code - 100 + 8}`;
    else if (code === 38 || code === 48) {
      const channel = code === 38 ? "fg" : "bg";
      if (values[index + 1] === 5 && Number.isInteger(values[index + 2])) {
        next[channel] = `palette:${values[index + 2]}`;
        index += 2;
      } else if (
        values[index + 1] === 2 &&
        values.slice(index + 2, index + 5).every(Number.isInteger)
      ) {
        next[channel] = `rgb:${values.slice(index + 2, index + 5).join(",")}`;
        index += 4;
      }
    }
  }
  return next;
}

export function decodeTmuxCaptureCellStyles(frame, geometry) {
  const rows = Array.from({ length: geometry.rows }, () =>
    Array.from({ length: geometry.cols }, () => ({ fg: "default", bg: "default" })),
  );
  let row = 0;
  let col = 0;
  let style = { fg: "default", bg: "default" };
  for (let index = 0; index < frame.length && row < geometry.rows; index += 1) {
    if (frame[index] === ESC && frame[index + 1] === "[") {
      let end = index + 2;
      while (end < frame.length && !/[A-Za-z]/u.test(frame[end])) end += 1;
      if (frame[end] === "m") {
        const raw = frame.slice(index + 2, end);
        if (!/^[0-9;]*$/u.test(raw)) throw new Error("Unsupported tmux SGR capture encoding");
        style = applySgr(style, raw === "" ? [] : raw.split(";").map(Number));
      }
      index = end;
      continue;
    }
    if (frame[index] === "\n") {
      row += 1;
      col = 0;
      continue;
    }
    if (frame[index] === "\r") continue;
    const codePoint = String.fromCodePoint(frame.codePointAt(index));
    if (codePoint.length === 2) index += 1;
    const width = stringWidth(codePoint);
    if (width < 1) continue;
    for (let offset = 0; offset < width && col + offset < geometry.cols; offset += 1) {
      rows[row][col + offset] = { ...style };
    }
    col += width;
  }
  return rows;
}

function dragSpanCells(from, to, content) {
  const localFrom = { x: from.x - content.x, y: from.y - content.y };
  const localTo = { x: to.x - content.x, y: to.y - content.y };
  const ordered =
    localFrom.y < localTo.y || (localFrom.y === localTo.y && localFrom.x <= localTo.x)
      ? { start: localFrom, end: localTo }
      : { start: localTo, end: localFrom };
  const cells = [];
  for (let row = ordered.start.y; row <= ordered.end.y; row += 1) {
    const first = row === ordered.start.y ? ordered.start.x : 0;
    const last = row === ordered.end.y ? ordered.end.x : content.width - 1;
    for (let col = first; col <= last; col += 1) {
      cells.push({ row: content.y + row, col: content.x + col });
    }
  }
  return cells;
}

export function proveRendererSelectionStyleDelta(
  beforeFrame,
  afterFrame,
  from,
  to,
  geometry,
  content,
) {
  const before = decodeTmuxCaptureCellStyles(beforeFrame, geometry);
  const after = decodeTmuxCaptureCellStyles(afterFrame, geometry);
  const span = dragSpanCells(from, to, content);
  const swapped = span.filter(({ row, col }) => {
    const prior = before[row]?.[col];
    const next = after[row]?.[col];
    return prior && next && prior.fg === next.bg && prior.bg === next.fg && prior.fg !== prior.bg;
  });
  const requested = new Set(span.map(({ row, col }) => `${row}:${col}`));
  const changed = [];
  for (let row = 0; row < geometry.rows; row += 1) {
    for (let col = 0; col < geometry.cols; col += 1) {
      const prior = before[row]?.[col];
      const next = after[row]?.[col];
      if (prior && next && (prior.fg !== next.fg || prior.bg !== next.bg))
        changed.push({ row, col });
    }
  }
  const extra = changed.filter(({ row, col }) => !requested.has(`${row}:${col}`));
  if (swapped.length < 2 || swapped.length !== span.length || extra.length !== 0) {
    throw new Error(
      `OpenTUI selection style proof covered ${swapped.length}/${span.length} requested cells with ${extra.length} extra changed cells`,
    );
  }
  return { cells: swapped.length, extraChangedCells: 0 };
}

export function deliverExactHostBytes({ identity, bytes, timeoutMs, bufferName, runTmux, clock }) {
  if (typeof bytes !== "string" || Buffer.byteLength(bytes, "utf8") === 0) {
    throw new Error("test-drive input sequence must contain bytes");
  }
  const deadline = clock.now() + timeoutMs;
  const cleanupReserve = Math.min(25, Math.max(5, Math.floor(timeoutMs / 4)));
  const workRemaining = () => {
    const value = Math.floor(deadline - clock.now() - cleanupReserve);
    if (value < 1) throw new Error("Exact PTY delivery exceeded its absolute deadline");
    return value;
  };
  const cleanupRemaining = () => Math.max(1, Math.floor(deadline - clock.now()));
  const loadMarker = "TMUX_IDE_TESTDRIVE_BUFFER_LOADED";
  const transaction = [
    "load-buffer",
    "-b",
    bufferName,
    "-",
    ";",
    "display-message",
    "-p",
    loadMarker,
    ";",
    ...exactPtyPasteBufferArgs(bufferName, identity.paneId),
  ];
  try {
    const output = runTmux(transaction, {
      input: bytes,
      timeout: workRemaining(),
    });
    if (String(output ?? "").trim() !== loadMarker) {
      throw new Error("Exact PTY delivery transaction proof is malformed");
    }
    return Object.freeze({
      physicalCalls: 1,
      transportAttempted: true,
      effectOccurred: true,
      loadMarkerAcquired: true,
      cleanupAttempted: false,
    });
  } catch (error) {
    // The marker is emitted only after load-buffer has acquired this
    // operation's unguessable buffer name. A later paste failure therefore
    // owns exactly one bounded delete; a load failure must not delete a name
    // it never acquired.
    const loadMarkerAcquired = String(error?.stdout ?? "").trim() === loadMarker;
    let cleanupAttempted = false;
    if (loadMarkerAcquired) {
      cleanupAttempted = true;
      try {
        runTmux(["delete-buffer", "-b", bufferName], { timeout: cleanupRemaining() });
      } catch {
        // The operation still fails by its original error; cleanup is bounded
        // and best-effort, but is never skipped.
      }
    }
    if (error && typeof error === "object") {
      error.deliveryEvidence = Object.freeze({
        transportAttempted: true,
        effectOccurred: loadMarkerAcquired ? null : false,
        loadMarkerAcquired,
        cleanupAttempted,
      });
    }
    throw error;
  }
}

export async function reapOwnedClipboardCallback({
  isActive,
  requestAbort,
  isAcknowledged,
  sleep,
  clock,
  timeoutMs,
}) {
  if (
    typeof isActive !== "function" ||
    typeof requestAbort !== "function" ||
    typeof isAcknowledged !== "function" ||
    typeof sleep !== "function" ||
    typeof clock?.now !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_INPUT_TIMEOUT_MS
  ) {
    throw new Error("Clipboard callback retirement input is malformed");
  }
  const startedAt = clock.now();
  const deadline = startedAt + timeoutMs;
  const elapsed = () =>
    Math.min(MAX_INPUT_TIMEOUT_MS, Math.max(0, Math.round(clock.now() - startedAt)));
  const failed = (cause) => {
    const error = new Error(`Clipboard callback cooperative retirement failed: ${cause}`);
    error.clipboardCallbackRetirement = Object.freeze({
      callbackRetirementStage: "failed",
      callbackRetirementElapsedMs: elapsed(),
      callbackWorkSettled: false,
      callbackLeaseInactive: false,
    });
    return error;
  };
  try {
    if (!isActive())
      return Object.freeze({
        callbackRetirementStage: "already-exited",
        callbackRetirementElapsedMs: 0,
        callbackWorkSettled: true,
        callbackLeaseInactive: true,
      });
    await requestAbort();
    while (clock.now() < deadline) {
      const active = isActive();
      const acknowledged = isAcknowledged();
      if (!active) {
        return Object.freeze({
          callbackRetirementStage: acknowledged ? "abort-ack" : "already-exited",
          callbackRetirementElapsedMs: elapsed(),
          callbackWorkSettled: true,
          callbackLeaseInactive: true,
        });
      }
      await sleep(Math.min(10, Math.max(1, deadline - clock.now())));
    }
    throw failed("deadline");
  } catch (error) {
    if (error?.clipboardCallbackRetirement) throw error;
    throw failed("control-channel");
  }
}

export async function watchClipboardCallbackAbort({
  controlToken,
  readRequest,
  abort,
  isSettled,
  sleep,
}) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(controlToken ?? "") ||
    typeof readRequest !== "function" ||
    typeof abort !== "function" ||
    typeof isSettled !== "function" ||
    typeof sleep !== "function"
  ) {
    throw new Error("Clipboard callback abort watcher input is malformed");
  }
  while (!isSettled()) {
    const request = readRequest();
    if (request !== null) {
      if (
        request?.version !== 1 ||
        Object.keys(request).length !== 3 ||
        request.kind !== "abort" ||
        request.controlToken !== controlToken
      ) {
        throw new Error("Clipboard callback abort request identity is malformed");
      }
      abort();
      return true;
    }
    await sleep(5);
  }
  return false;
}

export function validateClipboardObservationEvents(events, expected) {
  if (!Array.isArray(events) || events.length !== 1) {
    throw new Error(
      events?.length > 1
        ? "Multiple clipboard events matched one test-drive operation"
        : "Missing pane-scoped clipboard event",
    );
  }
  const event = exactObject(
    events[0],
    new Set(["version", "nonce", "paneId", "bufferName", "bytes", "sha256"]),
    "clipboard event",
  );
  if (
    event.version !== 1 ||
    event.nonce !== expected.nonce ||
    event.paneId !== expected.paneId ||
    typeof event.bufferName !== "string" ||
    !/^buffer[0-9]+$/u.test(event.bufferName) ||
    !Number.isInteger(event.bytes) ||
    event.bytes < 1 ||
    event.bytes > MAX_CLIPBOARD_BYTES ||
    typeof event.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(event.sha256)
  ) {
    throw new Error("Clipboard hook published malformed or unrelated evidence");
  }
  return { bytes: event.bytes, sha256: event.sha256 };
}

export function enforceClipboardCallbackCap(artifactIds) {
  const unique = new Set(artifactIds);
  if (unique.size > MAX_CLIPBOARD_CALLBACK_ARTIFACTS) {
    throw new Error(
      `Clipboard callback cap exceeded (${unique.size}/${MAX_CLIPBOARD_CALLBACK_ARTIFACTS})`,
    );
  }
  return unique.size;
}

export function parseClipboardCallbackState(value, expected) {
  const saveTimingExact =
    value?.stage === "save-pending" || value?.stage === "artifact-published"
      ? Number.isSafeInteger(value.preSaveElapsedMs) &&
        value.preSaveElapsedMs >= value.inventorySeenElapsedMs &&
        (value.stage === "artifact-published"
          ? value.saveOutcome === "complete" &&
            Number.isSafeInteger(value.saveElapsedMs) &&
            value.saveElapsedMs >= 0 &&
            value.preSaveElapsedMs + value.saveElapsedMs <= value.artifactPublishedElapsedMs
          : ["pending", "error"].includes(value.saveOutcome) &&
            (value.saveElapsedMs === null ||
              (Number.isSafeInteger(value.saveElapsedMs) && value.saveElapsedMs >= 0)))
      : value?.preSaveElapsedMs === null &&
        value?.saveElapsedMs === null &&
        value?.saveOutcome === "not-started";
  const timingExact =
    Number.isSafeInteger(value?.hookElapsedMs) &&
    value.hookElapsedMs >= 0 &&
    value.hookElapsedMs <= MAX_INPUT_TIMEOUT_MS &&
    (["inventory-seen", "save-pending", "artifact-published"].includes(value?.stage)
      ? Number.isSafeInteger(value.inventorySeenElapsedMs) &&
        value.inventorySeenElapsedMs >= value.hookElapsedMs
      : value?.inventorySeenElapsedMs === null) &&
    (value?.stage === "artifact-published"
      ? Number.isSafeInteger(value.artifactPublishedElapsedMs) &&
        value.artifactPublishedElapsedMs >= value.inventorySeenElapsedMs
      : value?.artifactPublishedElapsedMs === null);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 13 ||
    value.version !== 1 ||
    value.nonce !== expected?.nonce ||
    value.paneId !== expected?.paneId ||
    value.stage === "not-invoked" ||
    !clipboardCallbackStageOutcomeExact(value.stage, value.outcome) ||
    !Number.isSafeInteger(value.inventoryPolls) ||
    value.inventoryPolls < 0 ||
    value.inventoryPolls > 2_048 ||
    !Number.isSafeInteger(value.hookEntryLagMs) ||
    value.hookEntryLagMs < 0 ||
    value.hookEntryLagMs > MAX_INPUT_TIMEOUT_MS ||
    !timingExact ||
    !saveTimingExact ||
    ![
      value.hookElapsedMs,
      value.inventorySeenElapsedMs,
      value.artifactPublishedElapsedMs,
      value.preSaveElapsedMs,
      value.saveElapsedMs,
    ].every(
      (duration) =>
        duration === null ||
        (Number.isSafeInteger(duration) && duration >= 0 && duration <= MAX_INPUT_TIMEOUT_MS),
    )
  ) {
    throw new Error("Clipboard callback state is malformed or unrelated");
  }
  return Object.freeze({
    callbackStage: value.stage,
    callbackOutcome: value.outcome,
    callbackInventoryPolls: value.inventoryPolls,
    callbackHookElapsedMs: value.hookElapsedMs,
    callbackHookEntryLagMs: value.hookEntryLagMs,
    callbackInventorySeenElapsedMs: value.inventorySeenElapsedMs,
    callbackArtifactPublishedElapsedMs: value.artifactPublishedElapsedMs,
    callbackPreSaveElapsedMs: value.preSaveElapsedMs,
    callbackSaveElapsedMs: value.saveElapsedMs,
    callbackSaveOutcome: value.saveOutcome,
  });
}

export function parseClipboardAutoBufferInventory(source, bufferLimit) {
  if (
    typeof source !== "string" ||
    Buffer.byteLength(source, "utf8") > 256 * 1_024 ||
    !Number.isSafeInteger(bufferLimit) ||
    bufferLimit < 2 ||
    bufferLimit > MAX_CLIPBOARD_AUTO_BUFFERS
  ) {
    throw new Error("Clipboard automatic buffer inventory is malformed or over cap");
  }
  const buffers = [];
  const names = new Set();
  for (const line of source.split("\n").filter(Boolean)) {
    const fields = line.split("\t");
    if (fields.length !== 3) throw new Error("Clipboard buffer inventory row is malformed");
    const [name, sizeText, created] = fields;
    if (!/^buffer[0-9]+$/u.test(name)) continue;
    const size = Number(sizeText);
    if (
      names.has(name) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_CLIPBOARD_BYTES ||
      typeof created !== "string" ||
      created.length < 1 ||
      created.length > 64 ||
      [...created].some((character) => {
        const code = character.codePointAt(0);
        return code < 0x20 || code === 0x7f;
      })
    ) {
      throw new Error("Clipboard automatic buffer inventory entry is malformed");
    }
    names.add(name);
    buffers.push(Object.freeze({ name, size, created }));
  }
  if (buffers.length > bufferLimit || buffers.length > MAX_CLIPBOARD_AUTO_BUFFERS) {
    throw new Error("Clipboard automatic buffer inventory exceeds buffer-limit");
  }
  // tmux paste_walk() lists newest first, so the last automatic entry is the
  // exact eviction candidate when paste_add() reaches buffer-limit.
  const oldestAutoName = buffers.at(-1)?.name ?? null;
  return Object.freeze({
    bufferLimit,
    oldestAutoName,
    buffers: Object.freeze(
      [...buffers].sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
      ),
    ),
  });
}

const CLIPBOARD_LIMIT_MARKER = "__TMUX_IDE_CLIPBOARD_LIMIT__";
const CLIPBOARD_BUFFERS_MARKER = "__TMUX_IDE_CLIPBOARD_BUFFERS__";
const CLIPBOARD_INVENTORY_END_MARKER = "__TMUX_IDE_CLIPBOARD_INVENTORY_END__";

function clipboardInventoryTransactionCommands({ runTmux, timeoutMs, save }) {
  if (
    typeof runTmux !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_INPUT_TIMEOUT_MS ||
    (save !== null &&
      (typeof save !== "object" ||
        Array.isArray(save) ||
        Object.keys(save).length !== 2 ||
        !/^buffer[0-9]+$/u.test(save.bufferName) ||
        typeof save.path !== "string" ||
        save.path.length < 1 ||
        save.path.length > 4_096 ||
        [...save.path].some((character) => {
          const code = character.codePointAt(0);
          return code < 0x20 || code === 0x7f;
        })))
  ) {
    throw new Error("Clipboard inventory transaction input is malformed");
  }
  return [
    ...(save ? ["save-buffer", "-b", save.bufferName, save.path, ";"] : []),
    "display-message",
    "-p",
    CLIPBOARD_LIMIT_MARKER,
    ";",
    "show-options",
    "-gv",
    "buffer-limit",
    ";",
    "display-message",
    "-p",
    CLIPBOARD_BUFFERS_MARKER,
    ";",
    "list-buffers",
    "-F",
    "#{buffer_name}\t#{buffer_size}\t#{buffer_created}",
    ";",
    "display-message",
    "-p",
    CLIPBOARD_INVENTORY_END_MARKER,
  ];
}

function parseClipboardInventoryTransactionOutput({ output, noBuffers }) {
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 256 * 1_024) {
    throw new Error("Clipboard inventory transaction exceeded its output cap");
  }
  const lines = output.replace(/\n$/u, "").split("\n");
  const limitAt = lines.indexOf(CLIPBOARD_LIMIT_MARKER);
  const buffersAt = lines.indexOf(CLIPBOARD_BUFFERS_MARKER);
  const endAt = lines.indexOf(CLIPBOARD_INVENTORY_END_MARKER);
  if (
    limitAt !== 0 ||
    buffersAt !== 2 ||
    (!noBuffers &&
      (endAt < 3 ||
        endAt !== lines.length - 1 ||
        lines.lastIndexOf(CLIPBOARD_INVENTORY_END_MARKER) !== endAt)) ||
    (noBuffers && (endAt >= 0 || lines.length !== 3))
  ) {
    throw new Error("Clipboard inventory transaction output is malformed");
  }
  const bufferLimit = Number(lines[1]);
  const source = noBuffers ? "" : lines.slice(3, endAt).join("\n");
  return Object.freeze({
    source,
    inventory: parseClipboardAutoBufferInventory(source, bufferLimit),
  });
}

export function readClipboardAutoBufferInventoryTransaction({ runTmux, timeoutMs, save = null }) {
  const commands = clipboardInventoryTransactionCommands({ runTmux, timeoutMs, save });
  let output;
  let noBuffers = false;
  try {
    output = runTmux(commands, { timeout: timeoutMs });
  } catch (error) {
    if (!save && /no buffers/iu.test(String(error?.stderr ?? error?.message ?? ""))) {
      output = String(error?.stdout ?? "");
      noBuffers = true;
    } else {
      throw error;
    }
  }
  return parseClipboardInventoryTransactionOutput({ output, noBuffers });
}

export async function readClipboardAutoBufferInventoryTransactionAsync({
  runTmux,
  timeoutMs,
  save = null,
  signal,
}) {
  const commands = clipboardInventoryTransactionCommands({ runTmux, timeoutMs, save });
  let output;
  let noBuffers = false;
  try {
    output = await runTmux(commands, { timeout: timeoutMs, signal });
  } catch (error) {
    if (!save && /no buffers/iu.test(String(error?.stderr ?? error?.message ?? ""))) {
      output = String(error?.stdout ?? "");
      noBuffers = true;
    } else {
      throw error;
    }
  }
  return parseClipboardInventoryTransactionOutput({ output, noBuffers });
}

export function assessClipboardAutoBufferDelta(baseline, current) {
  if (
    baseline?.bufferLimit !== current?.bufferLimit ||
    !Array.isArray(baseline?.buffers) ||
    !Array.isArray(current?.buffers)
  ) {
    throw new Error("Clipboard inventory lease does not match current buffer-limit");
  }
  const before = new Map(baseline.buffers.map((entry) => [entry.name, entry]));
  const after = new Map(current.buffers.map((entry) => [entry.name, entry]));
  const added = current.buffers.filter((entry) => !before.has(entry.name));
  const removed = baseline.buffers.filter((entry) => !after.has(entry.name));
  const retainedChanged = baseline.buffers.some((entry) => {
    const next = after.get(entry.name);
    return next && (next.size !== entry.size || next.created !== entry.created);
  });
  if (!retainedChanged && added.length === 0 && removed.length === 0) {
    return Object.freeze({ status: "pending" });
  }
  const atLimit = baseline.buffers.length === baseline.bufferLimit;
  const exactRotation =
    atLimit &&
    removed.length === 1 &&
    removed[0].name === baseline.oldestAutoName &&
    current.buffers.length === baseline.buffers.length;
  const exactAppend =
    !atLimit && removed.length === 0 && current.buffers.length === baseline.buffers.length + 1;
  if (
    retainedChanged ||
    added.length !== 1 ||
    (!exactAppend && !exactRotation) ||
    added[0].size < 1
  ) {
    throw new Error("Clipboard automatic buffer inventory changed ambiguously");
  }
  return Object.freeze({ status: "captured", buffer: added[0] });
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function buildClipboardPaneHookCommand({
  nodePath,
  scriptPath,
  runtimeDir,
  socketPath,
  nonce,
  paneId,
}) {
  const observer = [
    "env",
    ...(socketPath ? [`TMUX_IDE_TESTDRIVE_HOST_SOCKET_PATH=${shellQuote(socketPath)}`] : []),
    `TMUX_IDE_TESTDRIVE_RUNTIME_DIR=${shellQuote(runtimeDir)}`,
    shellQuote(nodePath),
    shellQuote(scriptPath),
    "clipboard-observe",
    shellQuote(nonce),
    shellQuote(paneId),
    // set-hook is called through direct argv, so this format is stored and is
    // expanded only when the pane hook runs. Doubling is required only when a
    // surrounding tmux command/config parse would otherwise consume it.
    "#{q:hook_pane}",
  ].join(" ");
  // JSON string escaping is also valid tmux double-quoted command syntax for
  // this bounded ASCII command. tmux's `show-hooks` retains this canonical
  // representation, which lets the owner verify exact command identity.
  return `run-shell ${JSON.stringify(observer)}`;
}

export async function waitForClipboardObservation({
  listArtifacts,
  readEvent,
  expected,
  clock,
  sleep,
  timeoutMs,
  quietMs = 40,
}) {
  const deadline = clock.now() + timeoutMs;
  let firstCompleteAt = null;
  let retained = null;
  const scan = () => {
    const artifactIds = [...new Set(listArtifacts())];
    if (artifactIds.length > 1) {
      throw new Error("Multiple clipboard events matched one test-drive operation");
    }
    if (artifactIds.length !== 1) return null;
    const event = readEvent(artifactIds[0]);
    if (!event) return null;
    if (event.bufferName !== artifactIds[0]) {
      throw new Error("Clipboard event buffer identity does not match its atomic artifact");
    }
    return Object.freeze({
      artifactId: artifactIds[0],
      clipboard: Object.freeze(validateClipboardObservationEvents([event], expected)),
    });
  };
  while (clock.now() < deadline) {
    const validated = scan();
    if (validated) {
      retained ??= validated;
      firstCompleteAt ??= clock.now();
      if (clock.now() - firstCompleteAt >= quietMs) return retained;
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    await sleep(Math.min(10, remaining));
  }
  // A callback may atomically publish while the final bounded sleep reaches
  // the deadline. Sample once more so the owned retirement phase can fence it.
  const edge = scan();
  if (edge && quietMs === 0) return retained ?? edge;
  throw clipboardObservationTimeoutError();
}

export async function settleClipboardObservationAfterRetirement({
  listArtifacts,
  readCallbackEvidence,
  retainedBufferName,
  clock,
  sleep,
  timeoutMs,
  quietMs = 40,
}) {
  const startedAt = clock.now();
  const deadline = startedAt + timeoutMs;
  const exact = (final = false) => {
    const artifacts = [...new Set(listArtifacts())];
    const callback = readCallbackEvidence();
    const callbackPublished =
      callback?.callbackInvocations === 1 &&
      callback.callbackStage === "artifact-published" &&
      callback.callbackOutcome === "published" &&
      Number.isSafeInteger(callback.callbackInventoryPolls) &&
      callback.callbackInventoryPolls >= 1 &&
      callback.callbackInventoryPolls <= 2_048;
    const callbackImpossible =
      callback?.callbackInvocations > 1 || callback?.callbackOutcome === "error";
    if (
      artifacts.length !== 1 ||
      artifacts[0] !== retainedBufferName ||
      callbackImpossible ||
      (final && !callbackPublished)
    ) {
      throw new Error("Clipboard observation changed during post-retirement settlement");
    }
  };
  exact();
  while (clock.now() - startedAt < quietMs) {
    const remaining = deadline - clock.now();
    if (remaining < 1) throw new Error("Clipboard duplicate settlement exceeded its deadline");
    await sleep(Math.min(10, quietMs - (clock.now() - startedAt), remaining));
    exact();
  }
  exact(true);
  return Math.min(MAX_INPUT_TIMEOUT_MS, Math.max(0, Math.round(clock.now() - startedAt)));
}

export async function executeTestdriveInputOperation(command, port) {
  const startedAt = port.clock.now();
  const deadline = startedAt + command.timeoutMs;
  const clipboardOperation = command.kind === "selection-drag" || command.kind === "copy-capture";
  const cleanupReserveMs = clipboardOperation
    ? Math.min(CLIPBOARD_RETIREMENT_RESERVE_MS, Math.max(10, Math.floor(command.timeoutMs / 4)))
    : Math.min(100, Math.max(10, Math.floor(command.timeoutMs / 4)));
  const workRemaining = () => {
    const value = Math.floor(deadline - port.clock.now() - cleanupReserveMs);
    if (value < 1) throw new Error(`Test-drive ${command.kind} exceeded its absolute deadline`);
    return value;
  };
  const postInputIdentityReserveMs = clipboardOperation
    ? Math.min(POST_INPUT_IDENTITY_RESERVE_MS, Math.max(10, Math.floor(command.timeoutMs / 10)))
    : 0;
  let postInputIdentityPending = clipboardOperation;
  const clipboardObservationReserveMs = clipboardOperation
    ? Math.min(CLIPBOARD_OBSERVATION_RESERVE_MS, Math.max(40, Math.floor(command.timeoutMs / 6)))
    : 0;
  let clipboardObservationPending = clipboardOperation;
  const deliveryRemaining = () => {
    const pendingFinalizationReserve = Math.max(
      postInputIdentityPending ? postInputIdentityReserveMs : 0,
      clipboardObservationPending ? clipboardObservationReserveMs : 0,
    );
    const value = workRemaining() - pendingFinalizationReserve;
    if (value < 1) throw new Error(`Test-drive ${command.kind} exceeded its pre-identity deadline`);
    return value;
  };
  const cleanupRemaining = () => Math.max(1, Math.floor(deadline - port.clock.now()));
  let observation = null;
  let identity = null;
  let bytesInjected = 0;
  let phases = 0;
  let transportCalls = 0;
  let physicalTransportCalls = 0;
  let totalPhases = null;
  let totalTransportCalls = null;
  let failureSubstage = "resolve-identity";
  let selectionStyle = null;
  let clipboard = null;
  let operationFailure = null;
  let clipboardArmElapsedMs = null;
  let clipboardArmStartedElapsedMs = null;
  let clipboardArmBudgetAtStartMs = null;
  let clipboardArmRawRemainingAtStartMs = null;
  let clipboardReleaseElapsedMs = null;
  let clipboardWaitStartedElapsedMs = null;
  let clipboardReleaseBudgetAtStartMs = null;
  let clipboardReleaseIdentityElapsedMs = null;
  let clipboardReleaseTransportAttempted = false;
  let clipboardReleaseEffectOccurred = false;
  let clipboardReleaseLoadMarkerAcquired = false;
  let clipboardReleaseCleanupAttempted = false;
  const exactClipboardResult = (value) =>
    value !== null &&
    typeof value === "object" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes > 0 &&
    value.bytes <= MAX_CLIPBOARD_BYTES &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(value.sha256);
  const inject = async (bytes, logicalPhases = 1) => {
    const outcome = await port.inject(identity, bytes, deliveryRemaining());
    bytesInjected += Buffer.byteLength(bytes, "utf8");
    phases += logicalPhases;
    transportCalls += 1;
    physicalTransportCalls +=
      Number.isSafeInteger(outcome?.physicalCalls) && outcome.physicalCalls === 1
        ? outcome.physicalCalls
        : 1;
  };
  const pause = async (milliseconds) => {
    if (milliseconds <= 0) return;
    if (milliseconds > deliveryRemaining()) {
      throw new Error(`Test-drive ${command.kind} delay exceeds its absolute deadline`);
    }
    await port.sleep(milliseconds);
  };
  const finalizationReserveMs = clipboardOperation
    ? Math.max(postInputIdentityReserveMs, clipboardObservationReserveMs)
    : 0;
  const clipboardReleaseBudgetMs = Math.min(
    CLIPBOARD_RELEASE_BUDGET_MS,
    Math.max(20, Math.floor(command.timeoutMs / 15)),
  );
  const rawRemaining = () => Math.max(0, Math.floor(deadline - port.clock.now()));
  const armClipboardWithinBudget = async () => {
    failureSubstage = "pre-release-budget";
    const fixedReserveMs = cleanupReserveMs + finalizationReserveMs + clipboardReleaseBudgetMs;
    const rawRemainingAtStartMs = rawRemaining();
    const availableArmMs = rawRemainingAtStartMs - fixedReserveMs;
    if (availableArmMs < 90) {
      throw new Error(`Test-drive ${command.kind} exceeded its pre-release budget`);
    }
    const clipboardArmBudgetMs = Math.min(CLIPBOARD_ARM_BUDGET_MS, availableArmMs);
    clipboardArmBudgetAtStartMs = clipboardArmBudgetMs;
    clipboardArmRawRemainingAtStartMs = rawRemainingAtStartMs;
    failureSubstage = "clipboard-arm";
    clipboardArmStartedElapsedMs = Math.min(
      MAX_INPUT_TIMEOUT_MS,
      Math.max(0, Math.round(port.clock.now() - startedAt)),
    );
    const armStartedAt = port.clock.now();
    observation = await port.armClipboard(
      identity,
      port.nonce(),
      clipboardArmBudgetMs,
      cleanupReserveMs,
    );
    clipboardArmElapsedMs = Math.min(
      MAX_INPUT_TIMEOUT_MS,
      Math.max(0, Math.round(port.clock.now() - startedAt)),
    );
    if (
      port.clock.now() - armStartedAt > clipboardArmBudgetMs ||
      rawRemaining() < cleanupReserveMs + finalizationReserveMs + clipboardReleaseBudgetMs
    ) {
      throw new Error(`Test-drive ${command.kind} clipboard arm exceeded its bounded slice`);
    }
  };
  const releaseClipboardInput = async (bytes, logicalPhases = 1) => {
    const available = rawRemaining() - cleanupReserveMs - finalizationReserveMs;
    if (available < clipboardReleaseBudgetMs) {
      throw new Error(`Test-drive ${command.kind} exceeded its release budget`);
    }
    clipboardReleaseBudgetAtStartMs = clipboardReleaseBudgetMs;
    const releaseStartedAt = port.clock.now();
    const releaseDeadline = releaseStartedAt + clipboardReleaseBudgetMs;
    const releaseRemaining = () => {
      const value = Math.floor(releaseDeadline - port.clock.now());
      if (value < 1) throw new Error(`Test-drive ${command.kind} exceeded its release budget`);
      return value;
    };
    failureSubstage = "release-identity";
    const identityStartedAt = port.clock.now();
    await port.verifyIdentity(identity, releaseRemaining());
    clipboardReleaseIdentityElapsedMs = Math.min(
      clipboardReleaseBudgetMs,
      Math.max(0, Math.round(port.clock.now() - identityStartedAt)),
    );
    failureSubstage = command.kind === "selection-drag" ? "selection-release" : "input-delivery";
    clipboardReleaseTransportAttempted = true;
    let outcome;
    try {
      outcome = await port.inject(identity, bytes, releaseRemaining());
    } catch (error) {
      clipboardReleaseEffectOccurred =
        error?.deliveryEvidence?.effectOccurred === false &&
        error?.deliveryEvidence?.loadMarkerAcquired === false
          ? false
          : null;
      clipboardReleaseLoadMarkerAcquired = error?.deliveryEvidence?.loadMarkerAcquired === true;
      clipboardReleaseCleanupAttempted = error?.deliveryEvidence?.cleanupAttempted === true;
      throw error;
    }
    clipboardReleaseEffectOccurred =
      outcome?.physicalCalls === 1 &&
      outcome?.transportAttempted === true &&
      outcome?.effectOccurred === true &&
      outcome?.loadMarkerAcquired === true &&
      outcome?.cleanupAttempted === false
        ? true
        : null;
    clipboardReleaseLoadMarkerAcquired = outcome?.loadMarkerAcquired === true;
    clipboardReleaseCleanupAttempted = outcome?.cleanupAttempted === true;
    if (
      port.clock.now() - releaseStartedAt > clipboardReleaseBudgetMs ||
      rawRemaining() < cleanupReserveMs + finalizationReserveMs ||
      outcome?.physicalCalls !== 1 ||
      !clipboardReleaseEffectOccurred ||
      !clipboardReleaseLoadMarkerAcquired ||
      clipboardReleaseCleanupAttempted
    ) {
      throw new Error(`Test-drive ${command.kind} release proof exceeded its bounded slice`);
    }
    bytesInjected += Buffer.byteLength(bytes, "utf8");
    phases += logicalPhases;
    transportCalls += 1;
    physicalTransportCalls += 1;
  };
  try {
    identity = await port.resolveIdentity(deliveryRemaining());
    failureSubstage = "preflight-identity";
    await port.verifyIdentity(identity, deliveryRemaining());
    failureSubstage = "capabilities";
    const capabilities = await port.capabilities(identity, deliveryRemaining());
    const translated = translateTestdriveInput(command, {
      capabilities,
      geometry: { cols: identity.cols, rows: identity.rows },
    });
    totalPhases = translated.phases.length;
    totalTransportCalls = translated.phases.length;

    if (command.kind === "selection-drag") {
      totalPhases += 3;
      totalTransportCalls = 5;
      // Explicitly enter the product's pane-local select mode through its real
      // context menu, then require its rendered badge/note before dragging.
      for (const phase of [
        { bytes: mouseSequence("down", command.from.x, command.from.y, "right"), delayMs: 12 },
        { bytes: mouseSequence("up", command.from.x, command.from.y, "right"), delayMs: 12 },
        { bytes: "\r", delayMs: 0 },
      ]) {
        failureSubstage = "select-mode-identity";
        await port.verifyIdentity(identity, deliveryRemaining());
        failureSubstage = "enter-select-mode";
        await inject(phase.bytes);
        await pause(phase.delayMs);
      }
      failureSubstage = "wait-select-mode";
      await port.waitForFrame(
        identity,
        (frame) => frame.includes("select text: drag to copy") || frame.includes("⧉ select"),
        deliveryRemaining(),
      );
      failureSubstage = "capture-before-selection";
      await port.verifyIdentity(identity, deliveryRemaining());
      const before = await port.captureAnsi(identity, deliveryRemaining());
      const selectionPhases = translated.phases;
      const preRelease = selectionPhases.slice(0, -1);
      // One immutable PTY transaction preserves every logical SGR event and
      // their order while keeping host transport cost independent of distance.
      failureSubstage = "drag-pre-release-identity";
      await port.verifyIdentity(identity, deliveryRemaining());
      failureSubstage = "drag-pre-release";
      await inject(preRelease.map(({ bytes }) => bytes).join(""), preRelease.length);
      failureSubstage = "selection-style-wait";
      for (;;) {
        await port.verifyIdentity(identity, deliveryRemaining());
        const selected = await port.captureAnsi(identity, deliveryRemaining());
        await port.verifyIdentity(identity, deliveryRemaining());
        try {
          selectionStyle = {
            ...proveRendererSelectionStyleDelta(
              before,
              selected,
              command.from,
              command.to,
              {
                cols: identity.cols,
                rows: identity.rows,
              },
              command.contentRect,
            ),
            frameDigest: createHash("sha256").update(selected).digest("hex"),
          };
          break;
        } catch {
          await pause(Math.min(10, deliveryRemaining()));
        }
      }
      // Do not arm or release unless both bounded mutations and the concurrent
      // post-release proof fit alongside cleanup.
      await armClipboardWithinBudget();
      await releaseClipboardInput(selectionPhases.at(-1).bytes);
    } else {
      failureSubstage = translated.captureClipboard ? "clipboard-arm" : "input-delivery";
      if (translated.captureClipboard) await armClipboardWithinBudget();
      for (const phase of translated.phases) {
        if (translated.captureClipboard) await releaseClipboardInput(phase.bytes);
        else await inject(phase.bytes);
        await pause(phase.delayMs);
      }
    }

    let clipboardWaitFailure = null;
    let clipboardIdentityFailure = null;
    if (clipboardOperation) {
      // Start observing immediately after the input effect. Identity proof and
      // callback publication are independent prerequisites and run together;
      // neither can consume the other's pre-release reserve.
      clipboardObservationPending = false;
      failureSubstage = "clipboard-wait";
      clipboardReleaseElapsedMs = Math.min(
        MAX_INPUT_TIMEOUT_MS,
        Math.max(0, Math.round(port.clock.now() - startedAt)),
      );
      clipboardWaitStartedElapsedMs = clipboardReleaseElapsedMs;
      const waitTimeout = workRemaining();
      const identityTimeout = Math.min(postInputIdentityReserveMs, workRemaining());
      const waitPromise = observation?.wait(waitTimeout) ?? Promise.resolve(null);
      const identityPromise = port.verifyIdentity(identity, identityTimeout);
      const [waitResult, identityResult] = await Promise.allSettled([waitPromise, identityPromise]);
      postInputIdentityPending = false;
      if (waitResult.status === "fulfilled") clipboard = waitResult.value;
      else clipboardWaitFailure = waitResult.reason;
      if (identityResult.status === "rejected") {
        clipboardIdentityFailure = identityResult.reason;
      }
    } else {
      failureSubstage = "postflight-identity";
      await port.verifyIdentity(identity, workRemaining());
    }
    let clipboardObservation = null;
    if (observation) {
      failureSubstage = "clipboard-retirement";
      const terminalClipboard = await observation.dispose(cleanupRemaining());
      if (!clipboard && exactClipboardResult(terminalClipboard)) clipboard = terminalClipboard;
      const settledObservation = observation.evidence?.() ?? {};
      clipboardObservation = Object.freeze({
        ...settledObservation,
        callbackHookElapsedMs: settledObservation.callbackHookElapsedMs ?? null,
        callbackHookEntryLagMs: settledObservation.callbackHookEntryLagMs ?? null,
        callbackInventorySeenElapsedMs: settledObservation.callbackInventorySeenElapsedMs ?? null,
        callbackArtifactPublishedElapsedMs:
          settledObservation.callbackArtifactPublishedElapsedMs ?? null,
        callbackPreSaveElapsedMs: settledObservation.callbackPreSaveElapsedMs ?? null,
        callbackSaveElapsedMs: settledObservation.callbackSaveElapsedMs ?? null,
        callbackSaveOutcome: settledObservation.callbackSaveOutcome ?? "not-started",
        callbackRetirementStage: settledObservation.callbackRetirementStage ?? "not-started",
        callbackRetirementElapsedMs: settledObservation.callbackRetirementElapsedMs ?? 0,
        callbackWorkSettled: settledObservation.callbackWorkSettled === true,
        callbackLeaseInactive: settledObservation.callbackLeaseInactive === true,
        artifactObservedElapsedMs: settledObservation.artifactObservedElapsedMs ?? null,
        duplicateSettleElapsedMs: settledObservation.duplicateSettleElapsedMs ?? null,
        callbackLastScanElapsedMs: settledObservation.callbackLastScanElapsedMs ?? null,
        clipboardArmElapsedMs,
        clipboardArmStartedElapsedMs,
        clipboardArmBudgetAtStartMs,
        clipboardArmRawRemainingAtStartMs,
        clipboardReleaseElapsedMs,
        clipboardWaitStartedElapsedMs,
        clipboardReleaseBudgetAtStartMs,
        clipboardReleaseIdentityElapsedMs,
        clipboardReleaseTransportAttempted,
        clipboardReleaseEffectOccurred,
        clipboardReleaseLoadMarkerAcquired,
        clipboardReleaseCleanupAttempted,
        priorCopyCount: clipboard?.priorCopyCount ?? null,
        newCopyCount: clipboard?.newCopyCount ?? null,
        identityExact: clipboard?.identityExact === true,
      });
      observation = null;
    }
    if (clipboardIdentityFailure) {
      failureSubstage = "post-input-identity";
      throw clipboardIdentityFailure;
    }
    if (
      clipboardWaitFailure &&
      (!clipboard || !isClipboardObservationTimeout(clipboardWaitFailure))
    ) {
      failureSubstage = "clipboard-wait";
      throw clipboardWaitFailure;
    }
    return {
      version: 1,
      kind: command.kind,
      target: identity.paneId,
      paneId: identity.paneId,
      sessionId: identity.sessionId,
      geometry: { cols: identity.cols, rows: identity.rows },
      delivery: "exact-bytes-to-immutable-host-pane-pty",
      bytesInjected,
      phases,
      transportCalls,
      physicalTransportCalls,
      ...(command.kind === "focus" ? { requestedState: command.state } : null),
      ...(command.kind === "control-key" ? { requestedKey: command.key } : null),
      ...(command.kind === "modified-key"
        ? { requestedKey: command.key, requestedModifiers: command.modifiers }
        : null),
      ...(command.kind === "application-mouse"
        ? {
            requestedAction: command.action,
            requestedPoint: { x: command.x, y: command.y },
            requestedButton: command.button,
            requestedModifiers: command.modifiers,
          }
        : null),
      ...(command.kind === "selection-drag"
        ? {
            requestedSelection: {
              from: command.from,
              to: command.to,
              contentRect: command.contentRect,
            },
          }
        : null),
      elapsedMs: Number((port.clock.now() - startedAt).toFixed(2)),
      ...(clipboard ? { clipboard: { bytes: clipboard.bytes, sha256: clipboard.sha256 } } : null),
      ...(clipboardObservation ? { clipboardObservation } : null),
      ...(selectionStyle ? { selectionStyle } : null),
    };
  } catch (error) {
    operationFailure = error;
    if (error && typeof error === "object" && !error.observation) {
      const emptyClipboardEvidence = clipboardOperation
        ? {
            candidateAttempts: 0,
            occupiedCount: 0,
            retirementExact: false,
            retirementStage: "not-started",
            retirementElapsedMs: 0,
            finalOwnerAbsent: false,
            finalHookAbsent: false,
            callbackInvocations: 0,
            callbackStage: "not-invoked",
            callbackOutcome: "pending",
            callbackInventoryPolls: 0,
            callbackHookElapsedMs: null,
            callbackHookEntryLagMs: null,
            callbackInventorySeenElapsedMs: null,
            callbackArtifactPublishedElapsedMs: null,
            callbackPreSaveElapsedMs: null,
            callbackSaveElapsedMs: null,
            callbackSaveOutcome: "not-started",
            callbackRetirementStage: "not-started",
            callbackRetirementElapsedMs: 0,
            callbackWorkSettled: false,
            callbackLeaseInactive: false,
            artifactObservedElapsedMs: null,
            duplicateSettleElapsedMs: null,
            callbackLastScanElapsedMs: null,
          }
        : null;
      const clipboardLeaseEvidence =
        (observation?.evidence?.() ?? error.clipboardLeaseEvidence ?? emptyClipboardEvidence) ||
        null;
      error.observation = Object.freeze({
        operation: "tui-testdrive-input",
        kind: command.kind,
        substage: failureSubstage,
        completedPhases: Math.min(phases, 32),
        totalPhases:
          Number.isSafeInteger(totalPhases) && totalPhases >= 0 ? Math.min(totalPhases, 32) : null,
        completedTransportCalls: Math.min(transportCalls, 32),
        totalTransportCalls:
          Number.isSafeInteger(totalTransportCalls) && totalTransportCalls >= 0
            ? Math.min(totalTransportCalls, 32)
            : null,
        completedPhysicalTransportCalls: Math.min(physicalTransportCalls, 32),
        totalPhysicalTransportCalls:
          Number.isSafeInteger(totalTransportCalls) && totalTransportCalls >= 0
            ? Math.min(totalTransportCalls, 32)
            : null,
        cause:
          isClipboardObservationTimeout(error) ||
          error?.code === "ETIMEDOUT" ||
          /timed?\s*out|ETIMEDOUT/iu.test(error?.message ?? "")
            ? "timeout"
            : /identity|geometry changed/iu.test(error?.message ?? "")
              ? "identity-mismatch"
              : /deadline|budget/iu.test(error?.message ?? "")
                ? "deadline"
                : "operation-error",
        elapsedMs: Math.min(
          MAX_INPUT_TIMEOUT_MS,
          Math.max(0, Math.floor(port.clock.now() - startedAt)),
        ),
        remainingMs: Math.min(
          MAX_INPUT_TIMEOUT_MS,
          Math.max(0, Math.floor(deadline - port.clock.now())),
        ),
        ...(clipboardLeaseEvidence
          ? {
              ...clipboardLeaseEvidence,
              callbackInvocations: clipboardLeaseEvidence.callbackInvocations ?? 0,
              callbackStage: clipboardLeaseEvidence.callbackStage ?? "not-invoked",
              callbackOutcome: clipboardLeaseEvidence.callbackOutcome ?? "pending",
              callbackInventoryPolls: clipboardLeaseEvidence.callbackInventoryPolls ?? 0,
              callbackHookElapsedMs: clipboardLeaseEvidence.callbackHookElapsedMs ?? null,
              callbackHookEntryLagMs: clipboardLeaseEvidence.callbackHookEntryLagMs ?? null,
              callbackInventorySeenElapsedMs:
                clipboardLeaseEvidence.callbackInventorySeenElapsedMs ?? null,
              callbackArtifactPublishedElapsedMs:
                clipboardLeaseEvidence.callbackArtifactPublishedElapsedMs ?? null,
              callbackPreSaveElapsedMs: clipboardLeaseEvidence.callbackPreSaveElapsedMs ?? null,
              callbackSaveElapsedMs: clipboardLeaseEvidence.callbackSaveElapsedMs ?? null,
              callbackSaveOutcome: clipboardLeaseEvidence.callbackSaveOutcome ?? "not-started",
              callbackRetirementStage:
                clipboardLeaseEvidence.callbackRetirementStage ?? "not-started",
              callbackRetirementElapsedMs: clipboardLeaseEvidence.callbackRetirementElapsedMs ?? 0,
              callbackWorkSettled: clipboardLeaseEvidence.callbackWorkSettled === true,
              callbackLeaseInactive: clipboardLeaseEvidence.callbackLeaseInactive === true,
              artifactObservedElapsedMs: clipboardLeaseEvidence.artifactObservedElapsedMs ?? null,
              duplicateSettleElapsedMs: clipboardLeaseEvidence.duplicateSettleElapsedMs ?? null,
              callbackLastScanElapsedMs: clipboardLeaseEvidence.callbackLastScanElapsedMs ?? null,
              clipboardArmElapsedMs,
              clipboardArmStartedElapsedMs,
              clipboardArmBudgetAtStartMs,
              clipboardArmRawRemainingAtStartMs,
              clipboardReleaseElapsedMs,
              clipboardWaitStartedElapsedMs,
              clipboardReleaseBudgetAtStartMs,
              clipboardReleaseIdentityElapsedMs,
              clipboardReleaseTransportAttempted,
              clipboardReleaseEffectOccurred,
              clipboardReleaseLoadMarkerAcquired,
              clipboardReleaseCleanupAttempted,
              priorCopyCount: clipboard?.priorCopyCount ?? null,
              newCopyCount: clipboard?.newCopyCount ?? null,
              clipboardIdentityExact: clipboard?.identityExact === true,
            }
          : {}),
      });
    }
    throw error;
  } finally {
    if (observation) {
      try {
        await observation.dispose(cleanupRemaining());
      } catch {
        // The primary operation failure remains authoritative; the exact
        // retirement outcome is merged into its bounded observation below.
      } finally {
        if (operationFailure?.observation) {
          operationFailure.observation = Object.freeze({
            ...operationFailure.observation,
            ...observation.evidence?.(),
          });
        }
      }
    }
  }
}
import stringWidth from "string-width";
import { createHash } from "node:crypto";
