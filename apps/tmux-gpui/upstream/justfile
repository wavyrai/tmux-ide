default:
    @just --list

# macOS names a running app after its executable, so run the bundle to stay "Herdr".
run *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$(uname -s)" != Darwin ]; then
        exec cargo run --locked --release -p herdr-gpui --features qa-menu -- {{args}}
    fi
    {{just_executable()}} bundle release qa-menu
    exec target/release/Herdr.app/Contents/MacOS/Herdr {{args}}

run-debug *args:
    #!/usr/bin/env bash
    set -euo pipefail
    if [ "$(uname -s)" != Darwin ]; then
        exec cargo run --locked -p herdr-gpui -- {{args}}
    fi
    {{just_executable()}} bundle debug
    exec target/debug/Herdr.app/Contents/MacOS/Herdr {{args}}

format:
    cargo fmt --all

format-check:
    cargo fmt --all -- --check

# Every feature, then none: cloud providers are default features, and a build
# without them must not keep code only they use.
lint:
    cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
    cargo clippy --locked --workspace --all-targets --no-default-features -- -D warnings

test:
    cargo test --locked --workspace
    cargo test --locked --workspace --all-features

# Explicit opt-in: launches and cleans up its own isolated daemon only.
test-live binary:
    HERDR_TEST_BINARY="{{binary}}" cargo test --locked -p herdr-client --test live -- --ignored --nocapture

# Opens a real native window; requires an active desktop. Uses an isolated daemon.
test-gui binary:
    HERDR_TEST_BINARY="{{binary}}" cargo test --locked -p herdr-gpui --features integration-test --test live_gui -- --ignored --nocapture --test-threads=1

# Explicit opt-in: reads the real code signature and Homebrew records of an
# installed app. Never discovers an installation on its own.
test-update bundle:
    HERDR_TEST_BUNDLE="{{bundle}}" cargo test --locked -p herdr-gpui updater::install::tests::signing::installed_bundle -- --ignored --nocapture
    HERDR_TEST_BUNDLE="{{bundle}}" cargo test --locked -p herdr-gpui updater::brew::tests::the_real_cask -- --ignored --nocapture

# Really upgrades the installed app through Homebrew; restart it afterwards.
test-brew-upgrade bundle expected:
    HERDR_TEST_BUNDLE="{{bundle}}" HERDR_TEST_BREW_EXPECTED="{{expected}}" HERDR_TEST_BREW_UPGRADE=1 cargo test --locked -p herdr-gpui updater::brew::tests::homebrew_really_installs -- --ignored --nocapture

# Repeat the Linux suite under CPU pressure in a container, where scheduling
# races reproduce that a fast machine hides. Needs Docker; nothing else.
stress-linux iterations="30" cpus="0.5" filter="":
    bash scripts/stress-linux.sh {{iterations}} {{cpus}} {{filter}}

# Native font/glyph regression across repeated frames and sizes; no daemon needed.
test-sidebar:
    cargo test --locked -p herdr-gpui --features integration-test --test live_gui native_sidebar -- --ignored --nocapture --test-threads=1

# Native hover/scroll CPU scene budget in milliseconds, calibrated for this machine.
test-perf budget="30":
    cargo build --locked --release -p herdr-gpui --features integration-test
    HERDR_PERF_P95_MS="{{budget}}" target/release/herdr-gpui --performance-test

# Compare UI variants written as GPUI code in `file` (the built-in demo when
# empty) in a native window. "Send to agent" writes `feedback`; `capture` gets
# a PNG of the window once it has drawn. Debug build, no daemon. The process
# left running is the app itself, so its PID is the one to stop.
# See .claude/skills/gpui-mockup.
[positional-arguments]
mockup file="" feedback="" capture="":
    #!/usr/bin/env bash
    set -euo pipefail
    absolute() { case "$1" in ""|/*) printf '%s' "$1" ;; *) printf '%s/%s' {{quote(invocation_directory())}} "$1" ;; esac; }
    file="$(absolute "$1")"
    feedback="$(absolute "$2")"
    capture="$(absolute "$3")"
    HERDR_MOCKUP_FILE="$file" cargo build --locked -p herdr-gpui --features mockup
    args=(--mockup)
    if [ -n "$feedback" ]; then args+=(--feedback "$feedback"); fi
    if [ -n "$capture" ]; then args+=(--capture "$capture"); fi
    exec target/debug/herdr-gpui "${args[@]}"

build-release:
    cargo build --locked --release -p herdr-gpui

# Regenerate the checked-in artwork on macOS (requires brew install librsvg).
icons:
    swift scripts/generate-icons.swift

# Local, unsigned GUI-only bundle. Never installs or packages a daemon.
bundle profile="release" features="":
    #!/usr/bin/env bash
    set -euo pipefail
    test "$(uname -s)" = Darwin
    case "{{profile}}" in
        release) flags=--release ;;
        debug) flags= ;;
        *) echo "Unknown profile: {{profile}} (release or debug)" >&2; exit 2 ;;
    esac
    app=target/{{profile}}/Herdr.app
    cargo build --locked $flags --target-dir target -p herdr-gpui --features "{{features}}"
    mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
    cp target/{{profile}}/herdr-gpui "$app/Contents/MacOS/Herdr"
    cp assets/macos/Info.plist "$app/Contents/Info.plist"
    # LaunchServices and the Dock cache icons by bundle ID, so every worktree
    # build sharing the release ID competed with the installed app's icon.
    plutil -replace CFBundleIdentifier -string so.pen.herdr-gpui.dev "$app/Contents/Info.plist"
    icons=$(python3 scripts/release/build-icon.py macos "$app/Contents/MacOS/Herdr")
    cp "${icons%$'\n'*}" "$app/Contents/Resources/Herdr.icns"
    cp "${icons##*$'\n'}" "$app/Contents/Resources/Assets.car"
    plutil -lint "$app/Contents/Info.plist"
    # The linker's ad-hoc signature names the bare executable and binds no
    # Info.plist, so services that trust the bundle ID refuse the app:
    # notification authorization fails without a prompt. Ad-hoc sign the
    # assembled bundle so its identity is so.pen.herdr-gpui.dev.
    codesign --force --sign - "$app"

# Link the actual optimized application and exercise its CLI without a desktop.
test-build: build-release
    cargo test --locked --release -p herdr-gpui --test cli

# Fail on source files over 1,000 lines.
check-file-size:
    bash scripts/check-file-size.sh

ci: format-check check-file-size lint test

# Cross type-check the Windows target without a Windows machine. CI lints the
# MSVC target on a Windows runner; this uses the GNU target because a Mac or
# Linux host cannot supply the MSVC C toolchain some dependencies build against.
# Needs `rustup target add x86_64-pc-windows-gnu` and mingw-w64
# (`brew install mingw-w64`, or `apt install gcc-mingw-w64-x86-64`).
lint-windows:
    CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
    AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar \
    cargo clippy --locked --workspace --all-targets --all-features \
        --target x86_64-pc-windows-gnu -- -D warnings
    CC_x86_64_pc_windows_gnu=x86_64-w64-mingw32-gcc \
    AR_x86_64_pc_windows_gnu=x86_64-w64-mingw32-ar \
    cargo clippy --locked --workspace --all-targets --no-default-features \
        --target x86_64-pc-windows-gnu -- -D warnings

# Clippy for Linux in the Ubuntu 24.04 that CI uses, from any host with Docker.
# A cfg gate that is wrong only on Linux is invisible from macOS, and
# lint-windows only covers Windows. The container runs the host architecture;
# pass a platform, for example linux/amd64 on Apple Silicon, for the other one.
lint-linux platform="":
    bash scripts/lint-linux.sh {{platform}}

# Audit the GitHub workflows for injection, over-broad permissions, and unpinned actions.
audit-workflows:
    zizmor .github/

# License, advisory, and source checks over the dependency graph.
audit-deps:
    cargo deny check

# Sign published release artifacts with the local GPG key (YubiKey). Not a CI step.
sign-release *args:
    ./scripts/gpg-sign-release.sh {{args}}

# Verify published checksums, Sigstore and provenance; optional local GPG approval.
verify-release *args:
    ./scripts/verify-release.sh {{args}}

# Check commit subjects the way CI does; the changelog is generated from them.
check-commits base="origin/main":
    python3 scripts/release/check-commit-messages.py range "{{base}}..HEAD"

# Install the commit-msg hook for this checkout and every worktree of it.
hooks:
    git config core.hooksPath .githooks
    @echo "core.hooksPath = .githooks"

# What changed since the last release tag, straight from git history.
changelog-unreleased:
    git-cliff --config cliff.toml --unreleased

# The whole generated changelog; it is never tracked in git.
changelog:
    git-cliff --config cliff.toml

# Exactly what a release would publish: CHANGELOG.md and RELEASE_NOTES.md.
changelog-release version output:
    bash scripts/release/generate-changelog.sh "{{version}}" "{{output}}"

# Owner-only remote release; CI derives the YYYYMMDD.COUNTER version itself.
release:
    bash scripts/release/dispatch.sh

# Local universal signed/notarized DMG; does not publish anything.
dmg $VERSION:
    bash scripts/release/build-macos.sh "$VERSION"

# Static checks and mocked release tests; does not dispatch or publish anything.
release-check:
    for script in scripts/*.sh scripts/release/*.sh; do bash -n "$script" || exit; done
    PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/release/tests -v
    PYTHONDONTWRITEBYTECODE=1 python3 scripts/release/test-release-security.py
    actionlint .github/workflows/*.yml
    zizmor .github/
    git diff --check
