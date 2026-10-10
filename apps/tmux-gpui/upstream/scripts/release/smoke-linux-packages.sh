#!/usr/bin/env bash
# Install each distribution package into a clean container of its distribution,
# resolve its declared dependencies from that distribution's repositories, and
# check that the installed executable finds every library it links or dlopens.
# `--help` exits before GPUI starts, so no display is needed.
#
# Runs the host's architecture. Official Arch Linux images exist only for
# x86_64, so the ARM64 Arch package is built but not installed here.
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
[[ $# == 3 ]] || fail 'Usage: bash smoke-linux-packages.sh VERSION TARGET DIST_DIR'
version_check "$1"
case $2 in x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu) ;; *) fail 'Unsupported Linux target';; esac
dist=$(cd -- "$3" && pwd)
name=Herdr-$1-$2
command -v docker >/dev/null || fail 'docker is required'

# Index digests pin each image across architectures; bump them together.
ubuntu=ubuntu:24.04@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3
debian=debian:trixie@sha256:9cc080028c43b27d2074d63a5f9caf7166d731494965616c1a6d2827a004585c
fedora=fedora:42@sha256:99e203b80b1c3d8f7e161ec10a68fd02b081ef83a3963553e513c82846b97814
arch=archlinux:latest@sha256:f3691b4dde62ba4c4b6f0ae2c1fbf28e8c0c8c4b9a35c7e06dc1f70e21aa29f6

# Shared checks, run inside every container after installation; expanded there.
# shellcheck disable=SC2016
check='
set -euo pipefail
/usr/bin/herdr-gpui --help >/dev/null
# Capture before matching: with pipefail, grep -q exiting early would fail the
# writer with SIGPIPE and turn a present library into a false failure.
linked=$(ldd /usr/bin/herdr-gpui)
if grep "not found" <<<"$linked"; then exit 1; fi
cache=$(ldconfig -p)
for library in libvulkan.so.1 libwayland-client.so.0; do
    grep -q "^[[:space:]]*$library " <<<"$cache" || { echo "missing dlopen target $library" >&2; exit 1; }
done
test -f /usr/share/applications/so.pen.herdr-gpui.desktop
test -f /usr/share/icons/hicolor/scalable/apps/herdr-gpui.svg
test -f /usr/share/licenses/herdr-gpui/THIRD-PARTY-NOTICES.txt
'

run() {
    printf '== %s: %s\n' "$1" "$2"
    docker run --rm --pull=missing -v "$dist:/dist:ro" -e CHECK="$check" "$2" bash -euo pipefail -c "$3"
}

for image in "$ubuntu" "$debian"; do
    run "$name.deb" "$image" "
        apt-get update -qq
        DEBIAN_FRONTEND=noninteractive apt-get install -qq -y --no-install-recommends /dist/$name.deb >/dev/null
        bash -c \"\$CHECK\"
        apt-get remove -qq -y herdr-gpui >/dev/null
        test ! -e /usr/bin/herdr-gpui"
done
run "$name.rpm" "$fedora" "
    dnf install -q -y --setopt=install_weak_deps=False /dist/$name.rpm >/dev/null
    bash -c \"\$CHECK\"
    dnf remove -q -y herdr-gpui >/dev/null
    test ! -e /usr/bin/herdr-gpui"
if [[ $2 == x86_64-unknown-linux-gnu ]]; then
    run "$name.pkg.tar.zst" "$arch" "
        # pacman 7 drops to a seccomp-sandboxed download user, which some
        # container runtimes refuse; this throwaway container needs neither.
        pacman -Syu --noconfirm --needed --disable-sandbox >/dev/null
        pacman -U --noconfirm --disable-sandbox /dist/$name.pkg.tar.zst >/dev/null
        bash -c \"\$CHECK\"
        pacman -R --noconfirm herdr-gpui >/dev/null
        test ! -e /usr/bin/herdr-gpui"
fi
