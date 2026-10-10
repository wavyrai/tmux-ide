# Per-connection terminal delivery address

Raw tmux names containing spaces/Unicode were used as schema-constrained public workspace addresses before the socket could translate them. Admission succeeded but stream validation failed. The delivery hub now captures the trusted validated public address per connection before allocating a subscriber. Native session identity stays exact; ACK/NACK use the same immutable address.

The identical long-session source smoke failed before the change and passed afterward. Packaged Node/browser with a source-built isolated daemon also passed, as did the ordinary-name source route. These tests require actual frame delivery and input readiness, preserve the exact trailing-space native name, and clean up their private fixtures. They do not qualify native GUI typed input or a published release.

162 focused daemon tests passed, daemon typechecks and scoped lint/format passed. Independent reviewer approved all six source/test hashes in the freeze manifest and the smoke fixture.
