/**
 * @tmux-ide/contracts — shared Zod schemas for the daemon ↔ dashboard
 * boundary. Dashboard, packages/daemon, and any future v2 surfaces all
 * import from this single source of truth.
 *
 * Adding a schema? Put it in either `domain.ts` (runtime data: tasks,
 * missions, sessions, …) or `ide-config.ts` (the on-disk ide.yml
 * shape). Both files are re-exported wholesale below — no manual
 * registration needed.
 *
 * The `lib-internal/` directory holds schema-only helpers (auth, hq)
 * that ide-config depends on — they are exported transitively here
 * so consumers don't have to deep-import.
 */

export * from "./lib-internal/auth.ts";
export * from "./lib-internal/hq.ts";
export * from "./ide-config.ts";
export * from "./domain.ts";
export * from "./mission-projections.ts";
export * from "./tmux.ts";
export * from "./workspace.ts";
export * from "./workspace-state.ts";
export * from "./app-window-state.ts";
export * from "./client-view-state.ts";
export * from "./app-window-mutation.ts";
export * from "./workspace-config.ts";
export * from "./actions-contract.ts";
export * from "./actions-errors.ts";
export * from "./terminals.ts";
export * from "./issue-error.ts";
export * from "./terminal-attachments.ts";
export * from "./pane-stream.ts";
export * from "./control.ts";
export * from "./commands.ts";
export * from "./desktop-host.ts";
export * from "./desktop-workspace-name.ts";
export * from "./daemon-resource-request.ts";
export * from "./desktop-missions.ts";
export * from "./experience-identifiers.ts";
export * from "./semantic-identity.ts";
export * from "./experience-shell.ts";
export * from "./application-shell.ts";
export * from "./application-shell-resource.ts";
export * from "./workspace-catalog-resource.ts";
export * from "./workspace-resource-identity.ts";
export * from "./workspace-files-resource.ts";
export * from "./workspace-files-tree.ts";
export * from "./workspace-changes-resource.ts";
export * from "./workspace-changes-view.ts";
export * from "./workspace-pane-creation.ts";
export * from "./workspace-open.ts";
export * from "./workspace-promotion.ts";
export * from "./workspace-multiplexer.ts";
export * from "./interaction-receipts.ts";
export * from "./multiplexer-verbs.ts";
export * from "./visual-tokens.ts";
export * from "./visual-recipes.ts";
export * from "./pane-appearance.ts";
export * from "./agent-graph-overlay.ts";
export * from "./fleet-catalog.ts";
export * from "./fleet-agent-graph.ts";
export * from "./focus-overlay.ts";
export * from "./cohesion-fixture.ts";
export * from "./daemon-wire.ts";
export * from "./daemon-resources.ts";
export * from "./daemon-events.ts";
export * from "./desktop-update.ts";
export * from "./startup-readiness.ts";
export * from "./pane-widget-marker.ts";
export * from "./pane-widget-descriptor.ts";
export * from "./rich-card-widget.ts";
export * from "./widget-asset.ts";
