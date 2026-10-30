# Bezel dependency provenance

The tmux-ide native client uses bezel-gpui / bezel-gpui-platform 0.3.21,
bezel-theme / bezel-ui 0.2.22, pinned in upstream/Cargo.lock.
Source: https://github.com/crabtalk/bezel (reference checkout 5a46a86).

Theme/color math, menu cards, menu rows, ghost controls and floating glass surfaces
are reused from the upstream crates. Native terminal rendering and daemon input
admission remain owned by tmux-ide. Accessibility disables lens effects when the
native glass owner reports the opaque fallback.

gpui-wry 0.6.6 is vendored with the GPUI provider changed and rectangular clip
masks given explicit default corners. See upstream/crates/gpui-wry/NOTICE.md.

License scope: bezel-ui, bezel-theme, bezel-motion and bezel-icons are MIT.
The bezel-gpui renderer/platform family and its Bezel Zed support crates are
Apache-2.0, retaining Zed Industries' notices. Their complete license texts and
source notices are included in the generated RUST-THIRD-PARTY-NOTICES.txt in the
application bundle. The MIT text below applies to the Bezel UI-layer portions,
not to the GPUI/Zed-derived dependencies.

MIT License

Copyright (c) 2026 clearloop
Copyright (c) 2026 Wing (portions extracted from zeronsh/comet)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
