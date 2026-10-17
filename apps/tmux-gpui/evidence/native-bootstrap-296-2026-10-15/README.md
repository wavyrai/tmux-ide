# Native bootstrap 2.9.6 qualification

The universal native-alpha entry now bootstraps published CLI 2.9.6 when absent and upgrades recognized older stable versions. Exact 2.9.6 is retained. Newer, prerelease, unrecognized and unreadable executable versions stop before downloads or mutation. Native archive and bootstrap checksums are unchanged.

## Evidence

- New expectations failed against the old dispatcher (`.tasks/native-polish-np02/before.log`).
- Final native dispatcher and native installer tests: 38/38 passed (`after-review.log`).
- Real local-script install using public pinned assets, private HOME and temp directory: fresh install returned CLI 2.9.6 and created `~/Applications/Tmux IDE Alpha.app`; repeat update succeeded and retained the same CLI release symlink (`fresh-real.log`, `update-real.log`, `real-install-receipt.json`). This ran before the final unreadable-version guard; that guard is covered by the final regression tests and is not exercised by this successful fresh/update path.
- Ordinary CLI installer regression suite: 34/34 passed (`cli-installer.log`).
- Shell syntax, formatting and whitespace checks passed.
- Independent review found and then cleared the unreadable-version overwrite risk.

All raw logs live in `.tasks/native-polish-np02/`. The real install did not launch the app or explicitly start a daemon; this is installer qualification, not native GUI compatibility qualification. Existing older-version upgrades and maintenance paths are covered by isolated fixtures. Deployment and public URL verification remain pending. This evidence does not claim a new native release or visual polish.
