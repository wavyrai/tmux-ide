import { useEffect, useId, useMemo, useRef, useState } from "react";
import { activeCommand, rankCommands, type WorkbenchCommand } from "./command-model";

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
  const matches = useMemo(() => rankCommands(commands, query), [commands, query]);
  const enabled = matches.filter((command) => !command.disabled);
  const active = activeCommand(matches, activeId);
  const optionId = (commandId: string) => `${id}-${encodeURIComponent(commandId)}`;
  useEffect(() => {
    const item = root.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    const list = root.current?.querySelector<HTMLElement>('[role="listbox"]');
    if (!item || !list) return;
    const bounds = list.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < bounds.top) list.scrollTop -= bounds.top - row.top;
    else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
  }, [active?.id, matches]);
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
          if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229)
            return;
          const index = active ? enabled.indexOf(active) : -1;
          let next: number;
          switch (event.key) {
            case "ArrowDown":
              next = (index + 1) % enabled.length;
              break;
            case "ArrowUp":
              next = (index - 1 + enabled.length) % enabled.length;
              break;
            case "Home":
              if (event.shiftKey) return;
              next = 0;
              break;
            case "End":
              if (event.shiftKey) return;
              next = enabled.length - 1;
              break;
            case "Enter":
              event.preventDefault();
              if (active) onSelect(active);
              return;
            default:
              return;
          }
          event.preventDefault();
          if (enabled[next]) setActiveId(enabled[next].id);
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
                  aria-disabled={command.disabled || undefined}
                  data-slot="command-item"
                  onPointerMove={(event) => {
                    if (
                      !command.disabled &&
                      event.pointerType === "mouse" &&
                      (event.movementX || event.movementY)
                    )
                      setActiveId(command.id);
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    if (!command.disabled) onSelect(command);
                  }}
                >
                  {command.label}
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="dw-visually-hidden" role="status" aria-live="polite" aria-atomic="true">
        {matches.length} commands, {enabled.length} available.
      </div>
      {matches.length === 0 && <div className="dw-command-empty">No matching commands.</div>}
    </div>
  );
}
