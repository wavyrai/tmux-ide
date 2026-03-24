#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"
PROJECT_DIR="$(dirname "$APP_DIR")"

cd "$APP_DIR"

# Skip if already present
if [ -d "$APP_DIR/GhosttyKit.xcframework" ]; then
  echo "==> GhosttyKit.xcframework already exists"
  echo "==> Done"
  exit 0
fi

# Clone Ghostty if not in context
GHOSTTY_DIR="$PROJECT_DIR/context/ghostty"
if [ ! -d "$GHOSTTY_DIR" ]; then
  echo "==> Cloning Ghostty into context/ghostty..."
  git clone --depth 1 https://github.com/ghostty-org/ghostty.git "$GHOSTTY_DIR"
fi

# Check prerequisites
if ! command -v zig >/dev/null 2>&1; then
  echo "Error: zig not installed. Run: brew install zig"
  exit 1
fi

# Cache by SHA
GHOSTTY_SHA="$(git -C "$GHOSTTY_DIR" rev-parse HEAD)"
CACHE_ROOT="${HOME}/.cache/tmux-ide-app/ghosttykit"
CACHE_DIR="$CACHE_ROOT/$GHOSTTY_SHA"
CACHE_XCFRAMEWORK="$CACHE_DIR/GhosttyKit.xcframework"

mkdir -p "$CACHE_ROOT"
echo "==> Ghostty SHA: $GHOSTTY_SHA"

if [ ! -d "$CACHE_XCFRAMEWORK" ]; then
  echo "==> Building GhosttyKit.xcframework (this may take a few minutes)..."
  (
    cd "$GHOSTTY_DIR"
    zig build \
      -Demit-xcframework=true \
      -Demit-macos-app=false \
      -Dxcframework-target=universal \
      -Doptimize=ReleaseFast \
      -Dversion-string=0.0.0 \
      -Di18n=false
  )

  LOCAL_XCFRAMEWORK="$GHOSTTY_DIR/macos/GhosttyKit.xcframework"
  if [ ! -d "$LOCAL_XCFRAMEWORK" ]; then
    # Try zig-out path
    LOCAL_XCFRAMEWORK="$GHOSTTY_DIR/zig-out/lib/GhosttyKit.xcframework"
  fi

  if [ ! -d "$LOCAL_XCFRAMEWORK" ]; then
    echo "Error: GhosttyKit.xcframework not found after build"
    echo "Searched: $GHOSTTY_DIR/macos/ and $GHOSTTY_DIR/zig-out/lib/"
    exit 1
  fi

  mkdir -p "$CACHE_DIR"
  cp -R "$LOCAL_XCFRAMEWORK" "$CACHE_XCFRAMEWORK"
  echo "==> Cached GhosttyKit.xcframework"
fi

echo "==> Creating symlink ./GhosttyKit.xcframework"
ln -sfn "$CACHE_XCFRAMEWORK" "$APP_DIR/GhosttyKit.xcframework"

echo "==> Done"
