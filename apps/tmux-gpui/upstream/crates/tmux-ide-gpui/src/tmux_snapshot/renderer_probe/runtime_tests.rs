#![allow(clippy::unwrap_used)]
use super::*;
#[path = "runtime_output_tests.rs"]
mod output;
use crate::{terminal_painter::NativeFrame, tmux_snapshot::hit_regions::Region};
use herdr_client::protocol::CellData;
use std::sync::Arc;
fn state(text: &str, offset: u64) -> browser::State {
    let mut cells: Vec<_> = text
        .chars()
        .map(|c| CellData {
            symbol: c.to_string(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        })
        .collect();
    cells.resize(
        80,
        CellData {
            symbol: " ".into(),
            fg: 0,
            bg: 0,
            modifier: 0,
            skip: false,
            hyperlink: None,
        },
    );
    browser::State {
        request: 1,
        selected_pane: Some("%1".into()),
        renderer_probe_scope: Some(Scope {
            pane: "%1".into(),
            generation: "g".into(),
            incarnation: "i".into(),
            request: 1,
            cols: 80,
            rows: 1,
            viewport_offset: offset,
        }),
        copy_region: Some(crate::tmux_snapshot::copy::Region {
            id: "%1".into(),
            left: 0,
            top: 0,
            width: 80,
            height: 1,
            wrapped: vec![false],
        }),
        regions: vec![Region {
            id: "%1".into(),
            left: 0,
            top: 0,
            width: 80,
            height: 1,
        }],
        frame: Some(DisplayFrame::Native(Arc::new(NativeFrame {
            rows: vec![cells.into()],
            width: 80,
            height: 1,
            cursor: None,
        }))),
        ..Default::default()
    }
}
fn run(kind: &str, exercise: impl FnOnce()) -> serde_json::Value {
    let opt = FixtureOptIn::enabled(true).unwrap();
    let path = std::env::temp_dir().join(format!(
        "renderer-runtime-{}-{}.jsonl",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let (log, worker) = LogSink::spawn(opt, path.clone()).unwrap();
    RUNTIME.with_borrow_mut(|r| {
        *r = Some(Runtime {
            ledger: Ledger::new(opt),
            log,
            trials: vec![Trial {
                id: "one".into(),
                nonce: "a".repeat(32),
                kind: Some(kind.into()),
            }]
            .into(),
            started: Instant::now(),
            scroll: None,
            sequence: 0,
        })
    });
    exercise();
    RUNTIME.with_borrow_mut(|r| *r = None);
    worker.join().unwrap().unwrap();
    let raw = std::fs::read_to_string(&path).unwrap();
    std::fs::remove_file(path).unwrap();
    serde_json::from_str(raw.trim()).unwrap()
}
#[test]
fn input_requires_successful_unclipped_matching_paint() {
    let receipt = run("input", || {
        assert!(
            matches!(admit(Input::Text("!".into()),&state("READY",0)),Input::Text(t) if t==format!("PROBE-IN:{}\n","a".repeat(32)))
        );
        let s = state(&format!("PROBE-OUTPUT:{}", "a".repeat(32)), 0);
        after_paint(&s, s.frame.as_ref().unwrap(), 80, 1, false);
        RUNTIME.with_borrow(|r| assert!(r.as_ref().unwrap().ledger.pending()));
        after_paint(&s, s.frame.as_ref().unwrap(), 2, 1, true);
        RUNTIME.with_borrow(|r| assert!(r.as_ref().unwrap().ledger.pending()));
        after_paint(&s, s.frame.as_ref().unwrap(), 80, 1, true);
    });
    assert_eq!(receipt["status"], "completed");
}
#[test]
fn scroll_preparation_untimed_and_offset_preserved() {
    let receipt = run("scroll", || {
        let before = state(&format!("PROBE-ROW:{}:0477", "a".repeat(32)), 0);
        assert!(
            matches!(admit(Input::Text("!".into()),&before),Input::Text(t) if t.starts_with("PROBE-PREPARE-SCROLL:"))
        );
        RUNTIME.with_borrow(|r| assert!(!r.as_ref().unwrap().ledger.pending()));
        let _ = admit(Input::Scroll(3), &before);
        let s = state(&format!("PROBE-ROW:{}:0123", "a".repeat(32)), 3);
        after_paint(&s, s.frame.as_ref().unwrap(), 80, 1, true);
    });
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["expected"]["viewportOffset"], 3);
}
#[test]
fn preexisting_marker_fails_before_dispatch() {
    let receipt = run("input", || {
        let s = state(&format!("PROBE-OUTPUT:{}", "a".repeat(32)), 0);
        assert!(matches!(admit(Input::Text("!".into()),&s),Input::Text(t) if t.is_empty()));
    });
    assert_eq!(receipt["status"], "failed");
}

#[test]
fn title_row_is_excluded_from_terminal_geometry_and_scroll_witness() {
    let receipt = run("scroll", || {
        let mut before = state(&format!("PROBE-ROW:{}:0477", "a".repeat(32)), 0);
        let with_header = |s: &mut browser::State| {
            let Some(DisplayFrame::Native(frame)) = &s.frame else {
                panic!("native fixture")
            };
            let mut rows = frame.rows.clone();
            rows.insert(
                0,
                vec![
                    CellData {
                        symbol: " ".into(),
                        fg: 0,
                        bg: 0,
                        modifier: 0,
                        skip: false,
                        hyperlink: None
                    };
                    80
                ]
                .into(),
            );
            s.frame = Some(DisplayFrame::Native(Arc::new(NativeFrame {
                rows,
                width: 80,
                height: 2,
                cursor: None,
            })));
            s.copy_region.as_mut().unwrap().top = 1;
            s.regions[0].height = 2;
        };
        with_header(&mut before);
        let _ = admit(Input::Scroll(3), &before);
        let mut after = state(&format!("PROBE-ROW:{}:0123", "a".repeat(32)), 3);
        with_header(&mut after);
        // Only the title row is visible: cannot complete a terminal row witness.
        after_paint(&after, after.frame.as_ref().unwrap(), 80, 1, true);
        RUNTIME.with_borrow(|r| assert!(r.as_ref().unwrap().ledger.pending()));
        after_paint(&after, after.frame.as_ref().unwrap(), 80, 2, true);
    });
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["source"]["rows"], 1);
    assert_eq!(receipt["witness"]["row"], 0);
    assert_eq!(receipt["expected"]["viewportOffset"], 3);
}

#[test]
fn returning_live_and_unprepared_scroll_do_not_consume_the_next_trial() {
    let receipt = run("scroll", || {
        for before in [
            state("READY", 0),
            state(&format!("PROBE-ROW:{}:0477", "b".repeat(32)), 0),
            state(&format!("PROBE-ROW:{}:0477", "a".repeat(32)), 32),
        ] {
            let _ = admit(Input::Scroll(-32), &before);
            RUNTIME.with_borrow(|r| {
                let r = r.as_ref().unwrap();
                assert!(r.scroll.is_none());
                assert!(!r.ledger.pending());
                assert_eq!(r.trials.len(), 1);
            });
        }
        let before = state(&format!("PROBE-ROW:{}:0477", "a".repeat(32)), 0);
        let _ = admit(Input::Scroll(32), &before);
        let after = state(&format!("PROBE-ROW:{}:0445", "a".repeat(32)), 32);
        after_paint(&after, after.frame.as_ref().unwrap(), 80, 1, true);
    });
    assert_eq!(receipt["status"], "completed");
    assert_eq!(receipt["expected"]["viewportOffset"], 32);
}
