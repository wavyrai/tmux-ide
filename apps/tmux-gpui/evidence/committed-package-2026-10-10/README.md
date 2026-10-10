# Committed macOS ARM64 package qualification — 10 October 2026

Clean managed checkout at `a43136e0eeee58a32761cd4de5d1aa96faf40d8c`.
Frozen offline pnpm installation passed. The native packaging gate ran with
Node 24 and pinned Rust using a copied release dependency cache; this is a
clean source checkout, not a hermetic or empty-cache build. Source and binary
hashes, compiler identity and command are retained in native-build.json.

`check-packaged-app.sh` completed successfully: native release build, notices,
app assembly and five package/compatibility tests, with no skips. The artifact
is `/private/tmp/gpui-committed-package-a43136e0/Tmux IDE CI.app`. It is unsigned
for distribution and has not been installed, published or launched as the user demo.

The reviewed split fixture supports an explicit absolute TMUX_GPUI_TEST_APP.
It hashes and launches that app's Node and browser bundle from a private cwd,
with no source fallback. Both source and exact packaged paths pass movement
before release, final boundary 49, stable pane identities, same-viewer input
and owned cleanup, using the maintained tmux binary whose hash is in both logs.
Independent review approved fixture SHA-256
`08a02789c8d4d0672ac28a268e60b85b253bd2b0cbf8e4a4090000b406591478`.
Formatting, ESLint and diff checking pass for the fixture.

These are headless packaged bridge checks against the checkout daemon and an
explicit tmux binary. They do not prove native mouse/keyboard painting, physical
IME/display-scale acceptance, automatic reconnect, signing or public release.
The user's separate demo and production sessions were preserved.

Six sequential exact-packaged journeys also passed: window canvas/selection,
pane replacement and stale input rejection, pane resize gesture, history,
explicit Refresh discovery recovery, and competing viewer authority. Each
used the packaged Node/browser or live helper with isolated fixtures; exact
logs and exit codes are retained. No automatic reconnect claim is made.
