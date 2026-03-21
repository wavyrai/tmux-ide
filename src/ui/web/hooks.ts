import { createSignal, onMount, onCleanup } from "solid-js";

export function useKeyboard(
  handler: (evt: any) => void,
): void {
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
  if (e.key === "ArrowUp") return "up";
  if (e.key === "ArrowDown") return "down";
  if (e.key === "ArrowLeft") return "left";
  if (e.key === "ArrowRight") return "right";
  if (e.key === "Enter") return "return";
  if (e.key === "Escape") return "escape";
  if (e.key === "Backspace") return "backspace";
  if (e.key === "Tab") return "tab";
  if (e.key === "Delete") return "delete";
  if (e.key === " ") return "space";
  return e.key;
}

export function useTerminalDimensions() {
  const [dims, setDims] = createSignal({ width: 80, height: 24 });

  onMount(() => {
    const update = () => {
      // Measure a ch unit by using a temporary element
      const measure = document.createElement("span");
      measure.style.position = "absolute";
      measure.style.visibility = "hidden";
      measure.style.fontFamily =
        "var(--font-family, 'IBM Plex Mono', ui-monospace, monospace)";
      measure.style.fontSize = "var(--font-size, 13px)";
      measure.textContent = "0";
      document.body.appendChild(measure);
      const chWidth = measure.getBoundingClientRect().width;
      document.body.removeChild(measure);

      const lh = parseFloat(
        getComputedStyle(document.documentElement).lineHeight,
      );

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
