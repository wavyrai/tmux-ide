import { createHash } from "node:crypto";

/**
 * Proof captured outside the renderer, from the tmux pane that owns its PTY.
 * OpenTUI's `frame` event proves native submission only; this evidence proves
 * the resulting bytes reached the host terminal buffer.
 */
export function buildTuiHostPublicationEvidence({
  frame,
  kind,
  token = null,
  generation = null,
  processId = null,
  elapsedMs = null,
}) {
  if (kind !== "chrome" && kind !== "terminal") {
    throw new TypeError("host publication kind must be chrome or terminal");
  }
  const text = String(frame ?? "");
  const chromeVisible = text.includes("tmux-ide");
  const tokenVisible =
    kind === "chrome"
      ? true
      : typeof token === "string" && token.length > 0 && text.includes(token);
  return Object.freeze({
    version: 1,
    phase: kind === "terminal" ? "host-terminal-publication" : "host-chrome-publication",
    kind,
    generation,
    processId,
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, Math.round(elapsedMs)) : null,
    bytes: Buffer.byteLength(text),
    frameHash: createHash("sha256").update(text).digest("hex"),
    chromeVisible,
    tokenVisible,
    passed: chromeVisible && tokenVisible && text.length > 0,
  });
}
