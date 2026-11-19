//! The Machines step's Host suggestions from fixture SSH configs, never the
//! user's own.
#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

fn dir(config: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("config"), config).unwrap();
    dir
}
fn read(dir: &tempfile::TempDir) -> Vec<String> {
    hosts(dir.path(), dir.path())
}

#[test]
fn literal_host_names_in_order_once_each() {
    let dir = dir("# mine\n\
         Host spark\n  HostName 192.168.178.12\n  User thijs\n\
         Host build-1 build-2 # two at once\n\
         host=lowercase\n\
         HOST \"quoted\"\n\
         Host spark\n\
         \tHost  tabbed\n");
    assert_eq!(
        read(&dir),
        [
            "spark",
            "build-1",
            "build-2",
            "lowercase",
            "quoted",
            "tabbed"
        ]
    );
}

#[test]
fn patterns_negations_tokens_and_match_blocks_are_left_out() {
    let dir = dir("Host *\n  ServerAliveInterval 30\n\
         Host *.lan web? !bastion %h db\n\
         Match host jump exec \"true\"\n  ProxyCommand nc %h %p\n\
         Host -oProxyCommand=evil user@host a/b $(id)\n\
         Host ok\n");
    assert_eq!(read(&dir), ["db", "ok"]);
}

/// Include follows files and globs, relative to ~/.ssh, and a loop or a
/// missing file ends quietly. Nothing is run: a ProxyCommand is only text.
#[test]
fn includes_are_followed_once_and_loops_end() {
    let dir = dir("Include config.d/*\nInclude missing\nInclude ~/.ssh/loop\nHost after\n");
    fs::create_dir(dir.path().join("config.d")).unwrap();
    fs::write(dir.path().join("config.d/b"), "Host b\n").unwrap();
    fs::write(
        dir.path().join("config.d/a"),
        "Host a\nProxyCommand touch ran\n",
    )
    .unwrap();
    fs::write(
        dir.path().join("loop"),
        "Host looped\nInclude loop\nInclude config\n",
    )
    .unwrap();
    // `~` is the home given, so `~/.ssh/loop` is this fixture's.
    let home = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(dir.path(), home.path().join(".ssh")).unwrap();
    assert_eq!(
        hosts(dir.path(), home.path()),
        ["a", "b", "looped", "after"]
    );
    assert!(!dir.path().join("ran").exists());
}

#[test]
fn at_most_eight_and_a_missing_or_huge_config_gives_none() {
    let many: String = (0..20).map(|i| format!("Host h{i}\n")).collect();
    assert_eq!(read(&dir(&many)).len(), MAX);
    let empty = tempfile::tempdir().unwrap();
    assert!(read(&empty).is_empty());
    let huge = format!("{}Host late\n", "#".repeat(LIMIT as usize));
    assert!(read(&dir(&huge)).is_empty());
}
