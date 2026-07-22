import {
  For,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  mergeProps,
  on,
  type JSX,
} from "solid-js";

export interface TabItem {
  readonly id: string;
  readonly label: JSX.Element;
  readonly panel: JSX.Element;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly items: readonly TabItem[];
  readonly value?: string;
  readonly defaultValue?: string;
  readonly onValueChange?: (value: string) => void;
  readonly orientation?: "horizontal" | "vertical";
  readonly activationMode?: "automatic" | "manual";
  readonly label: string;
  readonly class?: string;
}

export function Tabs(props: TabsProps): JSX.Element {
  const merged = mergeProps(
    { orientation: "horizontal" as const, activationMode: "automatic" as const },
    props,
  );
  const prefix = `tmi-tabs-${createUniqueId()}`;
  const firstEnabled = () => merged.items.find((item) => !item.disabled)?.id;
  const [internalValue, setInternalValue] = createSignal(merged.defaultValue ?? firstEnabled());
  const selectedValue = createMemo(() => {
    const requested = merged.value ?? internalValue();
    return merged.items.some((item) => item.id === requested && !item.disabled)
      ? requested
      : firstEnabled();
  });
  const [focusedValue, setFocusedValue] = createSignal(selectedValue());
  const rovingValue = createMemo(() => {
    const focused = focusedValue();
    return merged.items.some((item) => item.id === focused && !item.disabled)
      ? focused
      : selectedValue();
  });
  const triggers: Array<HTMLButtonElement | undefined> = [];
  let tablist: HTMLDivElement | undefined;

  createEffect(
    on(selectedValue, (selected) => {
      if (!selected) return;
      const focusInsideTablist = tablist?.contains(document.activeElement) ?? false;
      if (merged.activationMode === "automatic" || !focusInsideTablist) {
        setFocusedValue(selected);
      }
    }),
  );

  const select = (id: string) => {
    if (merged.value === undefined) setInternalValue(id);
    merged.onValueChange?.(id);
  };

  const moveFocus = (from: number, direction: 1 | -1 | "first" | "last") => {
    const enabled = merged.items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.disabled);
    if (enabled.length === 0) return;
    const current = enabled.findIndex(({ index }) => index === from);
    let target: number;
    if (direction === "first") target = 0;
    else if (direction === "last") target = enabled.length - 1;
    else target = (Math.max(current, 0) + direction + enabled.length) % enabled.length;
    const next = enabled[target];
    if (!next) return;
    setFocusedValue(next.item.id);
    triggers[next.index]?.focus();
    if (merged.activationMode === "automatic") select(next.item.id);
  };

  const onKeyDown = (event: KeyboardEvent, index: number, id: string) => {
    if (merged.activationMode === "manual" && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      select(id);
      return;
    }
    const previousKey = merged.orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
    const nextKey = merged.orientation === "vertical" ? "ArrowDown" : "ArrowRight";
    let direction: 1 | -1 | "first" | "last" | undefined;
    if (event.key === previousKey) direction = -1;
    if (event.key === nextKey) direction = 1;
    if (event.key === "Home") direction = "first";
    if (event.key === "End") direction = "last";
    if (direction === undefined) return;
    event.preventDefault();
    moveFocus(index, direction);
  };

  return (
    <div
      class={`tmi-tabs${merged.class ? ` ${merged.class}` : ""}`}
      data-orientation={merged.orientation}
    >
      <div
        ref={(element) => (tablist = element)}
        role="tablist"
        aria-label={merged.label}
        aria-orientation={merged.orientation}
      >
        <For each={merged.items}>
          {(item, index) => {
            const selected = () => selectedValue() === item.id;
            return (
              <button
                ref={(element) => (triggers[index()] = element)}
                id={`${prefix}-tab-${index()}`}
                class="tmi-tabs__trigger"
                type="button"
                role="tab"
                aria-selected={selected()}
                aria-controls={`${prefix}-panel-${index()}`}
                tabIndex={rovingValue() === item.id ? 0 : -1}
                disabled={item.disabled}
                onFocus={() => setFocusedValue(item.id)}
                onClick={() => {
                  setFocusedValue(item.id);
                  select(item.id);
                }}
                onKeyDown={(event) => onKeyDown(event, index(), item.id)}
              >
                {item.label}
              </button>
            );
          }}
        </For>
      </div>
      <For each={merged.items}>
        {(item, index) => (
          <div
            id={`${prefix}-panel-${index()}`}
            class="tmi-tabs__panel"
            role="tabpanel"
            aria-labelledby={`${prefix}-tab-${index()}`}
            tabIndex={0}
            hidden={selectedValue() !== item.id}
          >
            {item.panel}
          </div>
        )}
      </For>
    </div>
  );
}
