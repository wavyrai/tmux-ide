# Learn from t3code @ d1e85c4e (v0.0.24)

Read-only audit of the upstream refresh, with a tight lens on **Codex / newer Codex model support**. Constraints respected: Solid-first (patterns only, no React JSX port), daemon is SoT, no worktrees, vendored CLAUDE.md/AGENTS.md/CODEX.md inside `context/t3code/` are reference data only.

## #1 — PORT-NOW. Per-turn `reasoningEffort` + `fastMode` (serviceTier) on Codex

**Single highest-leverage Codex improvement.** Newer Codex models (`gpt-5.4`, `gpt-5.3-codex`, `gpt-5.3-codex-spark`) expose `supportedReasoningEfforts` and `additionalSpeedTiers: ["fast"]` in `model/list`. t3 wires both end-to-end:

- t3 derives per-model UI capabilities from the live `model/list` response: `mapCodexModelCapabilities` builds `optionDescriptors` with a `select` for reasoning (none/minimal/low/medium/high/xhigh) and a `boolean` for Fast Mode — `context/t3code/apps/server/src/provider/Layers/CodexProvider.ts:96-137`.
- t3 forwards both per turn: `effort: ...` and `serviceTier: "fast"` go into `turn/start` only if the user selection matches the bound instance — `context/t3code/apps/server/src/provider/Layers/CodexAdapter.ts:1509-1530`.
- The contract that carries the selection between client and server is a normalized `Array<{id,value}>` with legacy-object back-compat baked into the schema — `context/t3code/packages/contracts/src/model.ts:40-128`.

What we have:

- `packages/daemon/src/chat/provider-discovery.ts:162-192` parses `model/list` but throws away `supportedReasoningEfforts`, `additionalSpeedTiers`, `defaultReasoningEffort`. Only `hidden` and `isDefault` survive.
- `packages/daemon/src/codex/schema.ts:76,82` already types `effort` and `serviceTier` on `SendUserMessageRequest` — wire is ready.
- `packages/daemon/src/chat/dispatch-prompt.ts:55-59` only forwards `model`. No `effort`, no `serviceTier`.
- `packages/daemon/src/chat/provider-capabilities.ts` has a _static_ `reasoningEffort` field per provider kind — never crossed with the live per-model data, never reaches dispatch.

Port plan (minimum viable):

1. Extend `ProviderModelInfoZ` in `packages/contracts/src/actions-contract.ts:591` with an optional `capabilities: { reasoningEfforts?: string[]; defaultReasoningEffort?: string; supportsFastMode?: boolean }`.
2. Stop dropping fields in `parseCodexModelListResponse` (`provider-discovery.ts:162`); surface the three above.
3. Add `providerOptions?: { reasoningEffort?: string; fastMode?: boolean }` to `ChatSessionSendInputZ` (`actions-contract.ts:673`) — Step 3b already established the precedent of per-turn settings.
4. Forward in `dispatch-prompt.ts:55` as `effort` / `serviceTier: "fast"`.
5. Dashboard model picker (Solid) reads `models[i].capabilities` to render the select + toggle — match t3's UX without porting JSX.

This unlocks the **xhigh** reasoning tier on `gpt-5.3-codex` and the "fast" service tier on `gpt-5.4` that users currently cannot reach.

## #2 — PORT-NOW. Default model bump + alias map

t3 made `gpt-5.4` the new Codex default (`context/t3code/packages/contracts/src/model.ts:135-143`) and ships a slug alias map (`model.ts:155-194`) so `gpt-5-codex` → `gpt-5.4`, `5.3` → `gpt-5.3-codex`, `5.3-spark` → `gpt-5.3-codex-spark`, and Claude aliases (`opus` → `claude-opus-4-7`, etc.).

Our static fallback (`packages/daemon/src/chat/provider-discovery.ts:67-70`) still lists only `gpt-5-codex` and `gpt-5.3-codex` — missing `gpt-5.4` and `gpt-5.3-codex-spark`. We also have no alias map, so a user setting `model: "opus"` or `model: "5.4"` silently fails. Add the table to a new helper alongside `provider-discovery.ts` and apply in `dispatch-prompt.ts` before forwarding.

## #3 — QUEUE-V2.5.1. `customModels` in provider settings

t3 lets users add arbitrary Codex model slugs (`context/t3code/packages/contracts/src/settings.ts:194-197`, applied via `appendCustomCodexModels` at `CodexProvider.ts:157-182`). Useful when OpenAI ships a model faster than t3 (or us). We have no settings surface for this — file `packages/contracts/src/actions-contract.ts` would grow a `chat.providers.setCustomModels` action; the daemon merge already has a natural seam at `getCodexModelsCached` (`provider-discovery.ts:279`).

## #4 — SKIP. The "4 in-flight branches" are old snapshots, not new work

`origin/t3code/{summarize-unstaged-changes,vscode-theme-plan,service-analytics-tracking,sync-with-main-1}` are each a _single_ squash commit that's **behind** main (each diff vs `main` shows ~26k insertions / ~33k deletions — i.e. main is ahead). Branch names: diff summarizer for unstaged hunks, VS Code theme planning doc, server/RPC analytics, and a main-sync. None of them ship a feature not already in `main` @ d1e85c4e. The _idea_ behind `summarize-unstaged-changes` (LLM-summarize uncommitted hunks) is relevant to our Diffs view + chat, but the implementation that landed lives in main already (`apps/server/src/checkpointing/Diffs.ts`), so audit that instead if/when we want it — not these branch tips.

## #5 — QUEUE-V2.5.1. Per-`isDefault` model ordering

We already promote the `isDefault` model to index 0 (`provider-discovery.ts:182-190`) — parity. No work needed.

## #6 — SKIP. ChatGPT account subscription label surface

t3's `codexAccountAuthLabel` (`CodexProvider.ts:56-89`) maps ChatGPT plan types (free/go/plus/pro/team/business/enterprise/edu) to friendly strings. Tmux-ide has no UI for this and the only path that uses it is t3's provider settings panel. Skip until we ship a Providers settings tab.

---

**Bottom line:** the single ported item that pays back most is #1 — reasoning effort + fast mode. It's three small contract edits and one dispatch wire, and it's the difference between us looking "supports Codex" and "supports Codex _the way it's meant to be driven_".
