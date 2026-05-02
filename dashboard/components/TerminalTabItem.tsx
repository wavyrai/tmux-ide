"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { TerminalTab } from "@/lib/useLayoutState";

interface TerminalTabItemProps {
  tab: TerminalTab;
  active: boolean;
  paneStatus?: "busy" | "idle" | null;
  onActivate: () => void;
  onClose: () => void;
}

export function TerminalTabItem({
  tab,
  active,
  paneStatus = null,
  onActivate,
  onClose,
}: TerminalTabItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.65 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-testid="terminal-tab"
      data-active={active ? "true" : "false"}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onActivate();
      }}
      className={`group flex h-8 max-w-56 shrink-0 items-center gap-2 border-b-2 px-3 text-left text-[12px] transition-colors ${
        active
          ? "border-[var(--accent)] text-[var(--accent)]"
          : "border-transparent text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
      }`}
      {...attributes}
      {...listeners}
    >
      {tab.paneId && (
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${
            paneStatus === "busy" ? "bg-[var(--accent)]" : "bg-[var(--dimmer)]"
          }`}
          aria-hidden="true"
        />
      )}
      <span className="truncate">{tab.title}</span>
      {!tab.paneId && (
        <>
          <span className="text-[var(--dimmer)]">/</span>
          <span className="truncate text-[var(--dim)]">{tab.projectName}</span>
        </>
      )}
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center text-[var(--dim)] opacity-0 transition-opacity hover:text-[var(--red)] group-hover:opacity-100"
      >
        ×
      </button>
    </div>
  );
}
