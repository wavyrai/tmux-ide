import type { ApplicationShellProjectionInputV1 } from "@tmux-ide/contracts";

import type { WorkspaceClient, WorkspaceClientSnapshot } from "./workspace-client-types.ts";

export type WorkspaceClientConformanceSurface = "core" | "opentui" | "web" | "sdk";

export interface WorkspaceClientConformanceAdapter<
  Shell extends ApplicationShellProjectionInputV1 = ApplicationShellProjectionInputV1,
> {
  readonly surface: WorkspaceClientConformanceSurface;
  semanticSnapshot(): WorkspaceClientSnapshot<Shell>["semantic"];
  semanticBytes(): string;
  semanticHash(): string;
  /** Canonical lifecycle + semantic + operation publication sequence. */
  traceBytes(): string;
  traceHash(): string;
  dispose(): void;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/**
 * Test/SDK adapter with no renderer dependency. Labels prove that every host
 * consumes the same public contract; they never participate in the hash.
 */
export function createWorkspaceClientConformanceAdapter<
  Shell extends ApplicationShellProjectionInputV1,
>(
  surface: WorkspaceClientConformanceSurface,
  client: WorkspaceClient<Shell, unknown, unknown>,
): WorkspaceClientConformanceAdapter<Shell> {
  const publications: string[] = [];
  const releases = (["lifecycle", "semantic", "operations"] as const).map((scope) =>
    client.subscribe(scope, (value) => {
      publications.push(canonical({ scope, value }));
    }),
  );
  const traceBytes = (): string => `[${publications.join(",")}]`;
  return {
    surface,
    semanticSnapshot: () => client.getSnapshot().semantic,
    semanticBytes: () => canonical(client.getSnapshot().semantic),
    semanticHash: () => fnv1a64(canonical(client.getSnapshot().semantic)),
    traceBytes,
    traceHash: () => fnv1a64(traceBytes()),
    dispose: () => {
      for (const release of releases) release();
    },
  };
}
