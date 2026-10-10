use super::*;
use std::cell::Cell;

#[test]
fn embedded_and_custom_mp3_decode_without_a_device() {
    for sound in [Sound::Done, Sound::Request] {
        let source = decode(sound, None).unwrap();
        let max_samples =
            source.sample_rate().get() as usize * source.channels().get() as usize * 15;
        let samples: Vec<_> = source.take(max_samples + 1).collect();
        assert!(!samples.is_empty() && samples.len() <= max_samples);
        assert!(samples.iter().all(|sample| sample.is_finite()));
        assert!(samples.iter().any(|sample| sample.abs() > 0.001));
    }
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("custom.mp3");
    std::fs::write(
        &path,
        include_bytes!("../../../../../assets/sounds/request.mp3"),
    )
    .unwrap();
    assert_eq!(
        decode(Sound::Done, Some(&path))
            .unwrap()
            .collect::<Vec<_>>(),
        decode(Sound::Request, None).unwrap().collect::<Vec<_>>()
    );
}

#[test]
fn custom_failures_preserve_sources_and_fall_back() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("custom.mp3");
    let error = decode_file(&path).err().unwrap();
    assert!(
        matches!(&error, Error::SoundFile { path: failed, source } if failed == &path && source.kind() == std::io::ErrorKind::NotFound)
    );
    assert!(std::error::Error::source(&error).is_some());
    for bytes in [b"".as_slice(), b"not an MP3"] {
        std::fs::write(&path, bytes).unwrap();
        let error = decode_file(&path).err().unwrap();
        assert!(matches!(error, Error::SoundDecode(_)));
        assert!(std::error::Error::source(&error).is_some());
        assert_eq!(
            decode(Sound::Done, Some(&path))
                .unwrap()
                .collect::<Vec<_>>(),
            decode(Sound::Done, None).unwrap().collect::<Vec<_>>()
        );
    }
    std::fs::File::create(&path)
        .unwrap()
        .set_len(MAX_FILE_BYTES + 1)
        .unwrap();
    assert!(matches!(decode_file(&path), Err(Error::SoundFileSize)));
    #[cfg(unix)]
    assert!(matches!(decode_file(dir.path()), Err(Error::SoundFileSize)));
    #[cfg(windows)]
    {
        let error = decode_file(dir.path()).err().unwrap();
        assert!(matches!(
            &error,
            Error::SoundFile { path, source }
                if path == dir.path() && source.kind() == std::io::ErrorKind::PermissionDenied
        ));
        assert!(std::error::Error::source(&error).is_some());
    }
    assert!(decode(Sound::Request, Some(dir.path())).is_ok());
    #[cfg(unix)]
    {
        std::fs::remove_file(&path).unwrap();
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&path)
                .status()
                .unwrap()
                .success()
        );
        assert!(matches!(decode_file(&path), Err(Error::SoundFileSize)));
    }
    assert!(decode(Sound::Request, Some(&path)).is_ok());
}

#[test]
fn playback_wait_stops_on_cancel_shutdown_timeout_and_device_loss() {
    for outcome in 0..5 {
        let (player, mut output) = Player::new();
        player.append(rodio::source::SineWave::new(440.0));
        assert!(output.next().is_some());
        let (sender, errors) = mpsc::sync_channel(1);
        let cancel = AtomicBool::new(false);
        let connection_cancel = AtomicBool::new(false);
        let stop = AtomicBool::new(false);
        let start = Instant::now();
        let now = Cell::new(start);
        let result = wait(
            &player,
            &errors,
            start + MAX_DURATION,
            &[&cancel, &connection_cancel],
            &stop,
            || now.get(),
            || match outcome {
                0 => cancel.store(true, Ordering::Release),
                1 => stop.store(true, Ordering::Release),
                2 => now.set(start + MAX_DURATION),
                4 => connection_cancel.store(true, Ordering::Release),
                _ => sender
                    .try_send(rodio::cpal::StreamError::DeviceNotAvailable)
                    .unwrap(),
            },
        );
        match outcome {
            0 | 1 | 4 => assert!(matches!(result, Err(Error::SoundCancelled))),
            2 => assert!(matches!(result, Err(Error::SoundTimeout))),
            _ => {
                let error = result.unwrap_err();
                assert!(matches!(error, Error::SoundStream(_)));
                assert!(std::error::Error::source(&error).is_some());
            }
        }
        // Consume the control interval, without a device or wall-clock sleep.
        for _ in 0..100_000 {
            let _ = output.next();
        }
        assert!(player.empty());
    }
}

#[test]
fn normal_completion_and_source_duration_are_bounded() {
    let source = rodio::source::SineWave::new(440.0).take_duration(MAX_DURATION);
    let rate = source.sample_rate().get() as usize;
    // Rodio rounds each sample duration down to whole nanoseconds.
    let count = source.take(rate * 16).count();
    assert!((rate * 15..=rate * 15 + rate / 1000).contains(&count));
    let (player, mut output) = Player::new();
    player.append(decode(Sound::Done, None).unwrap());
    let (_sender, errors) = mpsc::sync_channel(1);
    let now = Instant::now();
    assert!(
        wait(
            &player,
            &errors,
            now + MAX_DURATION,
            &[&AtomicBool::new(false)],
            &AtomicBool::new(false),
            || now,
            || {
                for _ in 0..1024 {
                    let _ = output.next();
                }
            }
        )
        .is_ok()
    );
    assert!(player.empty());
    assert!(matches!(
        check(now, &[&AtomicBool::new(true)], &AtomicBool::new(false), now),
        Err(Error::SoundCancelled)
    ));
}
