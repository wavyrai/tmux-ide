import { createSignal, onMount, onCleanup } from "solid-js";

/** Synthetic key event passed to handlers (mirrors OpenTUI naming). */
export interface UiKeyEvent {
  name: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  preventDefault: () => void;
  stopPropagation: () => void;
}

export function useKeyboard(handler: (evt: UiKeyEvent) => void): void {
  onMount(() => {
    const listener = (e: KeyboardEvent) => {
      const evt = {
        name: mapKeyName(e),
        ctrl: e.ctrlKey,
        shift: e.shiftKey,
        alt: e.altKey,
        meta: e.metaKey,
        preventDefault: () => e.preventDefault(),
        stopPropagation: () => e.stopPropagation(),
      };
      handler(evt);
    };
    document.addEventListener("keydown", listener);
    onCleanup(() => document.removeEventListener("keydown", listener));
  });
}

function mapKeyName(e: KeyboardEvent): string {
  switch (e.key) {
    case "ArrowUp":
      return "up";
    case "ArrowDown":
      return "down";
    case "ArrowLeft":
      return "left";
    case "ArrowRight":
      return "right";
    case "Enter":
      return "return";
    case "Escape":
      return "escape";
    case "Backspace":
      return "backspace";
    case "Tab":
      return "tab";
    case "Delete":
      return "delete";
    case " ":
      return "space";
    case "Home":
      return "home";
    case "End":
      return "end";
    case "PageUp":
      return "pageup";
    case "PageDown":
      return "pagedown";
    case "Insert":
      return "insert";
    default:
      // @opentui convention: single-char keys are always lowercase, with shift as a modifier.
      // Browser gives uppercase e.key for Shift+letter (e.g. "G"), so normalize to lowercase.
      if (e.key.length === 1) return e.key.toLowerCase();
      return e.key;
  }
}

export function useTerminalDimensions() {
  const [dims, setDims] = createSignal({ width: 80, height: 24 });

  onMount(() => {
    const update = () => {
      // Measure a ch unit by using a temporary element
      const measure = document.createElement("span");
      measure.style.position = "absolute";
      measure.style.visibility = "hidden";
      measure.style.fontFamily = "var(--font-family, 'IBM Plex Mono', ui-monospace, monospace)";
      measure.style.fontSize = "var(--font-size, 13px)";
      measure.textContent = "0";
      document.body.appendChild(measure);
      const chWidth = measure.getBoundingClientRect().width;
      document.body.removeChild(measure);

      const lh = parseFloat(getComputedStyle(document.documentElement).lineHeight);

      const effectiveCh = chWidth > 0 ? chWidth : 7.8; // fallback
      const effectiveLh = lh > 0 ? lh : 18.2; // fallback

      setDims({
        width: Math.floor(window.innerWidth / effectiveCh),
        height: Math.floor(window.innerHeight / effectiveLh),
      });
    };

    update();
    window.addEventListener("resize", update);
    onCleanup(() => window.removeEventListener("resize", update));
  });

  return dims;
}
