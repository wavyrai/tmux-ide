# Packaged bridge host-key refusal and explicit repair

Owned run83895 exited0 using stock tmux3.8, Node24.21, explicit source CLI d425 and the browser/helper inside the current unsigned db8d15a2 app. Existing ssh-onboarding-smoke.mjs used TMUX_GPUI_TEST_SSH_FAILURE=host-key and TMUX_GPUI_TEST_PUBLIC_DISCOVERY=1. Artifacts.json records exact inputs.

The fixture replaced only its own known_hosts entry with the wrong fixture public key. Saved Add yielded ssh-host-key / needs-attention, without frame or input authority. Restoring the original owned known_hosts and explicit Retry recovered the same saved machine/pane; fresh input executed and denied input was absent. Actual CLI remote-daemon-info used the mirrored verified private record; zero synthetic handshake requests. Cleanup returned successfully. No personal SSH settings or production server changed.

First run67322 failed at registry-ready because root supplied nonexistent browser.mjs rather than browser.bundle.mjs; its receipt/stderr and successful cleanup are retained. Only the explicit artifact path changed for the passing rerun.

This tests the packaged bridge with a current source CLI, not an installed remote CLI, native GUI, Spark, sleep/wake, second Mac or published release. Trust repair is explicit fixture restoration, not a user-facing host-key acceptance UI. No product change was required. Card NR08 remains open.
