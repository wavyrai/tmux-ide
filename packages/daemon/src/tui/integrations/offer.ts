import { runtimeOwnedPath } from "../../lib/runtime-namespace.ts";
import { resolveRuntimeNamespace } from "../../lib/runtime-namespace.ts";
/**
 * The one-time INTEGRATION OFFER — shown the first time tmux-ide adopts a
 * session on a machine that has Claude Code but hasn't installed the lifecycle
 * hook.
 *
 * The onboarding gap: the Claude Code integration turns pane state from
 * screen-scraping guesswork into ground truth, but nothing prompts the user to
 * install it — they'd have to read the docs. This offer notices `claude` on
 * PATH at adopt time and asks once: install now? [y/N]. `y` installs; anything
 * else skips. Either way a marker is written so it never asks again.
 *
 * "Once" is enforced by a marker file (`<home>/integration-offered`, `<home>` =
 * `TMUX_IDE_HOME` when set — so tests and the dev box never see it), exactly
 * like the welcome card ({@link ../chrome/welcome.ts}). The offer is ALSO gated
 * by config (`integrations.offer`), so it can be suppressed without touching the
 * marker. {@link shouldOfferIntegration} is the PURE decision; the marker
 * helpers and {@link maybeOfferIntegrationPopup} wire the io. It NEVER fails an
 * adopt — every io path is best-effort.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAppConfig } from "../../lib/app-config.ts";
import { claudeIntegrationStatus } from "./claude.ts";

/**
 * Absolute path to the "already offered" marker: `<home>/integration-offered`,
 * where `<home>` is `TMUX_IDE_HOME` when set (tests / per-run overrides), else
 * `~/.tmux-ide`. The env override lets a live test point the marker at a scratch
 * dir so it never touches — or is confused by — the real user's marker.
 */
export function integrationOfferMarkerPath(): string {
  const home = resolveRuntimeNamespace().stateHome;
  return runtimeOwnedPath(join(home, "integration-offered"));
}

/**
 * PURE — the first-adopt offer decision. Show the offer only when ALL hold:
 *   - `claudeOnPath`         Claude Code is installed on this machine,
 *   - `integrationInstalled` is false (nothing to offer if it's already hooked),
 *   - `markerPresent`        is false (we've never offered before), and
 *   - `offerEnabled`         config hasn't disabled the offer.
 * Kept pure so every gate is trivially unit-tested.
 */
export function shouldOfferIntegration(input: {
  claudeOnPath: boolean;
  integrationInstalled: boolean;
  markerPresent: boolean;
  offerEnabled: boolean;
}): boolean {
  return (
    input.claudeOnPath && !input.integrationInstalled && !input.markerPresent && input.offerEnabled
  );
}

/**
 * Create the marker so the offer shows only once. Best-effort — a marker we
 * can't write means the offer may show again, but it must never crash adopt.
 */
export function markIntegrationOffered(): void {
  const path = integrationOfferMarkerPath();
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Date().toISOString());
  } catch {
    // can't write the marker — degrade to "may offer again", never throw
  }
}

/**
 * PURE — the offer prompt text shown inside the popup. A single question with a
 * one-line rationale; the `[y/N]` makes the safe default (skip) obvious.
 */
export function buildOfferText(): string {
  const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
  const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
  const head = (s: string) => `\x1b[1;36m${s}\x1b[0m`;
  return [
    head(" Claude Code detected"),
    "",
    " Install the tmux-ide integration for ground-truth agent status?",
    dim(" It hooks Claude Code's lifecycle so pane state is exact, not guessed."),
    "",
    ` ${bold("[y]")} install    ${bold("[N]")} skip (any other key)`,
    dim(" Asked once — press a key."),
  ].join("\n");
}

/**
 * io — float the one-time offer popup on the CURRENT tmux client, best-effort.
 *
 * Called at the end of {@link ../chrome/statusline.ts adoptSession} (right after
 * the welcome card). Gated by {@link shouldOfferIntegration} (PATH + integration
 * status + marker + config) AND by being inside a tmux client — outside tmux
 * there's nowhere to float the popup, so we neither show it nor burn the marker
 * (the next in-tmux adopt still offers).
 *
 * The popup runs `tmux-ide integration offer`, which reads one key and installs
 * on `y` (see bin/cli.ts). It's spawned DETACHED and unref'd so it never blocks
 * the adopt. The marker is written immediately after the spawn attempt so a
 * rapid `adopt --all` offers exactly once, not once per session — matching the
 * welcome card's one-shot discipline.
 */
export function maybeOfferIntegrationPopup(): void {
  if (resolveRuntimeNamespace().development) return;
  let offer: boolean;
  try {
    const status = claudeIntegrationStatus();
    offer = shouldOfferIntegration({
      claudeOnPath: claudeOnPath(),
      integrationInstalled: status.installed,
      markerPresent: existsSync(integrationOfferMarkerPath()),
      offerEnabled: getAppConfig().integrations.offer,
    });
  } catch {
    return; // any probe failure → never risk the adopt, just don't offer
  }
  if (!offer) return;
  if (!process.env.TMUX) return;
  try {
    const child = spawn(
      "tmux",
      ["display-popup", "-E", "-w", "64", "-h", "12", "tmux-ide integration offer"],
      { stdio: "ignore", detached: true },
    );
    child.unref();
  } catch {
    // tmux missing / no client — best-effort, still mark so we don't retry forever
  }
  markIntegrationOffered();
}

/**
 * io — is `claude` on PATH? A which-probe capped at 2s, swallowing every failure
 * to false. Local (not {@link ../../lib/agent-discovery.ts}) to keep the adopt
 * path's offer check a single cheap probe rather than the full agent sweep.
 */
function claudeOnPath(): boolean {
  try {
    execFileSync("which", ["claude"], { stdio: "ignore", timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
