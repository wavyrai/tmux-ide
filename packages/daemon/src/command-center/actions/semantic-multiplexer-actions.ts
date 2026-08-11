import type { ActionName } from "./contract.ts";

export const SEMANTIC_MULTIPLEXER_ACTION_NAMES = [
  "workspace.window.split",
  "workspace.window.kill",
  "workspace.pane.kill",
  "workspace.session.kill",
  "workspace.rename",
  "workspace.pane.zoom.toggle",
  "workspace.pane.select",
  "workspace.pane.send",
  "workspace.pane.swap",
  "workspace.pane.resize",
] as const satisfies readonly ActionName[];

export type SemanticMultiplexerActionName = (typeof SEMANTIC_MULTIPLEXER_ACTION_NAMES)[number];

const semanticMultiplexerActionNames: ReadonlySet<string> = new Set(
  SEMANTIC_MULTIPLEXER_ACTION_NAMES,
);

export function isSemanticMultiplexerActionName(
  actionName: string,
): actionName is SemanticMultiplexerActionName {
  return semanticMultiplexerActionNames.has(actionName);
}
