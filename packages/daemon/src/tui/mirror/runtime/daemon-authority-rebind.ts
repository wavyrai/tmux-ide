import type { ApplicationShellSessionState } from "@tmux-ide/daemon-client/application-shell-session";

export interface DaemonAuthorityRebindActions {
  /** Retire every capability minted by the rejected daemon before discovery. */
  readonly retire: () => void;
  /** Re-read canonical daemon truth and establish a replacement authority. */
  readonly reconnect: () => boolean | Promise<boolean>;
}

interface DaemonAuthorityRebindOptions {
  readonly delayMs?: number;
  readonly maxAttempts?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function daemonAuthorityRebindKey(
  sessionName: string,
  state: ApplicationShellSessionState,
): string | null {
  if (state.status !== "degraded" || state.code !== "daemon-identity-mismatch") return null;
  const instanceId = state.target?.daemon.instanceId;
  return instanceId ? `${sessionName}\0${instanceId}` : null;
}

/**
 * A fatal daemon identity mismatch poisons every child capability from that
 * authority. Canonical discovery is retried at most three times for a rejected
 * session/generation pair; repeated stale frames cannot create an unbounded
 * reconnect loop. A later daemon generation has a new UUID and gets its own
 * bounded recovery window.
 */
export class DaemonAuthorityRebindCoordinator {
  readonly #delayMs: number;
  readonly #schedule: NonNullable<DaemonAuthorityRebindOptions["schedule"]>;
  readonly #cancel: NonNullable<DaemonAuthorityRebindOptions["cancel"]>;
  readonly #maxAttempts: number;
  readonly #attempts = new Map<string, number>();
  #pending: ReturnType<typeof setTimeout> | null = null;
  #pendingKey: string | null = null;
  #epoch = 0;

  constructor(options: DaemonAuthorityRebindOptions = {}) {
    this.#delayMs = options.delayMs ?? 100;
    this.#maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.#schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.#cancel = options.cancel ?? clearTimeout;
  }

  request(
    sessionName: string,
    state: ApplicationShellSessionState,
    actions: DaemonAuthorityRebindActions,
  ): boolean {
    const key = daemonAuthorityRebindKey(sessionName, state);
    if (!key) return false;
    // Even a repeated frame must leave no stale child capability live. Only
    // the canonical discovery attempt is deduplicated.
    actions.retire();
    if (this.#pendingKey === key || (this.#attempts.get(key) ?? 0) >= this.#maxAttempts)
      return true;
    if (!this.#attempts.has(key) && this.#attempts.size >= 32) {
      const oldest = this.#attempts.keys().next().value as string | undefined;
      if (oldest) this.#attempts.delete(oldest);
    }
    this.cancelPending();
    this.#scheduleAttempt(key, actions, this.#epoch);
    return true;
  }

  #scheduleAttempt(key: string, actions: DaemonAuthorityRebindActions, epoch: number): void {
    const attempt = (this.#attempts.get(key) ?? 0) + 1;
    this.#attempts.set(key, attempt);
    this.#pendingKey = key;
    this.#pending = this.#schedule(
      () => {
        if (epoch !== this.#epoch) return;
        this.#pending = null;
        this.#pendingKey = null;
        void Promise.resolve(actions.reconnect())
          .then((connected) => {
            if (epoch !== this.#epoch) return;
            if (connected || (this.#attempts.get(key) ?? 0) >= this.#maxAttempts) return;
            this.#scheduleAttempt(key, actions, epoch);
          })
          .catch(() => {
            if (epoch !== this.#epoch) return;
            if ((this.#attempts.get(key) ?? 0) < this.#maxAttempts)
              this.#scheduleAttempt(key, actions, epoch);
          });
      },
      Math.min(1_000, this.#delayMs * 2 ** (attempt - 1)),
    );
  }

  cancelPending(): void {
    this.#epoch += 1;
    if (this.#pending !== null) this.#cancel(this.#pending);
    this.#pending = null;
    this.#pendingKey = null;
  }

  dispose(): void {
    this.cancelPending();
    this.#attempts.clear();
  }
}
