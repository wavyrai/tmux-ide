# Recovery alpha candidate 2026101702

Version 0.1.2 build 2026101702 is signed, notarized and published as a GitHub prerelease. Website installer activation awaits the release PR checks and merge.

## Verified

- Bridge suite: 554 passed, 5 skipped, zero failures; TypeScript check passed.
- Exact candidate package tests: 10 passed.
- Packaged browser through private real OpenSSH: daemon replacement restores same browser/pane, retained tab ID and availability, and executed shell input.
- Input attempted during disconnection is absent after recovery; Home navigation cancels recovery and remains Home after daemon returns.
- Native GUI: named isolated QA app showed both panes, recovered automatically after its private daemon was replaced, retained one available tab, and executed RECOVERED_GUI_1702 in the right pane. Divider drag changed private pane widths to 33/46 columns.
- QA clone and candidate native/browser/live bytes match (qa-binary-match.json). Clone changes only bundle display identity for safe UI targeting.
- Independent read-only review: no source blocker. Integrated cancellation during an already in-flight catalog request is not separately proven; Home during outage is proven.
- Fresh read-only Spark SSH check: daemon 2.9.5, same PID2003653, NRestarts0, ExecMainStatus0. Original Spark drop trigger remains unknown. No Spark mutation/restart performed.

## Discovered and fixed during GUI testing

Initial candidate1701 restored terminal but left session tab Unavailable. Added verified tab target rebinding preserving ID/order and invalidating obsolete actions. Candidate1702 verifies correction in GUI and realSSH smoke.

## Resolved notarization blocker

The first signing attempt could not access profile tmux-ide-notary. A later retry succeeded without changing credentials. Failed-attempt evidence is retained separately.

## Evidence

package-tests.log; packaged-real-ssh.log; packaged-real-ssh-negative.log; packaged-real-ssh-cancel.log; gui-recovered-right.txt; native-qa.log; qa-binary-match.json. Bridge and Spark evidence in ../gpui-connection-triage-20261017. GUI screenshots are retained in chat tool results.

Owned QA window/daemons/sessions closed after checks. A UI observation after Quit relaunched the QA app without the fixture; no test input was sent to that new instance and it was quit immediately. Production tmux servers were never killed.

## Notarization retry succeeded

Profile tmux-ide-notary became accessible on retry. Signing, Apple notarization acceptance, ticket stapling/validation, Apple verification and archive roundtrip verification all completed successfully. Exact receipt: signed/signing-receipt.json. Publication pending required repository checks. The earlier missing-profile blocker is resolved.

## Public installer journey

Private HOME/prefix installation of signed build1616, public archive upgrade to1702, rollback and public archive re-update all passed. The last step reproduced an existing retained-version rejection; the installer now permits only the exact retained successor with matching bytes and fresh signature verification, preserving history and ownership checks. Independent review found no safety blocker. Installer transaction/recovery tests: 44 passed; native bootstrap/dispatch tests: 38 passed. Versioned v3 installer assets were appended without replacing published assets. No native app bytes changed.
