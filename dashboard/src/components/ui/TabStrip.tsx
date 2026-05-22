/**
 * TabStrip — unified segmented-tab control for the dashboard.
 *
 * Single visual language for every horizontal tab/segment strip
 * (BottomPanel, diff-mode toggle, setup wizard steps, etc). The
 * Inspector widget in `@tmux-ide/v2-solid-widgets` mirrors this
 * styling inline because it can't import from the dashboard package.
 *
 * Variants:
 *   - "underline" (default): flat row, active tab gets accent text
 *     + 2px accent underline. Use for full-width strips (BottomPanel,
 *     diff toolbar).
 *   - "pill": rounded segmented control inside a bordered surface.
 *     Use for compact, inline step/mode selectors.
 *
 * A11y: `role="tablist"` on the strip + `role="tab"` per item, with
 * `aria-selected` and `tabindex` reflecting the roving-tab-stop
 * pattern. Arrow keys cycle, Home/End jump to ends, Enter/Space
 * activate.
 */

import { For, Show, createMemo, type JSX } from "solid-js";

export interface TabStripItem<Id extends string = string> {
  id: Id;
  label: string;
  icon?: JSX.Element;
  badge?: JSX.Element;
  disabled?: boolean;
}

export type TabStripVariant = "underline" | "pill";

export interface TabStripProps<Id extends string = string> {
  items: ReadonlyArray<TabStripItem<Id>>;
  activeId: Id;
  onSelect: (id: Id) => void;
  variant?: TabStripVariant;
  ariaLabel?: string;
  /** data-testid prefix for each tab — each item gets `${testid}-${id}`. */
  testid?: string;
  /** data-testid for the tablist container itself. Distinct from `testid` to
   *  preserve the legacy `<container>s` / `<item>-{id}` naming used in tests. */
  containerTestid?: string;
  class?: string;
}

export function TabStrip<Id extends string = string>(props: TabStripProps<Id>): JSX.Element {
  const variant = (): TabStripVariant => props.variant ?? "underline";
  const ids = createMemo(() => props.items.map((item) => item.id));

  function focusItem(index: number, container: HTMLElement) {
    const items = container.querySelectorAll<HTMLButtonElement>("[role='tab']");
    const el = items.item(index);
    if (el) el.focus();
  }

  function onKeyDown(event: KeyboardEvent) {
    const target = event.currentTarget as HTMLElement | null;
    if (!target) return;
    const order = ids();
    const activeIdx = order.indexOf(props.activeId);
    const moveTo = (nextIdx: number) => {
      const wrapped = ((nextIdx % order.length) + order.length) % order.length;
      const next = order[wrapped];
      const isDisabled = props.items[wrapped]?.disabled === true;
      if (next && !isDisabled) {
        props.onSelect(next);
        queueMicrotask(() => focusItem(wrapped, target));
      }
    };
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        moveTo(activeIdx === -1 ? order.length - 1 : activeIdx - 1);
        break;
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        moveTo(activeIdx === -1 ? 0 : activeIdx + 1);
        break;
      case "Home":
        event.preventDefault();
        moveTo(0);
        break;
      case "End":
        event.preventDefault();
        moveTo(order.length - 1);
        break;
      default:
    }
  }

  return (
    <Show when={variant() === "pill"} fallback={renderUnderline(props, onKeyDown)}>
      {renderPill(props, onKeyDown)}
    </Show>
  );
}

function renderUnderline<Id extends string>(
  props: TabStripProps<Id>,
  onKeyDown: (event: KeyboardEvent) => void,
): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={props.ariaLabel}
      data-testid={props.containerTestid}
      data-variant="underline"
      onKeyDown={onKeyDown}
      class={
        "flex h-7 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 font-sans text-sm " +
        (props.class ?? "")
      }
    >
      <For each={props.items}>
        {(item) => {
          const active = () => item.id === props.activeId;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active()}
              aria-disabled={item.disabled ? true : undefined}
              tabIndex={active() ? 0 : -1}
              disabled={item.disabled}
              data-testid={props.testid ? `${props.testid}-${item.id}` : undefined}
              data-active={active() ? "true" : undefined}
              onClick={() => !item.disabled && props.onSelect(item.id)}
              class={
                "flex items-center gap-1 self-stretch border-b-2 px-2 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] " +
                (active()
                  ? "border-[var(--accent)] text-[var(--accent)]"
                  : "border-transparent text-[var(--dim)] hover:text-[var(--fg)]")
              }
            >
              <Show when={item.icon}>{item.icon}</Show>
              <span>{item.label}</span>
              <Show when={item.badge}>{item.badge}</Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}

function renderPill<Id extends string>(
  props: TabStripProps<Id>,
  onKeyDown: (event: KeyboardEvent) => void,
): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label={props.ariaLabel}
      data-testid={props.containerTestid}
      data-variant="pill"
      onKeyDown={onKeyDown}
      class={
        "inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface)] p-0.5 font-sans text-sm " +
        (props.class ?? "")
      }
    >
      <For each={props.items}>
        {(item) => {
          const active = () => item.id === props.activeId;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active()}
              aria-disabled={item.disabled ? true : undefined}
              tabIndex={active() ? 0 : -1}
              disabled={item.disabled}
              data-testid={props.testid ? `${props.testid}-${item.id}` : undefined}
              data-active={active() ? "true" : undefined}
              onClick={() => !item.disabled && props.onSelect(item.id)}
              class={
                "flex items-center gap-1 rounded px-2 py-1 transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] " +
                (active()
                  ? "bg-[var(--surface-active)] text-[var(--accent)]"
                  : "text-[var(--dim)] hover:text-[var(--fg)]")
              }
            >
              <Show when={item.icon}>{item.icon}</Show>
              <span>{item.label}</span>
              <Show when={item.badge}>{item.badge}</Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}
