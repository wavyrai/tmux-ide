import { z } from "zod";

/**
 * Text that comes from plugins (titles, labels, choices, results, errors)
 * ends up in terminals. C0 controls, DEL and C1 controls would let it
 * drive the terminal (OSC 52 writes the clipboard, `ESC[2K` rewrites a
 * prompt line), and bidi controls would let it reorder what is shown.
 */
// Written as escapes so the invisible characters stay visible in source.
const UNSAFE_CLASS =
  "[\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]";
const UNSAFE = new RegExp(UNSAFE_CLASS, "u");
const UNSAFE_GLOBAL = new RegExp(UNSAFE_CLASS, "gu");

export function hasUnsafeText(text: string): boolean {
  return UNSAFE.test(text);
}

/** One line of plain text: every unsafe character becomes a space. */
export function terminalSafe(text: string, max = 2000): string {
  return text.replace(UNSAFE_GLOBAL, " ").slice(0, max);
}

/**
 * Several lines of plain text, for whole outputs: newlines and tabs stay,
 * every other unsafe character becomes a space.
 */
export function terminalSafeBlock(text: string): string {
  return text.replace(UNSAFE_GLOBAL, (char) => (char === "\n" || char === "\t" ? char : " "));
}

/**
 * Every string inside a JSON value made terminal-safe. Values keep their
 * newlines and tabs (program output is several lines); keys become one line.
 */
export function terminalSafeDeep(value: unknown, max = 10_000): unknown {
  if (typeof value === "string") return terminalSafeBlock(value).slice(0, max);
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
