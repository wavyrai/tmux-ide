import type {
  DesktopDaemonCapabilityError,
  DesktopDaemonTransportState,
} from "@tmux-ide/contracts";

/**
 * The ONE owner of daemon event-transport retry in the desktop stack.
 *
 * The broker owns frame semantics (hello verification, projection, deltas);
 * this machine owns lifecycle policy: when a socket is (re)opened, the bounded
 * exponential backoff between attempts, the handshake deadline, the fatal
 * ceiling that stops retrying and surfaces, and the explicit wakeups that
 * interrupt a scheduled backoff. UI status is derived from the states it
 * publishes — never from whether a transport object happens to exist.
 */

export interface DaemonEventSupervisorPolicy {
  readonly initialDelayMs: number;
  readonly maximumDelayMs: number;
  readonly maximumAttempts: number;
  readonly handshakeTimeoutMs: number;
}

export interface DaemonEventSupervisorHooks {
  /** Whether any live subscription currently requires a socket. */
  demand(): boolean;
  /**
   * Open a physical socket and wire its frames back into the broker. A throw
   * is treated as a completed failed attempt.
   */
  openSocket(): void;
  /** Close the current physical socket (handshake-deadline enforcement). */
  closeSocket(code: number, reason: string): void;
  onStateChanged(state: DesktopDaemonTransportState): void;
}

export interface DaemonEventSupervisorDependencies {
  readonly policy: DaemonEventSupervisorPolicy;
  readonly hooks: DaemonEventSupervisorHooks;
  readonly now?: () => number;
}

const OPEN_FAILED: DesktopDaemonCapabilityError = {
  code: "event-unavailable",
  reason: "The daemon event connection is unavailable.",
};

const HANDSHAKE_TIMEOUT: DesktopDaemonCapabilityError = {
  code: "event-unavailable",
  reason: "The daemon event connection is unavailable.",
};

export class DaemonEventSupervisor {
  readonly #policy: DaemonEventSupervisorPolicy;
  readonly #hooks: DaemonEventSupervisorHooks;
  readonly #now: () => number;

  #state: DesktopDaemonTransportState = { phase: "idle" };
  #failedAttempts = 0;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor(dependencies: DaemonEventSupervisorDependencies) {
    this.#policy = dependencies.policy;
    this.#hooks = dependencies.hooks;
    this.#now = dependencies.now ?? Date.now;
  }

  state(): DesktopDaemonTransportState {
    return this.#state;
  }

  /** Demand appeared (or may have). Connects only from a settled idle state. */
  ensure(): void {
    if (this.#disposed) return;
    if (!this.#hooks.demand()) {
      this.release();
      return;
    }
    if (this.#state.phase === "idle") this.#connect();
  }

  /** The verified hello arrived: the connection is healthy and the budget resets. */
  verified(): void {
    if (this.#disposed) return;
    this.#clearHandshakeTimer();
    this.#clearRetryTimer();
    this.#failedAttempts = 0;
    this.#publish({ phase: "connected" });
  }

  /**
   * The broker observed a transport fault and already closed/cleared its
   * physical socket. Decides — and owns — what happens next.
   */
  failed(error: DesktopDaemonCapabilityError): void {
    if (this.#disposed) return;
    this.#clearHandshakeTimer();
    if (this.#retryTimer !== null) return;
    if (!this.#hooks.demand()) {
      this.release();
      return;
    }
    this.#publish({ phase: "degraded", error });
    if (this.#failedAttempts >= this.#policy.maximumAttempts) {
      this.#publish({ phase: "stopped", error });
      return;
    }
    const attempt = this.#failedAttempts + 1;
    const delay = Math.min(
      this.#policy.maximumDelayMs,
      this.#policy.initialDelayMs * 2 ** this.#failedAttempts,
    );
    this.#failedAttempts = attempt;
    this.#publish({
      phase: "reconnecting",
      attempt,
      maximumAttempts: this.#policy.maximumAttempts,
      nextRetryAt: this.#now() + delay,
      error,
    });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#disposed) return;
      if (!this.#hooks.demand()) {
        this.release();
        return;
      }
      this.#connect();
    }, delay);
    this.#retryTimer.unref?.();
  }

  /**
   * Explicit wakeup: a user retry or a daemon-record change. Interrupts a
   * scheduled backoff, and restarts a machine stopped at the fatal ceiling.
   */
  retry(): void {
    if (this.#disposed || !this.#hooks.demand()) return;
    if (this.#state.phase === "connected" || this.#state.phase === "connecting") return;
    this.#clearRetryTimer();
    if (this.#state.phase === "stopped") this.#failedAttempts = 0;
    this.#connect();
  }

  /** Demand is gone (or the renderer generation was released). */
  release(): void {
    this.#clearRetryTimer();
    this.#clearHandshakeTimer();
    this.#failedAttempts = 0;
    if (this.#state.phase !== "idle") this.#publish({ phase: "idle" });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.release();
    this.#disposed = true;
  }

  #connect(): void {
    this.#publish({ phase: "connecting" });
    try {
      this.#hooks.openSocket();
    } catch {
      this.failed(OPEN_FAILED);
      return;
    }
    this.#startHandshakeTimer();
  }

  #startHandshakeTimer(): void {
    this.#clearHandshakeTimer();
    this.#handshakeTimer = setTimeout(() => {
      this.#handshakeTimer = null;
      if (this.#disposed || this.#state.phase !== "connecting") return;
      try {
        this.#hooks.closeSocket(1008, "event handshake timeout");
      } catch {
        // The socket may already be gone; retry policy still owns what's next.
      }
      this.failed(HANDSHAKE_TIMEOUT);
    }, this.#policy.handshakeTimeoutMs);
    this.#handshakeTimer.unref?.();
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer === null) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer === null) return;
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
  }

  #publish(next: DesktopDaemonTransportState): void {
    this.#state = next;
    try {
      this.#hooks.onStateChanged(next);
    } catch {
      // A state observer cannot change lifecycle policy.
    }
  }
}
