import { IdeConfigSchema, type IdeConfig, type Row } from "../../schemas/ide-config.ts";

// ---------------------------------------------------------------------------
// Config Tree
// ---------------------------------------------------------------------------

export interface TreeNode {
  path: string[];
  label: string;
  value: string | null;
  depth: number;
  expandable: boolean;
}

function flattenValue(obj: unknown, path: string[], depth: number, nodes: TreeNode[]): void {
  if (Array.isArray(obj)) {
    const label = path[path.length - 1] ?? "";
    nodes.push({ path: [...path], label, value: null, depth, expandable: true });
    for (let i = 0; i < obj.length; i++) {
      flattenValue(obj[i], [...path, String(i)], depth + 1, nodes);
    }
  } else if (obj !== null && typeof obj === "object") {
    const label = path[path.length - 1] ?? "";
    nodes.push({ path: [...path], label, value: null, depth, expandable: true });
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      flattenValue(val, [...path, key], depth + 1, nodes);
    }
  } else {
    const label = path[path.length - 1] ?? "";
    nodes.push({
      path: [...path],
      label,
      value: obj === undefined || obj === null ? null : String(obj),
      depth,
      expandable: false,
    });
  }
}

export function flattenConfigTree(config: IdeConfig): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [key, val] of Object.entries(config)) {
    if (val === undefined) continue;
    flattenValue(val, [key], 0, nodes);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Config Mutations
// ---------------------------------------------------------------------------

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export function updateConfigAtPath(config: IdeConfig, path: string[], value: unknown): IdeConfig {
  const cloned = deepClone(config);
  let current: Record<string, unknown> = cloned as unknown as Record<string, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]!;
    current = current[key] as Record<string, unknown>;
  }
  const lastKey = path[path.length - 1]!;
  current[lastKey] = value;
  return cloned;
}

export function addPane(config: IdeConfig, rowIdx: number): IdeConfig {
  const cloned = deepClone(config);
  const row = cloned.rows[rowIdx];
  if (!row) return cloned;
  row.panes.push({ title: "New Pane" });
  return cloned;
}

export function removePane(config: IdeConfig, rowIdx: number, paneIdx: number): IdeConfig {
  const cloned = deepClone(config);
  const row = cloned.rows[rowIdx];
  if (!row) return cloned;
  if (row.panes.length <= 1) return cloned;
  row.panes.splice(paneIdx, 1);
  return cloned;
}

export function addRow(config: IdeConfig, size?: string): IdeConfig {
  const cloned = deepClone(config);
  const row: Row = { panes: [{ title: "Shell" }] };
  if (size) row.size = size;
  cloned.rows.push(row);
  return cloned;
}

export function removeRow(config: IdeConfig, rowIdx: number): IdeConfig {
  const cloned = deepClone(config);
  if (cloned.rows.length <= 1) return cloned;
  cloned.rows.splice(rowIdx, 1);
  return cloned;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateSetupConfig(
  config: unknown,
): { valid: true; config: IdeConfig } | { valid: false; errors: string[] } {
  const result = IdeConfigSchema.safeParse(config);
  if (result.success) {
    return { valid: true, config: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
  };
}
