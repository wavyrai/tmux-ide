// Fold SSH-tunneled remotes into the central agents view. Unlike HQ machines
// (which register themselves inbound), SSH remotes are outbound-only: this
// machine opened a forward tunnel to the remote daemon's loopback port, so the
// tunnel endpoint on 127.0.0.1 IS the remote daemon. We treat each configured
// remote with a recorded tunnel port as an agent source and as a control
// target — no reverse connectivity required, which matters for SSM-style
// setups where the remote can't reach back to this machine.
import { AgentListSchemaZ } from "@tmux-ide/contracts";
import { readSshRemotes, type SshRemote } from "../ssh-remote.ts";
import type { RemoteAgentSource } from "./agent-registry.ts";

const SSH_MACHINE_PREFIX = "ssh:";
const PROBE_TIMEOUT_MS = 2_500;

export function sshMachineId(remoteName: string): string {
  return `${SSH_MACHINE_PREFIX}${remoteName}`;
}

function tunnelPort(remote: SshRemote): number | null {
  return remote.localPort ?? remote.lastLocalPort ?? null;
}

function tunnelBaseUrl(remote: SshRemote): string | null {
  const port = tunnelPort(remote);
  return port ? `http://127.0.0.1:${port}` : null;
}

/**
 * Resolve an ssh-machine id (`ssh:<name>`) to the local tunnel base url, or
 * null when the id isn't an ssh machine / the remote has no recorded tunnel.
 */
export async function resolveSshMachineUrl(machineId: string): Promise<string | null> {
  if (!machineId.startsWith(SSH_MACHINE_PREFIX)) return null;
  const name = machineId.slice(SSH_MACHINE_PREFIX.length);
  const remote = (await readSshRemotes()).find((candidate) => candidate.name === name);
  return remote ? tunnelBaseUrl(remote) : null;
}

async function fetchAgents(baseUrl: string): Promise<RemoteAgentSource["agents"] | null> {
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    // The tunnel terminates on the remote's loopback, where the daemon runs
    // token-less; no Authorization needed. Redirects are refused for the same
    // reason as the HQ fan-out: never chase a hostile 3xx.
    const res = await fetch(`${baseUrl}/api/agents`, {
      signal: controller.signal,
      redirect: "manual",
    });
    clearTimeout(tid);
    if (!res.ok) return null;
    const parsed = AgentListSchemaZ.safeParse(await res.json());
    return parsed.success ? parsed.data.agents : null;
  } catch {
    return null;
  }
}

/**
 * Probe every configured SSH remote with a recorded tunnel port and return the
 * reachable ones as agent sources. Remotes whose tunnel is down (fetch fails)
 * are silently skipped — `remote ssh launch` re-records the port next time.
 *
 * Multiple store entries can point at the same tunnel port (e.g. a stale
 * remote plus a re-added one); probing both would duplicate every agent, so
 * entries are deduped by resolved URL, keeping the most recently launched.
 */
export async function listSshAgentSources(): Promise<RemoteAgentSource[]> {
  const byUrl = new Map<string, SshRemote>();
  for (const remote of await readSshRemotes()) {
    const url = tunnelBaseUrl(remote);
    if (!url) continue;
    const current = byUrl.get(url);
    const launched = (candidate: SshRemote) => candidate.lastLaunchedAt ?? "";
    if (!current || launched(remote) > launched(current)) byUrl.set(url, remote);
  }
  const probes = [...byUrl.entries()].map(
    async ([url, remote]): Promise<RemoteAgentSource | null> => {
      const agents = await fetchAgents(url);
      if (!agents) return null;
      return { machineId: sshMachineId(remote.name), machineName: remote.name, agents };
    },
  );
  return (await Promise.all(probes)).filter((source): source is RemoteAgentSource => !!source);
}
