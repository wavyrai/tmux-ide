# Hosted native package gate

GitHub Actions run38080028723 completed success. Branch head4876fa44 was tested as pull-request merge checkout e8dada73528cdb4dfcc8aa1be4000baadda7b371. Both Linux bridge/lifecycle and macOS Rust/package jobs passed. The macOS lane includes both Clippy configurations, both workspace test configurations, release executable/CLI tests, offline dependency fetch, app assembly and five artifact/compatibility tests without skips.

Downloaded packaging evidence independently confirms app assembly and5pass/0fail/0skip. Receipt records native hash and original downloaded artifact hashes. The native build declares nonhermetic cache/environment scope. This is an unsigned development artifact gate; no GUI, signing/notarization, clean-machine install, latest local daemon changes, or public release is qualified. The later long-session fixes and CI regression require another hosted run.
