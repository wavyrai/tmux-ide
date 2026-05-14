/**
 * Derives the composer's "provider state" — the bundle of (provider
 * kind, current model, traits, runtime mode, interaction mode, plan
 * follow-up flag) that the composer footer, primary actions, and
 * traits picker all need to read. Exposes both a pure helper and a
 * Solid context so consumers can opt in without prop-drilling 6
 * accessors through the render tree.
 *
 * Pure: `deriveComposerProviderState(input)` returns a plain
 * snapshot object — handy for tests and for ad-hoc reads inside an
 * effect that doesn't want to subscribe to the context.
 *
 * Reactive: `ComposerProviderStateProvider` wraps the composer in a
 * Solid context whose value is a memoized snapshot derived from the
 * supplied accessors. Children read it via `useComposerProviderState()`.
 *
 * Provider-state shape mirrors the upstream surface but stays
 * agnostic — chat-solid doesn't depend on the upstream contracts
 * package. Hosts that use richer model-options can extend
 * `traits` with whatever descriptor list they need.
 */

import {
  createContext,
  createMemo,
  useContext,
  type Accessor,
  type JSX,
} from "solid-js";
import type {
  ProviderInteractionMode,
  RuntimeMode,
} from "./CompactComposerControlsMenu";
import type { TraitDescriptor } from "./TraitsPicker";

export type ComposerProviderKind = "claude-code" | "codex" | "gemini" | (string & {});

export interface ComposerProviderStateInput {
  provider: Accessor<ComposerProviderKind>;
  model: Accessor<string | null>;
  prompt: Accessor<string>;
  /** Live trait descriptors — usually mirrors the TraitsPicker shape. */
  traits: Accessor<ReadonlyArray<TraitDescriptor>>;
  runtimeMode: Accessor<RuntimeMode>;
  interactionMode: Accessor<ProviderInteractionMode>;
  /** When true, a follow-up plan turn is staged. */
  showPlanFollowUpPrompt?: Accessor<boolean>;
  /** When true, the composer renders the "ultrathink" treatment. */
  ultrathinkActive?: Accessor<boolean>;
}

/**
 * Snapshot of the composer's provider state. Stable identity per
 * call so consumers can compare references in createMemo equality
 * checks. The trait-related fields (`promptEffort`, `selectedTraits`)
 * are derived once per snapshot — useful for the footer label.
 */
export interface ComposerProviderStateSnapshot {
  provider: ComposerProviderKind;
  model: string | null;
  prompt: string;
  traits: ReadonlyArray<TraitDescriptor>;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  showPlanFollowUpPrompt: boolean;
  ultrathinkActive: boolean;
  /**
   * Effort tier from the first `select` trait descriptor (typically
   * `effort`). Surfaces as a footer label without the footer having
   * to peek inside `traits`. Null when no select trait is set.
   */
  promptEffort: string | null;
  /**
   * Compressed view of the current trait state — pairs of
   * `(descriptorId, currentValue)`. Stable enough to use as an
   * equality key.
   */
  selectedTraits: ReadonlyArray<readonly [string, string | boolean]>;
  /**
   * Whether the composer should render its "ultrathink" frame
   * chrome. True only when `ultrathinkActive` is true AND a
   * descriptor in `traits` accepts a prompt-injected value.
   */
  applyUltrathinkChrome: boolean;
}

function firstSelectTraitValue(
  traits: ReadonlyArray<TraitDescriptor>,
): string | null {
  for (const descriptor of traits) {
    if (descriptor.type === "select") {
      return descriptor.currentValue;
    }
  }
  return null;
}

function compactSelectedTraits(
  traits: ReadonlyArray<TraitDescriptor>,
): ReadonlyArray<readonly [string, string | boolean]> {
  return traits.map(
    (descriptor) =>
      [
        descriptor.id,
        descriptor.type === "select"
          ? (descriptor.currentValue ?? "")
          : descriptor.currentValue,
      ] as const,
  );
}

/**
 * Pure: produce a snapshot from the raw accessor values. Tests use
 * this directly; the reactive provider memoizes it.
 */
export function deriveComposerProviderState(input: {
  provider: ComposerProviderKind;
  model: string | null;
  prompt: string;
  traits: ReadonlyArray<TraitDescriptor>;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  showPlanFollowUpPrompt?: boolean;
  ultrathinkActive?: boolean;
}): ComposerProviderStateSnapshot {
  const ultrathinkActive = Boolean(input.ultrathinkActive);
  const hasUltrathinkCapableTrait = input.traits.some(
    (descriptor) =>
      descriptor.type === "select" &&
      descriptor.options.some((option) => option.id === "ultrathink"),
  );
  return {
    provider: input.provider,
    model: input.model,
    prompt: input.prompt,
    traits: input.traits,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    showPlanFollowUpPrompt: Boolean(input.showPlanFollowUpPrompt),
    ultrathinkActive,
    promptEffort: firstSelectTraitValue(input.traits),
    selectedTraits: compactSelectedTraits(input.traits),
    applyUltrathinkChrome: ultrathinkActive && hasUltrathinkCapableTrait,
  };
}

const ComposerProviderStateContext = createContext<
  Accessor<ComposerProviderStateSnapshot> | null
>(null);

export function ComposerProviderStateProvider(props: {
  state: ComposerProviderStateInput;
  children: JSX.Element;
}): JSX.Element {
  const snapshot = createMemo<ComposerProviderStateSnapshot>(() =>
    deriveComposerProviderState({
      provider: props.state.provider(),
      model: props.state.model(),
      prompt: props.state.prompt(),
      traits: props.state.traits(),
      runtimeMode: props.state.runtimeMode(),
      interactionMode: props.state.interactionMode(),
      showPlanFollowUpPrompt: props.state.showPlanFollowUpPrompt?.(),
      ultrathinkActive: props.state.ultrathinkActive?.(),
    }),
  );

  return (
    <ComposerProviderStateContext.Provider value={snapshot}>
      {props.children}
    </ComposerProviderStateContext.Provider>
  );
}

/**
 * Read the composer provider-state snapshot from context. Returns
 * `null` outside the provider — call sites that don't want to be
 * tied to the provider should fall through to local accessors.
 */
export function useComposerProviderState(): Accessor<ComposerProviderStateSnapshot> | null {
  return useContext(ComposerProviderStateContext);
}
