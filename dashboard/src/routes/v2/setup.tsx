/**
 * /v2/setup — Solid port of `dashboard/app/v2/setup/page.tsx`.
 *
 * Four-step wizard: detect → layout → naming → review. Same daemon
 * endpoints as the React version (`/api/filesystem/inspect`,
 * `/api/projects/onboard`, then the `project.launch` action). Layout
 * + step-gating logic is identical so any agent muscle-memory from
 * the React UI carries over.
 *
 * Solid translation:
 *   - React `useReducer` → `createStore` with action-style mutators
 *   - `useRouter().push` → `useNavigate()` from @solidjs/router
 *   - Effect-wrapped API calls (`inspectDirectory`, `onboardProject`,
 *     `dispatchAction`) run via `Effect.runPromise`.
 */

import { createMemo, For, Show, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { A, useNavigate } from "@solidjs/router";
import { Effect } from "effect";
import {
  dispatchAction,
  inspectDirectory,
  onboardProject,
  type ProjectInspect,
  type ProjectInspectDetected,
} from "@/lib/api";

type StepId = "detect" | "layout" | "naming" | "review";

interface LayoutOption {
  id: "dual-claude" | "triple-claude" | "single-claude";
  label: string;
  description: string;
  agents: number;
  diagram: string[];
}

const LAYOUTS: LayoutOption[] = [
  {
    id: "dual-claude",
    label: "Dual Claude",
    description: "Two Claude panes on top; dev server + shell below.",
    agents: 2,
    diagram: [
      "┌─────────────────┬─────────────────┐",
      "│    Claude 1     │    Claude 2     │  70%",
      "├─────────────────┼─────────────────┤",
      "│   Dev Server    │     Shell       │  30%",
      "└─────────────────┴─────────────────┘",
    ],
  },
  {
    id: "triple-claude",
    label: "Triple Claude",
    description: "Three Claude panes on top; dev server + shell below.",
    agents: 3,
    diagram: [
      "┌──────────┬──────────┬──────────┐",
      "│ Claude 1 │ Claude 2 │ Claude 3 │  70%",
      "├──────────┴────┬─────┴──────────┤",
      "│  Dev Server   │     Shell      │  30%",
      "└───────────────┴────────────────┘",
    ],
  },
  {
    id: "single-claude",
    label: "Single Claude",
    description: "One wide Claude pane; dev server, tests, shell below.",
    agents: 1,
    diagram: [
      "┌─────────────────────────────────┐",
      "│           Claude                │  60%",
      "├─────────┬─────────┬─────────────┤",
      "│ Dev Srv │  Tests  │    Shell    │  40%",
      "└─────────┴─────────┴─────────────┘",
    ],
  },
];

const STEPS: { id: StepId; label: string }[] = [
  { id: "detect", label: "1. Detect" },
  { id: "layout", label: "2. Layout" },
  { id: "naming", label: "3. Agents" },
  { id: "review", label: "4. Review" },
];

interface SetupState {
  step: StepId;
  dir: string;
  inspect: ProjectInspect | null;
  inspectError: string | null;
  inspectLoading: boolean;
  layoutId: LayoutOption["id"];
  projectName: string;
  projectNameTouched: boolean;
  agentNames: string[];
  saving: boolean;
  saveError: string | null;
  savedName: string | null;
  launching: boolean;
  launchError: string | null;
}

function defaultAgentNames(layoutId: LayoutOption["id"]): string[] {
  const layout = LAYOUTS.find((l) => l.id === layoutId)!;
  if (layout.agents === 1) return ["Claude"];
  return Array.from({ length: layout.agents }, (_, i) => `Claude ${i + 1}`);
}

const INITIAL_STATE: SetupState = {
  step: "detect",
  dir: "",
  inspect: null,
  inspectError: null,
  inspectLoading: false,
  layoutId: "dual-claude",
  projectName: "",
  projectNameTouched: false,
  agentNames: defaultAgentNames("dual-claude"),
  saving: false,
  saveError: null,
  savedName: null,
  launching: false,
  launchError: null,
};

function computeCanAdvance(state: SetupState): boolean {
  switch (state.step) {
    case "detect":
      return state.inspect !== null;
    case "layout":
      return true;
    case "naming":
      return (
        state.projectName.trim().length > 0 && state.agentNames.every((n) => n.trim().length > 0)
      );
    case "review":
      return false;
  }
}

function canStepDirectly(state: SetupState, target: StepId): boolean {
  const order = STEPS.map((s) => s.id);
  const idx = order.indexOf(target);
  for (let i = 0; i < idx; i += 1) {
    const sId = order[i];
    if (sId === "detect" && state.inspect === null) return false;
    if (
      sId === "naming" &&
      (state.projectName.trim().length === 0 || state.agentNames.some((n) => !n.trim()))
    ) {
      return false;
    }
  }
  return true;
}

export default function SetupRoute() {
  const navigate = useNavigate();
  const [state, set] = createStore<SetupState>(structuredClone(INITIAL_STATE));

  function gotoStep(step: StepId) {
    set("step", step);
  }

  async function handleDetect() {
    if (!state.dir.trim()) return;
    set({ inspectLoading: true, inspectError: null });
    try {
      const inspect = await Effect.runPromise(inspectDirectory(state.dir.trim()));
      set({
        inspectLoading: false,
        inspect,
        projectName: state.projectNameTouched ? state.projectName : inspect.name,
      });
    } catch (err) {
      set({
        inspectLoading: false,
        inspectError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleSaveAndLaunch() {
    if (!state.inspect) return;
    const layout = LAYOUTS.find((l) => l.id === state.layoutId)!;
    set({ saving: true, saveError: null });
    try {
      const project = await Effect.runPromise(
        onboardProject({
          dir: state.inspect.dir,
          name: state.projectName.trim() || state.inspect.name,
          agents: layout.agents,
          agentNames: state.agentNames.map((n) => n.trim()).filter(Boolean),
          devCommand: state.inspect.detected.devCommand,
          testCommand: state.inspect.detected.testCommand,
        }),
      );
      set({ saving: false, savedName: project.name });

      set({ launching: true, launchError: null });
      try {
        await Effect.runPromise(dispatchAction("project.launch", { name: project.name }));
        set({ launching: false });
        navigate(`/v2/project/${encodeURIComponent(project.name)}`);
      } catch (err) {
        set({
          launching: false,
          launchError: err instanceof Error ? err.message : String(err),
        });
      }
    } catch (err) {
      set({
        saving: false,
        saveError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const currentLayout = createMemo(() => LAYOUTS.find((l) => l.id === state.layoutId)!);
  const stepIndex = createMemo(() => STEPS.findIndex((s) => s.id === state.step));
  const canAdvance = createMemo(() => computeCanAdvance(state));

  return (
    <div class="font-sans flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]">
      <header class="flex h-9 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-strong)] px-4 text-xs tabular-nums">
        <A
          href="/v2"
          class="mr-2 inline-flex items-center gap-1 text-[var(--dim)] hover:text-[var(--fg)]"
        >
          <span aria-hidden="true">◇</span>
          <span>tmux-ide</span>
        </A>
        <span class="mx-1 text-[var(--dimmer)]">/</span>
        <span class="text-[var(--accent)]">setup</span>
        <span class="flex-1" />
        <span class="text-[var(--dim)]">
          step {stepIndex() + 1} of {STEPS.length}
        </span>
      </header>

      <div class="flex-1 min-h-0 overflow-y-auto p-4 sm:p-5">
        <div class="mx-auto max-w-3xl space-y-4">
          <StepTabs
            steps={STEPS}
            currentStep={state.step}
            stepIndex={stepIndex()}
            canStepDirectly={(target) => canStepDirectly(state, target)}
            onSelect={gotoStep}
          />

          <Show when={state.step === "detect"}>
            <DetectPanel
              dir={state.dir}
              inspectLoading={state.inspectLoading}
              inspectError={state.inspectError}
              inspect={state.inspect}
              onDir={(dir) => set({ dir, inspectError: null })}
              onDetect={handleDetect}
            />
          </Show>
          <Show when={state.step === "layout"}>
            <LayoutPanel
              currentId={state.layoutId}
              onSelect={(layoutId) => set({ layoutId, agentNames: defaultAgentNames(layoutId) })}
            />
          </Show>
          <Show when={state.step === "naming"}>
            <NamingPanel
              projectName={state.projectName}
              agentNames={state.agentNames}
              onProjectName={(name) => set({ projectName: name, projectNameTouched: true })}
              onAgentName={(index, name) => set("agentNames", index, name)}
            />
          </Show>
          <Show when={state.step === "review"}>
            <ReviewPanel state={state} layout={currentLayout()} />
          </Show>
        </div>
      </div>

      <footer class="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--bg-strong)] px-4 py-2.5">
        <SetupButton
          variant="secondary"
          onClick={() => {
            const prev = STEPS[stepIndex() - 1];
            if (prev) gotoStep(prev.id);
          }}
          disabled={stepIndex() === 0}
        >
          Back
        </SetupButton>
        <span class="flex-1" />
        <Show
          when={state.step !== "review"}
          fallback={
            <SetupButton
              data-testid="setup-save-and-launch"
              onClick={handleSaveAndLaunch}
              disabled={state.saving || state.launching || !!state.savedName}
            >
              {state.saving
                ? "Saving..."
                : state.launching
                  ? "Launching..."
                  : state.savedName
                    ? "Done"
                    : "Save & Launch"}
            </SetupButton>
          }
        >
          <SetupButton
            data-testid="setup-next"
            onClick={() => {
              const next = STEPS[stepIndex() + 1];
              if (next && canAdvance()) gotoStep(next.id);
            }}
            disabled={!canAdvance()}
          >
            Next
          </SetupButton>
        </Show>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------

interface StepTabsProps {
  steps: { id: StepId; label: string }[];
  currentStep: StepId;
  stepIndex: number;
  canStepDirectly: (target: StepId) => boolean;
  onSelect: (step: StepId) => void;
}

function StepTabs(props: StepTabsProps) {
  return (
    <div
      data-testid="setup-step-tabs"
      class="inline-flex rounded-md border border-[var(--border)] bg-[var(--surface)] p-0.5"
    >
      <For each={props.steps}>
        {(s, i) => {
          const selected = () => s.id === props.currentStep;
          const reachable = () => i() <= props.stepIndex || props.canStepDirectly(s.id);
          return (
            <button
              type="button"
              data-testid={`setup-step-tab-${s.id}`}
              disabled={!reachable()}
              data-selected={selected() ? "true" : "false"}
              onClick={() => reachable() && props.onSelect(s.id)}
              class={`rounded px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                selected()
                  ? "bg-[var(--accent)] text-[var(--bg)]"
                  : "text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
              }`}
            >
              {s.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

function SetupCard(props: { title: string; children: JSX.Element }) {
  return (
    <section class="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
      <h2 class="mb-3 text-[10px] uppercase tracking-[0.14em] text-[var(--dim)]">{props.title}</h2>
      {props.children}
    </section>
  );
}

function SetupRow(props: { children: JSX.Element }) {
  return <div class="flex items-center justify-between gap-3 py-1 text-xs">{props.children}</div>;
}

function SetupInput(props: {
  label: string;
  value: string;
  placeholder?: string;
  onInput: (v: string) => void;
  "data-testid"?: string;
}) {
  return (
    <label class="block">
      <span class="mb-1 block text-[11px] text-[var(--dim)]">{props.label}</span>
      <input
        type="text"
        spellcheck={false}
        autocomplete="off"
        value={props.value}
        placeholder={props.placeholder}
        data-testid={props["data-testid"]}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        class="block w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 text-xs text-[var(--fg)] placeholder:text-[var(--dimmer)] focus:border-[var(--accent)] focus:outline-none"
      />
    </label>
  );
}

function SetupButton(props: {
  variant?: "primary" | "secondary";
  onClick?: () => void;
  disabled?: boolean;
  "data-testid"?: string;
  children: JSX.Element;
}) {
  const variant = () => props.variant ?? "primary";
  return (
    <button
      type="button"
      data-testid={props["data-testid"]}
      onClick={props.onClick}
      disabled={props.disabled}
      class={
        "h-7 shrink-0 cursor-pointer rounded-md px-2.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        (variant() === "primary"
          ? "bg-[var(--accent)] text-[var(--bg)] hover:opacity-90"
          : "border border-[var(--border)] bg-[var(--surface)] text-[var(--fg)] hover:bg-[var(--surface-hover)]")
      }
    >
      {props.children}
    </button>
  );
}

// ---------------------------------------------------------------------
// Step panels
// ---------------------------------------------------------------------

interface DetectPanelProps {
  dir: string;
  inspectLoading: boolean;
  inspectError: string | null;
  inspect: ProjectInspect | null;
  onDir: (dir: string) => void;
  onDetect: () => void;
}

function DetectPanel(props: DetectPanelProps) {
  return (
    <SetupCard title="Detect project">
      <p class="mb-3 text-xs text-[var(--dim)]">
        Point the wizard at a directory. The daemon inspects it and reports the package manager,
        frameworks, and detected dev/test commands.
      </p>
      <SetupInput
        label="Directory"
        placeholder="/Users/me/Developer/my-project"
        value={props.dir}
        onInput={props.onDir}
        data-testid="setup-detect-dir"
      />
      <div class="mt-3 flex items-center justify-between gap-3">
        <span class="text-[11px] text-[var(--dim)]">
          {props.inspectLoading ? "Inspecting..." : ""}
        </span>
        <SetupButton
          onClick={props.onDetect}
          disabled={!props.dir.trim() || props.inspectLoading}
          data-testid="setup-detect-run"
        >
          {props.inspectLoading ? "..." : "Inspect"}
        </SetupButton>
      </div>

      <Show when={props.inspectError}>
        <p class="mt-2 text-xs text-[var(--red-foreground,var(--red))]">{props.inspectError}</p>
      </Show>

      <Show when={props.inspect}>
        {(insp) => <DetectSummary detected={insp().detected} hasIdeYml={insp().hasIdeYml} />}
      </Show>
    </SetupCard>
  );
}

function DetectSummary(props: { detected: ProjectInspectDetected; hasIdeYml: boolean }) {
  return (
    <div class="mt-3 space-y-1">
      <SetupRow>
        <span class="text-[var(--dim)]">Package manager</span>
        <span>{props.detected.packageManager ?? "—"}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Frameworks</span>
        <span>
          {props.detected.frameworks.length > 0 ? props.detected.frameworks.join(", ") : "—"}
        </span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Dev command</span>
        <span>{props.detected.devCommand ?? "—"}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Test command</span>
        <span>{props.detected.testCommand ?? "—"}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Existing ide.yml</span>
        <span>{props.hasIdeYml ? "yes (will be replaced)" : "no"}</span>
      </SetupRow>
    </div>
  );
}

function LayoutPanel(props: {
  currentId: LayoutOption["id"];
  onSelect: (id: LayoutOption["id"]) => void;
}) {
  return (
    <SetupCard title="Pick layout">
      <p class="mb-3 text-xs text-[var(--dim)]">
        Choose the pane arrangement. You can edit ide.yml later.
      </p>
      <div class="space-y-2">
        <For each={LAYOUTS}>
          {(layout) => {
            const selected = () => layout.id === props.currentId;
            return (
              <button
                type="button"
                data-testid={`setup-layout-${layout.id}`}
                data-selected={selected() ? "true" : "false"}
                onClick={() => props.onSelect(layout.id)}
                class={
                  "block w-full rounded-md border px-3 py-2 text-left transition-colors " +
                  (selected()
                    ? "border-[var(--accent)] bg-[var(--surface-active)]"
                    : "border-[var(--border)] bg-[var(--bg-strong)] hover:bg-[var(--surface-hover)]")
                }
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="text-sm font-medium text-[var(--fg)]">{layout.label}</span>
                  <span class="text-[11px] text-[var(--dim)]">{layout.agents} agents</span>
                </div>
                <p class="mt-1 text-[11px] text-[var(--dim)]">{layout.description}</p>
                <pre class="mt-2 overflow-x-auto font-mono text-[10px] leading-tight text-[var(--fg-secondary)]">
                  {layout.diagram.join("\n")}
                </pre>
              </button>
            );
          }}
        </For>
      </div>
    </SetupCard>
  );
}

function NamingPanel(props: {
  projectName: string;
  agentNames: string[];
  onProjectName: (name: string) => void;
  onAgentName: (index: number, name: string) => void;
}) {
  return (
    <SetupCard title="Name agents">
      <p class="mb-3 text-xs text-[var(--dim)]">Pick a session name and per-agent pane titles.</p>
      <SetupInput
        label="Session name"
        placeholder="my-project"
        value={props.projectName}
        onInput={props.onProjectName}
        data-testid="setup-naming-project"
      />
      <div class="mt-3 space-y-2">
        <For each={props.agentNames}>
          {(name, i) => (
            <SetupInput
              label={`Agent ${i() + 1}`}
              value={name}
              onInput={(v) => props.onAgentName(i(), v)}
              data-testid={`setup-naming-agent-${i()}`}
            />
          )}
        </For>
      </div>
    </SetupCard>
  );
}

function ReviewPanel(props: { state: SetupState; layout: LayoutOption }) {
  return (
    <SetupCard title="Review">
      <SetupRow>
        <span class="text-[var(--dim)]">Directory</span>
        <span class="truncate">{props.state.inspect?.dir ?? "—"}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Session name</span>
        <span>{props.state.projectName.trim() || props.state.inspect?.name || "—"}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Layout</span>
        <span>{props.layout.label}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Agents</span>
        <span>{props.state.agentNames.join(", ")}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Dev command</span>
        <span>{props.state.inspect?.detected.devCommand ?? "—"}</span>
      </SetupRow>
      <SetupRow>
        <span class="text-[var(--dim)]">Test command</span>
        <span>{props.state.inspect?.detected.testCommand ?? "—"}</span>
      </SetupRow>

      <Show when={props.state.saveError}>
        <p class="mt-3 text-xs text-[var(--red-foreground,var(--red))]">
          Save failed: {props.state.saveError}
        </p>
      </Show>
      <Show when={props.state.launchError}>
        <p class="mt-3 text-xs text-[var(--red-foreground,var(--red))]">
          Launch failed: {props.state.launchError}
        </p>
      </Show>
      <Show when={props.state.savedName && !props.state.launchError}>
        <p class="mt-3 text-xs text-[var(--green-foreground,var(--green))]">
          Saved {props.state.savedName}. Launching session…
        </p>
      </Show>
    </SetupCard>
  );
}
