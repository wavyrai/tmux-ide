#![allow(clippy::unwrap_used)]
use super::{BridgeEvent, COPIED_FOR, Context, Focus, Offer, RemoteCopy, preview, size_label};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

fn copy(pane: &str, text: &str) -> BridgeEvent {
    BridgeEvent::Clipboard {
        session: "s".into(),
        pane_id: pane.into(),
        incarnation: "g:0".into(),
        text: text.into(),
    }
}

fn context<'a>(
    window_active: bool,
    selected: Option<&'a str>,
    shown: &'a dyn Fn(&str) -> bool,
) -> Context<'a> {
    Context {
        focus: Focus {
            window_active,
            selected_pane: selected,
        },
        shown,
        machine: "spark",
    }
}

#[test]
fn a_copy_right_after_typing_in_the_focused_pane_is_written_and_shown() {
    let now = Instant::now() + Duration::from_secs(60);
    let shown = |pane: &str| pane == "a" || pane == "b";
    let mut remote = RemoteCopy::default();
    remote.note_input("a", now - Duration::from_millis(300));
    let written = remote.receive(
        copy("a", "hi\nthere"),
        &context(true, Some("a"), &shown),
        now,
    );
    assert_eq!(written.as_deref(), Some("hi\nthere"));
    assert_eq!(remote.note("a", now), Some("Copied from spark: hi·there"));
    assert_eq!(remote.offer("a"), None);
    // The note lasts 1.5 s, then goes.
    assert!(remote.note("a", now + COPIED_FOR).is_none());
    assert_eq!(remote.due_at(), Some(now + COPIED_FOR));
    assert!(!remote.expire(now + COPIED_FOR - Duration::from_millis(1)));
    assert!(remote.expire(now + COPIED_FOR));
    assert_eq!(remote.due_at(), None);
}

#[test]
fn any_other_copy_is_an_offer_and_never_written() {
    let now = Instant::now() + Duration::from_secs(60);
    let shown = |pane: &str| pane == "a" || pane == "b";
    let cases: [(bool, Option<&str>, Option<Duration>); 5] = [
        // Background pane.
        (true, Some("b"), Some(Duration::from_millis(100))),
        // Unfocused window.
        (false, Some("a"), Some(Duration::from_millis(100))),
        // No input to the pane, or too long ago (`sleep 5; printf …`).
        (true, Some("a"), None),
        (true, Some("a"), Some(Duration::from_millis(2001))),
        (true, Some("a"), Some(Duration::from_secs(5))),
    ];
    for (active, selected, ago) in cases {
        let mut remote = RemoteCopy::default();
        if let Some(ago) = ago {
            remote.note_input("a", now - ago);
        }
        let written = remote.receive(copy("a", "hi"), &context(active, selected, &shown), now);
        assert_eq!(written, None, "{active} {selected:?} {ago:?}");
        assert_eq!(
            remote.offer("a"),
            Some(&Offer {
                pane: "a".into(),
                text: "hi".into(),
                machine: "spark".into(),
            })
        );
        assert_eq!(remote.note("a", now), None);
    }
}

#[test]
fn the_newest_offer_replaces_an_older_one_and_a_click_takes_it_once() {
    let now = Instant::now();
    let shown = |_: &str| true;
    let mut remote = RemoteCopy::default();
    let quiet = context(false, None, &shown);
    assert_eq!(remote.receive(copy("a", "old"), &quiet, now), None);
    assert_eq!(remote.receive(copy("b", "new"), &quiet, now), None);
    assert_eq!(remote.offer("a"), None);
    assert_eq!(remote.accept("a"), None);
    assert_eq!(remote.accept("b").as_deref(), Some("new"));
    assert_eq!(remote.accept("b"), None);
    assert_eq!(remote.receive(copy("b", "again"), &quiet, now), None);
    remote.dismiss("a");
    assert!(remote.offer("b").is_some());
    remote.dismiss("b");
    assert_eq!(remote.offer("b"), None);
}

#[test]
fn a_silent_copy_clears_the_offer_of_its_own_pane_only() {
    let now = Instant::now() + Duration::from_secs(60);
    let shown = |_: &str| true;
    let mut remote = RemoteCopy::default();
    remote.receive(copy("a", "offered"), &context(false, None, &shown), now);
    remote.note_input("b", now);
    let written = remote.receive(copy("b", "typed"), &context(true, Some("b"), &shown), now);
    assert_eq!(written.as_deref(), Some("typed"));
    assert!(remote.offer("a").is_some());
    remote.note_input("a", now);
    remote.receive(copy("a", "typed"), &context(true, Some("a"), &shown), now);
    assert_eq!(remote.offer("a"), None);
}

#[test]
fn copies_from_panes_the_window_does_not_show_are_dropped() {
    let now = Instant::now();
    let shown = |pane: &str| pane == "a";
    let mut remote = RemoteCopy::default();
    remote.note_input("z", now);
    assert_eq!(
        remote.receive(copy("z", "x"), &context(true, Some("z"), &shown), now),
        None
    );
    assert_eq!(remote.offer("z"), None);
    assert_eq!(remote.note("z", now), None);
    // A pane that goes away loses its offer.
    remote.receive(copy("a", "x"), &context(false, None, &shown), now);
    remote.retain(|_| false);
    assert_eq!(remote.offer("a"), None);
}

#[test]
fn a_refused_copy_names_its_size() {
    let now = Instant::now();
    let shown = |_: &str| true;
    let mut remote = RemoteCopy::default();
    let refused = BridgeEvent::TooLarge {
        session: "s".into(),
        pane_id: "a".into(),
        incarnation: "g:0".into(),
        bytes: 3 * 1024 * 1024 + 512 * 1024,
    };
    assert_eq!(
        remote.receive(refused, &context(true, Some("a"), &shown), now),
        None
    );
    assert_eq!(
        remote.note("a", now),
        Some("Copy from spark too large (3.5 MB)")
    );
    assert_eq!(remote.offer("a"), None);
}

#[test]
fn sizes_and_previews_read_plainly() {
    assert_eq!(size_label(1), "1 byte");
    assert_eq!(size_label(2), "2 bytes");
    assert_eq!(size_label(1023), "1023 bytes");
    assert_eq!(size_label(1024), "1 KB");
    assert_eq!(size_label(2049), "3 KB");
    assert_eq!(size_label(1024 * 1024), "1.0 MB");
    assert_eq!(preview("a\tb\x1b[31m"), "a·b·[31m");
    let long = "x".repeat(41);
    assert_eq!(preview(&long), format!("{}…", "x".repeat(40)));
    assert_eq!(preview(&"y".repeat(40)), "y".repeat(40));
}

/// A remote machine can never read the Mac pasteboard: outside tests, the
/// pasteboard is read only by the Cmd+V paste key and the search field's own
/// paste. A new read anywhere else (a bridge message among them) fails here.
#[test]
fn the_pasteboard_is_read_only_by_the_paste_keys() {
    fn sources(dir: &Path, found: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                // Test-only module directories (`tests/`, `*_tests/`).
                if (path.file_name().and_then(|n| n.to_str()))
                    .is_some_and(|n| n == "tests" || n.ends_with("_tests"))
                {
                    continue;
                }
                sources(&path, found);
            } else if path.extension().is_some_and(|e| e == "rs")
                && !path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.ends_with("_tests.rs") || n == "tests.rs")
            {
                found.push(path);
            }
        }
    }
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    sources(&manifest.join("src"), &mut files);
    sources(&manifest.join("../herdr-client/src"), &mut files);
    assert!(files.len() > 100, "found {} files", files.len());
    let mut reads = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).unwrap();
        // Inline test modules may read the pasteboard to check a write.
        let code = text.split("#[cfg(test)]\nmod tests {").next().unwrap_or("");
        let count = code.matches("read_from_clipboard").count();
        if count > 0 {
            let name = file
                .strip_prefix(manifest)
                .unwrap_or(file)
                .display()
                .to_string();
            reads.push((name, count));
        }
    }
    reads.sort();
    assert_eq!(
        reads,
        vec![
            ("src/search_input.rs".to_owned(), 1),
            ("src/tmux_snapshot/browser_ui.rs".to_owned(), 1),
        ]
    );
    let browser_ui =
        std::fs::read_to_string(manifest.join("src/tmux_snapshot/browser_ui.rs")).unwrap();
    let read = browser_ui.find("read_from_clipboard").unwrap();
    let paste_key = browser_ui[..read].rfind("key.key == \"v\"").unwrap();
    assert!(
        read - paste_key < 400,
        "the pasteboard read must follow the Cmd+V check"
    );
}

/// The bridge's own code never reads the pasteboard or answers the daemon.
#[test]
fn the_bridge_never_reads_the_pasteboard() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    for file in [
        manifest.join("src/tmux_snapshot/remote_copy.rs"),
        manifest.join("../herdr-client/src/tmux_daemon/remote_bridge.rs"),
        manifest.join("../herdr-client/src/tmux_daemon/remote_bridge_wire.rs"),
        manifest.join("../herdr-client/src/tmux_daemon/remote_clipboard.rs"),
    ] {
        let text = std::fs::read_to_string(&file).unwrap();
        for forbidden in ["read_from_clipboard", "NSPasteboard", "read_from_primary"] {
            assert!(
                !text.contains(forbidden),
                "{} contains {forbidden}",
                file.display()
            );
        }
    }
    let lane =
        std::fs::read_to_string(manifest.join("../herdr-client/src/tmux_daemon/remote_bridge.rs"))
            .unwrap();
    // The lane's only outgoing data frame is the hello.
    assert_eq!(
        lane.matches("Message::Text(").count(),
        2,
        "one send, one receive arm"
    );
    assert!(lane.contains("socket.send(Message::Text(wire::HELLO.into()))"));
}
