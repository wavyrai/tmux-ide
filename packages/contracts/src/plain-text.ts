import { z } from "zod";

/**
 * Text that comes from plugins (titles, labels, choices, results, errors)
 * ends up in terminals. C0 controls, DEL and C1 controls would let it
 * drive the terminal (OSC 52 writes the clipboard, `ESC[2K` rewrites a
 * prompt line), and bidi controls would let it reorder what is shown.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;
// eslint-disable-next-line no-control-regex
const UNSAFE_GLOBAL = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;

export function hasUnsafeText(text: string): boolean {
  return UNSAFE.test(text);
}

/** One line of plain text: every unsafe character becomes a space. */
export function terminalSafe(text: string, max = 2000): string {
  return text.replace(UNSAFE_GLOBAL, " ").slice(0, max);
}

/** Every string inside a JSON value made terminal-safe (keys included). */
export function terminalSafeDeep(value: unknown, max = 10_000): unknown {
  if (typeof value === "string") return terminalSafe(value, max);
  if (Array.isArray(value)) return value.map((item) => terminalSafeDeep(item, max));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        terminalSafe(key, 200),
        terminalSafeDeep(item, max),
      ]),
    );
  return value;
}

/** A string schema that refuses control, DEL, C1 and bidi characters, newlines included. */
export function plainTextSchema(min: number, max: number) {
  return z
    .string()
    .min(min)
    .max(max)
    .refine(
      (value) => !hasUnsafeText(value),
      "must be plain text: no control characters or newlines",
    );
}
