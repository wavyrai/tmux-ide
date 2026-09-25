/**
 * The responsive shell spells terminal focus as either `focus terminal` or the
 * compact `Terminals · terminal · …`, the component status bar's
 * `Terminals / terminal`, or the session-scoped component footer
 * `<session> Terminals Live tmux session discovered`, or the narrow Linux
 * combination of the active `●❯` tab marker and a live-session footer. All are
 * canonical focus projections; platform glyph widths can choose different
 * variants at the same tmux size.
 */
export function frameShowsTerminalFocus(frame) {
  return (
    frame.includes("focus terminal") ||
    /Terminals\s+·\s+terminal\s+·/u.test(frame) ||
    /Terminals\s*\/\s*terminal\b/u.test(frame) ||
    /\S+\s+Terminals\s+Live tmux session discovered\b/u.test(frame) ||
    (/●❯/u.test(frame) && /\S+\s+Live tmux session discovered\b/u.test(frame))
  );
}

/** The selected Home row's footer keeps its full location when its column truncates. */
export function frameShowsSelectedHomeAgent(
  frame,
  agentLabel,
  sessionName,
  expectedStatus = "working",
) {
  const lines = frame.split("\n");
  const summary = lines.findIndex((line) => line.includes("1 observed agent"));
  if (summary < 0) return false;
  const rows = lines.slice(summary + 1);
  return (
    rows.some(
      (line, index) =>
        (line.includes(`› ${agentLabel} `) || line.trimStart().startsWith(`${agentLabel} `)) &&
        (line.includes("Local / Default /") ||
          rows[index + 1]?.trimEnd().endsWith("Local / Default") ||
          rows[index + 1]?.trimStart().startsWith(`${sessionName} · Local · Default · `)) &&
        line.trimEnd().split(/\s+/u).at(-1)?.toLowerCase() === expectedStatus.toLowerCase(),
    ) && rows.some((line) => line.trim() === `Local / Default / ${sessionName} · Enter open`)
  );
}
