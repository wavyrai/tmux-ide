#!/usr/bin/env bash
# setup.sh — Verify GhosttyKit.xcframework is available for the TmuxIde build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FRAMEWORK="$APP_DIR/GhosttyKit.xcframework"

echo "==> Checking GhosttyKit.xcframework..."

if [ -e "$FRAMEWORK" ]; then
    if [ -L "$FRAMEWORK" ]; then
        TARGET="$(readlink "$FRAMEWORK")"
        echo "    Found symlink -> $TARGET"
    else
        echo "    Found at $FRAMEWORK"
    fi
    echo "==> GhosttyKit.xcframework is ready."
    exit 0
fi

echo ""
echo "    GhosttyKit.xcframework not found at:"
echo "    $FRAMEWORK"
echo ""
echo "    To obtain it, build GhosttyKit from the Ghostty source:"
echo ""
echo "      1. Clone Ghostty:"
echo "         git clone https://github.com/ghostty-org/ghostty.git"
echo ""
echo "      2. Build the xcframework (requires Zig 0.13+):"
echo "         cd ghostty"
echo "         zig build -Doptimize=ReleaseFast -Dapp-runtime=none"
echo ""
echo "      3. The framework will be at:"
echo "         zig-out/lib/GhosttyKit.xcframework/"
echo ""
echo "      4. Symlink it into the app directory:"
echo "         ln -s /path/to/ghostty/zig-out/lib/GhosttyKit.xcframework \\"
echo "           $FRAMEWORK"
echo ""
echo "    Alternatively, if you have Ghostty.app installed, the framework"
echo "    may be inside the app bundle:"
echo "      /Applications/Ghostty.app/Contents/Frameworks/GhosttyKit.framework"
echo ""
echo "    Note: The build expects an xcframework (not a plain .framework)."
echo "    Building from source is the recommended approach."
echo ""
exit 1
