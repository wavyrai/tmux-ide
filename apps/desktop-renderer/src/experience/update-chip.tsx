import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { DesktopUpdateStatus, HostCapabilities } from "@tmux-ide/contracts";

/**
 * The one quiet titlebar affordance for a staged update. It appears only when the
 * host reports `phase: "ready"` — a verified update is staged and will apply on
 * the next launch — and otherwise renders nothing. No modal, no countdown, no
 * auto-restart: it is a calm, non-interactive status pill in the shared visual
 * language. The host owns the whole mechanism; this reads a coarse status and
 * shows a single line.
 */
export function UpdateChip(props: { readonly host: HostCapabilities }): ReturnType<typeof Show> {
  const [status, setStatus] = createSignal<DesktopUpdateStatus | null>(null);

  onMount(() => {
    let disposed = false;
    void props.host.update
      .getStatus()
      .then((initial) => {
        if (!disposed) setStatus(initial);
      })
      .catch(() => undefined);
    const unsubscribe = props.host.update.onStatusChanged((next) => setStatus(next));
    onCleanup(() => {
      disposed = true;
      unsubscribe();
    });
  });

  const ready = () => status()?.phase === "ready";

  return (
    <Show when={ready() ? status() : null}>
      {(current) => (
        <div
          class="titlebar__update-chip"
          role="status"
          aria-live="polite"
          title={`Version ${current().availableVersion ?? ""} is staged. Restart tmux-ide to apply it.`.trim()}
        >
          <span class="titlebar__update-chip-dot" aria-hidden="true" />
          <span class="titlebar__update-chip-label">
            Update ready
            <Show when={current().availableVersion}>
              {(version) => <span class="titlebar__update-chip-version"> · v{version()}</span>}
            </Show>
          </span>
          <span class="titlebar__update-chip-hint">restart to apply</span>
        </div>
      )}
    </Show>
  );
}
