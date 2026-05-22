import { createSignal, For, Show } from "solid-js";
import { statusFor, usePlanState } from "../hooks/usePlanState";
import type { PlanEntry } from "../types";

export function PlanCard(props: {
  entries: PlanEntry[];
  onSendPlanRequest?: (markdown: string) => void;
}) {
  const plan = usePlanState(() => props.entries);
  const [adding, setAdding] = createSignal(false);
  const [newStep, setNewStep] = createSignal("");

  function addStep(): void {
    plan.addUserEntry(newStep());
    setNewStep("");
    setAdding(false);
  }

  return (
    <section class="mr-auto max-w-[88%] rounded-md border border-border-weak bg-surface p-2.5">
      <div class="mb-2 flex items-center justify-between gap-2">
        <div class="flex items-center gap-1.5 text-sm text-dim">Plan</div>
        <Show when={props.onSendPlanRequest}>
          {(onSendPlanRequest) => (
            <button
              type="button"
              class="rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg-secondary hover:border-accent hover:text-accent"
              onClick={() => onSendPlanRequest()(plan.exportMarkdown())}
            >
              Send plan to agent
            </button>
          )}
        </Show>
      </div>

      <ul class="m-0 space-y-1.5 p-0">
        <For each={plan.entries()}>
          {(entry, index) => (
            <li class="flex items-start gap-2 text-base text-fg-secondary">
              <button
                type="button"
                class="mt-0.5 h-5 w-5 flex-shrink-0 cursor-pointer rounded border border-border bg-bg text-base leading-none text-fg-secondary hover:border-accent hover:text-accent"
                aria-label={`Cycle status for ${entry.content}`}
                onClick={() => plan.toggleEntry(index())}
              >
                {iconFor(statusFor(entry))}
              </button>
              <span class="min-w-0 flex-1">
                {entry.content}
                <Show when={entry.origin === "user"}>
                  <span class="ml-1 text-dim">(yours)</span>
                </Show>
              </span>
              <Show when={entry.origin === "user"}>
                <button
                  type="button"
                  class="flex-shrink-0 border-0 bg-transparent text-base text-dim hover:text-fg"
                  aria-label={`Remove ${entry.content}`}
                  onClick={() => plan.removeUserEntry(index())}
                >
                  ×
                </button>
              </Show>
              <Show when={entry.priority}>
                {(priority) => (
                  <span class="flex-shrink-0 text-xs uppercase text-dim">{priority()}</span>
                )}
              </Show>
            </li>
          )}
        </For>
      </ul>

      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            class="mt-2 border-0 bg-transparent p-0 text-base text-dim hover:text-accent"
            onClick={() => setAdding(true)}
          >
            + Add step
          </button>
        }
      >
        <div class="mt-2 flex gap-2">
          <input
            class="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-base text-fg outline-none focus:border-accent"
            value={newStep()}
            placeholder="Add a plan step"
            aria-label="New plan step"
            onInput={(event) => setNewStep(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setAdding(false);
                setNewStep("");
                return;
              }
              if (event.key !== "Enter") return;
              event.preventDefault();
              addStep();
            }}
          />
          <button
            type="button"
            class="rounded-md border border-border bg-bg px-2 text-base text-fg-secondary hover:border-accent hover:text-accent"
            onClick={addStep}
          >
            Add
          </button>
        </div>
      </Show>
    </section>
  );
}

function iconFor(status: PlanEntry["status"]): string {
  if (status === "completed") return "✓";
  if (status === "in_progress") return "…";
  return "○";
}
