/**
 * The responsive shell spells terminal focus as either `focus terminal` or the
 * compact `Terminals · terminal · …`. Both are canonical focus projections;
 * platform glyph widths can choose different variants at the same tmux size.
 */
export function frameShowsTerminalFocus(frame) {
  return frame.includes("focus terminal") || /Terminals\s+·\s+terminal\s+·/u.test(frame);
}
