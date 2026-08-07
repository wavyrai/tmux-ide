export interface DesktopDaemonRuntimeShutdown {
  readonly disposeHostIpc: () => void;
  readonly disposeDaemonResources: () => void;
  readonly stopOwnedDaemon: () => Promise<void>;
}

/** Retire renderer and broker authority before stopping an owned daemon. */
export async function shutdownDesktopDaemonRuntime(
  runtime: DesktopDaemonRuntimeShutdown,
): Promise<void> {
  const failures: unknown[] = [];
  for (const dispose of [runtime.disposeHostIpc, runtime.disposeDaemonResources]) {
    try {
      dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await runtime.stopOwnedDaemon();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "desktop daemon runtime shutdown failed");
  }
}
