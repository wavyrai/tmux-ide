import type { TuiApplicationLifecycle, TuiShutdownReport } from "./application-lifecycle.ts";

export interface TuiBootstrapRenderer {
  destroy(): void | Promise<void>;
}

export interface TuiMountedRoot<Root> {
  readonly root: Root;
  /** Input owners and root subscriptions have mounted when this resolves. */
  readonly ready?: Promise<void>;
  /** Unsubscribe/close root-owned resources before native renderer teardown. */
  readonly close?: () => void | Promise<void>;
}

export interface TuiBootstrapContext<Args, Config, Renderer extends TuiBootstrapRenderer> {
  readonly args: Args;
  readonly config: Config;
  readonly renderer: Renderer;
  readonly lifecycle: TuiApplicationLifecycle;
}

export interface TuiApplicationBootstrapOptions<
  Args,
  Config,
  Renderer extends TuiBootstrapRenderer,
  Root,
> {
  readonly argv: readonly string[];
  readonly parseArgs: (argv: readonly string[]) => Args | Promise<Args>;
  readonly loadConfig: (args: Args) => Config | Promise<Config>;
  readonly createRenderer: (input: { args: Args; config: Config }) => Renderer | Promise<Renderer>;
  readonly createLifecycle: (renderer: Renderer) => TuiApplicationLifecycle;
  readonly mountRoot: (
    context: TuiBootstrapContext<Args, Config, Renderer>,
  ) => TuiMountedRoot<Root> | Promise<TuiMountedRoot<Root>>;
  readonly publishReady: (
    context: TuiBootstrapContext<Args, Config, Renderer> & { readonly root: Root },
  ) => void | Promise<void>;
}

export interface TuiApplicationHandle<Args, Config, Renderer, Root> {
  readonly args: Args;
  readonly config: Config;
  readonly renderer: Renderer;
  readonly root: Root;
  readonly lifecycle: TuiApplicationLifecycle;
  shutdown(): Promise<TuiShutdownReport>;
}

export interface TuiRootFailureObserverOptions {
  /** Break the bootstrap readiness wait with the original render failure. */
  readonly rejectReadiness: (error: unknown) => void;
  /** Record the failure before renderer teardown can remove diagnostics. */
  readonly reportFailure?: (error: unknown) => void;
  /** Retire application resources and the native renderer. */
  readonly shutdown: () => void | Promise<unknown>;
}

/**
 * Join a framework root's asynchronous failure to the bootstrap lifecycle.
 *
 * OpenTUI's Solid `render()` returns a root Promise independently from the
 * readiness Promise awaited below. A rejected root must therefore reject that
 * gate explicitly; merely shutting the renderer down strands bootstrap on a
 * never-settling readiness wait and leaves the host process alive.
 */
export function observeTuiRootFailure(
  root: PromiseLike<unknown>,
  options: TuiRootFailureObserverOptions,
): void {
  void Promise.resolve(root).catch(async (error: unknown) => {
    options.reportFailure?.(error);
    options.rejectReadiness(error);
    await options.shutdown();
  });
}

/**
 * Thin, dependency-injected boot sequence. No config, daemon, Solid, or native
 * renderer work occurs at module evaluation time; each boundary is testable.
 */
export async function startTuiApplication<
  Args,
  Config,
  Renderer extends TuiBootstrapRenderer,
  Root,
>(
  options: TuiApplicationBootstrapOptions<Args, Config, Renderer, Root>,
): Promise<TuiApplicationHandle<Args, Config, Renderer, Root>> {
  const args = await options.parseArgs(options.argv);
  const config = await options.loadConfig(args);
  const renderer = await options.createRenderer({ args, config });
  const lifecycle = options.createLifecycle(renderer);
  const context: TuiBootstrapContext<Args, Config, Renderer> = {
    args,
    config,
    renderer,
    lifecycle,
  };
  try {
    const mounted = await options.mountRoot(context);
    if (mounted.close) lifecycle.registerCloser("application-root", mounted.close);
    await mounted.ready;
    if (!lifecycle.accepting) {
      await lifecycle.shutdown("host");
      throw new Error("OpenTUI root stopped before reaching input readiness");
    }
    await options.publishReady({ ...context, root: mounted.root });
    return {
      ...context,
      root: mounted.root,
      shutdown: () => lifecycle.shutdown("host"),
    };
  } catch (error) {
    await lifecycle.shutdown("bootstrap-error");
    throw error;
  }
}
