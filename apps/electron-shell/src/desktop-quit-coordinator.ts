import { ShutdownBarrier, type ShutdownTask } from "./shutdown-barrier.ts";

export interface DesktopBeforeQuitEvent {
  preventDefault(): void;
}

export interface DesktopQuitApplication {
  on(event: "before-quit", listener: (event: DesktopBeforeQuitEvent) => void): unknown;
  quit(): void;
}

export interface DesktopQuitCoordinatorOptions {
  readonly app: DesktopQuitApplication;
  readonly shutdownTasks: () => readonly ShutdownTask[];
  readonly onShutdownError: (error: unknown) => void;
}

/**
 * Installs the desktop quit barrier before starting fallible background work.
 * Shutdown tasks are resolved lazily so resources added later in startup are
 * still retired by the same once-only barrier.
 */
export class DesktopQuitCoordinator {
  readonly #options: DesktopQuitCoordinatorOptions;
  readonly #shutdown = new ShutdownBarrier();
  #installed = false;
  #quitRequested = false;
  #shutdownInitiated = false;
  #quittingAfterBarrier = false;

  constructor(options: DesktopQuitCoordinatorOptions) {
    this.#options = options;
  }

  install(): void {
    if (this.#installed) return;
    this.#installed = true;
    this.#options.app.on("before-quit", (event) => this.#onBeforeQuit(event));
  }

  get quitRequested(): boolean {
    return this.#quitRequested;
  }

  async startUnlessQuitting<T>(start: () => Promise<T>): Promise<T | null> {
    this.install();
    if (this.#quitRequested) return null;
    const value = await start();
    return this.#quitRequested ? null : value;
  }

  #onBeforeQuit(event: DesktopBeforeQuitEvent): void {
    if (this.#quittingAfterBarrier) return;
    this.#quitRequested = true;
    event.preventDefault();
    if (this.#shutdownInitiated) return;
    this.#shutdownInitiated = true;
    void this.#shutdown
      .run(this.#options.shutdownTasks())
      .catch((error: unknown) => this.#options.onShutdownError(error))
      .finally(() => {
        this.#quittingAfterBarrier = true;
        this.#options.app.quit();
      });
  }
}
