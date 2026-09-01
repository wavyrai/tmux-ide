/**
 * The responsive shell spells terminal focus as either `focus terminal` or the
 * compact `Terminals · terminal · …`, the component status bar's
 * `Terminals / terminal`, or the session-scoped component footer
 * `<session> Terminals Live tmux session discovered`. All are canonical focus
 * projections; platform glyph widths can choose different variants at the
 * same tmux size.
 */
export function frameShowsTerminalFocus(frame) {
  return (
    frame.includes("focus terminal") ||
    /Terminals\s+·\s+terminal\s+·/u.test(frame) ||
    /Terminals\s*\/\s*terminal\b/u.test(frame) ||
    /\S+\s+Terminals\s+Live tmux session discovered\b/u.test(frame)
  );
}
