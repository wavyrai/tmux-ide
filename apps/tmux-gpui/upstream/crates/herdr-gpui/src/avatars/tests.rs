#![allow(clippy::expect_used)]
use super::*;

// Exercises the POSIX disk cache; other platforms have no cache root.
#[cfg(unix)]
#[test]
fn profile_disk_hits_skip_network_and_stale_images_survive_failed_refresh() {
    let fixture = cache::tests::Fixture::new();
    let url = "https://avatars.githubusercontent.com/u/123?v=4";
    let now = SystemTime::now();
    let bytes = cache::tests::png();
    cache::write(&fixture.0, url, &bytes, now).expect("cache write");
    for _ in 0..2 {
        let (image, updates) = profile_avatar_with(Some(fixture.0.clone()), url, now, |_| {
            panic!("fresh disk hit must not fetch")
        });
        assert_eq!(image.expect("disk hit").bytes, bytes);
        assert!(updates.is_none());
    }
    let stale = now + Duration::from_secs(86400);
    let (release, wait) = mpsc::sync_channel(1);
    let (image, updates) = profile_avatar_with(Some(fixture.0.clone()), url, stale, move |_| {
        wait.recv_timeout(Duration::from_secs(5))
            .expect("release refresh");
        None
    });
    assert_eq!(
        image.expect("stale image immediately available").bytes,
        bytes
    );
    release.send(()).expect("refresh waiting");
    assert!(matches!(
        updates
            .expect("refresh receiver")
            .recv_timeout(Duration::from_secs(5)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
    assert!(cache::read(&fixture.0, url, stale).is_some());
    let replacement = Arc::new(Image::empty());
    let fetched = replacement.clone();
    let (image, updates) =
        profile_avatar_with(Some(fixture.0.clone()), url, stale, move |_| Some(fetched));
    assert!(image.is_some());
    assert!(Arc::ptr_eq(
        &updates
            .expect("refresh")
            .recv_timeout(Duration::from_secs(5))
            .expect("replacement"),
        &replacement
    ));
    let (image, updates) = profile_avatar_with(
        Some(fixture.0.clone()),
        "https://evil.test/avatar",
        now,
        |_| panic!("invalid URL must not fetch"),
    );
    assert!(image.is_none() && updates.is_none());
}

#[test]
fn profile_avatar_urls_never_accept_credentials_or_other_hosts() {
    assert!(valid_profile_avatar(
        "https://avatars.githubusercontent.com/u/123?v=4"
    ));
    for url in [
        "http://avatars.githubusercontent.com/u/1",
        "https://avatars.githubusercontent.com.evil.test/u/1",
        "https://avatars.githubusercontent.com@evil.test/u/1",
        "https://evil.test/avatar",
        "https://user:token@avatars.githubusercontent.com/u/1",
        "https://avatars.githubusercontent.com:443/u/1",
        "https://avatars.githubusercontent.com/\\evil.test/u/1",
        "https://avatars.githubusercontent.com/u/1\n",
    ] {
        assert!(!valid_profile_avatar(url), "{url}");
    }
}

#[test]
#[ignore = "requires HERDR_AVATAR_TEST_REPO and network access to GitHub avatars"]
fn loads_local_repository_owner_avatar() {
    let cwd = std::env::var("HERDR_AVATAR_TEST_REPO").expect("set a local GitHub repository path");
    let owner = repo_owner(&cwd).expect("repository has a GitHub origin");
    let mut avatars = Avatars::new();
    avatars.request(&cwd);
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    while avatars.image(&cwd).is_none() {
        avatars.poll();
        assert!(
            std::time::Instant::now() < deadline,
            "avatar worker timed out"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let image = avatars.image(&cwd).expect("owner avatar downloaded");
    assert!(!image.bytes.is_empty());
    eprintln!("Avatar loaded for {owner}: {} bytes", image.bytes.len());
}

#[test]
fn parses_github_remotes() {
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "git@github.com:",
        "ssh://git@github.com/",
    ] {
        for repo in ["repo", "repo.git", "a_repo-1.2.git"] {
            assert_eq!(
                github_owner(&format!("{prefix}Some-Owner/{repo}")),
                Some("some-owner".to_owned())
            );
        }
    }
    assert_eq!(github_owner("https://github.com/a/r"), Some("a".into()));
}

#[test]
fn rejects_untrusted_hosts_and_malformed_paths() {
    for remote in [
        "https://github.com.evil.test/owner/repo",
        "https://github.com@evil.test/owner/repo",
        "https://evil.test/github.com/owner/repo",
        "https://github.com:443/owner/repo",
        "git@github.com.evil.test:owner/repo",
        "ssh://git@github.com.evil.test/owner/repo",
        "ssh://git@github.com:22/owner/repo",
        "file:///github.com/owner/repo",
        "https://github.com/owner",
        "https://github.com/owner/",
        "https://github.com/owner/.git",
        "https://github.com/owner/..",
        "https://github.com/owner/repo/extra",
        "https://github.com/owner/repo/",
        "https://github.com/owner/repo?query",
        "https://github.com/owner/repo#fragment",
        "https://github.com/owner/repo%2fextra",
        "https://github.com/owner/repo\\extra",
        "https://github.com/owner/repo\n",
    ] {
        assert_eq!(github_owner(remote), None, "{remote}");
    }
    // No account-name grammar is enforced: whatever GitHub names an owner,
    // an enterprise managed user included, survives the round trip.
    for owner in ["a_b", "a--b", "owner_shortcode", "-owner", "owner-", "a.b"] {
        assert_eq!(
            github_owner(&format!("https://github.com/{owner}/repo")).as_deref(),
            Some(owner),
            "{owner}"
        );
    }
    // Only what would not stay inside its own path segment is refused.
    for owner in ["", ".", "..", "a@b", "a%2fb", "a b", "a?b", "a#b", "\u{e9}"] {
        assert_eq!(
            github_owner(&format!("https://github.com/{owner}/repo")),
            None,
            "{owner}"
        );
    }
    assert!(github_owner(&format!("https://github.com/{}/repo", "a".repeat(100))).is_some());
    assert!(github_owner(&format!("https://github.com/{}/repo", "a".repeat(101))).is_none());
}

#[test]
fn accepts_only_supported_content_types() {
    for (mime, format) in [
        ("image/png", ImageFormat::Png),
        ("IMAGE/JPEG; charset=binary", ImageFormat::Jpeg),
        ("image/gif", ImageFormat::Gif),
        ("image/webp", ImageFormat::Webp),
    ] {
        assert_eq!(avatar_format(mime), Some(format));
    }
    for mime in [
        "",
        "text/html",
        "image/svg+xml",
        "image/png-extra",
        "application/octet-stream",
    ] {
        assert_eq!(avatar_format(mime), None);
    }
}

#[test]
fn deduplicates_pending_hits_and_misses_and_drains_results() {
    let (requests, incoming) = mpsc::sync_channel(MAX_REQUESTS);
    let (outgoing, results) = mpsc::channel();
    let mut avatars = Avatars {
        requests,
        results,
        images: HashMap::new(),
    };
    assert!(!avatars.poll());
    assert!(avatars.image("hit").is_none());
    for cwd in ["hit", "miss", "hit", "miss"] {
        avatars.request(cwd);
    }
    assert_eq!(incoming.try_iter().collect::<Vec<_>>(), ["hit", "miss"]);
    let image = Arc::new(Image::empty());
    assert!(outgoing.send(("hit".into(), Some(image.clone()))).is_ok());
    assert!(outgoing.send(("miss".into(), None)).is_ok());
    assert!(avatars.poll());
    assert!(!avatars.poll());
    assert!(
        avatars
            .image("hit")
            .is_some_and(|cached| Arc::ptr_eq(&cached, &image))
    );
    assert!(avatars.image("miss").is_none());
    avatars.request("hit");
    avatars.request("miss");
    assert!(incoming.try_recv().is_err());
}
