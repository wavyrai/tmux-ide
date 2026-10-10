# Herdr Sound Attribution

The notification timing/validation policy in `src/sound.rs`, local sound settings
in `src/sound/config.rs`, and custom-sound fallback in `src/sound/playback.rs`
are adapted from Herdr (https://github.com/herdrdev/herdr), revision
`8ac9542757292f7a8d42a2d532bc6a8a33c7ffce`:

- `src/client/shell/notification_policy.rs`
- `src/config/sound.rs`, `src/config/io.rs`, `src/detect/mod.rs`
- `src/sound.rs`

Changes separate audio from toast presentation, add bounded queues, cancellation,
typed errors, worker-owned configuration and playback, and native window focus.
Configuration always uses the local production `herdr` directory.
Playback now uses Rodio/CPAL rather than upstream's external system players.
Embedded MP3s decode directly from memory; custom MP3 reads and playback are bounded.

Rodio 0.22.2 is MIT OR Apache-2.0; CPAL 0.17.3 is Apache-2.0.
The unmodified Symphonia 0.5.5 MP3 decoder crates (`symphonia`,
`symphonia-bundle-mp3`, `symphonia-core`, `symphonia-metadata`) remain MPL-2.0.
Release third-party notices include their license texts and exact source-download
URLs, with version-scoped reviews in `scripts/release/generate-notices.py`.
Linux dynamically links the system ALSA library; it is not bundled.

`assets/sounds/done.mp3` and `assets/sounds/request.mp3` at the repository root
are unmodified copies from that revision. These files are covered by upstream's
Apache License, Version 2.0; no separate sound license or upstream NOTICE was
present. The full license is in this repository's root `LICENSE`.
