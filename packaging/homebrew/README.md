# Homebrew packaging

`brew install wavyrai/tap/tmux-ide` — no preexisting Node or tmux needed.

## Strategy (decided M23.4)

**Standard Homebrew Node formula**: the published npm tarball is installed
global-style into the Cellar with Homebrew's own `node` (`std_npm_args`, the
same pattern homebrew-core uses for renovate/gemini-cli/etc.).

The alternative — shipping the bun-compiled TUI binary plus a thin CLI — was
rejected: the compiled artifact covers only the TUI surfaces (the CLI itself
is Node), it would need per-platform release assets and sha blocks in the
formula, and it diverges from the tested npm artifact. With the Node formula,
`node` is a brew-resolved dependency rather than a user prerequisite, which
is what the "one-command install" goal actually requires.

Two details the formula handles because Homebrew installs with
`--ignore-scripts` (so the package's npm postinstall never runs):

1. it recreates the `@tmux-ide/{tmux-bridge,contracts}` symlinks the
   postinstall would have made (the bun-run TUI surfaces resolve them), and
2. it runs `npm rebuild node-pty` (a no-op where the bundled prebuild exists;
   compiles the binding elsewhere).

The per-user Claude steps the postinstall would have done (skill sync, agent
teams flag) are covered by the formula's caveats: run
`tmux-ide integration install claude` once.

## One-time publication (owner: PM/user)

1. Create the GitHub repo `wavyrai/homebrew-tap` (empty; the name must be
   exactly `homebrew-tap`).
2. Seed it: `scripts/publish-tap.sh` (clones the tap, copies
   `packaging/homebrew/Formula/tmux-ide.rb` → `Formula/tmux-ide.rb`, pushes).
3. Add a repo secret `TAP_PUSH_TOKEN` to wavyrai/tmux-ide: a fine-grained PAT
   with contents read/write on `wavyrai/homebrew-tap`. From then on the
   `bump_tap` job in `.github/workflows/release.yml` rewrites the formula's
   url + sha256 on every release and pushes it (it no-ops gracefully while
   the secret or the repo is missing).
4. Flip the install docs: `docs/content/docs/getting-started.mdx` already
   contains the Homebrew section, marked with a "PENDING TAP PUBLICATION"
   comment — delete the comment.

## Editing the formula

`packaging/homebrew/Formula/tmux-ide.rb` in this repo is the source of truth;
structural edits flow to the tap on the next release (or via
`scripts/publish-tap.sh`). Check before shipping:

```bash
brew style packaging/homebrew/Formula/tmux-ide.rb
# full audit + install needs a tap context:
brew tap-new <user>/zz-audit --no-git
cp packaging/homebrew/Formula/tmux-ide.rb "$(brew --repo <user>/zz-audit)/Formula/"
brew audit --strict --online <user>/zz-audit/tmux-ide
brew install --build-from-source <user>/zz-audit/tmux-ide && brew test tmux-ide
brew uninstall tmux-ide && brew untap <user>/zz-audit
```
