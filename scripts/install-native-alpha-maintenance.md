# Native installer recovery candidate (unreleased)

`install-native-alpha-maintenance.sh` is the staged source for the next immutable
native installer asset, not a second permanent public installer. The public
`docs/public/install-native-alpha.sh` and universal dispatcher's v3 checksum remain
unchanged. Neither published entry currently accepts recovery; do not advertise a
public curl recovery command from this work.

The candidate adds explicit `--recover` with `keep-current` only. It asks the
existing transaction owner to verify the retained app and interrupted journal.
It never automatically rolls back, deletes a lock, bootstraps the CLI, downloads
an app archive, or starts/stops processes. The managed Node 24 runtime must already
exist. It still fetches the checksum-pinned installer backend over HTTPS; this is
not offline recovery. Download/verification failure leaves recovery unattempted.

A live or uncertain transaction owner is refused. After successful recovery, the
Applications entry is reconciled only when it is absent or points at the exact
managed alias. If the interrupted first installation left no selected app, the
candidate removes an owned dangling entry and explicitly reports that no app
remains; installation must be requested separately. Foreign entries are refused.

Release staging must publish this candidate as a **new immutable installer
asset**, qualify its signed-app install/update/recovery/removal journeys, and
promote the public source, dispatcher support and checksum pin together. Treat
recovery as maintenance in that dispatcher: missing managed runtime must refuse,
not bootstrap or replace a CLI. Keep the old v3 asset immutable. Remove this
staged copy when it is promoted rather than maintaining two public implementations.

Local qualification uses synthetic app payloads and an injected verifier in the
existing installer test seam. Real SIGKILL boundaries exercise the canonical
journal owner, but these tests do not establish Apple signing/notarization,
second-Mac behavior or live published-download readiness.
