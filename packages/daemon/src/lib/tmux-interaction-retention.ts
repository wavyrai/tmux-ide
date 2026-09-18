const EVENT_SEPARATOR = "|tmux-ide-input-event-v1|";

// ASCII metadata only. The native producer retains a prefix plus the newest
// record; truncation inserts a framed gap, never an invented interaction.
// Keep this within tmux's supported format-width range: larger widths can
// silently disable truncation. Live tests cover tmux 3.4 and 3.7c.
export const TMUX_INTERACTION_RETAINED_CHARS = 8_192;
export const TMUX_INTERACTION_GAP_RECORD = `${EVENT_SEPARATOR}gap${EVENT_SEPARATOR}`;
export const TMUX_INTERACTION_MAX_DRAIN_BYTES =
  TMUX_INTERACTION_RETAINED_CHARS + TMUX_INTERACTION_GAP_RECORD.length + 1_024;

export function tmuxInteractionOption(bufferName: string): string {
  if (!/^[A-Za-z0-9._-]{1,256}$/u.test(bufferName)) throw new TypeError("Invalid observer name");
  return `@${bufferName}`;
}

/** One native command, also used by atomic NOHOOKS recovery (fixed ordinals). */
export function boundedTmuxInteractionAppendCommand(bufferName: string, record: string): string {
  const option = tmuxInteractionOption(bufferName);
  if (!/^[A-Za-z0-9%:._|-]{1,1024}$/u.test(record)) {
    throw new TypeError("Invalid observer metadata");
  }
  return `set-option -gF '${option}' '#{=/${TMUX_INTERACTION_RETAINED_CHARS}/${TMUX_INTERACTION_GAP_RECORD}:${option}}${record}'`;
}
