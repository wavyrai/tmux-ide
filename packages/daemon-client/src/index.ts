/**
 * Host-neutral clients and state machines for the canonical daemon protocol.
 *
 * Process ownership, canonical-record persistence, and host-specific spawning
 * remain outside this package. Consumers converge through the typed bootstrap
 * coordinator and then attach through generation-aware transports.
 */

export * from "./bootstrap-coordinator.ts";
export * from "./connection-supervisor.ts";
export * from "./resource-replica.ts";
export * from "./push-resource-session.ts";
export * from "./generation-bound-store.ts";
export * from "./application-shell-session.ts";
export * from "./direct-application-shell-transport.ts";
export * from "./owner-action-client.ts";
export * from "./workspace-pane-client.ts";
export * from "./pane-stream-client.ts";
export * from "./workspace-catalog-v2.ts";
export * from "./workspace-client-types.ts";
export * from "./workspace-client.ts";
export * from "./workspace-client-conformance.ts";
export * from "./terminal-fast-lane.ts";
export * from "./first-latest-coordinator.ts";
