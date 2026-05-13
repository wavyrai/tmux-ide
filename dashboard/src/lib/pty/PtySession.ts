/**
 * PtySession — reactive wrapper around FrontendPty (G20-P2).
 *
 * Holds the Solid signal that the UI reads (`status` + `errorMessage`)
 * and the imperative `connect / dispose` lifecycle. One PtySession
 * per `sessionId`; lookup via `sessionPool`.
 *
 * Renderer pattern from the audit: components that need a session
 * call `session.connect()` in `onMount` (explicit, no auto-observer
 * trick). The session can be reused across mounts — disposing only
 * happens when the tab is explicitly closed.
 */

import { createSignal, type Accessor } from "solid-js";
import {
  FrontendPty,
  type FrontendPtyOptions,
  type FrontendPtyStatus,
} from "./FrontendPty";

export class PtySession {
  pty: FrontendPty | null = null;
  /** Last opts passed to `connect()` — replayed on reconnect. */
  private lastOpts: FrontendPtyOptions | null = null;
  private setStatusInternal: (next: FrontendPtyStatus) => void;
  private setErrorInternal: (next: string | null) => void;
  readonly status: Accessor<FrontendPtyStatus>;
  readonly errorMessage: Accessor<string | null>;
  private unsubStatus: (() => void) | null = null;

  constructor(readonly sessionId: string) {
    const [status, setStatus] = createSignal<FrontendPtyStatus>("disconnected");
    const [errorMessage, setError] = createSignal<string | null>(null);
    this.status = status;
    this.errorMessage = errorMessage;
    this.setStatusInternal = setStatus;
    this.setErrorInternal = setError;
  }

  /** Idempotent. If a FrontendPty already exists this is a no-op; the
   *  caller is expected to call `dispose()` first when intentionally
   *  reconnecting under different opts. */
  connect(opts?: FrontendPtyOptions): void {
    if (this.pty) return;
    this.lastOpts = opts ?? null;
    this.pty = new FrontendPty(this.sessionId);
    this.unsubStatus = this.pty.onStatusChange((next) => {
      this.setStatusInternal(next);
      this.setErrorInternal(this.pty?.errorMessage ?? null);
    });
    this.pty.connect(opts ?? {});
  }

  /** Disposes the FrontendPty (closes the WS, tears down xterm).
   *  After this call the session is reusable — `connect()` rebuilds
   *  a fresh FrontendPty under the same sessionId. */
  dispose(): void {
    this.unsubStatus?.();
    this.unsubStatus = null;
    this.pty?.dispose();
    this.pty = null;
    this.setStatusInternal("disconnected");
    this.setErrorInternal(null);
  }

  /** Returns the opts captured by the most recent `connect()` call,
   *  if any. Used by PaneSizingContext to recover initial dims. */
  getLastOptions(): FrontendPtyOptions | null {
    return this.lastOpts;
  }
}
