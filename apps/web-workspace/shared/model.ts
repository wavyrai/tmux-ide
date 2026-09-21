export type Layout =
  | { type: "leaf"; id: string }
  | {
      type: "split";
      id: string;
      direction: "horizontal" | "vertical";
      ratio: number;
      first: Layout;
      second: Layout;
    };
export interface Pane {
  viewOnly?: boolean;
  widget?: "Markdown" | "Files" | "Activity";
  agent?: {
    name: string;
    activity: "running" | "waiting" | "complete" | "idle" | "failed" | "disconnected";
  };
  interaction?: {
    badge: "READING" | "READ" | "SENDING" | "INPUT" | "SENT" | "RECEIVED" | "FAILED";
    external?: boolean;
  };
  command: string;
  createdAt: number;
  cwd: string;
  id: string;
  status: "running" | "exited";
}
export interface Tab {
  connectionId?: string;
  connectionStatus?: "paired" | "connecting" | "offline";
  machineId?: string;
  fleetSessionId?: string;
  daemonInstanceId?: string;
  workspaceName?: string;
  paneCount?: number;
  machine?: string;
  createdAt: number;
  customName: boolean;
  hidden: boolean;
  id: string;
  layout: Layout;
  name: string;
}
export interface Settings {
  darkTheme: string;
  fontSize: number;
  lightTheme: string;
  mode: "system" | "light" | "dark";
}
export interface Workspace {
  panes: Record<string, Pane>;
  revision: number;
  settings: Settings;
  tabs: Tab[];
  version: 1;
}
export function leaves(node: Layout): string[] {
  return node.type === "leaf" ? [node.id] : [...leaves(node.first), ...leaves(node.second)];
}
export function replaceLeaf(node: Layout, id: string, replacement: Layout): Layout {
  return node.type === "leaf"
    ? node.id === id
      ? replacement
      : node
    : {
        ...node,
        first: replaceLeaf(node.first, id, replacement),
        second: replaceLeaf(node.second, id, replacement),
      };
}
export function removeLeaf(node: Layout, id: string): Layout | null {
  if (node.type === "leaf") {
    return node.id === id ? null : node;
  }
  const first = removeLeaf(node.first, id),
    second = removeLeaf(node.second, id);
  return first && second ? { ...node, first, second } : first || second;
}
export function resizeLayout(node: Layout, id: string, ratio: number): Layout {
  if (node.type === "leaf") {
    return node;
  }
  return node.id === id
    ? { ...node, ratio }
    : {
        ...node,
        first: resizeLayout(node.first, id, ratio),
        second: resizeLayout(node.second, id, ratio),
      };
}
