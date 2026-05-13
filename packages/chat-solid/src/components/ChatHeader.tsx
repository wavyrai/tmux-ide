import { createMemo, createSignal, Show, type Accessor } from "solid-js";
import type { AgentProvider, ChatThreadUsageSummary, StopReason, ThreadState } from "../types";
import type { ProviderInfo } from "../api";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { ProviderModelPicker } from "./ProviderModelPicker";

interface ChatHeaderProps {
  thread: Accessor<ThreadState | null>;
  inflight: Accessor<boolean>;
  stopReason: Accessor<StopReason | null>;
  usage: Accessor<ChatThreadUsageSummary | null>;
  sessionName: Accessor<string | null>;
  /** Discovered providers used by the right-slot model picker. */
  availableProviders?: Accessor<ReadonlyArray<ProviderInfo>>;
  /** Fires when the picker selects a different provider. */
  onProviderChange?: (next: AgentProvider) => void;
  onCancel(): void;
  onRename(title: string): Promise<void>;
  onClose?: () => void;
}

export function ChatHeader(props: ChatHeaderProps) {
  const [editing, setEditing] = createSignal(false);
  const [draft, setDraft] = createSignal("");

  const activeProvider = createMemo(() => props.thread()?.provider ?? null);
  const providerList = createMemo<ReadonlyArray<ProviderInfo>>(
    () => props.availableProviders?.() ?? [],
  );

  function beginEdit() {
    setDraft(props.thread()?.title ?? "New chat");
    setEditing(true);
  }

  async function commit() {
    const title = draft().trim();
    setEditing(false);
    if (title && title !== props.thread()?.title) await props.onRename(title);
  }

  return (
    <header class="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border-weak bg-surface px-3">
      <Show
        when={editing()}
        fallback={
          <button
            class="min-w-0 flex-1 cursor-text truncate border-0 bg-transparent text-left text-[13px] text-fg outline-none hover:text-accent"
            type="button"
            onClick={beginEdit}
            title="Rename chat"
          >
            {props.thread()?.title ?? "Chat"}
          </button>
        }
      >
        <input
          class="min-w-0 flex-1 truncate border-0 bg-transparent text-[13px] text-fg outline-none"
          value={draft()}
          onInput={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") void commit();
            if (event.key === "Escape") setEditing(false);
          }}
          autofocus
        />
      </Show>
      <ContextWindowMeter usage={props.usage} />
      <Show when={props.availableProviders}>
        <ProviderModelPicker
          provider={activeProvider}
          availableProviders={providerList}
          onChange={(next) => props.onProviderChange?.(next)}
          disabled={props.inflight}
        />
      </Show>
      <Show when={props.sessionName()}>
        {(session) => (
          <span class="inline-flex items-center rounded-md border border-border-weak px-1.5 py-0.5 text-[11px] text-dim">
            {session()}
          </span>
        )}
      </Show>
      <Show when={props.stopReason()}>
        {(reason) => (
          <span class="inline-flex items-center rounded-md border border-border-weak px-1.5 py-0.5 text-[11px] text-dim">
            {reason().replaceAll("_", " ")}
          </span>
        )}
      </Show>
      <Show when={props.inflight()}>
        <button
          class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-fg-secondary hover:border-accent hover:text-accent disabled:cursor-not-allowed disabled:opacity-45"
          type="button"
          onClick={props.onCancel}
        >
          Stop
        </button>
      </Show>
      <Show when={props.onClose}>
        {(onClose) => (
          <button
            class="h-7 cursor-pointer rounded-md border border-border bg-surface px-2 text-[12px] text-fg-secondary hover:border-accent hover:text-accent"
            type="button"
            onClick={onClose()}
          >
            Close
          </button>
        )}
      </Show>
    </header>
  );
}
