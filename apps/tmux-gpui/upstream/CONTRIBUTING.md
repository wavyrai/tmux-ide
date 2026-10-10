# Contributing

Thanks for looking at Herdr GPUI. This file covers the mechanics; the
engineering rules that actually govern changes live in
[AGENTS.md](AGENTS.md) — architecture boundaries, Rust conventions, and
verification expectations. Read it before a non-trivial change. It applies to
human and agent contributors alike.

## Before You Start

- **macOS and experimental Linux builds.** GPUI uses Metal on macOS and
  Vulkan with X11/Wayland on Linux. CI/release builds cover Linux x86_64 and
  ARM64; native Linux desktop verification is still pending. No Windows build
  currently exists.
- **You need Herdr installed.** This repository is a client of the
  daemon from [herdrdev/herdr](https://github.com/herdrdev/herdr). Normal local
  launches may start it if absent; explicit sockets remain attach-only. The GUI
  never installs, stops, or upgrades it. Bugs in the daemon, its session
  model, or its socket handling belong upstream, not here.
- **Open an issue first for anything large.** The README's *Next Milestones*
  section is the roadmap. A PR that lands a milestone differently than planned
  is more likely to stall than a short issue discussing it.

## Setup

Install rustup and, on macOS, the Xcode command-line tools. On Ubuntu 24.04,
run `bash scripts/install-linux-deps.sh` for build libraries and fonts;
see [Linux builds](README.md#linux-builds) for runtime requirements and limitations.
The toolchain is pinned in
`rust-toolchain.toml` and GPUI is pinned to an exact version, so `rustup show`
is enough — do not upgrade either as a side effect of another change. `mise.toml`
mirrors the same Rust version for [mise](https://mise.jdx.dev) users (`mise install`);
change both files together.

```sh
just run          # optimized build; use this for anything interactive
just run-debug    # unoptimized, notably slower with a dense terminal
```

On macOS these launch `target/<profile>/Herdr.app`, so the running app is named
**Herdr** rather than the `herdr-gpui` executable a bare `cargo run` produces.

## Verifying a Change

Run the workspace gates before opening a PR:

```sh
just format
just ci
```

`just ci` is exactly what CI runs: `cargo fmt --all -- --check`, a
`-D warnings` clippy pass over all targets and features, and the test suite
under both default and all features. CI additionally builds release binaries
for Apple Silicon, Intel macOS, and native Ubuntu 24.04 x86_64/ARM64, exercising
their release CLI without a desktop. Run `just test-build` for linking or
packaging changes and `just release-check` for archive/release changes. The latter
runs the release packaging/security tests and workflow audits; see
[release tooling](scripts/release/README.md) for prerequisites. Owner-authored
internal PRs run audit/test jobs; optimized release builds run only on `main`.
Outside-contributor and Dependabot PR jobs are skipped, not considered validated;
see the [CI policy](README.md#continuous-integration).

Some tests are opt-in because they need resources CI does not have:

```sh
just test-live /absolute/path/to/herdr   # needs an explicit daemon binary
just test-gui  /absolute/path/to/herdr   # also needs an active desktop
just test-sidebar                        # native glyph regression
just test-perf                           # release-mode scene budget
```

Never point a live test at your personal daemon — they create and clean up
their own isolated one. For visual changes, check the real native window:
narrow layouts, long labels, focus, and clipping. Headless layout tests do not
prove native glyph or input correctness.
Linux X11 and Wayland both need manual desktop coverage; the performance harness
and AppKit click probes remain macOS-only. The GUI test sandbox resolves the
parent Wayland socket without exposing its HOME or runtime directory to daemons.

## Pull Requests

- Use conventional commit subjects: `feat`, `fix`, `perf`, `refactor`, `revert`,
  `docs`, `chore`, `ci`, `build`, `style`, `test`. Explain the problem and the
  chosen approach in the body for non-trivial work.
- Subjects are published: the release changelog is generated from them, so
  `feat` appears under Added, `fix` under Fixed, `perf`/`refactor`/`revert`
  under Changed, `docs` under Documentation, and `chore`, `ci`, `build`,
  `style` and `test` are never shown to users. Write the subject for someone
  reading a release page, and keep rationale in the body; only the first line
  is published. A breaking change is always published: mark it `type!:` or add
  a `BREAKING CHANGE: <what breaks>` footer.
- Run `just hooks` once per clone to install the `commit-msg` hook that checks
  this locally; CI checks it again for every commit in a pull request. Preview
  the result with `just changelog-unreleased`.
- `main` requires a pull request and green CI. Review your own full diff
  against the base before marking it ready.
- State the validation you actually ran, and say plainly which native or
  manual checks you could not run. Do not describe a headless test as
  end-to-end verification.
- Keep user-facing docs in step with behavior changes.

## License

By contributing, you agree that your contributions are licensed under
Apache-2.0, matching [LICENSE](LICENSE).
