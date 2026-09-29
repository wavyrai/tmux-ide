# Closed Intel Mac CLI build preparation

Root accepted input artifact11052542881/run36607482309. This recipe uses finalc95f246a/treefaf91085 product32/native-opt-in and retained native4998 unchanged. It builds only offline dependencies and CLI; no stock/native/reference build, daemon/fixture or performance run. Grid-referencead20 is retained input provenance, explicitly not a matched-dependency journal-only baseline because its private dylibs differ from4998.

Actual pins and13 executable/helper/test source hashes are in pins.json. Intake admits exact ZIP3ba2233c (553524500bytes), nested payload5d260a99, payload-manifesta553ebbb and actual file hashes from the accepted manifest: Node724b8ccb, Bun2fa513af, pnpmb276da51, native4998ab3b, referencead20daee. Paths come from the accepted payload-path-map and are constrained to the new private extraction root. Existing input Mach private dylibs are executable-relative; fresh actual loader/closure checks remain mandatory, with no relinking or old absolute Homebrew assumptions.

Changes from the held draft:

- Populate actual accepted input pins; preserve old held-inputs.json for the refusal regression. Unknown future CLI/output hashes remain null until actual build evidence.
- Replace sourcebundle input with a pinned Actions checkout of exactc95 and a private no-hardlinks Git clone, retaining exact commit/tree/clean checks and full Git payload. This avoids uploading another40MB bundle and does not weaken source identity.
- Use streaming hashlib SHA so actual Xcode Python3.9 is supported; all Python source parsed as3.9 and six Python tests run under /usr/bin/python3.
- Resolve metafile external names from the built CLI module's scope, matching runtime resolution; node-pty readiness is separately loaded from the daemon package scope. Refuse absent imports/native bindings rather than enabling unreviewed install scripts.
- Add exact ZIP intake and source-only workflow. Workflow has an exact isolated branch push trigger `qualification/darwin-x64-cli-c95f246a`, plus manual dispatch. It is not on main and no push has occurred. A single authorized push is the proposed execution trigger; do not additionally dispatch it.

Validation: six Python admission/payload tests and eight Node metafile/Mach/native-byte tests pass using real retained4998 evidence. Actual payload map→pin comparisons and all13 recipe hashes pass. Source review receipt is .tasks/cli-prep/actual-pins-review.json in this isolated worktree. No current recipe stage/build/native executable ran locally.

Review files: prepare.py, collect.mjs, admission.py, intake.py, pins.json and ../../../.github/workflows/qualification-darwin-x64-cli.yml. Existing neutral payload/bounded and Mach/native adapters are retained. Root should authorize commit/push only after final review; no merge, production install or default service action is part of this recipe.
