import type { TerminalAuthorityClient } from "./terminal-host-focus.ts";

type HostSnapshot = Readonly<{
  status: string;
  rendererEpoch: number;
  daemonGeneration: string | null;
  authorityClient: TerminalAuthorityClient | null;
}>;

export type ApplicationHostFocusBindingIdentity = Readonly<{
  bindingEpoch: number;
  rendererEpoch: number;
  clientGeneration: number;
  clientPhase: "live";
  authorityGeneration: string;
  runtimeSession: string;
  daemonInstanceId: string;
  workspaceName: string;
  clientId: string;
}>;

export function createApplicationHostFocusControlBindingObserver(options: {
  enabled: boolean;
  currentHost: () => HostSnapshot | null;
  publish: (identity: ApplicationHostFocusBindingIdentity) => void;
}): Readonly<{
  adopt: (snapshot: HostSnapshot | null) => void;
  current: () => ApplicationHostFocusBindingIdentity | null;
  dispose: () => void;
}> {
  let disposed = false;
  let adopted: HostSnapshot | null = null;
  let stop: (() => void) | null = null;
  let binding: ApplicationHostFocusBindingIdentity | null = null;
  let publishedKey: string | null = null;
  let bindingEpoch = 0;

  const exactCurrentHost = (): HostSnapshot | null => {
    const current = options.currentHost();
    return !disposed &&
      adopted !== null &&
      current?.status === "live" &&
      current.authorityClient === adopted.authorityClient &&
      current.rendererEpoch === adopted.rendererEpoch &&
      current.daemonGeneration === adopted.daemonGeneration
      ? current
      : null;
  };

  const observe = () => {
    if (!options.enabled) return;
    const current = exactCurrentHost();
    if (current === null) {
      binding = null;
      return;
    }
    const client = current.authorityClient;
    const snapshot = client?.getSnapshot() ?? null;
    const authority = client?.authorityIdentity ?? null;
    const generation = current.daemonGeneration;
    const workspaceName = snapshot?.target?.workspaceName;
    const targetGeneration = snapshot?.target?.daemon?.instanceId;
    const clientGeneration = snapshot?.generation;
    if (
      client === null ||
      snapshot?.phase !== "live" ||
      authority === null ||
      authority.generation !== generation ||
      targetGeneration !== generation ||
      typeof workspaceName !== "string" ||
      workspaceName.length === 0 ||
      !Number.isSafeInteger(clientGeneration) ||
      (clientGeneration as number) < 0
    ) {
      binding = null;
      return;
    }
    const key = JSON.stringify([
      current.rendererEpoch,
      clientGeneration,
      authority.generation,
      authority.session,
      generation,
      workspaceName,
      authority.clientId,
    ]);
    if (key === publishedKey && binding !== null) return;
    publishedKey = key;
    binding = Object.freeze({
      bindingEpoch: ++bindingEpoch,
      rendererEpoch: current.rendererEpoch,
      clientGeneration: clientGeneration as number,
      clientPhase: "live",
      authorityGeneration: authority.generation,
      runtimeSession: authority.session,
      daemonInstanceId: generation,
      workspaceName,
      clientId: authority.clientId,
    });
    options.publish(binding);
  };

  const adopt = (snapshot: HostSnapshot | null) => {
    if (disposed) return;
    const same =
      adopted?.status === snapshot?.status &&
      adopted?.authorityClient === snapshot?.authorityClient &&
      adopted?.rendererEpoch === snapshot?.rendererEpoch &&
      adopted?.daemonGeneration === snapshot?.daemonGeneration;
    adopted = snapshot;
    if (same) {
      observe();
      return;
    }
    stop?.();
    stop = null;
    binding = null;
    publishedKey = null;
    const client = snapshot?.status === "live" ? snapshot.authorityClient : null;
    if (client) {
      const listener = () => observe();
      stop = client.onBinding?.(listener) ?? client.onAuthority(listener);
    }
    observe();
  };

  return Object.freeze({
    adopt,
    current() {
      observe();
      return binding;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stop?.();
      stop = null;
      adopted = null;
      binding = null;
      publishedKey = null;
    },
  });
}
