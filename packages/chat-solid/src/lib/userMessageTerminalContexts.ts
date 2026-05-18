/**
 * Helpers for inlining terminal-context references into the prompt
 * body. Each context's `header` (e.g. "vite lines 12-30") is rewritten
 * to a stable `@<terminal>:<lines>` token so the agent can quote it
 * back unambiguously. Outbound use lives in chat-solid; the user-
 * facing chip strip is rendered by `ComposerPendingTerminalContexts`.
 *
 * The header pattern is intentionally permissive — anything we can't
 * parse as a line range still gets a slug fallback (e.g. "@my-shell")
 * so a malformed header never silently drops a context.
 */

import { formatInlineTerminalContextLabel as formatInlineLabel } from "./terminalContext";

const TERMINAL_CONTEXT_HEADER_PATTERN = /^(.*?)\s+line(?:s)?\s+(\d+)(?:-(\d+))?$/i;

export function formatInlineTerminalContextLabel(header: string): string {
  const trimmed = header.trim();
  const match = TERMINAL_CONTEXT_HEADER_PATTERN.exec(trimmed);
  if (!match) {
    return `@${trimmed.toLowerCase().replace(/\s+/g, "-")}`;
  }
  const lineStart = Number.parseInt(match[2] ?? "", 10);
  const lineEnd = Number.parseInt(match[3] ?? match[2] ?? "", 10);
  if (!Number.isFinite(lineStart) || !Number.isFinite(lineEnd)) {
    return `@${trimmed.toLowerCase().replace(/\s+/g, "-")}`;
  }
  return formatInlineLabel({
    terminalLabel: match[1]?.trim() || "terminal",
    lineStart,
    lineEnd,
  });
}

export function buildInlineTerminalContextText(
  contexts: ReadonlyArray<{ header: string }>,
): string {
  return contexts
    .map((context) => context.header.trim())
    .filter((header) => header.length > 0)
    .map(formatInlineTerminalContextLabel)
    .join(" ");
}

/**
 * A terminal context surfaces inside a sent user message as a
 * `resource` block whose uri is `tmux-pane://<session>/<paneId>`
 * (see `useChatThread.blocksForAttachments`). This parses such a
 * block into the chip's display shape — a stable `@<pane>` label,
 * a tooltip (the captured body, or an "expired" hint), and an
 * `expired` flag when the capture carried no text.
 */
export interface ParsedTerminalContextResource {
  label: string;
  tooltipText: string;
  expired: boolean;
}

const TMUX_PANE_URI_PREFIX = "tmux-pane://";

export function parseTerminalContextResource(block: {
  type: string;
  resource?: { uri?: string; text?: string };
}): ParsedTerminalContextResource | null {
  if (block.type !== "resource" || !block.resource) return null;
  const uri = block.resource.uri ?? "";
  if (!uri.startsWith(TMUX_PANE_URI_PREFIX)) return null;
  const rest = uri.slice(TMUX_PANE_URI_PREFIX.length);
  const paneSegment = rest.split("/").filter(Boolean).pop() ?? rest;
  const slug = paneSegment.trim().toLowerCase().replace(/\s+/g, "-") || "terminal";
  const body = (block.resource.text ?? "").replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
  const expired = body.length === 0;
  return {
    label: `@${slug}`,
    tooltipText: expired
      ? `Terminal context expired. Re-add @${slug} to include its output in your message.`
      : body,
    expired,
  };
}

export function textContainsInlineTerminalContextLabels(
  text: string,
  contexts: ReadonlyArray<{ header: string }>,
): boolean {
  let searchStartIndex = 0;
  for (const context of contexts) {
    const label = formatInlineTerminalContextLabel(context.header);
    const matchIndex = text.indexOf(label, searchStartIndex);
    if (matchIndex === -1) return false;
    searchStartIndex = matchIndex + label.length;
  }
  return true;
}
