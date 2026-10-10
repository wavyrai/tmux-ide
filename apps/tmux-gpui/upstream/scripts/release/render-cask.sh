#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/common.sh"
[[ $# == 2 ]] || fail 'Usage: bash render-cask.sh VERSION SHA256 > herdr-gpui.rb'
version_check "$1"
[[ $2 =~ ^[0-9a-fA-F]{64}$ ]] || fail 'SHA256 must contain exactly 64 hexadecimal characters'
sha=$(printf '%s' "$2" | tr 'A-F' 'a-f')
while IFS= read -r line; do
    line=${line//@VERSION@/$1}
    printf '%s\n' "${line//@SHA256@/$sha}"
done < "$release_root/homebrew/Casks/herdr-gpui.rb"
