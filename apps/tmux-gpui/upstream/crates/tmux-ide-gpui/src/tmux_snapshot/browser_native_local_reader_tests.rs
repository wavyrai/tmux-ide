#![allow(clippy::unwrap_used)]
use super::*;

const REV: &str = "0123456789abcdef0123456789abcdef";

fn chunk(offset: u64, bytes: &[u8], revision: &str) -> ReaderChunk {
    ReaderChunk {
        revision: revision.into(),
        size: 10,
        offset,
        bytes: bytes.to_vec(),
    }
}

#[test]
fn pages_reassemble_in_order_and_a_gap_restarts_the_read() {
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    let whole = assemble(Some(first), chunk(5, b"world", REV)).unwrap();
    assert_eq!(whole.bytes, b"helloworld");
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    assert!(assemble(Some(first), chunk(6, b"orld", REV)).is_none());
    let first = assemble(None, chunk(0, b"hello", REV)).unwrap();
    assert!(assemble(Some(first), chunk(5, b"world", &"f".repeat(32))).is_none());
    assert!(assemble(None, chunk(5, b"world", REV)).is_none());
}

#[test]
fn the_next_page_resumes_where_the_held_bytes_end() {
    let held = Progress {
        revision: REV.into(),
        bytes: vec![0; 7],
    };
    assert_eq!(
        page_of(Some(&held)),
        Some(ReaderPage {
            revision: REV.into(),
            offset: 7
        })
    );
}

/// R28, R29 and review round 1, item 3: only visible readers are served, none
/// in the background, and in turn so that a later reader is not starved.
#[test]
fn readers_are_served_in_turn_only_when_visible_and_in_front() {
    let panes: Vec<String> = ["a", "b", "c", "d"].map(String::from).to_vec();
    let visible = |pane: &str| pane != "c";
    assert_eq!(order(true, panes.iter(), visible, None), ["a", "b", "d"]);
    assert_eq!(
        order(true, panes.iter(), visible, Some("a")),
        ["b", "d", "a"]
    );
    assert_eq!(
        order(true, panes.iter(), visible, Some("d")),
        ["a", "b", "d"]
    );
    // A reader that is gone or hidden does not stall the turn.
    assert_eq!(
        order(true, panes.iter(), visible, Some("c")),
        ["a", "b", "d"]
    );
    assert!(order(false, panes.iter(), visible, None).is_empty());
}

/// Review round 2, finding 3 and B2: the budget left is the budget less the
/// cached pictures' pixels, and no second picture is fetched while one is
/// still being stored, so every store sees what the ones before it used.
#[test]
fn stores_run_one_at_a_time_against_the_budget_left() {
    let mut fetch = PaneFetch {
        wanted: ["a.png", "b.png", "c.png"].map(String::from).to_vec(),
        ..Default::default()
    };
    assert_eq!(fetch.budget_left(), PIXEL_BUDGET);
    assert_eq!(fetch.next_asset(), Some("a.png"));
    fetch.storing.insert("a.png".into());
    assert_eq!(fetch.next_asset(), None);
    fetch.storing.clear();
    fetch.assets.insert("a.png".into(), Asset::Failed);
    fetch.pixels.insert("a.png".into(), 10_000_000);
    fetch.pixels.insert("x.png".into(), 6_000_000);
    assert_eq!(fetch.budget_left(), PIXEL_BUDGET - 16_000_000);
    assert_eq!(fetch.next_asset(), Some("b.png"));
    fetch.pixels.insert("y.png".into(), PIXEL_BUDGET);
    assert_eq!(fetch.budget_left(), 0);
}

/// T1: a render older than the latest asked for is dropped.
#[test]
fn a_stale_render_is_dropped() {
    let doc = Arc::new(bezel_markdown::parse("# a\n"));
    let mut fetch = PaneFetch {
        ticket: 2,
        fresh: true,
        ..Default::default()
    };
    assert!(!fetch.take_render(1, doc.clone(), vec!["old.png".into()]));
    assert!(fetch.rendered.is_none() && fetch.wanted.is_empty());
    assert_eq!((fetch.generation, fetch.fresh), (0, true));
    assert!(fetch.take_render(2, doc, vec!["new.png".into()]));
    assert_eq!(fetch.wanted, ["new.png"]);
    assert_eq!((fetch.generation, fetch.fresh), (1, false));
}

/// #353 round 3, B4: a whole picture that cannot reach the work thread fails
/// at once instead of waiting in `storing` for ever; one that reaches it waits
/// there for its result.
#[test]
fn a_picture_the_work_thread_cannot_take_fails_at_once() {
    use herdr_client::tmux_daemon::ImageMime;
    let page = || ReaderAsset::Page {
        mime: ImageMime::Png,
        chunk: ReaderChunk {
            revision: REV.into(),
            size: 4,
            offset: 0,
            bytes: b"\x89PNG".to_vec(),
        },
    };
    let mut gate = Gate {
        kitchen: Some(Kitchen::closed()),
        ..Default::default()
    };
    let wanted = PaneFetch {
        wanted: vec!["a.png".into()],
        ..Default::default()
    };
    gate.panes.insert("pane".into(), wanted);
    assert!(gate.asset("pane", "a.png".into(), page()));
    let fetch = &gate.panes["pane"];
    assert!(fetch.storing.is_empty());
    assert!(matches!(fetch.assets.get("a.png"), Some(Asset::Failed)));
    assert_eq!(
        fetch.next_asset(),
        None,
        "a failed picture is not fetched again"
    );

    let mut gate = Gate::default();
    gate.panes.insert("pane".into(), PaneFetch::default());
    assert!(!gate.asset("pane", "a.png".into(), page()));
    let fetch = &gate.panes["pane"];
    assert!(fetch.storing.contains("a.png"));
    assert!(!fetch.assets.contains_key("a.png"));
}
