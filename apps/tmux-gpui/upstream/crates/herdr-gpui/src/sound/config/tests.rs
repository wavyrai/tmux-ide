use super::*;

#[test]
fn shared_config_path_precedence_is_independent_of_gui_build() {
    assert_eq!(
        config_path(|_| None),
        std::env::temp_dir().join("herdr/config.toml")
    );
    let vars = [
        ("HOME", "/home/test"),
        ("XDG_CONFIG_HOME", "/xdg"),
        ("HERDR_CONFIG_PATH", "/explicit/settings.toml"),
    ];
    for (count, expected) in [
        (
            1,
            if cfg!(windows) {
                "/home/test/AppData/Roaming/herdr/config.toml"
            } else {
                "/home/test/.config/herdr/config.toml"
            },
        ),
        (2, "/xdg/herdr/config.toml"),
        (3, "/explicit/settings.toml"),
    ] {
        assert_eq!(
            config_path(|key| vars[..count]
                .iter()
                .find(|(k, _)| *k == key)
                .map(|(_, value)| (*value).into())),
            PathBuf::from(expected)
        );
    }
}

#[test]
fn defaults_overrides_aliases_and_global_mute() {
    let settings = Settings::default();
    assert_eq!(settings.delay, 1);
    assert!(settings.sound.allows(None));
    assert!(settings.sound.allows(Some("claude")));
    assert!(!settings.sound.allows(Some("Droid")));
    let settings = Settings::parse("[ui.sound.agents]\ndroid = 'default'\nopen_code = 'off'\ngithub_copilot = 'off'\nagy = 'off'\n", Path::new("/config.toml")).unwrap();
    assert!(settings.sound.allows(Some("droid")));
    for alias in [
        "OpenCode",
        "opencode2",
        "open-code",
        "github-copilot",
        "copilot",
        "ghcs",
        "Antigravity",
        "C:\\bin\\opencode.exe",
    ] {
        assert!(!settings.sound.allows(Some(alias)), "{alias}");
    }
    assert!(settings.sound.allows(Some("unknown")));
    let settings = Settings::parse(
        "[ui.sound]\nenabled = false\n[ui.sound.agents]\ndroid = 'on'",
        Path::new("/config.toml"),
    )
    .unwrap();
    assert!(!settings.sound.allows(Some("droid")));
    assert!(!settings.sound.allows(None));
}

#[test]
fn paths_are_local_config_relative_with_per_sound_precedence() {
    let settings = Settings::parse("[ui.sound]\npath = 'all.mp3'\ndone_path = 'done.mp3'\n[ui.toast]\ndelay_seconds = 3600\n[unrelated]\nfield = 12", Path::new("/local/config.toml")).unwrap();
    assert_eq!(
        settings.path_for(Sound::Done),
        Some("/local/done.mp3".into())
    );
    assert_eq!(
        settings.path_for(Sound::Request),
        Some("/local/all.mp3".into())
    );
    assert_eq!(settings.delay, 3600);
    let settings = Settings::parse(
        "[ui.sound]\nrequest_path = '/absolute.mp3'",
        Path::new("/local/config.toml"),
    )
    .unwrap();
    assert_eq!(
        settings.path_for(Sound::Request),
        Some("/absolute.mp3".into())
    );
    assert_eq!(settings.path_for(Sound::Done), None);
}

#[test]
fn values_from_a_newer_herdr_fall_back_one_by_one() {
    // Herdr owns this file: a value this build cannot read keeps its own
    // default and every other setting still applies.
    for text in [
        "[ui.toast]\ndelay_seconds = 3601",
        "[ui.toast]\ndelay_seconds = -1",
        "[ui.toast]\ndelay_seconds = '2'",
        "[ui]\ntoast = 'later'",
    ] {
        assert_eq!(
            Settings::parse(text, Path::new("x")).unwrap().delay,
            1,
            "{text}"
        );
    }
    let settings = Settings::parse(
        "[ui.toast]\ndelay_seconds = 5\n[ui.sound]\nenabled = 'yes'\n\
             done_path = 'done.mp3'\nrequest_path = 7\nfuture = true\n\
             [ui.sound.agents]\nclaude = 'always'\ndroid = 'on'\ncodex = 'off'",
        Path::new("/local/config.toml"),
    )
    .unwrap();
    assert_eq!(settings.delay, 5);
    assert!(settings.sound.enabled);
    assert_eq!(
        settings.path_for(Sound::Done),
        Some("/local/done.mp3".into())
    );
    assert_eq!(settings.path_for(Sound::Request), None);
    // The unreadable agent setting keeps its default; the others apply.
    assert!(settings.sound.allows(Some("claude")));
    assert!(settings.sound.allows(Some("droid")));
    assert!(!settings.sound.allows(Some("codex")));
    let settings = Settings::parse("ui = 3", Path::new("x")).unwrap();
    assert!(settings.sound.enabled);
    assert_eq!(settings.delay, 1);
}

#[test]
fn bounded_reads_preserve_sources() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("config.toml");
    assert_eq!(Settings::load_path(&path).unwrap().delay, 1);
    std::fs::write(&path, "[ui.sound]\nenabled = false").unwrap();
    assert!(!Settings::load_path(&path).unwrap().sound.enabled);
    std::fs::write(&path, "[broken").unwrap();
    let error = Settings::load_path(&path).err().unwrap();
    assert!(
        matches!(&error, Error::Path { source, .. } if matches!(source.as_ref(), Error::Toml(_)))
    );
    assert!(std::error::Error::source(&error).is_some());
    std::fs::write(&path, vec![b' '; 1_048_577]).unwrap();
    assert!(
        matches!(Settings::load_path(&path), Err(Error::Path { source, .. }) if matches!(*source, Error::SoundConfigSize))
    );
}

#[test]
fn worker_reloads_asynchronously_and_keeps_last_valid_config() {
    use super::super::{Job, Service};
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    };
    use std::time::{Duration, Instant};
    let (loads, loaded) = mpsc::sync_channel(4);
    let (played, sounds) = mpsc::sync_channel(4);
    let count = Arc::new(AtomicUsize::new(0));
    let worker_count = count.clone();
    loads.send(Ok(Settings::default())).unwrap();
    let service = Service::start(
        move || {
            let result = loaded.recv_timeout(Duration::from_secs(3)).unwrap();
            worker_count.fetch_add(1, Ordering::Release);
            result
        },
        move |_, path, _, _| {
            played.send(path.map(Path::to_owned)).unwrap();
            Ok(())
        },
    );
    let wait_loaded = |expected| {
        let deadline = Instant::now() + Duration::from_secs(3);
        while count.load(Ordering::Acquire) < expected {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(1));
        }
    };
    // Distinct titles, since the worker plays one copy of a repeated event.
    let send = |title: &str| {
        service
            .sender
            .as_ref()
            .unwrap()
            .send(Job {
                request: crate::sound::PlaybackRequest::Notification {
                    boot: None,
                    event: herdr_client::protocol::SemanticNotification {
                        kind: herdr_client::protocol::SemanticNotificationKind::Custom,
                        title: title.into(),
                        body: None,
                        sound: Some(Sound::Done),
                        agent: None,
                        workspace_id: None,
                        tab_id: None,
                        pane_id: None,
                        position: None,
                    },
                },
                cancel: Arc::new(AtomicBool::new(false)),
                connection_cancel: Arc::new(AtomicBool::new(false)),
                queued: Instant::now(),
            })
            .unwrap();
    };
    wait_loaded(1);
    send("initial");
    assert_eq!(sounds.recv_timeout(Duration::from_secs(3)).unwrap(), None);
    loads
        .send(Settings::parse(
            "[ui.sound]\npath = 'new.mp3'",
            Path::new("/local/config.toml"),
        ))
        .unwrap();
    service.reload.store(true, Ordering::Release);
    wait_loaded(2);
    send("reloaded");
    assert_eq!(
        sounds.recv_timeout(Duration::from_secs(3)).unwrap(),
        Some("/local/new.mp3".into())
    );
    loads.send(Err(Error::SoundConfigSize)).unwrap();
    service.reload.store(true, Ordering::Release);
    wait_loaded(3);
    send("retained");
    assert_eq!(
        sounds.recv_timeout(Duration::from_secs(3)).unwrap(),
        Some("/local/new.mp3".into())
    );
    drop(service);
    assert!(matches!(
        sounds.recv_timeout(Duration::from_secs(3)),
        Err(mpsc::RecvTimeoutError::Disconnected)
    ));
}
