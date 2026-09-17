#!/bin/sh
# Usage: curl -fsSL https://tmux.thijsverreck.com/install.sh | sh
set -e
info() { printf '%s\n' "$1"; }
error() { printf 'error: %s\n' "$1" >&2; exit 1; }
command -v tmux >/dev/null 2>&1 || error "tmux is not installed. Install it first: https://github.com/tmux/tmux/wiki/Installing"
command -v node >/dev/null 2>&1 || error "Node.js is not installed. Install Node.js 20+: https://nodejs.org"
NODE_VERSION=$(node -p 'Number(process.versions.node.split(".")[0])')
case "$NODE_VERSION" in ''|*[!0-9]*) error "Could not determine Node.js version" ;; esac
[ "$NODE_VERSION" -ge 20 ] || error "Node.js 20+ is required (found ${NODE_VERSION})"
if command -v pnpm >/dev/null 2>&1; then
  PM=pnpm
elif command -v bun >/dev/null 2>&1; then
  PM=bun
elif command -v npm >/dev/null 2>&1; then
  PM=npm
else
  error "Install npm, pnpm, or Bun first. Yarn installations should use their original Yarn workflow."
fi
info "Installing tmux-ide@latest with $PM..."
case "$PM" in
  npm)
    npm install -g tmux-ide@latest
    PACKAGE_ROOT=$(npm root -g) || error "Cannot locate npm global packages; check npm prefix -g."
    INSTALLED_CLI="$PACKAGE_ROOT/tmux-ide/bin/cli.js"
    ;;
  pnpm)
    pnpm add -g tmux-ide@latest
    PACKAGE_ROOT=$(pnpm root -g) || error "Cannot locate pnpm global packages; run pnpm setup."
    INSTALLED_CLI="$PACKAGE_ROOT/tmux-ide/bin/cli.js"
    ;;
  bun)
    bun add -g tmux-ide@latest
    GLOBAL_BIN=$(bun pm bin -g) || error "Cannot locate Bun global binaries; check BUN_INSTALL."
    INSTALLED_CLI="$GLOBAL_BIN/tmux-ide"
    ;;
esac
[ -n "$INSTALLED_CLI" ] && [ -f "$INSTALLED_CLI" ] || error "Installed CLI was not found at $INSTALLED_CLI; inspect your $PM global installation."
# Invoke the exact installed entry, never an older tmux-ide earlier on PATH.
EXPECTED_VERSION=$(node -e 'const fs = require("node:fs"); const path = require("node:path"); const entry = fs.realpathSync(process.argv[1]); const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), "../package.json"), "utf8")); if (pkg.name !== "tmux-ide" || typeof pkg.version !== "string") process.exit(1); process.stdout.write(pkg.version);' "$INSTALLED_CLI") || error "Cannot verify the installed package at $INSTALLED_CLI"
INSTALLED_VERSION=$(node "$INSTALLED_CLI" --version) || error "The installed CLI failed its version check: $INSTALLED_CLI"
[ "$INSTALLED_VERSION" = "tmux-ide v$EXPECTED_VERSION" ] || error "Installed CLI version does not match its package ($INSTALLED_VERSION versus $EXPECTED_VERSION)."
# Package postinstall owns skill/integration setup; no npm-specific copying here.
info "$INSTALLED_VERSION installed successfully ($INSTALLED_CLI)."
info "Ensure your $PM global bin directory is on PATH."
info "Get started:"
info "  cd your-project"
info "  tmux-ide          # launch; no config required"
info "  tmux-ide init     # optional .tmux-ide/workspace.yml preset"
