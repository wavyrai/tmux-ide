"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { File, Folder, Settings, Sparkles, TerminalSquare, X } from "lucide-react";
import type { Tab } from "@/lib/navigation";

interface MainTabItemProps {
  tab: Tab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
}

function TabIcon({ kind }: { kind: Tab["kind"] }) {
  switch (kind) {
    case "settings":
      return <Settings aria-hidden="true" size={14} className="shrink-0 text-[var(--dimmer)]" />;
    case "skill":
      return <Sparkles aria-hidden="true" size={14} className="shrink-0 text-[var(--dimmer)]" />;
    case "file":
      return <File aria-hidden="true" size={14} className="shrink-0 text-[var(--dimmer)]" />;
    case "terminal":
      return (
        <span className="relative inline-flex shrink-0 items-center">
          <TerminalSquare
            aria-hidden="true"
            size={14}
            className="text-[var(--dimmer)]"
          />
          <span
            aria-hidden="true"
            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--green)]"
          />
        </span>
      );
    case "view":
    default:
      return <Folder aria-hidden="true" size={14} className="shrink-0 text-[var(--dimmer)]" />;
  }
}

/**
 * Single tab pill in the unified main tab strip. Drag-reorder is
 * provided via `useSortable` from @dnd-kit/sortable; the surrounding
 * `MainTabsBar` mounts the SortableContext + DndContext.
 */
export function MainTabItem({ tab, active, onActivate, onClose }: MainTabItemProps) {
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
      data-testid="main-tab"
      data-active={active ? "true" : "false"}
      data-kind={tab.kind}
      data-tab-id={tab.id}
      onClick={onActivate}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onActivate();
      }}
      className={`group flex h-8 max-w-60 shrink-0 items-center gap-2 border-b-2 px-3 text-left text-[12px] transition-colors motion-safe:active:scale-[0.98] ${
        active
          ? "border-[var(--accent)] bg-[var(--surface-active)] text-[var(--accent)]"
          : "border-transparent text-[var(--dim)] hover:bg-[var(--surface-hover)] hover:text-[var(--fg)]"
      }`}
      {...attributes}
      {...listeners}
    >
      <TabIcon kind={tab.kind} />
      <span className="truncate">{tab.title}</span>
      <button
        type="button"
        aria-label={`Close ${tab.title}`}
        data-testid={`main-tab-close-${tab.id}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="ml-auto inline-flex h-5 w-5 shrink-0 items-center justify-center text-[var(--dim)] opacity-0 transition-opacity motion-safe:active:scale-[0.95] hover:text-[var(--red)] group-hover:opacity-100"
      >
        <X aria-hidden="true" size={13} />
      </button>
    </div>
  );
}
