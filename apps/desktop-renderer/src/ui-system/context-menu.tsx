import {
  For,
  Show,
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";

import { createRuntimeStyleBinding, type RuntimeStyleBinding } from "../runtime-style.ts";
import {
  initialContextMenuIndex,
  nextContextMenuIndex,
  resolveContextMenuPlacement,
  type ContextMenuNavigationKey,
  type ContextMenuPoint,
} from "./context-menu-geometry.ts";

/**
 * One item as a menu renders it.
 *
 * `disabledReason` is a sentence, not a flag: unavailable items stay on the
 * menu with the reason beside them, because a person who cannot find "close
 * pane" learns nothing and a person who reads "this is the session's last pane"
 * learns the rule. `keyHint` is the binding that performs the same thing
 * elsewhere — the menu is where the keys get taught.
 */
export interface ContextMenuItem {
  readonly id: string;
  readonly label: string;
  /** Extra sentence for assistive technology and the item's tooltip. */
  readonly description?: string;
  readonly disabledReason: string | null;
  /** Destructive items are styled with the danger ink and confirmed inline. */
  readonly destructive?: boolean;
  /** Right-aligned key hint. Null renders an empty slot, never a guessed key. */
  readonly keyHint?: string | null;
  /** A short qualifier printed after the label, e.g. "(app layout)". */
  readonly qualifier?: string | null;
}

export interface ContextMenuSection {
  readonly id: string;
  readonly label?: string | null;
  /** One quiet line under the section heading; where a section's scope is stated. */
  readonly note?: string | null;
  readonly items: readonly ContextMenuItem[];
}

/**
 * How the menu was opened, which decides when it starts accepting activations.
 *
 * The tmux lesson this repo already paid for: a menu opened from a button PRESS
 * is dismissed by the user's own RELEASE. The DOM version of the same mistake is
 * a menu that opens on `contextmenu` (which fires on press on macOS) and then
 * treats the release that ends the very same gesture as a click on whatever item
 * landed under the pointer. `"contextmenu"` therefore waits for that release
 * before arming; `"click"` and `"keyboard"` have no pending release to wait for.
 */
export type ContextMenuOpenSource = "contextmenu" | "click" | "keyboard";

export interface ContextMenuProps {
  readonly open: boolean;
  /** Viewport coordinates of the pointer (or of the anchor, for a button). */
  readonly pointer: ContextMenuPoint;
  readonly label: string;
  readonly sections: readonly ContextMenuSection[];
  readonly openSource?: ContextMenuOpenSource;
  readonly onClose: () => void;
  readonly onActivate: (itemId: string, source: "mouse" | "keyboard") => void;
  readonly class?: string;
  /** Test/fixture seam; production mounts to the nearest overlay root. */
  readonly mount?: HTMLElement;
}

interface FlatItem {
  readonly item: ContextMenuItem;
  readonly sectionId: string;
}

function flatten(sections: readonly ContextMenuSection[]): readonly FlatItem[] {
  return sections.flatMap((section) =>
    section.items.map((item) => ({ item, sectionId: section.id })),
  );
}

/**
 * A pointer-anchored menu.
 *
 * Presentational and verb-agnostic: it knows about labels, reasons, key hints
 * and destruction, and nothing about tmux. Callers build the sections (see
 * `experience/multiplexer-verb-menu.ts`) and perform the effect.
 */
export function ContextMenu(props: ContextMenuProps): JSX.Element {
  const id = `tmi-context-menu-${createUniqueId()}`;
  const [armed, setArmed] = createSignal(false);
  const [activeIndex, setActiveIndex] = createSignal<number | null>(null);
  const [confirmingId, setConfirmingId] = createSignal<string | null>(null);
  const [positioned, setPositioned] = createSignal(false);
  let menu: HTMLDivElement | undefined;
  let anchor: HTMLSpanElement | undefined;
  let runtimeStyle: RuntimeStyleBinding | null = null;

  onCleanup(() => runtimeStyle?.dispose());

  const items = () => flatten(props.sections);
  const isEnabled = (item: ContextMenuItem): boolean => item.disabledReason === null;

  const position = () => {
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const placement = resolveContextMenuPlacement(
      props.pointer,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    runtimeStyle?.update({
      left: `${placement.left}px`,
      top: `${placement.top}px`,
      "transform-origin": `${placement.originY} ${placement.originX}`,
    });
    setPositioned(true);
  };

  // Opening: place, arm, and take focus. Every one of these is undone on close
  // so a reopened menu never inherits a stale confirm or a stale focus index.
  createEffect(() => {
    if (!props.open) {
      setArmed(false);
      setActiveIndex(null);
      setConfirmingId(null);
      setPositioned(false);
      return;
    }
    const source = props.openSource ?? "contextmenu";
    setConfirmingId(null);
    setActiveIndex(
      source === "keyboard"
        ? initialContextMenuIndex(items().map((entry) => isEnabled(entry.item)))
        : null,
    );
    position();
    const frame = window.requestAnimationFrame(() => {
      position();
      if (source === "keyboard") focusActive();
      else menu?.focus({ preventScroll: true });
    });

    if (source === "contextmenu") {
      // Arm on the release that ends the opening gesture, or on the next fresh
      // press if that release never reaches us (pointer capture elsewhere).
      const arm = () => setArmed(true);
      document.addEventListener("pointerup", arm, { capture: true, once: true });
      document.addEventListener("pointerdown", arm, { capture: true, once: true });
      onCleanup(() => {
        document.removeEventListener("pointerup", arm, { capture: true });
        document.removeEventListener("pointerdown", arm, { capture: true });
      });
    } else {
      setArmed(true);
    }

    const dismissOnOutsidePress = (event: PointerEvent) => {
      if (!armed()) return;
      const target = event.target;
      if (target instanceof Node && menu?.contains(target)) return;
      props.onClose();
    };
    const dismissOnBlur = () => props.onClose();
    document.addEventListener("pointerdown", dismissOnOutsidePress, true);
    window.addEventListener("blur", dismissOnBlur);
    onCleanup(() => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", dismissOnOutsidePress, true);
      window.removeEventListener("blur", dismissOnBlur);
    });
  });

  const focusActive = (): void => {
    const index = activeIndex();
    if (index === null || !menu) return;
    const buttons = menu.querySelectorAll<HTMLButtonElement>("[data-context-menu-item]");
    buttons[index]?.focus({ preventScroll: true });
  };

  const move = (key: ContextMenuNavigationKey): void => {
    setActiveIndex(nextContextMenuIndex(items().length, activeIndex(), key));
    focusActive();
  };

  /**
   * Activation, including the inline confirm.
   *
   * A destructive item asks a second time IN PLACE rather than opening a modal:
   * the object being destroyed stays visible behind the menu, and the second
   * click is one pixel from the first. Any other item, or Escape, cancels the
   * pending confirm — the dangerous state cannot be left armed by wandering off.
   */
  const activate = (item: ContextMenuItem, source: "mouse" | "keyboard"): void => {
    if (!armed() || !isEnabled(item)) return;
    if (item.destructive && confirmingId() !== item.id) {
      setConfirmingId(item.id);
      return;
    }
    setConfirmingId(null);
    props.onActivate(item.id, source);
    props.onClose();
  };

  const handleKeyDown: JSX.EventHandler<HTMLDivElement, KeyboardEvent> = (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key === "Tab") {
      props.onClose();
      return;
    }
    if (
      event.key === "ArrowDown" ||
      event.key === "ArrowUp" ||
      event.key === "Home" ||
      event.key === "End"
    ) {
      event.preventDefault();
      move(event.key);
    }
  };

  return (
    <span ref={(element) => (anchor = element)} class="tmi-context-menu-anchor">
      <Show when={props.open}>
        <Portal
          mount={
            props.mount ??
            anchor?.closest<HTMLElement>("[data-overlay-root]") ??
            anchor?.closest<HTMLElement>(".app, [data-tmi-theme]") ??
            document.body
          }
        >
          <div
            ref={(element) => {
              menu = element;
              runtimeStyle = createRuntimeStyleBinding(element);
              position();
            }}
            id={id}
            class={`tmi-context-menu${props.class ? ` ${props.class}` : ""}`}
            role="menu"
            aria-label={props.label}
            aria-orientation="vertical"
            tabIndex={-1}
            data-positioned={String(positioned())}
            data-armed={String(armed())}
            data-context-menu="true"
            onKeyDown={handleKeyDown}
            onContextMenu={(event) => event.preventDefault()}
          >
            <For each={props.sections}>
              {(section, sectionIndex) => (
                <div
                  class="tmi-context-menu__section"
                  role="group"
                  aria-label={section.label ?? undefined}
                  data-section-id={section.id}
                  data-first={sectionIndex() === 0}
                >
                  <Show when={section.label}>
                    {(label) => (
                      <p class="tmi-context-menu__section-label" aria-hidden="true">
                        {label()}
                      </p>
                    )}
                  </Show>
                  <Show when={section.note}>
                    {(note) => <p class="tmi-context-menu__section-note">{note()}</p>}
                  </Show>
                  <For each={section.items}>
                    {(item) => {
                      const index = () => items().findIndex((entry) => entry.item.id === item.id);
                      const confirming = () => confirmingId() === item.id;
                      const enabled = () => isEnabled(item);
                      return (
                        <button
                          type="button"
                          role="menuitem"
                          class="tmi-context-menu__item"
                          data-context-menu-item={item.id}
                          data-destructive={String(item.destructive === true)}
                          data-confirm-pending={String(confirming())}
                          data-disabled={String(!enabled())}
                          aria-disabled={!enabled()}
                          aria-label={
                            enabled()
                              ? undefined
                              : `${item.label}, unavailable: ${item.disabledReason}`
                          }
                          title={item.disabledReason ?? item.description ?? item.label}
                          tabIndex={index() === activeIndex() ? 0 : -1}
                          data-focus-ring=""
                          onPointerEnter={() => {
                            setActiveIndex(index());
                            if (!confirming()) setConfirmingId(null);
                          }}
                          onFocus={() => setActiveIndex(index())}
                          onClick={(event) =>
                            activate(item, event.detail === 0 ? "keyboard" : "mouse")
                          }
                        >
                          <span class="tmi-context-menu__item-label">
                            {confirming()
                              ? `Confirm ${item.label.toLocaleLowerCase()}`
                              : item.label}
                            <Show when={item.qualifier}>
                              {(qualifier) => (
                                <small class="tmi-context-menu__item-qualifier">
                                  {qualifier()}
                                </small>
                              )}
                            </Show>
                          </span>
                          <Show when={!enabled()}>
                            <small class="tmi-context-menu__item-reason">
                              {item.disabledReason}
                            </small>
                          </Show>
                          <Show when={enabled() && confirming()}>
                            <small class="tmi-context-menu__item-reason" role="alert">
                              This cannot be undone. Click again.
                            </small>
                          </Show>
                          <kbd class="tmi-context-menu__item-key" aria-hidden={!item.keyHint}>
                            {item.keyHint ?? ""}
                          </kbd>
                        </button>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
        </Portal>
      </Show>
    </span>
  );
}
