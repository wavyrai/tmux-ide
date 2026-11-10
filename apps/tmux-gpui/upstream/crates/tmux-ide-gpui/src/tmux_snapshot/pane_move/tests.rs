#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;

fn region(id: &str, left: u16, top: u16, width: u16, height: u16) -> Region {
    Region {
        id: id.into(),
        left,
        top,
        width,
        height,
    }
}

/// Two panes side by side, and a third under the right one.
fn layout() -> Vec<Region> {
    vec![
        region("a", 0, 0, 40, 20),
        region("b", 41, 0, 40, 10),
        region("c", 41, 11, 40, 9),
    ]
}

fn ready() -> Facts {
    Facts {
        cards: true,
        ..Facts::default()
    }
}

fn at(x: f32, y: f32) -> Point<Pixels> {
    point(px(x), px(y))
}

fn pressed(now: &[Region]) -> Owner {
    let mut owner = Owner::default();
    owner
        .press("a", at(100., 10.), 7, Some("s".into()), now, ready())
        .unwrap();
    owner
}

fn pick(id: &str) -> Option<Pick> {
    Some(Pick {
        id: id.into(),
        token: format!("{id}-token"),
    })
}

fn phase(owner: &Owner) -> Phase {
    owner.gesture.as_ref().unwrap().phase.clone()
}

#[test]
fn the_threshold_is_four_points() {
    let origin = at(100., 100.);
    assert!(!crossed(origin, at(103.9, 100.)));
    assert!(!crossed(origin, at(102., 102.)), "2.8 pt diagonally");
    assert!(crossed(origin, at(104., 100.)));
    assert!(crossed(origin, at(97., 96.)), "5 pt up and left");
}

#[test]
fn a_press_that_never_moves_four_points_is_a_click() {
    let now = Instant::now();
    let mut owner = pressed(&layout());
    assert!(!owner.moved(at(102., 11.), pick("b"), &layout()));
    assert!(phase(&owner) == Phase::Pressed);
    assert_eq!(owner.release(&layout(), now), Release::Click);
    assert!(
        owner.gesture.is_none(),
        "the header's click focuses the pane"
    );
}

#[test]
fn each_window_state_that_rules_out_a_drag_refuses_the_press() {
    let cases = [
        (
            Facts {
                zoomed: true,
                ..ready()
            },
            Refusal::Zoomed,
        ),
        (
            Facts {
                held: true,
                ..ready()
            },
            Refusal::Held,
        ),
        (
            Facts {
                reconnecting: true,
                ..ready()
            },
            Refusal::Reconnecting,
        ),
        (
            Facts {
                dialog: true,
                ..ready()
            },
            Refusal::Dialog,
        ),
        (
            Facts {
                pending: true,
                ..ready()
            },
            Refusal::Pending,
        ),
        (Facts::default(), Refusal::NoCards),
    ];
    for (facts, refusal) in cases {
        let mut owner = Owner::default();
        assert_eq!(
            owner.press("a", at(0., 0.), 7, None, &layout(), facts),
            Err(refusal)
        );
        assert!(owner.gesture.is_none());
    }
    let mut owner = Owner::default();
    assert_eq!(
        owner.press("a", at(0., 0.), 7, None, &layout(), ready()),
        Ok(())
    );
}

#[test]
fn a_press_while_a_swap_is_pending_is_refused() {
    let now = Instant::now();
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("b"), &layout());
    assert!(matches!(
        owner.release(&layout(), now),
        Release::Swap { .. }
    ));
    assert_eq!(
        owner.press("c", at(0., 0.), 7, None, &layout(), ready()),
        Err(Refusal::Pending)
    );
}

#[test]
fn a_drag_onto_another_panes_centre_swaps_them() {
    let now = Instant::now();
    let mut owner = pressed(&layout());
    assert!(
        owner.moved(at(110., 10.), None, &layout()),
        "the drag starts"
    );
    assert!(owner.dragging());
    assert!(phase(&owner) == Phase::Dragging { target: None });
    // Over its own card: not a target.
    owner.moved(at(120., 10.), pick("a"), &layout());
    assert!(phase(&owner) == Phase::Dragging { target: None });
    owner.moved(at(300., 10.), pick("b"), &layout());
    assert!(phase(&owner) == Phase::Dragging { target: pick("b") });
    assert_eq!(
        owner.release(&layout(), now),
        Release::Swap {
            source: "a".into(),
            target: pick("b").unwrap()
        }
    );
    assert!(matches!(phase(&owner), Phase::Pending { .. }));
}

#[test]
fn releasing_outside_a_pane_or_on_the_source_or_esc_cancels() {
    let now = Instant::now();
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), None, &layout());
    assert_eq!(owner.release(&layout(), now), Release::Cancel);
    assert!(matches!(phase(&owner), Phase::Returning { .. }));

    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("a"), &layout());
    assert_eq!(owner.release(&layout(), now), Release::Cancel);

    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("b"), &layout());
    owner.cancel(now);
    assert!(matches!(phase(&owner), Phase::Returning { .. }));
    assert!(!owner.dragging());
}

#[test]
fn the_card_glides_home_over_layout_and_snaps_under_reduce_motion() {
    let _speed = bezel_motion::lock_speed();
    let now = Instant::now();
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), None, &layout());
    owner.release(&layout(), now);
    let mid = owner
        .returning(now + Duration::from_millis(100), false)
        .unwrap();
    assert!(mid > 0. && mid < 1.);
    assert_eq!(
        owner.returning(now + bezel_motion::LAYOUT.total(), false),
        Some(1.)
    );
    assert!(owner.gesture.is_none(), "home: the gesture is over");

    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), None, &layout());
    owner.release(&layout(), now);
    assert_eq!(owner.returning(now, true), Some(1.));
    assert!(owner.gesture.is_none());
}

#[test]
fn a_layout_change_mid_drag_rebuilds_and_a_lost_pane_cancels() {
    let now = Instant::now();
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("b"), &layout());
    // An agent splits c: both panes are still there, so the drag goes on.
    let mut split = layout();
    split.push(region("d", 61, 11, 20, 9));
    split[2].width = 19;
    assert!(!owner.relayout(&split, now));
    assert!(owner.dragging());
    // b closes: the drag ends.
    let closed: Vec<_> = layout().into_iter().filter(|r| r.id != "b").collect();
    assert!(owner.relayout(&closed, now));
    assert!(matches!(phase(&owner), Phase::Returning { .. }));
    // So does losing the source.
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), None, &layout());
    let gone: Vec<_> = layout().into_iter().filter(|r| r.id != "a").collect();
    assert!(owner.relayout(&gone, now));
}

#[test]
fn a_drop_after_the_layout_changed_under_the_preview_is_refused() {
    let now = Instant::now();
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("b"), &layout());
    let mut changed = layout();
    changed[1].height = 8;
    assert_eq!(owner.release(&changed, now), Release::Stale);
    assert!(matches!(phase(&owner), Phase::Returning { .. }));
    // Moving once more redraws the zones from the new layout: then it drops.
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("b"), &layout());
    owner.moved(at(301., 10.), pick("b"), &changed);
    assert!(matches!(owner.release(&changed, now), Release::Swap { .. }));
}

fn swapped_layout() -> Vec<Region> {
    let mut after = layout();
    after[0] = region("a", 41, 0, 40, 10);
    after[1] = region("b", 0, 0, 40, 20);
    after
}

#[test]
fn swapped_needs_both_halves_and_nothing_else_moved() {
    let before = layout();
    assert!(swapped(&before, &swapped_layout(), "a", "b"));
    assert!(swapped(&before, &swapped_layout(), "b", "a"));
    assert!(!swapped(&before, &before, "a", "b"));
    // a takes b's place but b takes c's: a rotation, not a swap.
    let rotated = vec![
        region("c", 0, 0, 40, 20),
        region("a", 41, 0, 40, 10),
        region("b", 41, 11, 40, 9),
    ];
    assert!(!swapped(&before, &rotated, "a", "b"));
    // Only a moved: half a swap.
    let half = vec![
        region("a", 41, 0, 40, 10),
        region("b", 41, 0, 40, 10),
        region("c", 41, 11, 40, 9),
    ];
    assert!(!swapped(&before, &half, "a", "b"));
    assert!(
        !swapped(&before, &swapped_layout()[..2], "a", "b"),
        "c is gone"
    );
    // A resize alongside the swap still reads as the swap.
    let mut resized = swapped_layout();
    resized[2].height = 8;
    assert!(swapped(&before, &resized, "a", "b"));
}

fn sent(now: Instant) -> Owner {
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("b"), &layout());
    owner.release(&layout(), now);
    owner.sent("spent".into());
    owner
}

#[test]
fn a_pending_swap_settles_when_the_layout_shows_it() {
    let now = Instant::now();
    let mut owner = sent(now);
    assert_eq!(owner.settle(&layout(), None, "", now), Settle::Waiting);
    assert_eq!(
        owner.settle(
            &swapped_layout(),
            Some("next"),
            "",
            now + Duration::from_millis(50)
        ),
        Settle::Swapped
    );
    assert!(owner.gesture.is_none());
    assert!(owner.undo.is_some());
}

#[test]
fn an_unrelated_change_first_or_a_late_layout_still_settles() {
    let now = Instant::now();
    // A resize lands before the swap's layout: keep waiting.
    let mut owner = sent(now);
    let mut resized = layout();
    resized[2].height = 8;
    assert_eq!(owner.settle(&resized, None, "", now), Settle::Waiting);
    let mut after = swapped_layout();
    after[2].height = 8;
    assert_eq!(owner.settle(&after, Some("next"), "", now), Settle::Swapped);
    // The action finished long ago without a refusal; the layout is late.
    let mut owner = sent(now);
    let late = now + Duration::from_secs(10);
    assert_eq!(
        owner.settle(&layout(), Some("next"), "Connected", late),
        Settle::Waiting
    );
    assert_eq!(
        owner.settle(&swapped_layout(), Some("next"), "", late),
        Settle::Swapped
    );
}

#[test]
fn only_the_daemons_refusal_or_the_deadline_fails_a_swap() {
    let now = Instant::now();
    // Refused after admission: the capability moved on, the status says so.
    let mut owner = sent(now);
    assert_eq!(
        owner.settle(&layout(), Some("next"), NOT_APPLIED, now),
        Settle::Failed
    );
    assert!(matches!(phase(&owner), Phase::Returning { .. }));
    assert!(
        owner.undo.is_none(),
        "no Undo for a swap that didn't settle"
    );
    // An earlier action's refusal, published before this one was admitted.
    let mut owner = sent(now);
    assert_eq!(
        owner.settle(&layout(), Some("spent"), NOT_APPLIED, now),
        Settle::Waiting
    );
    // Nothing back by the deadline.
    let mut owner = sent(now);
    assert_eq!(
        owner.settle(&layout(), None, "", now + SETTLE),
        Settle::Failed
    );
    assert!(owner.undo.is_none());
}

#[test]
fn a_drag_that_ends_without_a_swap_gives_back_the_old_selection() {
    let now = Instant::now();
    let mut owner = pressed(&layout());
    owner.moved(at(300., 10.), pick("b"), &layout());
    owner.gesture.as_mut().unwrap().restore = Some("c".into());
    assert_eq!(owner.take_restore(), None, "not while dragging");
    owner.cancel(now);
    assert_eq!(owner.take_restore(), Some("c".into()));
    assert_eq!(owner.take_restore(), None, "once");
    // A swap that settles keeps the dragged pane selected.
    let mut owner = sent(now);
    owner.gesture.as_mut().unwrap().restore = Some("c".into());
    owner.settle(&swapped_layout(), Some("next"), "", now);
    assert_eq!(owner.take_restore(), None);
}

#[test]
fn undo_swaps_back_only_while_the_layout_is_unchanged() {
    let undo = Undo {
        request: 7,
        a: "a".into(),
        b: "b".into(),
        layout: swapped_layout(),
    };
    assert_eq!(undo.reverse(7, &swapped_layout(), "a"), Some("b".into()));
    assert_eq!(undo.reverse(7, &swapped_layout(), "b"), Some("a".into()));
    assert_eq!(undo.reverse(7, &swapped_layout(), "c"), None);
    assert_eq!(
        undo.reverse(8, &swapped_layout(), "a"),
        None,
        "another session"
    );
    let mut changed = swapped_layout();
    changed[2].height = 8;
    assert_eq!(undo.reverse(7, &changed, "a"), None);
}

#[test]
fn only_the_middle_of_a_card_swaps() {
    let card = Bounds::new(at(0., 0.), size(px(200.), px(100.)));
    assert!(in_centre(card, at(100., 50.)));
    assert!(in_centre(card, at(41., 21.)));
    assert!(!in_centre(card, at(39., 50.)), "left edge");
    assert!(!in_centre(card, at(100., 19.)), "top edge");
    assert!(!in_centre(card, at(170., 50.)), "right edge");
}
