use super::*;

#[test]
fn timestamp_and_left_aligned_levels_have_exact_columns() {
    let time = chrono::DateTime::parse_from_rfc3339("2025-09-26T15:03:45-07:00").unwrap();
    let timestamp = time.format(TIMESTAMP_FORMAT).to_string();
    assert_eq!(timestamp, "[2025-09-26 15:03:45]");
    for (level, padded) in [
        (Level::TRACE, "TRACE"),
        (Level::DEBUG, "DEBUG"),
        (Level::INFO, "INFO "),
        (Level::WARN, "WARN "),
        (Level::ERROR, "ERROR"),
    ] {
        let mut record = Record::fixture(level, "message");
        record.target = "target".into();
        assert_eq!(
            record.line(),
            format!("[2025-09-26 15:03:45] {padded} target message")
        );
        assert_eq!(&record.line()[28..], "target message");
    }
}

fn sink(capacity: usize) -> (Capture, Receiver<Vec<u8>>, Arc<Counters>) {
    let (lines, queued) = mpsc::sync_channel(capacity);
    let counters = Arc::new(Counters::default());
    let capture = Capture {
        lines,
        counters: counters.clone(),
    };
    (capture, queued, counters)
}

fn queued_records(queued: &Receiver<Vec<u8>>) -> Vec<Record> {
    queued
        .try_iter()
        .map(|line| {
            assert_eq!(line.last(), Some(&b'\n'));
            assert_eq!(line.iter().filter(|byte| **byte == b'\n').count(), 1);
            serde_json::from_slice(&line).unwrap()
        })
        .collect()
}

fn counts(counters: &Counters) -> (u64, u64) {
    (
        counters.generation.load(Ordering::Acquire),
        counters.dropped.load(Ordering::Relaxed),
    )
}

fn line(message: &str) -> Vec<u8> {
    let mut line = serde_json::to_vec(&Record::fixture(Level::INFO, message)).unwrap();
    line.push(b'\n');
    line
}

fn messages(tail: &Tail) -> Vec<String> {
    tail.records()
        .iter()
        .map(|record| record.message.clone())
        .collect()
}

#[test]
fn public_api_is_available_without_installing_a_global_subscriber() {
    let _init = init;
    let _ = (generation(), dropped(), path());
}

#[test]
fn json_schema_preserves_typed_fields_and_roundtrips() {
    let (capture, queued, _) = sink(QUEUE);
    tracing::subscriber::with_default(subscriber(capture), || {
        let span = tracing::info_span!(target: "herdr_gpui", "paint", password = "secret");
        let _entered = span.enter();
        tracing::info!(target: "herdr_gpui::terminal_painter",
            ready = true, signed = -7_i64, unsigned = u64::MAX, ratio = 1.25_f64,
            text = "quoted \"text\"", debug = ?[1, 2], large = u128::MAX,
            nonfinite = f64::INFINITY, "Paint complete");
    });
    let rows = queued_records(&queued);
    let row = &rows[0];
    let encoded = serde_json::to_string(row).unwrap();
    let json: Value = serde_json::from_str(&encoded).unwrap();
    assert_eq!(json["type"], "event");
    assert_eq!(json["level"], "INFO");
    assert_eq!(json["namespace"], "herdr_gpui");
    assert_eq!(json["target"], "herdr_gpui::terminal_painter");
    assert_eq!(json["message"], "Paint complete");
    assert_eq!(json["fields"]["ready"], true);
    assert_eq!(json["fields"]["signed"], -7);
    assert_eq!(json["fields"]["unsigned"], u64::MAX);
    assert_eq!(json["fields"]["ratio"], 1.25);
    assert_eq!(json["fields"]["text"], "quoted \"text\"");
    assert_eq!(json["fields"]["debug"], "[1, 2]");
    assert_eq!(json["fields"]["large"], u128::MAX.to_string());
    assert_eq!(json["fields"]["nonfinite"], "inf");
    assert_eq!(json["spans"], serde_json::json!(["paint"]));
    assert!(!encoded.contains("secret"));
    assert_eq!(serde_json::from_str::<Record>(&encoded).unwrap(), *row);
    assert!(serde_json::from_str::<Record>(&encoded.replace("INFO", "INVALID")).is_err());
}

#[test]
fn json_escaping_and_many_fields_share_one_record_budget() {
    let (capture, queued, _) = sink(QUEUE);
    let huge = "\"\\\n\u{1f980}".repeat(100_000);
    tracing::subscriber::with_default(subscriber(capture), || {
        tracing::info!(target: "herdr_client", a = huge.as_str(), b = huge.as_str(), "{}", huge);
        tracing::info!(target: "herdr_client",
            a01=1,a02=2,a03=3,a04=4,a05=5,a06=6,a07=7,a08=8,a09=9,a10=10,
            a11=1,a12=2,a13=3,a14=4,a15=5,a16=6,a17=7,a18=8,a19=9,a20=10,
            a21=1,a22=2,a23=3,a24=4,a25=5,a26=6,a27=7,a28=8,a29=9,a30=10,
            a31=1,a32=2,a33=3,a34=4);
    });
    let lines: Vec<_> = queued.try_iter().collect();
    assert_eq!(lines.len(), 2);
    for line in &lines {
        // The budget covers the JSON; the newline is framing.
        assert!(line.len() <= MAX_BYTES + 1, "{}", line.len());
        let row: Record = serde_json::from_slice(line).unwrap();
        assert!(row.truncated);
        assert!(row.fields.len() <= 32);
    }
    let row: Record = serde_json::from_slice(&lines[1]).unwrap();
    assert_eq!(row.fields.len(), 32);
}

#[test]
fn levels_targets_and_span_context() {
    let (capture, queued, counters) = sink(QUEUE);
    tracing::subscriber::with_default(subscriber(capture), || {
        let span =
            tracing::info_span!(target: "herdr_client", "connection", secret = "not retained");
        let _entered = span.enter();
        tracing::trace!(target: "herdr_client::worker", "trace");
        tracing::debug!(target: "herdr_gpui", "debug");
        tracing::info!(target: "herdr_protocol", "info");
        tracing::warn!(target: "herdr_client", "warn");
        tracing::error!(target: "herdr_gpui", "error");
        tracing::error!(target: "herdr_gpui_impostor", "excluded");
        tracing::error!(target: "gpui", "excluded");
    });
    let records = queued_records(&queued);
    assert_eq!(counts(&counters), (0, 0));
    assert_eq!(
        records.iter().map(|r| r.level).collect::<Vec<_>>(),
        [
            Level::TRACE,
            Level::DEBUG,
            Level::INFO,
            Level::WARN,
            Level::ERROR
        ]
    );
    for record in records {
        assert_eq!(record.spans, ["connection"]);
        assert!(!record.body().contains("not retained"));
        assert!(
            chrono::NaiveDateTime::parse_from_str(&record.timestamp, "[%Y-%m-%d %H:%M:%S]").is_ok()
        );
    }
}

#[test]
fn bounded_utf8_controls_and_debug_stream() {
    struct Huge;
    impl fmt::Debug for Huge {
        fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            for _ in 0..1_000_000 {
                f.write_str("\u{1f980}\n\0")?;
            }
            panic!("formatter should stop on budget exhaustion")
        }
    }
    let (capture, queued, _) = sink(QUEUE);
    tracing::subscriber::with_default(subscriber(capture), || {
        tracing::info!(target: "herdr_gpui", value = ?Huge);
    });
    let records = queued_records(&queued);
    assert!(serde_json::to_vec(&records[0]).unwrap().len() <= MAX_BYTES);
    assert!(records[0].truncated);
    assert!(!records[0].body().chars().any(char::is_control));
}

#[test]
fn filtered_and_reentrant_events_never_format_fields() {
    struct MustNotFormat;
    impl fmt::Debug for MustNotFormat {
        fn fmt(&self, _: &mut fmt::Formatter<'_>) -> fmt::Result {
            panic!("filtered or reentrant event formatted a field")
        }
    }
    let (capture, queued, counters) = sink(QUEUE);
    tracing::subscriber::with_default(subscriber(capture), || {
        tracing::error!(target: "dependency", value = ?MustNotFormat);
        FORMATTING.set(true);
        let _guard = FormattingGuard;
        tracing::error!(target: "herdr_client", value = ?MustNotFormat);
    });
    assert!(queued_records(&queued).is_empty());
    assert_eq!(counts(&counters), (1, 1));
    assert!(!FORMATTING.get());
}

#[test]
fn a_full_queue_or_missing_writer_drops_without_blocking() {
    let (capture, queued, counters) = sink(1);
    tracing::subscriber::with_default(subscriber(capture), || {
        for i in 0..3 {
            tracing::info!(target: "herdr_gpui", i, "queued");
        }
    });
    assert_eq!(queued_records(&queued).len(), 1);
    assert_eq!(counts(&counters), (2, 2));

    let (capture, queued, counters) = sink(QUEUE);
    drop(queued);
    tracing::subscriber::with_default(subscriber(capture), || {
        tracing::info!(target: "herdr_gpui", "no writer");
    });
    assert_eq!(counts(&counters), (1, 1));
}

#[test]
fn concurrent_writers_reach_disk_or_count_as_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("logs").join(FILE_NAME);
    let (capture, queued, counters) = sink(QUEUE);
    let writer = {
        let path = path.clone();
        let counters = counters.clone();
        thread::spawn(move || write_lines(path, queued, &counters))
    };
    let dispatch = tracing::Dispatch::new(subscriber(capture));
    thread::scope(|scope| {
        for _ in 0..8 {
            let dispatch = dispatch.clone();
            scope.spawn(move || {
                tracing::dispatcher::with_default(&dispatch, || {
                    for i in 0..2000 {
                        tracing::trace!(target: "herdr_client", iteration = i, "concurrent");
                    }
                });
            });
        }
    });
    // The writer exits once every sender, owned by the subscriber, is gone.
    drop(dispatch);
    writer.join().unwrap();
    let text = fs::read_to_string(&path).unwrap();
    let written = text.lines().count() as u64;
    for line in text.lines() {
        assert_eq!(
            serde_json::from_str::<Record>(line).unwrap().message,
            "concurrent"
        );
    }
    assert!(written > 0);
    assert_eq!(written + counts(&counters).1, 16000);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn log_files_rotate_before_overflowing_and_reopen_after_failure() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    let previous = dir.path().join(PREVIOUS_FILE_NAME);
    let mut log = LogFile {
        path: path.clone(),
        file: None,
        limit: 10,
    };
    log.append(b"aaaa\n").unwrap();
    log.append(b"bbbb\n").unwrap();
    log.append(b"cccc\n").unwrap();
    assert_eq!(fs::read(&previous).unwrap(), b"aaaa\nbbbb\n");
    assert_eq!(fs::read(&path).unwrap(), b"cccc\n");
    // A single oversized batch still lands, alone, in a fresh file.
    log.append(b"0123456789abcdef\n").unwrap();
    assert_eq!(fs::read(&previous).unwrap(), b"cccc\n");
    assert_eq!(fs::read(&path).unwrap(), b"0123456789abcdef\n");

    // A reopened process measures the existing file before appending.
    let mut reopened = LogFile {
        path: path.clone(),
        file: None,
        limit: 20,
    };
    reopened.append(b"dddd\n").unwrap();
    assert_eq!(fs::read(&previous).unwrap(), b"0123456789abcdef\n");
    assert_eq!(fs::read(&path).unwrap(), b"dddd\n");

    let blocked = LogFile {
        path: dir.path().join("file").join(FILE_NAME),
        file: None,
        limit: 20,
    };
    fs::write(dir.path().join("file"), b"").unwrap();
    let mut blocked = blocked;
    assert!(blocked.append(b"eeee\n").is_err());
    assert!(blocked.file.is_none());
    fs::remove_file(dir.path().join("file")).unwrap();
    blocked.append(b"eeee\n").unwrap();
    assert_eq!(
        fs::read(dir.path().join("file").join(FILE_NAME)).unwrap(),
        b"eeee\n"
    );
}

#[test]
fn tails_read_appended_complete_lines_and_skip_foreign_ones() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    let mut tail = Tail::new(&path);
    tail.read().unwrap();
    assert!(tail.records().is_empty());

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap();
    let second = line("second");
    file.write_all(&line("first")).unwrap();
    file.write_all(b"not json\n").unwrap();
    file.write_all(&vec![b'x'; MAX_LINE * 2]).unwrap();
    file.write_all(b"\n").unwrap();
    file.write_all(&second[..10]).unwrap();
    tail.read().unwrap();
    assert_eq!(messages(&tail), ["first"]);
    file.write_all(&second[10..]).unwrap();
    tail.read().unwrap();
    assert_eq!(messages(&tail), ["first", "second"]);

    // Rotation leaves a shorter file: read it from the start, keep history.
    fs::write(&path, line("rotated")).unwrap();
    tail.read().unwrap();
    assert_eq!(messages(&tail), ["first", "second", "rotated"]);
}

#[test]
fn tails_start_near_the_end_and_keep_a_bounded_history() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    let record = line("filler");
    let count = TAIL_BYTES as usize / record.len() + 2;
    let mut text = Vec::with_capacity(count * record.len());
    for _ in 0..count {
        text.extend_from_slice(&record);
    }
    text.extend_from_slice(&line("newest"));
    fs::write(&path, &text).unwrap();
    let mut tail = Tail::new(&path);
    tail.read().unwrap();
    let records = tail.records();
    // Only the last TAIL_BYTES are read, and only the newest records kept.
    assert!(count > TAIL_RECORDS);
    assert_eq!(records.len(), TAIL_RECORDS);
    assert_eq!(records.last().unwrap().message, "newest");

    let mut tail = Tail::new(&path);
    for _ in 0..TAIL_RECORDS + 3 {
        tail.consume(&line("more"));
    }
    tail.consume(&line("last"));
    assert_eq!(tail.records().len(), TAIL_RECORDS);
    assert_eq!(tail.records().last().unwrap().message, "last");
}
