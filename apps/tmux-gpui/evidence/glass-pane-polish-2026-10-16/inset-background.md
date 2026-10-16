# Rounded terminal inset background

The terminal view used appearance.canvas for the rounded padded content panel, while terminal renderer, headers and footer used theme.background. The user screenshot of build2026101602 showed the resulting white band around gray terminal content.

Use theme.background for the terminal content panel; retain canvas for Home. Geometry, clipping and explicit terminal cell colors are unchanged. Independent reviewer found no blocker.

Validation: full-check.sh exit 0, formatting and file sizes passed, workspace clippy all-features and no-default-features passed, GPUI default 2791 passed / 7 ignored, all-features 2822 passed / 8 ignored. Log retained in .tasks/glass-alpha-2026101602/inset-background-check.log. Installer tooling tests: 32 passed, zero failed, .tasks/glass-alpha-2026101603/installer-tests.log.

Native verification of the correction remains pending replacement build2026101603. Build1602 fullscreen input run was incomplete due intermittent UI automation window access, not accepted as a passing GUI check. Owned fixture cancellation cleaned up its processes; production untouched. No release readiness claim.
