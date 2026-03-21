import { readDirectory, type FileEntry, type Ignore } from "../lib/files.ts";

export interface TreeNode {
  entry: FileEntry;
  expanded: boolean;
  children: TreeNode[];
  depth: number;
  gitStatus: string | null;
}

export function buildRootNodes(
  scanDir: string,
  projectRoot: string,
  ig: Ignore,
  gitMap: Map<string, string>,
  showHidden: boolean,
  showIgnored: boolean = false,
): TreeNode[] {
  return readDirectory(scanDir, projectRoot, ig, showHidden, showIgnored).map((entry) => ({
    entry,
    expanded: false,
    children: [],
    depth: 0,
    gitStatus: gitMap.get(entry.path) ?? null,
  }));
}

export function expandNode(
  node: TreeNode,
  projectRoot: string,
  ig: Ignore,
  gitMap: Map<string, string>,
  showHidden: boolean,
): void {
  if (!node.entry.isDir || node.expanded) return;
  node.expanded = true;
  node.children = readDirectory(node.entry.absolutePath, projectRoot, ig, showHidden).map(
    (entry) => ({
      entry,
      expanded: false,
      children: [],
      depth: node.depth + 1,
      gitStatus: gitMap.get(entry.path) ?? null,
    }),
  );
}

export function collapseNode(node: TreeNode): void {
  node.expanded = false;
  node.children = [];
}

export function flattenVisibleNodes(nodes: TreeNode[]): TreeNode[] {
  const result: TreeNode[] = [];
  function walk(list: TreeNode[]) {
    for (const node of list) {
      result.push(node);
      if (node.expanded) walk(node.children);
    }
  }
  walk(nodes);
  return result;
}

export function refreshExpandedNodes(
  nodes: TreeNode[],
  projectRoot: string,
  ig: Ignore,
  gitMap: Map<string, string>,
  showHidden: boolean,
): TreeNode[] {
  return nodes.map((node) => {
    const updated: TreeNode = {
      ...node,
      gitStatus: gitMap.get(node.entry.path) ?? null,
    };
    if (node.expanded && node.entry.isDir) {
      const freshChildren = readDirectory(node.entry.absolutePath, projectRoot, ig, showHidden).map(
        (entry) => ({
          entry,
          expanded: false,
          children: [],
          depth: node.depth + 1,
          gitStatus: gitMap.get(entry.path) ?? null,
        }),
      );
      // Preserve expanded state of children that still exist
      const oldByPath = new Map(node.children.map((c) => [c.entry.path, c]));
      updated.children = freshChildren.map((fresh) => {
        const old = oldByPath.get(fresh.entry.path);
        if (old?.expanded && old.entry.isDir) {
          return {
            ...fresh,
            expanded: true,
            children: refreshExpandedNodes([old], projectRoot, ig, gitMap, showHidden)[0]!.children,
          };
        }
        return fresh;
      });
    }
    return updated;
  });
}
