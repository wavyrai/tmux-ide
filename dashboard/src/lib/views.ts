/**
 * Central registry of view ids for the `/project/[name]` shell.
 *
 * Per WN11 (audit), the React app had three places defining this set
 * (ViewId union, VIEWS array, palette items). The Solid port unifies
 * them into one module — types + arrays derive from a single source.
 */

import type { Component } from "solid-js";
import {
  Files,
  GitCompare,
  ListTodo,
  CheckSquare,
  Target,
  Compass,
  MessagesSquare,
  KanbanSquare,
  Search,
  Terminal as TerminalIcon,
  Bot,
  BarChart3,
  DollarSign,
  Sparkles,
  Diff,
  StickyNote,
} from "lucide-solid";

export const VIEWS = [
  { id: "mission", label: "Mission", glyph: "◆", Icon: Target },
  { id: "mission-control", label: "Mission Control", glyph: "✦", Icon: Compass },
  { id: "agents", label: "Agents", glyph: "✲", Icon: Bot },
  { id: "kanban", label: "Kanban", glyph: "⊟", Icon: KanbanSquare },
  { id: "tasks", label: "Tasks", glyph: "≡", Icon: CheckSquare },
  { id: "plans", label: "Plans", glyph: "▦", Icon: ListTodo },
  { id: "skills", label: "Skills", glyph: "✶", Icon: Sparkles },
  { id: "notes", label: "Notes", glyph: "✎", Icon: StickyNote },
  { id: "chat", label: "Chat", glyph: "❯", Icon: MessagesSquare },
  { id: "terminal", label: "Terminal", glyph: ">_", Icon: TerminalIcon },
  { id: "files", label: "Files", glyph: "▤", Icon: Files },
  { id: "search", label: "Search", glyph: "⌕", Icon: Search },
  { id: "diffs", label: "Diffs", glyph: "⎇", Icon: GitCompare },
  { id: "changes", label: "Changes", glyph: "Δ", Icon: Diff },
  { id: "metrics", label: "Metrics", glyph: "▬", Icon: BarChart3 },
  { id: "costs", label: "Costs", glyph: "◍", Icon: DollarSign },
] as const satisfies ReadonlyArray<{
  id: string;
  label: string;
  glyph: string;
  Icon: Component<{ size?: number; strokeWidth?: number; class?: string }>;
}>;

export type ViewId = (typeof VIEWS)[number]["id"];

const VIEW_ID_SET = new Set<string>(VIEWS.map((v) => v.id));

export function isViewId(value: string): value is ViewId {
  return VIEW_ID_SET.has(value);
}

export const DEFAULT_VIEW: ViewId = "kanban";
