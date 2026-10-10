//! Client-side previews of the daemon's worktree naming, so the new worktree
//! dialog can propose the branch and show the checkout it is about to ask for,
//! as the terminal client does. The daemon still derives the authoritative
//! branch and path; nothing here decides them.

/// Namespace the daemon gives every branch it generates for a new checkout.
const PREFIX: &str = "worktree";

/// Validate a literal branch name, without resolving checkout shorthand or
/// consulting a repository (which may live on a remote endpoint).
pub(super) fn validate_branch(branch: &str) -> crate::Result<()> {
    let invalid = branch.is_empty()
        || branch == "@"
        || branch == "HEAD"
        || branch.starts_with('-')
        || branch.ends_with('.')
        || branch.contains("..")
        || branch.contains("@{")
        || branch
            .bytes()
            .any(|byte| byte <= b' ' || byte == 0x7f || b"~^:?*[\\".contains(&byte))
        || branch
            .split('/')
            .any(|part| part.is_empty() || part.starts_with('.') || part.ends_with(".lock"));
    if invalid {
        return Err(crate::Error::InvalidBranchName);
    }
    Ok(())
}

/// The branch the daemon would generate for `seed`. Pure, so the proposal is
/// reproducible in tests; callers supply the clock.
pub(super) fn generated_branch_slug(seed: u64) -> String {
    const ADJECTIVES: [&str; 8] = [
        "brave", "calm", "clear", "green", "lucky", "quiet", "rapid", "silver",
    ];
    const NOUNS: [&str; 8] = [
        "river", "cloud", "field", "forest", "harbor", "meadow", "stone", "valley",
    ];
    let adjective = ADJECTIVES[(seed as usize) % ADJECTIVES.len()];
    let noun = NOUNS[((seed / ADJECTIVES.len() as u64) as usize) % NOUNS.len()];
    let suffix = seed & 0xffff;
    format!("{PREFIX}/{adjective}-{noun}-{suffix:04x}")
}

/// A branch proposal seeded from the current clock, as the daemon seeds its own.
pub(super) fn proposed_branch() -> String {
    generated_branch_slug(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_micros().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0),
    )
}

/// The directory component the daemon derives from a branch name.
pub(super) fn branch_to_path_slug(branch: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;
    for ch in branch.chars() {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }
    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        PREFIX.to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// The checkout the daemon would create under its worktree directory. This is an
/// endpoint path, not a path on the machine drawing the dialog, so the separator
/// follows the root the daemon reported rather than this platform's.
pub(super) fn checkout_preview(root: &str, repo: &str, branch: &str) -> String {
    let separator = if !root.starts_with('/') && root.contains('\\') {
        '\\'
    } else {
        '/'
    };
    format!(
        "{}{separator}{repo}{separator}{}",
        root.trim_end_matches(separator),
        branch_to_path_slug(branch)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literal_branch_names_follow_git_ref_rules() {
        for branch in [
            "config reload",
            "feature\tbranch",
            "feature\nbranch",
            "bad\u{7f}",
            "",
            "@",
            "HEAD",
            "-option",
            "a..b",
            "a@{b",
            "a~b",
            "a^b",
            "a:b",
            "a?b",
            "a*b",
            "a[b",
            "a\\b",
            "/a",
            "a/",
            "a//b",
            ".hidden",
            "a/.b",
            "a.lock",
            "a.lock/b",
            "a.",
        ] {
            assert!(
                matches!(
                    validate_branch(branch),
                    Err(crate::Error::InvalidBranchName)
                ),
                "{branch:?}"
            );
        }
        for branch in [
            "config-reload",
            "feature/test",
            "fix.v2",
            "a./b",
            "日本語",
            "a@b",
        ] {
            assert!(validate_branch(branch).is_ok(), "{branch:?}");
        }
    }

    #[test]
    fn generated_branches_are_namespaced_and_reproducible() {
        assert_eq!(generated_branch_slug(0), "worktree/brave-river-0000");
        assert_eq!(generated_branch_slug(9), "worktree/calm-cloud-0009");
        assert_eq!(
            generated_branch_slug(u64::MAX),
            "worktree/silver-valley-ffff"
        );
        let proposed = proposed_branch();
        assert!(proposed.starts_with("worktree/"), "{proposed}");
        assert_eq!(proposed.split('-').count(), 3, "{proposed}");
    }

    #[test]
    fn checkout_previews_follow_the_endpoint_root_and_branch_slug() {
        assert_eq!(
            checkout_preview(
                "/home/me/.herdr/worktrees/",
                "herdr",
                "worktree/brave-river"
            ),
            "/home/me/.herdr/worktrees/herdr/worktree-brave-river"
        );
        assert_eq!(
            checkout_preview("C:\\Users\\me\\worktrees", "herdr", "feature/Login v2"),
            "C:\\Users\\me\\worktrees\\herdr\\feature-login-v2"
        );
        // A branch with nothing to slug still lands in the namespaced directory.
        assert_eq!(branch_to_path_slug("///"), "worktree");
        assert_eq!(branch_to_path_slug("--Fix_42--"), "fix-42");
    }
}
