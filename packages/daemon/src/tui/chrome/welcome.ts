import { runtimeOwnedPath } from "../../lib/runtime-namespace.ts";
import { resolveRuntimeNamespace } from "../../lib/runtime-namespace.ts";
/**
 * The first-run WELCOME card — shown ONCE, the moment tmux-ide first adopts a
 * session.
 *
 * The discovery problem: once a session is adopted, the whole TUI is one
 * keystroke away (the home cockpit, the switcher, the actions menu, the cheat
 * sheet), but a brand-new user has no way to know those keys exist. The welcome
 * card is the pointer: a tiny hero that names the four "unlock" keys and then
 * gets out of the way forever.
 *
 * "Once" is enforced by a marker file (`~/.tmux-ide/welcomed`, overridable via
 * `TMUX_IDE_HOME` so tests — and the dev box — never see it unexpectedly). The
 * card is ALSO gated by config (`welcome.show`), so it can be suppressed without
 * touching the marker.
 *
 * {@link buildWelcomeText} is PURE (tested); {@link maybeShowWelcomePopup} and
 * the marker helpers wire the io. The CLI `welcome` command prints the card and
 * waits for any key (see bin/cli.ts).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_KEYS, getAppConfig, type AppKeys } from "../../lib/app-config.ts";

// --- ANSI styling — the CLI's bold/dim/cyan pattern (matches ./cheatsheet.ts). ---
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const head = (s: string) => `\x1b[1;36m${s}\x1b[0m`;

/**
 * Render a tmux key name for humans: `M-` → `⌥`, `C-` → `^`, `S-` → `⇧`. Keeps
 * the card's key hints sourced from the real `M-…` config values (same helper as
 * the cheat sheet).
 */
function renderKey(tmuxKey: string): string {
  return tmuxKey.replace(/M-/g, "⌥").replace(/C-/g, "^").replace(/S-/g, "⇧");
}

/**
 * Absolute path to the "already welcomed" marker: `<home>/welcomed`, where
 * `<home>` is `TMUX_IDE_HOME` when set (tests / per-run overrides), else
 * `~/.tmux-ide`. The env override lets a live test point the marker at a scratch
 * dir so it never touches — or is confused by — the real user's marker.
 */
export function welcomeMarkerPath(): string {
  const home = resolveRuntimeNamespace().stateHome;
  return runtimeOwnedPath(join(home, "welcomed"));
}

/**
 * Whether the first-run welcome should show: the marker file is ABSENT and the
 * config hasn't disabled it (`welcome.show !== false`). A missing/garbage config
 * defaults `welcome.show` to true (see app-config), so a fresh install shows it.
 */
export function shouldShowWelcome(): boolean {
  return !existsSync(welcomeMarkerPath()) && getAppConfig().welcome.show;
}

/**
 * Create the marker file so the welcome shows only once. Best-effort — a marker
 * we can't write means the card may show again, but it must never crash adopt.
 */
export function markWelcomed(): void {
  const path = welcomeMarkerPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Date().toISOString());
  } catch {
    // can't write the marker — degrade to "may show again", never throw
  }
}

/**
 * PURE — the welcome card text (ANSI-styled), sized for a small ~60×12 popup. A
 * tiny hero naming the FOUR keys that unlock the whole TUI, sourced from the live
 * key config so a rebind relabels the card. Ends with the "shows once" note so
 * the user knows it won't nag.
 */
export function buildWelcomeText(keys: AppKeys = DEFAULT_KEYS): string {
  const lines = [
    head(" You're in tmux-ide"),
    dim(" your terminal, now a fleet you can see and steer."),
    "",
    " Four keys unlock everything:",
    `   ${bold("right-click")}   the actions menu — anywhere`,
    `   ${bold(renderKey(keys.home).padEnd(11))}   the home cockpit`,
    `   ${bold(renderKey(keys.popup).padEnd(11))}   switch session`,
    `   ${bold(renderKey(keys.cheatsheet).padEnd(11))}   all keys (the cheat sheet)`,
    "",
    dim(" This card shows once — press any key to close."),
  ];
  return lines.join("\n");
}

/**
 * io — float the one-time welcome card on the CURRENT tmux client, best-effort.
 *
 * Called at the end of {@link ../chrome/statusline.ts adoptSession}. Gated by
 * {@link shouldShowWelcome} (marker + config) AND by being inside a tmux client
 * — outside tmux there's nowhere to float the popup, so we neither show it nor
 * burn the one-shot (the marker stays, so the next in-tmux adopt still shows it).
 *
 * The popup is spawned DETACHED and unref'd so it never blocks the adopt: a
 * `display-popup -E` would otherwise keep the tmux CLI alive until the user
 * pressed a key. `spawn` inherits `$TMUX`, so the popup lands on the invoking
 * client. The marker is written immediately after the spawn attempt so a rapid
 * `adopt --all` shows the card exactly once, not once per session.
 */
export function maybeShowWelcomePopup(): void {
  if (!shouldShowWelcome()) return;
  if (!process.env.TMUX) return;
  try {
    const child = spawn(
      "tmux",
      ["display-popup", "-E", "-w", "60", "-h", "12", "tmux-ide welcome"],
      { stdio: "ignore", detached: true },
    );
    child.unref();
  } catch {
    // tmux missing / no client — best-effort, still mark so we don't retry forever
  }
  markWelcomed();
}
