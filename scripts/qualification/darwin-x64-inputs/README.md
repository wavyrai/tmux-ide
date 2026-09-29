# Darwin x64 input preparation

This recipe prepares pinned inputs on `macos-15-intel`; it does not execute a performance campaign, build the application CLI, change its default batching, or build/run the retained instrumented tmux. The dedicated workflow checks out source `be8bcfad29610265716b8dcb657658cf8f1d0ba3`, verifies retained native artifact11030052402 and its exact archive/bundle hashes, prepares Node26.8.2/Bun1.4.2/pnpm10.21.0, fetches a frozen offline store, and builds one private native-grid-only reference from e476+gridpatchb0be.

Homebrew inputs are resolved/captured in this ephemeral preparation job; their historical builds are not claimed reproducible. Source, tools, dependency store, native/reference files, Mach closure and actual hosted OS/load receipts are retained. System loader/shared-cache scope is explicit. Hosted load is disclosed, not an additional exclusive-host gate. No stock tmux is installed or built by this recipe.

`inputs.tar.gz` preserves executable modes and internal links, with complete roundtrip verification. Raw status/logs are uploaded on failures too. Both preparation status and payload status must pass. Later CLI preparation must rebind relative payload paths, validate actual host/runtime closure, build native addons as required, and apply only a separately reviewed private32 overlay. Neither preparation success nor the retained18functional tests establish C4 performance.

`idle-final-capture.patch` is an unapplied fixture patch against the historical Macr3 case. It carries the accepted Spark final-issuer barrier; later idle integration must require all six effects, final sequence11 and sameepoch status12. This does not alter125s/26samples or the100ms wake bound. Original CPU1500pairs/3rounds/10%, parser200samples/3rounds/1ms, metadata50/100ms, memory and coherence requirements remain separate qualification lanes.

Read-only tests (no target executable is started):

```sh
node --test scripts/qualification/darwin-x64-inputs/mach-inputs.test.mjs scripts/qualification/darwin-x64-inputs/final-capture-drain.test.mjs
python3 scripts/qualification/darwin-x64-inputs/test_prepare_inputs.py
DARWIN_X64_NATIVE_EVIDENCE=/path/to/retained-reviewed-evidence node --test scripts/qualification/darwin-x64-inputs/native-input.test.mjs
```

The last test requires the original bundle and local `root-reviewed.json`; missing evidence fails instead of silently skipping. The input runner uses the digest-pinned CI artifact's original functional/cleanup receipts directly.

The workflow runs only on an explicit dispatch or a push to `qualification/darwin-x64-c4-inputs`. Do not push and also dispatch for the same authorization: one push is one requested preparation run. All runtime/performance lanes require separate artifact review.

The hosted Intel image was observed with `/usr/local/bin/openssl` pointing to OpenSSL1.1, conflicting with the OpenSSL3 dependency post-install. The recipe may run only `brew unlink openssl@1.1` after matching that exact link, its installed formula prefix/cellar/version/file membership and a second identical filesystem witness. Absent links need no mutation; unknown or changing links and non-hosted execution fail closed. Before/revalidated/after receipts are retained even if unlink fails; no force-overwrite or ignored installer error is used. Hosted-runner guards use GitHub's [documented default variables](https://docs.github.com/en/actions/reference/workflows-and-actions/variables).
