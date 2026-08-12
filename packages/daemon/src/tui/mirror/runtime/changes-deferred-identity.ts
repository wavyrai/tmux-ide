export interface DeferredChangesIdentity {
  readonly workspaceName: string;
  readonly directory: string;
}

export interface DeferredChangesIdentityInput {
  readonly workspaceName: string;
  readonly directory: string;
  readonly fallbackDirectory: string;
  readonly startup: DeferredChangesIdentity | null;
}

/** Full workspace identity used by every deferred Changes intent fence. */
export function changesIdentityKey(identity: DeferredChangesIdentity): string {
  return `${identity.workspaceName}\u0000${identity.directory}`;
}

/** Startup --diff applies only while its original workspace is still current
 * and no authoritative context directory has replaced it. */
export function resolveDeferredChangesIdentity(
  input: DeferredChangesIdentityInput,
): DeferredChangesIdentity {
  if (
    input.startup &&
    input.startup.workspaceName === input.workspaceName &&
    input.directory === ""
  ) {
    return input.startup;
  }
  return {
    workspaceName: input.workspaceName,
    directory: input.directory || input.fallbackDirectory,
  };
}
