# frozen_string_literal: true

# The source-of-truth Homebrew formula for tmux-ide. It lives in this repo and
# is published to `wavyrai/homebrew-tap` (as Formula/tmux-ide.rb) by
# scripts/publish-tap.sh, then kept current by the `bump_tap` job in
# .github/workflows/release.yml on every release.
#
# Strategy: standard Homebrew Node formula — the published npm tarball is
# installed global-style into the Cellar with Homebrew's own `node`, so
# `brew install wavyrai/tap/tmux-ide` needs no preexisting Node or tmux.
class TmuxIde < Formula
  desc "Terminal-native IDE and agent cockpit built around tmux"
  homepage "https://github.com/wavyrai/tmux-ide"
  url "https://registry.npmjs.org/tmux-ide/-/tmux-ide-2.7.0.tgz"
  sha256 "fbef6a0040a90770e772e2c3c6144dce238dfb77300415126aaab6ad43110a02"
  license "MIT"

  depends_on "node"
  depends_on "tmux"

  def install
    # std_npm_args passes --ignore-scripts, so the package's npm postinstall
    # never runs here. That is deliberate (its Claude-integration steps write
    # to $HOME, which the build sandbox forbids — see caveats), but two things
    # it would have done inside the package itself are recreated below.
    system "npm", "install", *std_npm_args

    pkg = libexec/"lib/node_modules/tmux-ide"

    # 1. The TUI surfaces run from the shipped sources via bun and import the
    #    shipped workspace packages by name; the postinstall would have linked
    #    them into node_modules (see scripts/postinstall.js in the package).
    scope = pkg/"node_modules/@tmux-ide"
    scope.mkpath
    (scope/"tmux-bridge").make_symlink "../../packages/tmux-bridge"
    (scope/"contracts").make_symlink "../../packages/contracts"

    # 2. node-pty loads its bundled prebuild directly on common platforms
    #    (verified: no rebuild needed on macOS); `npm rebuild` is insurance
    #    that compiles the binding wherever no prebuild is shipped.
    cd pkg do
      system "npm", "rebuild", "node-pty", "--#{Language::Node.npm_cache_config}"
    end

    bin.install_symlink libexec.glob("bin/*")
  end

  def caveats
    <<~EOS
      An npm global install runs tmux-ide's postinstall (Claude Code skill
      sync); Homebrew skips package lifecycle scripts, so run once:
        tmux-ide integration install claude   # Claude Code hooks + skill sync
      (or `tmux-ide skill-sync` for the skill alone).

      The full-screen app (`tmux-ide app`) runs from source when `bun` is on
      PATH; otherwise fetch the compiled TUI binary with:
        tmux-ide update --tui-binary
    EOS
  end

  test do
    assert_match "tmux-ide v#{version}", shell_output("#{bin}/tmux-ide --version")
    assert_predicate \
      libexec/"lib/node_modules/tmux-ide/packages/daemon/dist/native/TmuxIdeNotifier.app/Contents/MacOS/tmux-ide-notifier",
      :executable?
    # doctor exits 1 in an empty dir (no ide.yml) — the checks still render.
    assert_match "tmux installed", shell_output("#{bin}/tmux-ide doctor 2>&1", 1)
  end
end
