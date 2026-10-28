#![allow(clippy::unwrap_used)]
use super::*;
use std::time::{Duration, Instant};

mod state_directory;

#[core::prelude::v1::test]
fn font_size_input_accepts_only_whole_values_in_range() {
    for (input, expected) in [
        ("8", Some(8.)),
        ("48", Some(48.)),
        (" 24 ", Some(24.)),
        ("7", None),
        ("49", None),
        ("14.5", None),
        ("-8", None),
        ("+12", None),
        ("12px", None),
        ("", None),
        ("999999", None),
    ] {
        assert_eq!(parse_font_size(input), expected, "{input:?}");
    }
}

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new() -> Self {
        loop {
            let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = env::temp_dir().join(format!(
                "herdr-preferences-test-{}-{sequence}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self(path),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("Cannot create test directory: {error}"),
            }
        }
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn await_loaded(preferences: &mut Preferences) -> Chrome {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(chrome) = preferences.loaded() {
            assert_eq!(preferences.loaded(), None);
            return chrome;
        }
        assert!(Instant::now() < deadline, "preferences load timed out");
        thread::sleep(Duration::from_millis(1));
    }
}

#[core::prelude::v1::test]
fn roundtrip_and_reset_drain_after_drop() {
    let directory = TestDirectory::new();
    let path = endpoint_path(&directory.0, Path::new("/tmp/test.sock"));
    let mut preferences = Preferences::start(Ok(path.clone()));
    assert_eq!(await_loaded(&mut preferences), Chrome::default());
    for width in 1..=100 {
        preferences.save(Chrome {
            sidebar_width: Some(width as f32),
            sidebar_split: Some(0.4),
            agent_sort: Some(AgentSort::Priority),
            notes_width: None,
            review_files_width: None,
        });
    }
    let worker = preferences.worker.take().unwrap();
    drop(preferences);
    // Only the test waits for persistence before reading or removing files.
    worker.join().unwrap();
    let mut preferences = Preferences::start(Ok(path.clone()));
    assert_eq!(
        await_loaded(&mut preferences),
        Chrome {
            sidebar_width: Some(100.0),
            sidebar_split: Some(0.4),
            agent_sort: Some(AgentSort::Priority),
            notes_width: None,
            review_files_width: None,
        }
    );
    preferences.save(Chrome::default());
    let worker = preferences.worker.take().unwrap();
    drop(preferences);
    worker.join().unwrap();
    assert_eq!(read_chrome(&path).unwrap(), Chrome::default());
    let mut preferences = Preferences::start(Ok(path));
    assert_eq!(await_loaded(&mut preferences), Chrome::default());
}

#[core::prelude::v1::test]
fn only_a_toggled_sort_is_stored_and_older_files_migrate() {
    let directory = TestDirectory::new();
    let path = endpoint_path(&directory.0, Path::new("/tmp/sort.sock"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let chrome = |agent_sort| Chrome {
        sidebar_width: Some(240.0),
        sidebar_split: None,
        agent_sort,
        notes_width: None,
        review_files_width: None,
    };
    for (json, expected) in [
        // A file from before the sort existed follows the daemon.
        (r#"{"sidebar_width_px": 240.0}"#, None),
        // Earlier builds wrote their default whether or not it was chosen,
        // so only a stored "priority" is known to be a toggle.
        (
            r#"{"sidebar_width_px": 240.0, "agent_sort": "grouped"}"#,
            None,
        ),
        (
            r#"{"sidebar_width_px": 240.0, "agent_sort": "priority"}"#,
            Some(AgentSort::Priority),
        ),
        (
            r#"{"sidebar_width_px": 240.0, "agent_sort": "sideways"}"#,
            None,
        ),
        (
            r#"{"sidebar_width_px": 240.0, "agent_sort_manual": null}"#,
            None,
        ),
        (
            r#"{"sidebar_width_px": 240.0, "agent_sort_manual": "grouped"}"#,
            Some(AgentSort::Grouped),
        ),
        (
            r#"{"sidebar_width_px": 240.0, "agent_sort_manual": "spaces"}"#,
            None,
        ),
        (
            r#"{"sidebar_width_px": 240.0, "agent_sort_manual": 1}"#,
            None,
        ),
    ] {
        fs::write(&path, json).unwrap();
        assert_eq!(read_chrome(&path).unwrap(), chrome(expected), "{json}");
    }
    for agent_sort in [None, Some(AgentSort::Grouped), Some(AgentSort::Priority)] {
        write_chrome(&path, chrome(agent_sort)).unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        // The legacy key is no longer written, so it cannot pin a default.
        assert!(stored.get("agent_sort").is_none(), "{stored}");
        assert_eq!(read_chrome(&path).unwrap(), chrome(agent_sort));
    }
}

#[core::prelude::v1::test]
fn drop_does_not_wait_for_blocked_worker_and_queued_saves_still_drain() {
    let (saves, requests) = mpsc::channel();
    let (ready_tx, ready) = mpsc::channel();
    let (release, blocked) = mpsc::channel();
    let (drained_tx, drained) = mpsc::channel();
    let worker = thread::spawn(move || {
        ready_tx.send(()).unwrap();
        blocked.recv().unwrap();
        drained_tx
            .send(requests.into_iter().collect::<Vec<_>>())
            .unwrap();
    });
    let preferences = Preferences {
        saves: Some(saves),
        loaded: None,
        worker: Some(worker),
    };
    let queued = [
        Chrome {
            sidebar_width: Some(160.),
            sidebar_split: None,
            agent_sort: Some(AgentSort::Grouped),
            notes_width: None,
            review_files_width: None,
        },
        Chrome {
            sidebar_width: Some(400.),
            sidebar_split: Some(0.6),
            agent_sort: Some(AgentSort::Priority),
            notes_width: Some(420.),
            review_files_width: None,
        },
        Chrome::default(),
    ];
    for chrome in queued {
        preferences.save(chrome);
    }
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let (dropped_tx, dropped) = mpsc::channel();
    let dropper = thread::spawn(move || {
        drop(preferences);
        dropped_tx.send(()).unwrap();
    });
    let result = dropped.recv_timeout(Duration::from_secs(5));
    // Release even on failure so a regressed join does not strand the threads.
    release.send(()).unwrap();
    let saved = drained.recv_timeout(Duration::from_secs(5)).unwrap();
    dropper.join().unwrap();
    assert!(result.is_ok(), "drop waited for the blocked worker");
    assert_eq!(saved, queued);
}

#[core::prelude::v1::test]
fn malformed_and_invalid_widths_fall_back_to_default() {
    let directory = TestDirectory::new();
    let path = directory.0.join("preferences.json");
    for contents in [
        "not json",
        "[]",
        "null",
        r#"{"sidebar_width_px":0}"#,
        r#"{"sidebar_width_px":-1}"#,
        r#"{"sidebar_width_px":"200"}"#,
        r#"{"sidebar_width_px":true}"#,
        r#"{"sidebar_width_px":1e100}"#,
        r#"{"sidebar_width_px":1e-100}"#,
        r#"{"sidebar_width_px":NaN}"#,
    ] {
        fs::write(&path, contents).unwrap();
        assert!(read_chrome(&path).is_err(), "accepted {contents}");
        let mut preferences = Preferences::start(Ok(path.clone()));
        assert_eq!(await_loaded(&mut preferences), Chrome::default());
    }
    for contents in ["{}", r#"{"sidebar_width_px":null}"#] {
        fs::write(&path, contents).unwrap();
        assert_eq!(read_chrome(&path).unwrap(), Chrome::default());
    }
    for width in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.0, -1.0] {
        assert!(
            write_chrome(
                &path,
                Chrome {
                    sidebar_width: Some(width),
                    sidebar_split: None,
                    agent_sort: None,
                    notes_width: None,
                    review_files_width: None,
                }
            )
            .is_err()
        );
    }
    let chrome = Chrome {
        sidebar_width: Some(237.5),
        sidebar_split: None,
        agent_sort: None,
        notes_width: None,
        review_files_width: None,
    };
    write_chrome(&path, chrome).unwrap();
    assert_eq!(read_chrome(&path).unwrap(), chrome);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[core::prelude::v1::test]
fn invalid_sidebar_splits_preserve_other_preferences() {
    let directory = TestDirectory::new();
    let path = directory.0.join("preferences.json");
    let expected = Chrome {
        sidebar_width: Some(240.0),
        sidebar_split: None,
        agent_sort: Some(AgentSort::Priority),
        notes_width: None,
        review_files_width: None,
    };
    for split in [
        "null", "0", "-1", "0.099", "0.901", "1e100", "1e-100", "\"0.5\"", "true", "[]", "{}",
    ] {
        fs::write(
            &path,
            format!(
                r#"{{"sidebar_width_px":240,"agent_sort":"priority","sidebar_split":{split}}}"#
            ),
        )
        .unwrap();
        assert_eq!(read_chrome(&path).unwrap(), expected, "{split}");
    }
    for split in [
        f32::NAN,
        f32::INFINITY,
        f32::NEG_INFINITY,
        0.0,
        0.099,
        0.901,
    ] {
        write_chrome(
            &path,
            Chrome {
                sidebar_split: Some(split),
                ..expected
            },
        )
        .unwrap();
        assert_eq!(read_chrome(&path).unwrap(), expected, "{split}");
    }
}

#[core::prelude::v1::test]
fn sidebar_split_roundtrips_including_boundaries_and_reset() {
    let directory = TestDirectory::new();
    let path = directory.0.join("preferences.json");
    for sidebar_split in [Some(0.1), Some(0.4), Some(0.9), None] {
        let chrome = Chrome {
            sidebar_width: Some(240.0),
            sidebar_split,
            agent_sort: Some(AgentSort::Priority),
            notes_width: None,
            review_files_width: None,
        };
        write_chrome(&path, chrome).unwrap();
        let stored: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(stored["sidebar_split"], serde_json::json!(sidebar_split));
        assert_eq!(read_chrome(&path).unwrap(), chrome);
    }
}

#[core::prelude::v1::test]
fn endpoint_paths_use_stable_fnv1a() {
    let root = Path::new("/state/herdr/gpui");
    assert_eq!(
        endpoint_path(root, Path::new("hello")),
        Path::new("/state/herdr/gpui/local-a430d84680aabd0b.json")
    );
    assert_eq!(
        endpoint_path(root, Path::new("")),
        Path::new("/state/herdr/gpui/local-cbf29ce484222325.json")
    );
    assert_ne!(
        endpoint_path(root, Path::new("/a.sock")),
        endpoint_path(root, Path::new("/b.sock"))
    );
}

mod notes_width;
