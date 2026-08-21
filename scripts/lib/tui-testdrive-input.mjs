const MAX_JSON_BYTES = 96 * 1024;
export const MAX_PASTE_BYTES = 64 * 1024;
export const MAX_CLIPBOARD_BYTES = 1024 * 1024;
export const MAX_CLIPBOARD_CALLBACK_ARTIFACTS = 4;
export const DEFAULT_INPUT_TIMEOUT_MS = 2_000;
export const MAX_INPUT_TIMEOUT_MS = 5_000;

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

function inputError(message) {
  throw new Error(`Invalid test-drive input: ${message}`);
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
  if (swapped.length < 2 || swapped.length !== span.length) {
    throw new Error(
      `OpenTUI selection style proof covered ${swapped.length}/${span.length} requested cells`,
    );
  }
  return { cells: swapped.length };
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
  try {
    runTmux(["load-buffer", "-b", bufferName, "-"], {
      input: bytes,
      timeout: workRemaining(),
    });
    runTmux(exactPtyPasteBufferArgs(bufferName, identity.paneId), {
      timeout: workRemaining(),
    });
  } finally {
    try {
      runTmux(["delete-buffer", "-b", bufferName], { timeout: cleanupRemaining() });
    } catch {
      // The operation still fails by its original error; cleanup is bounded
      // and best-effort, but is never skipped.
    }
  }
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
    new Set(["version", "nonce", "paneId", "bytes", "sha256"]),
    "clipboard event",
  );
  if (
    event.version !== 1 ||
    event.nonce !== expected.nonce ||
    event.paneId !== expected.paneId ||
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
  while (clock.now() < deadline) {
    const artifactIds = [...new Set(listArtifacts())];
    if (artifactIds.length > 1) {
      throw new Error("Multiple clipboard events matched one test-drive operation");
    }
    if (artifactIds.length === 1) {
      const event = readEvent(artifactIds[0]);
      if (event) {
        const validated = validateClipboardObservationEvents([event], expected);
        firstCompleteAt ??= clock.now();
        if (clock.now() - firstCompleteAt >= quietMs) return validated;
      }
    }
    const remaining = deadline - clock.now();
    if (remaining <= 0) break;
    await sleep(Math.min(10, remaining));
  }
  throw new Error(`Timed out waiting for pane-scoped clipboard operation ${expected.nonce}`);
}

export async function executeTestdriveInputOperation(command, port) {
  const startedAt = port.clock.now();
  const deadline = startedAt + command.timeoutMs;
  const cleanupReserveMs = Math.min(100, Math.max(10, Math.floor(command.timeoutMs / 4)));
  const workRemaining = () => {
    const value = Math.floor(deadline - port.clock.now() - cleanupReserveMs);
    if (value < 1) throw new Error(`Test-drive ${command.kind} exceeded its absolute deadline`);
    return value;
  };
  const cleanupRemaining = () => Math.max(1, Math.floor(deadline - port.clock.now()));
  let observation = null;
  let identity = null;
  let bytesInjected = 0;
  let phases = 0;
  const inject = async (bytes) => {
    await port.inject(identity, bytes, workRemaining());
    bytesInjected += Buffer.byteLength(bytes, "utf8");
    phases += 1;
  };
  const pause = async (milliseconds) => {
    if (milliseconds <= 0) return;
    if (milliseconds > workRemaining()) {
      throw new Error(`Test-drive ${command.kind} delay exceeds its absolute deadline`);
    }
    await port.sleep(milliseconds);
  };
  const observeClipboard = async () => {
    observation = await port.armClipboard(identity, port.nonce(), workRemaining());
  };
  try {
    identity = await port.resolveIdentity(workRemaining());
    await port.verifyIdentity(identity, workRemaining());
    const capabilities = await port.capabilities(identity, workRemaining());
    const translated = translateTestdriveInput(command, {
      capabilities,
      geometry: { cols: identity.cols, rows: identity.rows },
    });

    if (command.kind === "selection-drag") {
      // Explicitly enter the product's pane-local select mode through its real
      // context menu, then require its rendered badge/note before dragging.
      for (const phase of [
        { bytes: mouseSequence("down", command.from.x, command.from.y, "right"), delayMs: 12 },
        { bytes: mouseSequence("up", command.from.x, command.from.y, "right"), delayMs: 12 },
        { bytes: "\r", delayMs: 0 },
      ]) {
        await inject(phase.bytes);
        await pause(phase.delayMs);
      }
      await port.waitForFrame(
        identity,
        (frame) => frame.includes("select text: drag to copy") || frame.includes("⧉ select"),
        workRemaining(),
      );
      const before = await port.captureAnsi(identity, workRemaining());
      const selectionPhases = translated.phases;
      for (const phase of selectionPhases.slice(0, -1)) {
        await inject(phase.bytes);
        await pause(phase.delayMs);
      }
      const selected = await port.captureAnsi(identity, workRemaining());
      proveRendererSelectionStyleDelta(
        before,
        selected,
        command.from,
        command.to,
        {
          cols: identity.cols,
          rows: identity.rows,
        },
        command.contentRect,
      );
      await observeClipboard();
      await inject(selectionPhases.at(-1).bytes);
    } else {
      if (translated.captureClipboard) await observeClipboard();
      for (const phase of translated.phases) {
        await inject(phase.bytes);
        await pause(phase.delayMs);
      }
    }

    const clipboard = observation ? await observation.wait(workRemaining()) : null;
    await port.verifyIdentity(identity, workRemaining());
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
      ...(command.kind === "focus" ? { requestedState: command.state } : null),
      ...(command.kind === "control-key" ? { requestedKey: command.key } : null),
      ...(command.kind === "modified-key"
        ? { requestedKey: command.key, requestedModifiers: command.modifiers }
        : null),
      ...(command.kind === "application-mouse"
        ? { requestedAction: command.action, requestedPoint: { x: command.x, y: command.y } }
        : null),
      elapsedMs: Number((port.clock.now() - startedAt).toFixed(2)),
      ...(clipboard ? { clipboard: { bytes: clipboard.bytes, sha256: clipboard.sha256 } } : null),
    };
  } finally {
    if (observation) await observation.dispose(cleanupRemaining());
  }
}
import stringWidth from "string-width";
