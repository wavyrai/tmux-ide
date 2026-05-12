/**
 * G14-T093 — public surface of the daemon's Effect runtime layer.
 *
 * Schema-at-edge: callers in HTTP/IPC handlers `Effect.runPromise(...)`
 * exactly at the boundary; everywhere else, code composes Effect programs
 * with the services and layers re-exported here.
 */

export * from "./errors.ts";
export * from "./services.ts";
export * from "./layers.ts";
export * from "./chat-turn-pipeline.ts";
