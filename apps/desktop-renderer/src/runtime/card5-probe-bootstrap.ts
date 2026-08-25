export const CARD5_PROBE_QUERY = "tmuxIdeCard5Evidence";
export const CARD5_ACTIVE_TERMINAL_PANEL = "#workspace-panel-terminals:not([hidden])";

interface Card5ProbeGlobals {
  __TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__?: boolean;
  __TMUX_IDE_CARD5_EVIDENCE_ENABLED__?: boolean;
  __TMUX_IDE_CARD5_QUALIFIED_TERMINAL__?: (mode?: "readiness" | "observation") => Element | null;
}

/** One shared qualification boundary for startup and every later Card5 capture. */
export function resolveCard5QualifiedTerminalSurface(
  documentHost: Pick<Document, "visibilityState" | "querySelector"> = document,
  styleHost: Pick<typeof globalThis, "getComputedStyle"> = globalThis,
  mode: "readiness" | "observation" = "readiness",
): Element | null {
  if (mode === "readiness" && documentHost.visibilityState !== "visible") return null;
  const panel = documentHost.querySelector(CARD5_ACTIVE_TERMINAL_PANEL);
  if (!panel) return null;
  const panelRect = panel.getBoundingClientRect();
  if (panelRect.width <= 0 || panelRect.height <= 0 || panel.getClientRects().length === 0)
    return null;
  for (const surface of panel.querySelectorAll(".terminal-surface")) {
    const style = styleHost.getComputedStyle(surface);
    const rect = surface.getBoundingClientRect();
    if (
      surface.getAttribute("data-phase") === "connected" &&
      surface.getAttribute("data-preserves-frame") === "true" &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.visibility !== "collapse" &&
      rect.width > 0 &&
      rect.height > 0 &&
      surface.getClientRects().length > 0
    ) {
      return surface;
    }
  }
  return null;
}

/** Enables bounded diagnostics only for one exact loopback development URL. */
export function card5ProbeBootstrapRequested(value: string): boolean {
  const url = new URL(value);
  const values = url.searchParams.getAll(CARD5_PROBE_QUERY);
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    url.username === "" &&
    url.password === "" &&
    url.port !== "" &&
    values.length === 1 &&
    values[0] === "1"
  );
}

export function installCard5ProbeBootstrap(
  value: string,
  globals: Card5ProbeGlobals = globalThis as Card5ProbeGlobals,
): boolean {
  if (!card5ProbeBootstrapRequested(value)) return false;
  globals.__TMUX_IDE_ANSI_RENDITION_PROBE_ENABLED__ = true;
  globals.__TMUX_IDE_CARD5_EVIDENCE_ENABLED__ = true;
  globals.__TMUX_IDE_CARD5_QUALIFIED_TERMINAL__ = (mode = "readiness") =>
    resolveCard5QualifiedTerminalSurface(document, globalThis, mode);
  return true;
}
