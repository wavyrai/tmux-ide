#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
[[ $# == 5 ]] || fail 'Usage: bash package-linux.sh VERSION TARGET BINARY OUTPUT_DIR THIRD_PARTY_NOTICES'
version_check "$1"
case $2 in x86_64-unknown-linux-gnu|aarch64-unknown-linux-gnu) ;; *) fail 'Unsupported Linux target';; esac
[[ -f $3 && -d $4 ]] || fail 'Binary file and existing output directory required'
[[ -f $5 && -s $5 ]] || fail 'Nonempty third-party notices file required'
out=$(cd -- "$4" && pwd)/Herdr-$1-$2.tar.gz
new_output "$out"
selection=$(python3 "$release_root/scripts/release/build-icon.py" linux "$3")
icon=${selection%$'\n'*}
icon_path=${selection##*$'\n'}
[[ -f $icon && $icon_path == share/* ]] || fail 'Could not select the Linux icon'
tmp=$(mktemp -d "${out%/*}/.herdr-linux.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
name=Herdr-$1-$2
root=$tmp/$name
mkdir -p "$root/bin" "$root/share/applications" "$root/${icon_path%/*}" "$root/share/licenses/herdr-gpui"
cp "$3" "$root/bin/herdr-gpui"
chmod 755 "$root/bin/herdr-gpui"
cp "$icon" "$root/$icon_path"
cp "$release_root/scripts/release/so.pen.herdr-gpui.desktop" "$root/share/applications/"
cp "$release_root/crates/herdr-protocol/LICENSE-APACHE" "$release_root/crates/herdr-protocol/NOTICE.md" "$root/share/licenses/herdr-gpui/"
cp "$release_root/LICENSE" "$release_root/NOTICE" "$release_root/assets/icons/LICENSE-octicons" "$root/share/licenses/herdr-gpui/"
cp "$5" "$root/share/licenses/herdr-gpui/THIRD-PARTY-NOTICES.txt"
cp "$release_root/crates/herdr-gpui/SOUND-NOTICE.md" "$root/share/licenses/herdr-gpui/"
COPYFILE_DISABLE=1 tar -C "$tmp" -czf "$tmp/archive.tar.gz" "$name"
mv "$tmp/archive.tar.gz" "$out"
printf '%s\n' "$out"
