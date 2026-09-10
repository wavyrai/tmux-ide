import { SidebarToggle } from "./sidebar-toggle";
import { useEffect, useRef, useState, type RefObject, type ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { CommandList } from "./command-list";
import { Search, X } from "../icons";
import type { WorkbenchCommand } from "./command-model";
function ChromePopover({
  portal,
  label,
  title,
  children,
  shortcut,
}: {
  portal: RefObject<HTMLDivElement | null>;
  label: string;
  title: string;
  children: ReactNode;
  shortcut?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!shortcut) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.key === shortcut &&
        !event.metaKey &&
        !event.ctrlKey &&
        !target.closest("input,textarea,[contenteditable=true]")
      ) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [shortcut]);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger className="dw-chrome-button" aria-keyshortcuts={shortcut}>
        {label}
      </Popover.Trigger>
      <Popover.Portal container={portal}>
        <Popover.Positioner className="dw-chrome-positioner" align="end" sideOffset={0}>
          <Popover.Popup className="dw-chrome-popover">
            <header className="dw-popover-heading">
              <Popover.Title>{title}</Popover.Title>
              <Popover.Close className="dw-button" aria-label="Close popover">
                <X size={14} />
              </Popover.Close>
            </header>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
export function AppChrome({
  portal,
  commands,
  sidebarOpen,
  onToggleSidebar,
}: {
  portal: RefObject<HTMLDivElement | null>;
  commands: WorkbenchCommand[];
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
}) {
  const [open, setOpen] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        !event.isComposing &&
        !event.repeat &&
        (event.metaKey || event.ctrlKey) &&
        event.key.toLowerCase() === "k"
      ) {
        event.preventDefault();
        if (!open)
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [open]);
  return (
    <header className="dw-app-chrome" aria-label="Application command bar">
      <span className="dw-chrome-brand">
        <SidebarToggle open={sidebarOpen} onToggle={onToggleSidebar} />
        <strong>tmux-ide</strong>
      </span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger
          onClick={() => {
            returnFocus.current = null;
          }}
          className="dw-command-trigger"
          aria-label="Open commands"
          aria-keyshortcuts="Meta+K Control+K"
        >
          <Search size={14} />
          <span>Search panes, themes and commands…</span>
          <kbd>⌘ K</kbd>
        </Popover.Trigger>
        <Popover.Portal container={portal}>
          <Popover.Positioner className="dw-chrome-positioner" align="center" sideOffset={0}>
            <Popover.Popup
              finalFocus={() => (returnFocus.current?.isConnected ? returnFocus.current : true)}
              className="dw-chrome-popover dw-command-popover"
            >
              <Popover.Title className="dw-visually-hidden">Workbench commands</Popover.Title>
              <CommandList
                commands={commands}
                recentIds={recentIds}
                onSelect={(command) => {
                  setRecentIds((ids) =>
                    [command.id, ...ids.filter((id) => id !== command.id)].slice(0, 5),
                  );
                  setOpen(false);
                  command.run();
                }}
              />
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
      <div className="dw-chrome-utilities">
        <ChromePopover portal={portal} label="What’s new" title="What’s new">
          <p className="dw-popover-muted">Design workbench · preview changes</p>
          <ul className="dw-popover-notes">
            <li>Resizable panels with pointer and keyboard controls.</li>
            <li>Drag pane titles to move or swap; zoom to focus.</li>
            <li>Shared themes, compact chrome and token-based spacing.</li>
            <li>Searchable commands, contextual Help and this changelog.</li>
          </ul>
          <p className="dw-popover-muted">
            These are design-preview changes, not a new published beta.
          </p>
        </ChromePopover>
        <ChromePopover portal={portal} label="Help ?" title="Workbench help" shortcut="?">
          <dl className="dw-shortcuts">
            <dt>Commands</dt>
            <dd>⌘ K / Ctrl K</dd>
            <dt>Zoom pane</dt>
            <dd>Double-click its title</dd>
            <dt>Restore layout</dt>
            <dd>Esc</dd>
            <dt>Resize</dt>
            <dd>Drag a divider or use arrow keys</dd>
            <dt>Move pane</dt>
            <dd>Drag title toward a pane edge</dd>
            <dt>Swap panes</dt>
            <dd>Drop in the center, or use Actions</dd>
            <dt>Move tab</dt>
            <dd>Drag or Alt Shift ← / →</dd>
          </dl>
          <p className="dw-popover-muted">
            This workspace uses local fixtures. Terminal input does not execute commands.
          </p>
        </ChromePopover>
      </div>
    </header>
  );
}
