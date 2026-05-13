/**
 * Generic Solid wrapper around the @tmux-ide/v2-solid-widgets `mount*`
 * factories. Each widget exposes a `mount(container, opts)` that calls
 * Solid's `render()` internally and returns a `{ unmount, setOptions }`
 * handle. Hosting them from inside another Solid app means a second
 * `render()` rooted at our container — fine, but we need to forward
 * option updates and run the cleanup on unmount.
 *
 * The host is generic over the option + handle types and accepts an
 * `options` accessor so reactivity flows through `setOptions` whenever
 * the host's data signal changes.
 */

import { createEffect, onCleanup, onMount } from "solid-js";
import type { JSX } from "solid-js";

interface MountHandle<TOpts> {
  unmount(): void;
  setOptions(next: Partial<TOpts>): void;
}

interface WidgetHostProps<TOpts> {
  mount: (container: HTMLElement, opts: TOpts) => MountHandle<TOpts>;
  options: () => TOpts;
  class?: string;
  style?: JSX.CSSProperties | string;
}

export function WidgetHost<TOpts>(props: WidgetHostProps<TOpts>): JSX.Element {
  let container: HTMLDivElement | undefined;
  let handle: MountHandle<TOpts> | null = null;

  onMount(() => {
    if (!container) return;
    handle = props.mount(container, props.options());
  });

  createEffect(() => {
    const next = props.options();
    if (handle) handle.setOptions(next);
  });

  onCleanup(() => {
    handle?.unmount();
    handle = null;
  });

  return (
    <div
      ref={container}
      class={props.class}
      style={props.style}
      data-widget-host="true"
    />
  );
}
