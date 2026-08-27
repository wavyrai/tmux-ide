#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 NODE_INCLUDE_DIR" >&2
  exit 64
fi

node_include=$1
printf '%s  %s\n%s  %s\n%s  %s\n%s  %s\n' \
  2d4560831e525b47b060ec8a0864ab73993df9e20215ce9f0fe7b24cd31af32a "$node_include/node_api.h" \
  a25356630d3058f0a0c8937d9f297e9471e037fda58c2696d8a505c2bd99cb00 "$node_include/node_api_types.h" \
  8808ef8899a1691411928ef5dd7dae0537aedc93d3a34e223b2d89692e79c788 "$node_include/js_native_api.h" \
  4f19cb90d240765cc0961d92a1ee20f65fdc50db7de1ab0a5cb6bc227224e1a0 "$node_include/js_native_api_types.h" |
  shasum -a 256 -c -
