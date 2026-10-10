use super::*;
use herdr_client::ConnectTarget;
use std::{fs, path::Path, process::Command};

fn git(dir: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        output.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn commit(dir: &Path, file: &str) -> String {
    fs::write(dir.join(file), file).unwrap();
    git(dir, &["add", file]);
    git(dir, &["commit", "-q", "-m", file]);
    git(dir, &["rev-parse", "HEAD"])
}

struct Fixture {
    _temp: tempfile::TempDir,
    /// The origin's Git common directory and main checkout.
    key: String,
    main: std::path::PathBuf,
    /// A clone made before `feature` and its commit existed.
    destination: String,
    feature: String,
}

/// An origin with a `feature` branch one commit ahead in a linked checkout,
/// and a destination clone that predates that commit.
fn fixture() -> Fixture {
    let temp = tempfile::tempdir().unwrap();
    let main = temp.path().join("origin repo");
    fs::create_dir(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    commit(&main, "base.txt");
    let destination = temp.path().join("destination");
    git(
        temp.path(),
        &[
            "clone",
            "-q",
            main.to_str().unwrap(),
            destination.to_str().unwrap(),
        ],
    );
    let linked = temp.path().join("feature checkout");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "feature",
            linked.to_str().unwrap(),
        ],
    );
    let feature = commit(&linked, "feature.txt");
    Fixture {
        key: main.join(".git").to_string_lossy().into_owned(),
        main,
        destination: destination.join(".git").to_string_lossy().into_owned(),
        feature,
        _temp: temp,
    }
}

fn host() -> Host {
    Host::new(&ConnectTarget::Local).unwrap()
}

#[test]
fn a_base_resolves_to_its_commit_through_the_common_directory() {
    let fixture = fixture();
    let cancelled = AtomicBool::new(false);
    let head = git(&fixture.main, &["rev-parse", "HEAD"]);
    // HEAD there is the main checkout's, as the daemon reads it.
    assert_eq!(
        git::resolve_commit(&host(), &fixture.key, "HEAD", &cancelled).unwrap(),
        head
    );
    assert_eq!(
        git::resolve_commit(&host(), &fixture.key, "refs/heads/feature", &cancelled).unwrap(),
        fixture.feature
    );
    assert!(matches!(
        git::resolve_commit(&host(), &fixture.key, "refs/heads/missing", &cancelled),
        Err(Error::Script { .. } | Error::NoCommit { .. })
    ));
}

#[test]
fn the_main_checkout_is_found_from_the_common_directory() {
    let fixture = fixture();
    let found = git::main_checkout(&host(), &fixture.key, &AtomicBool::new(false)).unwrap();
    assert_eq!(
        fs::canonicalize(found).unwrap(),
        fs::canonicalize(&fixture.main).unwrap()
    );
}

#[test]
fn a_shipped_commit_arrives_without_touching_the_origin() {
    let fixture = fixture();
    let cancelled = AtomicBool::new(false);
    let to = host();
    assert!(!git::has_commit(&to, &fixture.destination, &fixture.feature, &cancelled).unwrap());
    let tips = git::destination_branch(&to, &fixture.destination, "HEAD", &cancelled)
        .unwrap()
        .tips;
    assert!(
        !tips.is_empty(),
        "the clone's own commits are prerequisites"
    );
    let reference = "refs/herdr-teleport/test-ship";
    let mut bundle = tempfile::tempfile().unwrap();
    git::bundle_commit(
        &host(),
        &fixture.key,
        &fixture.feature,
        reference,
        &tips,
        &mut bundle,
        &cancelled,
    )
    .unwrap();
    // The bundle's reference only lived while it was written.
    assert_eq!(
        git(&fixture.main, &["for-each-ref", "refs/herdr-teleport"]),
        ""
    );
    bundle.rewind().unwrap();
    let uploaded = git::upload(&to, bundle, &cancelled).unwrap();
    git::fetch(&to, &fixture.destination, &uploaded, reference, &cancelled).unwrap();
    git::discard_upload(&to, &uploaded, &cancelled).unwrap();
    assert!(!Path::new(&uploaded).exists());
    assert!(git::has_commit(&to, &fixture.destination, &fixture.feature, &cancelled).unwrap());
    git::drop_reference(&to, &fixture.destination, reference, &cancelled);
    let destination = Path::new(&fixture.destination);
    assert_eq!(
        git(destination, &["for-each-ref", "refs/herdr-teleport"]),
        "",
        "the temporary reference is dropped"
    );
}

#[test]
fn an_origin_names_its_repository_as_teleport_resolves_it() {
    let origin = Origin {
        place: Place {
            endpoint_id: "local".into(),
            label: "This Mac".into(),
            host: host(),
        },
        workspace_id: "w1".into(),
        repo_key: "/repo/.git".into(),
        repo_label: "repo".into(),
    };
    let source = origin.source();
    assert_eq!(source.repo_key, "/repo/.git");
    assert_eq!(source.workspace_id, "w1");
    // Without a branch, discovery never offers to reclaim a checkout.
    assert_eq!(source.branch, None);
    assert_eq!(source.custom_label, None);
}
