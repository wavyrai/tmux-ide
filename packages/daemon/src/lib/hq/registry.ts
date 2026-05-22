// Based on VibeTunnel (MIT) — github.com/amantus-ai/vibetunnel
import { logger } from "../log.ts";
import type { RemoteMachine } from "./types.ts";

const LOG = "remote-registry";

export class RemoteRegistry {
  private machines = new Map<string, RemoteMachine>();
  private machinesByName = new Map<string, RemoteMachine>();
  private sessionToMachine = new Map<string, string>();
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly healthInterval: number;
  private readonly healthTimeout: number;
  private isShuttingDown: () => boolean;

  constructor(opts?: {
    healthInterval?: number;
    healthTimeout?: number;
    isShuttingDown?: () => boolean;
  }) {
    this.healthInterval = opts?.healthInterval ?? 15_000;
    this.healthTimeout = opts?.healthTimeout ?? 5_000;
    this.isShuttingDown = opts?.isShuttingDown ?? (() => false);
    this.startHealthChecker();
  }

  register(
    remote: Omit<RemoteMachine, "registeredAt" | "lastHeartbeat" | "sessionIds">,
  ): RemoteMachine {
    // If same ID already registered, update it (heartbeat / re-registration)
    const existing = this.machines.get(remote.id);
    if (existing) {
      existing.name = remote.name;
      existing.url = remote.url;
      existing.token = remote.token;
      existing.lastHeartbeat = new Date();
      this.machinesByName.set(remote.name, existing);
      logger.debug(LOG, `Machine re-registered: ${remote.name} (${remote.id})`);
      return existing;
    }

    // Block duplicate names (different ID)
    if (this.machinesByName.has(remote.name)) {
      throw new Error(`Machine with name '${remote.name}' is already registered`);
    }

    const now = new Date();
    const machine: RemoteMachine = {
      ...remote,
      registeredAt: now,
      lastHeartbeat: now,
      sessionIds: new Set(),
    };

    this.machines.set(remote.id, machine);
    this.machinesByName.set(remote.name, machine);
    logger.info(LOG, `Machine registered: ${remote.name} (${remote.id}) from ${remote.url}`);

    void this.checkMachineHealth(machine);
    return machine;
  }

  unregister(id: string): boolean {
    const machine = this.machines.get(id);
    if (!machine) return false;

    for (const sid of machine.sessionIds) {
      this.sessionToMachine.delete(sid);
    }
    this.machinesByName.delete(machine.name);
    this.machines.delete(id);
    logger.info(LOG, `Machine unregistered: ${machine.name} (${id})`);
    return true;
  }

  getMachine(id: string): RemoteMachine | undefined {
    return this.machines.get(id);
  }

  getMachines(): RemoteMachine[] {
    return Array.from(this.machines.values());
  }

  getMachineBySession(sessionId: string): RemoteMachine | undefined {
    const mid = this.sessionToMachine.get(sessionId);
    return mid ? this.machines.get(mid) : undefined;
  }

  updateSessions(machineId: string, sessionIds: string[]): void {
    const machine = this.machines.get(machineId);
    if (!machine) return;

    for (const old of machine.sessionIds) {
      this.sessionToMachine.delete(old);
    }
    machine.sessionIds = new Set(sessionIds);
    for (const sid of sessionIds) {
      this.sessionToMachine.set(sid, machineId);
    }
  }

  private async checkMachineHealth(machine: RemoteMachine): Promise<void> {
    if (this.isShuttingDown()) return;

    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), this.healthTimeout);

      const res = await fetch(`${machine.url}/health`, {
        headers: { Authorization: `Bearer ${machine.token}` },
        signal: controller.signal,
      });

      clearTimeout(tid);
      if (res.ok) {
        machine.lastHeartbeat = new Date();
        logger.debug(LOG, `Health OK: ${machine.name}`);
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (err) {
      if (this.isShuttingDown()) return;
      logger.warn(LOG, `Health check failed, pruning: ${machine.name} (${machine.id})`, {
        error: String(err),
      });
      this.unregister(machine.id);
    }
  }

  private startHealthChecker(): void {
    this.healthCheckTimer = setInterval(() => {
      if (this.isShuttingDown()) return;
      const checks = this.getMachines().map((m) => this.checkMachineHealth(m));
      Promise.all(checks).catch(() => {});
    }, this.healthInterval);
  }

  destroy(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    logger.info(LOG, "Registry destroyed");
  }
}
