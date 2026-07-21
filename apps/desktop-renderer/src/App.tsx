import { createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import type {
  ApplicationShellCommandInvocation,
  ApplicationShellProjectionInputV1,
  DesktopThemeState,
  DesktopWindowState,
  HostCapabilities,
} from "@tmux-ide/contracts";

import {
  parseThemeState,
  parseWindowState,
  readHostBootstrap,
  readInitialThemeState,
  resolveHostCapabilities,
} from "./host-capabilities.ts";
import { DomApplicationShell, createDomExperience } from "./experience/index.ts";

export interface AppProps {
  readonly host?: HostCapabilities;
  readonly initialTheme?: DesktopThemeState;
  readonly shellInput?: ApplicationShellProjectionInputV1;
  readonly onCommand?: (invocation: ApplicationShellCommandInvocation) => void;
}

export function App(props: AppProps = {}) {
  const host = props.host ?? resolveHostCapabilities();
  const initialTheme = props.initialTheme ?? readInitialThemeState();
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

  const effectiveTheme = () => theme() ?? bootstrap()?.theme ?? initialTheme;
  const effectiveWindow = () => windowState() ?? bootstrap()?.window ?? null;
  const experience = createMemo(() => createDomExperience({ hostTheme: effectiveTheme() }));

  return (
    <div
      class="app"
      data-theme={experience().appearance}
      data-platform={bootstrap()?.platform}
      data-reduced-motion={String(experience().accessibility.reducedMotion)}
      data-increased-contrast={String(experience().accessibility.increasedContrast)}
      data-accessibility-conflicts={experience().accessibility.conflicts.join(" ") || undefined}
      data-shell-source={props.shellInput === undefined ? "preview" : "runtime"}
      style={experience().variables}
    >
      <DomApplicationShell
        host={host}
        daemonState={bootstrap()?.daemon}
        runtime={bootstrap()?.runtime}
        platform={bootstrap()?.platform}
        windowState={effectiveWindow()}
        input={props.shellInput}
        dataMode={props.shellInput === undefined ? "preview" : "runtime"}
        onCommand={props.onCommand}
      />
    </div>
  );
}
