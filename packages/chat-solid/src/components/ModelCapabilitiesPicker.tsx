/**
 * ModelCapabilitiesPicker — compact effort + fast-mode selector that
 * sits adjacent to the ProviderModelPicker in the chat header.
 *
 * Reads the active model's `capabilities` (surfaced by the daemon's
 * `provider-discovery`) and renders:
 *   - a reasoning-effort `<select>` when `reasoningEfforts` is
 *     non-empty,
 *   - a fast-mode checkbox when `supportsFastMode` is true.
 *
 * Hidden entirely when the active model declares neither — keeps the
 * header chrome quiet for providers/models that don't surface these.
 *
 * Mirrors t3's `mapCodexModelCapabilities`
 * (`context/t3code/apps/server/src/provider/Layers/CodexProvider.ts:96-137`):
 * the descriptor IDs `reasoningEffort` + `fastMode` match the wire
 * shape t3 ships, so a future migration to the full descriptor schema
 * is additive.
 *
 * Persistence is delegated to the caller (host owns the per-thread ×
 * model store). The picker is a pure render: it reads `value()` and
 * fires `onChange(id, value)` — no side-effects.
 */

import { createMemo, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import type { ProviderModelCapabilities } from "../api";

const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Max",
};

function effortLabel(effort: string): string {
  return EFFORT_LABELS[effort] ?? effort;
}

export interface ModelCapabilitiesPickerProps {
  capabilities: Accessor<ProviderModelCapabilities | undefined>;
  /** Current reasoning effort selection. Falls back to the model's
   *  defaultReasoningEffort when null. */
  effort: Accessor<string | null>;
  /** Current fast-mode flag. */
  fastMode: Accessor<boolean>;
  onChange: (id: "reasoningEffort", value: string) => void;
  onToggleFastMode: (next: boolean) => void;
  disabled?: Accessor<boolean>;
}

export function ModelCapabilitiesPicker(props: ModelCapabilitiesPickerProps) {
  const efforts = createMemo<string[]>(() => {
    const caps = props.capabilities();
    return caps?.reasoningEfforts ?? [];
  });
  const supportsFastMode = createMemo<boolean>(
    () => props.capabilities()?.supportsFastMode === true,
  );
  const effortValue = createMemo<string>(() => {
    const explicit = props.effort();
    if (explicit) return explicit;
    return props.capabilities()?.defaultReasoningEffort ?? "";
  });
  const visible = createMemo<boolean>(() => efforts().length > 0 || supportsFastMode());
  const isDisabled = (): boolean => props.disabled?.() ?? false;

  return (
    <Show when={visible()}>
      <div data-testid="model-capabilities-picker" class="flex items-center gap-1.5">
        <Show when={efforts().length > 0}>
          <label
            class="flex items-center gap-1 rounded-md border border-border-weak bg-surface px-1.5 py-0.5 text-sm text-dim"
            title="Reasoning effort"
          >
            <span aria-hidden="true">⚡</span>
            <select
              data-testid="reasoning-effort-select"
              class="border-0 bg-transparent text-sm text-fg outline-none disabled:cursor-not-allowed disabled:opacity-50"
              value={effortValue()}
              disabled={isDisabled()}
              onChange={(event) => props.onChange("reasoningEffort", event.currentTarget.value)}
            >
              <For each={efforts()}>
                {(level) => <option value={level}>{effortLabel(level)}</option>}
              </For>
            </select>
          </label>
        </Show>
        <Show when={supportsFastMode()}>
          <label
            class="flex items-center gap-1 rounded-md border border-border-weak bg-surface px-1.5 py-0.5 text-sm text-dim"
            title="Fast mode (lower latency)"
          >
            <input
              data-testid="fast-mode-toggle"
              type="checkbox"
              class="h-3 w-3 accent-[var(--accent)]"
              checked={props.fastMode()}
              disabled={isDisabled()}
              onChange={(event) => props.onToggleFastMode(event.currentTarget.checked)}
            />
            <span class="text-fg">Fast</span>
          </label>
        </Show>
      </div>
    </Show>
  );
}
