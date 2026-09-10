import { GlassIcon } from "../../glass-icon";
export interface WindowTab {
  id: string;
  name: string;
  command: string;
  paneCount: number;
  zoomed: boolean;
}
export function WindowTabs({
  items,
  value,
  onValueChange,
}: {
  items: readonly WindowTab[];
  value: string | null;
  onValueChange: (id: string) => void;
}) {
  return (
    <nav data-slot="window-tabs" className="live-window-tabs" aria-label="Tmux windows">
      {items.map((item, index) => (
        <button
          key={item.id}
          aria-current={item.id === value ? "page" : undefined}
          onClick={() => onValueChange(item.id)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % items.length
                : event.key === "ArrowLeft"
                  ? (index + items.length - 1) % items.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? items.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            onValueChange(items[next]!.id);
            event.currentTarget.parentElement?.querySelectorAll("button")[next]?.focus();
          }}
        >
          <GlassIcon count={item.paneCount} command={item.command} />
          <span className="live-window-label">{item.name}</span>
          {item.zoomed ? " · Zoomed" : ""}
        </button>
      ))}
    </nav>
  );
}
