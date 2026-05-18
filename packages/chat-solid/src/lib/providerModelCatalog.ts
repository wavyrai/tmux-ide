/**
 * Static per-provider model catalog.
 *
 * chat-solid has no live model-listing API, but the model picker's
 * rich surface (sidebar rail, capability rows, search highlighting)
 * only activates when it's fed real per-instance model rows. This
 * catalog supplies them, keyed by driver kind. It is intentionally
 * editorial / hand-maintained — bump it when a provider ships a new
 * model, the same way `modelPickerModelHighlights` is maintained.
 *
 * Selecting a model still maps to a provider switch on the daemon
 * (there is no per-model transport yet); the chosen slug is tracked
 * client-side so the active row + trigger reflect the pick.
 */

import type { ModelListRowModel } from "../components/ModelListRow";

export const PROVIDER_MODEL_CATALOG: ReadonlyMap<
  string,
  ReadonlyArray<ModelListRowModel>
> = new Map<string, ReadonlyArray<ModelListRowModel>>([
  [
    "claude-code",
    [
      {
        slug: "claude-opus-4-7",
        name: "Claude Opus 4.7",
        shortName: "Opus 4.7",
        subProvider: "1M context · highest capability",
      },
      {
        slug: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        shortName: "Sonnet 4.6",
        subProvider: "Balanced speed + quality",
      },
      {
        slug: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        shortName: "Haiku 4.5",
        subProvider: "Fastest · low cost",
      },
    ],
  ],
  [
    "codex",
    [
      { slug: "gpt-5-codex", name: "GPT-5 Codex", subProvider: "Code-tuned" },
      { slug: "gpt-5", name: "GPT-5", subProvider: "General purpose" },
    ],
  ],
  [
    "gemini",
    [
      { slug: "gemini-2.5-pro", name: "Gemini 2.5 Pro", subProvider: "Long context" },
      { slug: "gemini-2.5-flash", name: "Gemini 2.5 Flash", subProvider: "Fast" },
    ],
  ],
]);

/** Default model slug per driver kind — used to seed the active row. */
export const DEFAULT_MODEL_BY_KIND: ReadonlyMap<string, string> = new Map<string, string>([
  ["claude-code", "claude-opus-4-7"],
  ["codex", "gpt-5-codex"],
  ["gemini", "gemini-2.5-pro"],
]);
