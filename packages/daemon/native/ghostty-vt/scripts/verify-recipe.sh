#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 PROOF_DIR ZIG_EXECUTABLE" >&2
  exit 64
fi

proof_dir=$1
zig=$2
expected_addon=b52c636e142775ebc44b3e16ac529859c8b7153f9e21ec79b874122f96ee0c8c

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) expected_zig=c65cd34917923f575448cc0603dd7c2326da0af0e5c323043d090662dcdf351c ;;
  Darwin-x86_64) expected_zig=f76ad95c3f2ba6c8fd2ae0337bfb0fedd27e1223183597cfa0ddc517db1d5b20 ;;
  Linux-aarch64) expected_zig=931b8e9a9327dac87bc439067f07604219510fa541133ff6e542c6243968cc86 ;;
  Linux-x86_64) expected_zig=2858dc89dbbfdd08cceda1b841e7fd0a793a1a67b49f150bc3d0d1de44ed7f51 ;;
  *) echo "unsupported build host: $(uname -s)-$(uname -m)" >&2; exit 65 ;;
esac

printf '%s  %s\n%s  %s\n' "$expected_addon" "$proof_dir/src/addon.c" "$expected_zig" "$zig" |
  shasum -a 256 -c -
[[ "$($zig version)" == "0.15.2" ]] || { echo "Zig 0.15.2 is required" >&2; exit 66; }
