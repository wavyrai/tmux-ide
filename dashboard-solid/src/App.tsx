import type { JSX, ParentProps } from "solid-js";

/**
 * Root shell for the Solid dashboard.
 *
 * P1 is intentionally bare: no top bar, no sidebar, no command palette.
 * The widgets gallery is the only mounted route, so all global chrome is
 * deferred to G16-P2 (project shell) and G16-P3 (overview/setup/settings).
 *
 * Theme: the design tokens in src/styles.css default to the dark theme
 * (`:root`) and switch via `[data-theme="..."]`. P1 leaves the body
 * default (dark); a theme signal lands in P2.
 */
export function App(props: ParentProps): JSX.Element {
  return (
    <div class="flex h-screen w-screen min-h-0 min-w-0 flex-col bg-[var(--bg)] text-[var(--fg)] font-sans antialiased">
      {props.children}
    </div>
  );
}
