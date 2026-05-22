/**
 * Quote a string for safe embedding in POSIX sh/bash commands as a single word.
 * Wraps in single quotes; embedded `'` becomes `'\''` (end quote, literal quote, resume).
 */
export function shellEscape(s: string): string {
  // Each "'" in the input becomes '\'' outside a single-quoted string.
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
