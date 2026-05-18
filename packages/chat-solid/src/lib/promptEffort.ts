/**
 * Per-turn effort wiring for the composer's TraitsPicker.
 *
 * The daemon's `chat.session.send` contract is strict (threadId +
 * content only) — there is no provider-options field — so effort is
 * applied the way upstream applies its prompt-injected values: by
 * prefixing the outgoing user text with a recognized Claude effort
 * keyword (`think` / `think hard` / `ultrathink`). "Default" injects
 * nothing. This keeps the lever provider-agnostic and side-effect
 * free — it only ever rewrites the first text block.
 */

import type { ContentBlock } from "../types";
import type { TraitDescriptor } from "../components/TraitsPicker";

export type PromptEffort = "default" | "think" | "think-hard" | "ultrathink";

export const DEFAULT_PROMPT_EFFORT: PromptEffort = "default";

interface EffortOption {
  id: PromptEffort;
  label: string;
  /** Prefix injected ahead of the user's text. Empty = no-op. */
  prefix: string;
}

const EFFORT_OPTIONS: ReadonlyArray<EffortOption> = [
  { id: "default", label: "Default", prefix: "" },
  { id: "think", label: "Think", prefix: "think" },
  { id: "think-hard", label: "Think hard", prefix: "think hard" },
  { id: "ultrathink", label: "Ultrathink", prefix: "ultrathink" },
];

export function isPromptEffort(value: string): value is PromptEffort {
  return EFFORT_OPTIONS.some((option) => option.id === value);
}

export function promptEffortLabel(effort: PromptEffort): string {
  return EFFORT_OPTIONS.find((option) => option.id === effort)?.label ?? "Default";
}

/**
 * Builds the single `select` descriptor the TraitsPicker renders for
 * effort. Provider-agnostic — every provider gets the same tiers;
 * the host owns which value is current.
 */
export function buildEffortDescriptor(current: PromptEffort): TraitDescriptor {
  return {
    id: "effort",
    label: "Effort",
    type: "select",
    currentValue: current,
    options: EFFORT_OPTIONS.map((option) => ({
      id: option.id,
      label: option.label,
      ...(option.id === DEFAULT_PROMPT_EFFORT ? { isDefault: true } : {}),
    })),
  };
}

/**
 * Returns a copy of `content` with the effort keyword prefixed onto
 * the first text block (or a new leading text block when the turn
 * carries none, e.g. attachment-only). A no-op for "default" or when
 * the keyword is already the leading token.
 */
export function applyPromptEffort(
  content: ReadonlyArray<ContentBlock>,
  effort: PromptEffort,
): ContentBlock[] {
  const prefix = EFFORT_OPTIONS.find((option) => option.id === effort)?.prefix ?? "";
  if (!prefix) return [...content];

  const firstTextIndex = content.findIndex((block) => block.type === "text");
  if (firstTextIndex === -1) {
    return [{ type: "text", text: prefix }, ...content];
  }

  const next = [...content];
  const block = next[firstTextIndex] as Extract<ContentBlock, { type: "text" }>;
  const trimmed = block.text.trimStart();
  if (trimmed.toLowerCase().startsWith(prefix.toLowerCase())) return next;
  next[firstTextIndex] = { type: "text", text: `${prefix}\n\n${block.text}` };
  return next;
}
