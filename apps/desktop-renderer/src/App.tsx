import { Show, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import type { DesktopThemeState, DesktopWindowState } from "@tmux-ide/contracts";

import {
  parseThemeState,
  parseWindowState,
  readHostBootstrap,
  resolveHostCapabilities,
} from "./host-capabilities.ts";
import { createDomExperience } from "./experience/index.ts";

const host = resolveHostCapabilities();

function daemonLabel(status: string): string {
  if (status === "ready") return "Daemon ready";
  if (status === "absent") return "Daemon absent";
  if (status === "unavailable") return "Daemon unavailable";
  return "Daemon integration deferred";
}

export function App() {
  const [bootstrap] = createResource(() => readHostBootstrap(host));
  const [theme, setTheme] = createSignal<DesktopThemeState | null>(null);
  const [windowState, setWindowState] = createSignal<DesktopWindowState | null>(null);

  onMount(() => {
    const stopTheme = host.theme.onChanged((next) => setTheme(parseThemeState(next)));
    const stopWindow = host.window.onStateChanged((next) => setWindowState(parseWindowState(next)));
    onCleanup(() => {
      stopTheme();
      stopWindow();
    });
  });

  const effectiveTheme = () => theme() ?? bootstrap()?.theme ?? null;
  const effectiveWindow = () => windowState() ?? bootstrap()?.window ?? null;
  const experience = createMemo(() => createDomExperience({ hostTheme: effectiveTheme() }));

  return (
    <main
      class="app"
      data-theme={experience().appearance}
      data-reduced-motion={String(experience().accessibility.reducedMotion)}
      data-increased-contrast={String(experience().accessibility.increasedContrast)}
      data-accessibility-conflicts={experience().accessibility.conflicts.join(" ") || undefined}
      style={experience().variables}
    >
      <header class="titlebar">
        <div class="titlebar__drag">
          <span class="brand-mark" aria-hidden="true">
            ▦
          </span>
          <strong>tmux-ide</strong>
          <span class="titlebar__context">desktop foundation</span>
        </div>
        <Show when={bootstrap()?.runtime === "electron" && bootstrap()?.platform !== "darwin"}>
          <nav class="window-controls" aria-label="Window controls">
            <button type="button" aria-label="Minimize" onClick={() => void host.window.minimize()}>
              −
            </button>
            <button
              type="button"
              aria-label={effectiveWindow()?.maximized ? "Restore" : "Maximize"}
              onClick={() => void host.window.toggleMaximized()}
            >
              {effectiveWindow()?.maximized ? "❐" : "□"}
            </button>
            <button type="button" aria-label="Close" onClick={() => void host.window.close()}>
              ×
            </button>
          </nav>
        </Show>
      </header>

      <section class="workbench">
        <aside class="rail" aria-label="Workspace navigation">
          <button class="rail__item rail__item--active" type="button">
            <span>⌂</span>Home
          </button>
          <button class="rail__item" type="button">
            <span>▣</span>Sessions
          </button>
          <button class="rail__item" type="button">
            <span>◇</span>Missions
          </button>
          <button class="rail__item" type="button">
            <span>⌘</span>Commands
          </button>
        </aside>

        <section class="canvas" aria-labelledby="welcome-title">
          <div class="canvas__eyebrow">Host-neutral Solid workspace</div>
          <h1 id="welcome-title">Your tmux sessions, ready for a real desktop.</h1>
          <p class="canvas__lead">
            This renderer is ordinary browser code. Electron owns only native lifecycle and window
            capabilities; terminals and missions will arrive through shared daemon contracts.
          </p>

          <div class="cards">
            <article class="card">
              <div class="card__icon">01</div>
              <h2>Open a project</h2>
              <p>
                Project onboarding will discover or create the workspace without hand-authored IDE
                files.
              </p>
              <button
                class="primary-action"
                type="button"
                onClick={() => void host.dialog.selectProjectDirectory()}
              >
                Choose folder
              </button>
            </article>
            <article class="card card--terminal">
              <div class="terminal-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </div>
              <pre aria-label="Terminal placeholder">
                <code>
                  <span>$</span> tmux-ide --headless{"\n"}
                  <b>future daemon preflight only</b>
                </code>
              </pre>
            </article>
          </div>
        </section>

        <aside class="inspector" aria-label="Desktop host status">
          <h2>Foundation</h2>
          <dl>
            <div>
              <dt>Runtime</dt>
              <dd>{bootstrap()?.runtime ?? "loading"}</dd>
            </div>
            <div>
              <dt>Platform</dt>
              <dd>{bootstrap()?.platform ?? "—"}</dd>
            </div>
            <div>
              <dt>Theme</dt>
              <dd>{effectiveTheme()?.mode ?? "—"}</dd>
            </div>
            <div>
              <dt>Daemon</dt>
              <dd>{daemonLabel(bootstrap()?.daemon.status ?? "deferred")}</dd>
            </div>
          </dl>
          <div class="boundary-note">
            <span>Boundary</span>
            No Node.js or Electron APIs are present in this renderer.
          </div>
        </aside>
      </section>

      <footer class="statusbar">
        <span>
          <i class="status-dot" />{" "}
          {bootstrap.loading ? "Connecting to host" : "Desktop shell ready"}
        </span>
        <span>⌘K command palette · coming next</span>
      </footer>
    </main>
  );
}
