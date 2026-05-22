/**
 * `deriveComposerProviderState` (pure) + the Solid context wrapper.
 *
 * Pure tests pin the derived fields (promptEffort, selectedTraits,
 * applyUltrathinkChrome). Context tests confirm a child component
 * reads the live snapshot when wrapped in
 * `ComposerProviderStateProvider`.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createSignal, type JSX } from "solid-js";
import { render } from "solid-js/web";
import {
  ComposerProviderStateProvider,
  deriveComposerProviderState,
  useComposerProviderState,
} from "../src/components/composerProviderState";
import type { TraitDescriptor } from "../src/components/TraitsPicker";

const effort: TraitDescriptor = {
  id: "effort",
  label: "Effort",
  type: "select",
  currentValue: "medium",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
    { id: "ultrathink", label: "Ultrathink" },
  ],
};

const thinking: TraitDescriptor = {
  id: "thinking",
  label: "Thinking",
  type: "boolean",
  currentValue: true,
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("deriveComposerProviderState — pure", () => {
  it("surfaces the primary select trait value as promptEffort", () => {
    const snapshot = deriveComposerProviderState({
      provider: "claude-code",
      model: "claude-opus-4-7",
      prompt: "",
      traits: [effort, thinking],
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(snapshot.promptEffort).toBe("medium");
  });

  it("returns null promptEffort when no select trait is present", () => {
    const snapshot = deriveComposerProviderState({
      provider: "codex",
      model: "gpt-5",
      prompt: "",
      traits: [thinking],
      runtimeMode: "approval-required",
      interactionMode: "default",
    });
    expect(snapshot.promptEffort).toBeNull();
  });

  it("compresses selectedTraits to (id, value) pairs", () => {
    const snapshot = deriveComposerProviderState({
      provider: "claude-code",
      model: null,
      prompt: "",
      traits: [effort, thinking],
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(snapshot.selectedTraits).toEqual([
      ["effort", "medium"],
      ["thinking", true],
    ]);
  });

  it("only flags applyUltrathinkChrome when both ultrathinkActive AND a capable trait exist", () => {
    expect(
      deriveComposerProviderState({
        provider: "claude-code",
        model: null,
        prompt: "Ultrathink: refactor auth",
        traits: [effort],
        runtimeMode: "approval-required",
        interactionMode: "default",
        ultrathinkActive: true,
      }).applyUltrathinkChrome,
    ).toBe(true);

    expect(
      deriveComposerProviderState({
        provider: "codex",
        model: null,
        prompt: "Ultrathink: refactor",
        traits: [
          {
            ...effort,
            options: [
              { id: "low", label: "Low" },
              { id: "high", label: "High" },
            ],
          },
        ],
        runtimeMode: "approval-required",
        interactionMode: "default",
        ultrathinkActive: true,
      }).applyUltrathinkChrome,
    ).toBe(false);

    expect(
      deriveComposerProviderState({
        provider: "claude-code",
        model: null,
        prompt: "noop",
        traits: [effort],
        runtimeMode: "approval-required",
        interactionMode: "default",
        ultrathinkActive: false,
      }).applyUltrathinkChrome,
    ).toBe(false);
  });

  it("forwards plan-follow-up + interaction mode + runtime mode through to the snapshot", () => {
    const snapshot = deriveComposerProviderState({
      provider: "claude-code",
      model: null,
      prompt: "",
      traits: [],
      runtimeMode: "full-access",
      interactionMode: "plan",
      showPlanFollowUpPrompt: true,
    });
    expect(snapshot.runtimeMode).toBe("full-access");
    expect(snapshot.interactionMode).toBe("plan");
    expect(snapshot.showPlanFollowUpPrompt).toBe(true);
  });
});

function Probe(): JSX.Element {
  const snapshot = useComposerProviderState();
  return (
    <pre data-testid="composer-provider-state-probe">
      {JSON.stringify(snapshot?.() ?? { context: "missing" })}
    </pre>
  );
}

describe("ComposerProviderStateProvider — reactive", () => {
  it("exposes a live snapshot via context", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);

    const [provider] = createSignal("claude-code");
    const [model, setModel] = createSignal<string | null>("claude-opus-4-7");
    const [prompt] = createSignal("Ultrathink: refactor auth");
    const [traits, setTraits] = createSignal<TraitDescriptor[]>([effort, thinking]);
    const [runtimeMode, setRuntime] = createSignal<
      "approval-required" | "auto-accept-edits" | "full-access"
    >("approval-required");
    const [interactionMode] = createSignal<"default" | "plan">("default");
    const [planFollowUp] = createSignal(false);
    const [ultrathink, setUltra] = createSignal(true);

    const dispose = render(
      () => (
        <ComposerProviderStateProvider
          state={{
            provider,
            model,
            prompt,
            traits,
            runtimeMode,
            interactionMode,
            showPlanFollowUpPrompt: planFollowUp,
            ultrathinkActive: ultrathink,
          }}
        >
          <Probe />
        </ComposerProviderStateProvider>
      ),
      container,
    );

    const probe = container.querySelector("[data-testid='composer-provider-state-probe']");
    const initial = JSON.parse(probe!.textContent!);
    expect(initial.provider).toBe("claude-code");
    expect(initial.promptEffort).toBe("medium");
    expect(initial.applyUltrathinkChrome).toBe(true);
    expect(initial.selectedTraits).toEqual([
      ["effort", "medium"],
      ["thinking", true],
    ]);

    // Reactivity: bump runtime + flip a trait. The probe re-renders
    // and the snapshot reflects the new state.
    setRuntime("full-access");
    setModel("claude-haiku-4-5");
    setTraits([{ ...effort, currentValue: "high" }, thinking]);
    setUltra(false);
    const next = JSON.parse(probe!.textContent!);
    expect(next.runtimeMode).toBe("full-access");
    expect(next.model).toBe("claude-haiku-4-5");
    expect(next.promptEffort).toBe("high");
    expect(next.applyUltrathinkChrome).toBe(false);

    dispose();
  });

  it("returns null from useComposerProviderState outside the provider", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const dispose = render(() => <Probe />, container);
    const probe = container.querySelector("[data-testid='composer-provider-state-probe']");
    expect(JSON.parse(probe!.textContent!)).toEqual({ context: "missing" });
    dispose();
  });
});
