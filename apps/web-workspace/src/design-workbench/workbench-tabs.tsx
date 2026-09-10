import { useEffect, useRef } from "react";
import { GlassIcon } from "../glass-icon";
import { X } from "../icons";
export interface WorkbenchTab {
  id: string;
  name: string;
  command?: string;
  count: number;
}
export function WorkbenchTabs({
  items,
  value,
  onSelect,
  onMove,
  onClose,
}: {
  items: WorkbenchTab[];
  value: string;
  onSelect: (id: string) => void;
  onMove?: (source: string, target: string) => void;
  onClose?: (id: string) => void;
}) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    const strip = nav.current;
    const tab = Array.from(strip?.querySelectorAll<HTMLElement>("[data-window-id]") ?? []).find(
      (el) => el.dataset.windowId === value,
    );
    if (!strip || !tab) return;
    const row = tab.getBoundingClientRect(),
      bounds = strip.getBoundingClientRect();
    if (row.left < bounds.left) strip.scrollLeft -= bounds.left - row.left;
    else if (row.right > bounds.right) strip.scrollLeft += row.right - bounds.right;
  }, [value, items]);
  return (
    <nav ref={nav} className="dw-tabs" aria-label="Windows">
      {items.map((item, index) => (
        <div
          className="dw-tab-group"
          key={item.id}
          data-active={value === item.id}
          draggable={Boolean(onMove)}
          onDragStart={(event) => {
            event.dataTransfer.setData("application/x-workbench-window", item.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("application/x-workbench-window"))
              event.preventDefault();
          }}
          onDrop={(event) => {
            event.preventDefault();
            const source = event.dataTransfer.getData("application/x-workbench-window");
            if (source) onMove?.(source, item.id);
          }}
        >
          <button
            className="dw-tab"
            aria-current={value === item.id ? "page" : undefined}
            onClick={() => onSelect(item.id)}
            title={item.name}
            onKeyDown={(event) => {
              const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!direction) return;
              event.preventDefault();
              const other = items[(index + direction + items.length) % items.length];
              if (!other) return;
              if (event.altKey && event.shiftKey) onMove?.(item.id, other.id);
              else {
                onSelect(other.id);
                const buttons = event.currentTarget
                  .closest("nav")
                  ?.querySelectorAll<HTMLButtonElement>("[data-window-id]");
                buttons?.[items.indexOf(other)]?.focus();
              }
            }}
            data-window-id={item.id}
          >
            <GlassIcon command={item.command} count={item.count} />
            <span className="dw-tab-label">{item.name}</span>
          </button>
          {onClose && (
            <button
              className="dw-button dw-tab-close"
              aria-label={`Close window ${item.name}`}
              disabled={items.length === 1}
              onClick={() => onClose(item.id)}
            >
              <X size={14} />
            </button>
          )}
        </div>
      ))}
    </nav>
  );
}
