import { useEffect, useId, useRef, useState } from "react";
import type { WorkbenchCommand } from "./app-chrome";

/** Single-focus command list: the input owns focus and announces the active option. */
export function CommandList({
  commands,
  onSelect,
}: {
  commands: WorkbenchCommand[];
  onSelect: (command: WorkbenchCommand) => void;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = commands.filter((command) =>
    terms.every((term) => `${command.label} ${command.group}`.toLocaleLowerCase().includes(term)),
  );
  const active = matches.find((command) => command.id === activeId) ?? matches[0];
  const optionId = (commandId: string) => `${id}-${encodeURIComponent(commandId)}`;
  useEffect(() => {
    root.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  return (
    <div ref={root} className="dw-command-root" data-slot="command">
      <input
        autoFocus
        className="dw-command-input"
        role="combobox"
        aria-label="Search commands"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={`${id}-list`}
        aria-activedescendant={active ? optionId(active.id) : undefined}
        placeholder="What would you like to do?"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActiveId(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          const index = matches.indexOf(active);
          let next: number;
          switch (event.key) {
            case "ArrowDown":
              next = (index + 1) % matches.length;
              break;
            case "ArrowUp":
              next = (index - 1 + matches.length) % matches.length;
              break;
            case "Home":
              if (event.shiftKey) return;
              next = 0;
              break;
            case "End":
              if (event.shiftKey) return;
              next = matches.length - 1;
              break;
            case "Enter":
              event.preventDefault();
              if (active) onSelect(active);
              return;
            default:
              return;
          }
          event.preventDefault();
          if (matches[next]) setActiveId(matches[next].id);
        }}
      />
      <div className="dw-command-list" id={`${id}-list`} role="listbox" aria-label="Commands">
        {[...new Set(matches.map((command) => command.group))].map((group, groupIndex) => (
          <div key={group} role="group" aria-labelledby={`${id}-group-${groupIndex}`}>
            <div data-slot="command-group-heading" id={`${id}-group-${groupIndex}`}>
              {group}
            </div>
            {matches
              .filter((command) => command.group === group)
              .map((command) => (
                <div
                  key={command.id}
                  id={optionId(command.id)}
                  role="option"
                  aria-selected={active?.id === command.id}
                  data-slot="command-item"
                  onPointerMove={() => setActiveId(command.id)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onSelect(command)}
                >
                  {command.label}
                </div>
              ))}
          </div>
        ))}
      </div>
      {matches.length === 0 && (
        <div className="dw-command-empty" role="status">
          No matching commands.
        </div>
      )}
    </div>
  );
}
