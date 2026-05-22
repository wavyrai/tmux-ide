/**
 * /widget/:name — single-widget xterm mirror.
 *
 * Solid port of `dashboard/app/widget/[name]/page.tsx`. Calls
 * `fetchWidgetSpawn` to ask the daemon for the widget binary's cwd +
 * argv, then mounts a Terminal pinned to those values. The same PTY
 * WebSocket protocol drives both the in-app Terminal panes and this
 * standalone embed.
 *
 * Query parameters:
 *   - session   (required) — the session name the widget binds to.
 *   - dir       (required) — the working directory.
 *   - target    (optional) — passed through to the daemon as a hint.
 *   - theme     (optional) — JSON-encoded theme override.
 */

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { A, useParams, useSearchParams } from "@solidjs/router";
import { Effect } from "effect";
import { Terminal } from "@/components/Terminal";
import { fetchWidgetSpawn, type WidgetSpawnSpec } from "@/lib/api";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; spec: WidgetSpawnSpec; id: string }
  | { kind: "error"; message: string };

export default function WidgetRoute(): JSX.Element {
  const params = useParams<{ name: string }>();
  const [search] = useSearchParams<{
    session?: string;
    dir?: string;
    target?: string;
    theme?: string;
  }>();

  const [state, setState] = createSignal<LoadState>({ kind: "loading" });

  const widgetName = () => params.name ?? "";
  const session = () => (typeof search.session === "string" ? search.session : "");
  const dir = () => (typeof search.dir === "string" ? search.dir : "");
  const target = () => (typeof search.target === "string" ? search.target : undefined);
  const themeRaw = () => (typeof search.theme === "string" ? search.theme : undefined);
  const bridgeId = () => `widget:${widgetName()}:${session()}:${target() ?? "*"}`;

  onMount(() => {
    let cancelled = false;
    if (!widgetName() || !session() || !dir()) {
      setState({
        kind: "error",
        message: "missing widget name, session, or dir query params",
      });
      return;
    }
    void (async () => {
      try {
        let theme: unknown = undefined;
        const raw = themeRaw();
        if (raw) {
          try {
            theme = JSON.parse(raw);
          } catch {
            throw new Error("theme query param must be valid JSON");
          }
        }
        const fetchParams: {
          session: string;
          dir: string;
          target?: string;
          theme?: unknown;
        } = { session: session(), dir: dir() };
        const t = target();
        if (t) fetchParams.target = t;
        if (theme !== undefined) fetchParams.theme = theme;
        const spec = await Effect.runPromise(fetchWidgetSpawn(widgetName(), fetchParams));
        if (cancelled) return;
        setState({ kind: "ready", spec, id: bridgeId() });
      } catch (err) {
        if (cancelled) return;
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    onCleanup(() => {
      cancelled = true;
    });
  });

  return (
    <div
      data-testid="v2-widget-route"
      data-widget-name={widgetName()}
      class="flex h-screen flex-col bg-[var(--bg)] text-[var(--fg)]"
    >
      <header class="flex h-7 shrink-0 items-center border-b border-[var(--border)] bg-[var(--bg-strong)] px-3 text-sm tabular-nums">
        <A
          href="/"
          class="mr-2 inline-flex items-center gap-1 text-[var(--dim)] hover:text-[var(--fg)]"
        >
          <span aria-hidden="true">◇</span>
          <span>tmux-ide</span>
        </A>
        <span class="mx-1 text-[var(--dimmer)]">/</span>
        <span>widget</span>
        <span class="mx-1 text-[var(--dimmer)]">/</span>
        <span class="font-medium text-[var(--accent)]">{widgetName()}</span>
        <Show when={session()}>
          <span class="mx-1 text-[var(--dimmer)]">·</span>
          <span class="text-[var(--fg-secondary)]">{session()}</span>
        </Show>
        <Show when={target()}>
          <span class="mx-1 text-[var(--dimmer)]">·</span>
          <span class="truncate text-[var(--dim)]">{target()}</span>
        </Show>
        <span class="flex-1" />
        <span class="text-[var(--dim)]">PTY mirror</span>
      </header>

      <div class="flex-1 min-h-0">
        <Show when={state().kind === "loading"}>
          <div
            data-testid="v2-widget-loading"
            class="flex h-full items-center justify-center text-[var(--dim)]"
          >
            resolving widget…
          </div>
        </Show>
        <Show when={state().kind === "error"}>
          {(_) => {
            const s = state();
            if (s.kind !== "error") return null;
            return (
              <div
                data-testid="v2-widget-error"
                class="flex h-full items-center justify-center px-6 text-center text-[var(--red-foreground,var(--red))]"
              >
                <div>
                  <div class="mb-2 text-base uppercase tracking-wider">widget unavailable</div>
                  <div class="text-sm text-[var(--dim)]">{s.message}</div>
                </div>
              </div>
            );
          }}
        </Show>
        <Show when={state().kind === "ready"}>
          {(_) => {
            const s = state();
            if (s.kind !== "ready") return null;
            return <Terminal id={s.id} showHeader={false} cwd={s.spec.cwd} cmd={s.spec.cmd} />;
          }}
        </Show>
      </div>
    </div>
  );
}
