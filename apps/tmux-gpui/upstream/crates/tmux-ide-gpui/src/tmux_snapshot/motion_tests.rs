#![allow(clippy::unwrap_used)]
use super::*;

fn ms(n: u64) -> Duration {
    Duration::from_millis(n)
}

fn machine<'a>(key: &'a str, collapsed: bool, rows: &[&str]) -> Machine<'a> {
    Machine {
        key,
        collapsed,
        rows: rows.iter().map(|r| (*r).to_owned()).collect(),
    }
}

#[test]
fn the_catalog_timings_are_the_cards() {
    // The card's table names these; a Bezel bump that moves one should be
    // a decision, not a surprise.
    let _speed = bezel_motion::lock_speed();
    assert_eq!(bezel_motion::MENU_IN.total(), ms(140));
    assert_eq!(bezel_motion::DIALOG_IN.total(), ms(180));
    assert_eq!(bezel_motion::FADE_QUICK.total(), ms(150));
    assert_eq!(FADE_IN.total(), ms(500));
    assert_eq!(COLLAPSE.total(), ms(180));
    assert_eq!(CHEVRON.total(), ms(200));
    assert_eq!(SCROLL_GLIDE.total(), ms(500));
}

#[test]
fn progress_runs_over_the_spec_and_snaps_under_reduce_motion() {
    let _speed = bezel_motion::lock_speed();
    assert_eq!(progress(&FADE_IN, ms(0), false), 0.);
    let mid = progress(&FADE_IN, ms(100), false);
    assert!(mid > 0. && mid < 1., "partway at 100 ms: {mid}");
    assert!(progress(&FADE_IN, ms(499), false) < 1.);
    assert_eq!(progress(&FADE_IN, ms(500), false), 1.);
    assert_eq!(progress(&COLLAPSE, ms(180), false), 1.);
    assert_eq!(
        progress(&FADE_IN, ms(0), true),
        1.,
        "reduced: the end state at once"
    );
}

#[test]
fn opening_home_animates_nothing_already_there() {
    let now = Instant::now();
    let mut motion = HomeMotion::default();
    motion.observe(&[machine("m", false, &["a", "b"])], now);
    assert_eq!(motion.entered("a", now, false), 1.);
    assert_eq!(motion.entered("m", now, false), 1.);
    assert!(!motion.settle(now, false), "a fresh visit owes no frames");
}

#[test]
fn a_row_that_arrives_fades_in_once_by_its_id() {
    let now = Instant::now();
    let mut motion = HomeMotion::default();
    motion.observe(&[machine("m", false, &["a"])], now);
    motion.observe(&[machine("m", false, &["a", "b"])], now);
    assert_eq!(motion.entered("b", now, false), 0.);
    assert_eq!(motion.entered("a", now, false), 1.);
    // Republishing the same catalog does not replay it.
    let later = now + ms(100);
    motion.observe(&[machine("m", false, &["a", "b"])], later);
    let t = motion.entered("b", later, false);
    assert!(t > 0. && t < 1.);
    assert!(motion.settle(later, false));
    let done = now + FADE_IN.total();
    assert_eq!(motion.entered("b", done, false), 1.);
    assert!(!motion.settle(done, false), "settled: no more frames");
    motion.observe(&[machine("m", false, &["a", "b"])], done);
    assert_eq!(motion.entered("b", done, false), 1.);
}

#[test]
fn reduce_motion_settles_arrivals_at_once() {
    let now = Instant::now();
    let mut motion = HomeMotion::default();
    motion.observe(&[machine("m", false, &[])], now);
    motion.observe(
        &[machine("m", false, &["b"]), machine("n", false, &["c"])],
        now,
    );
    assert_eq!(motion.entered("b", now, true), 1.);
    assert_eq!(motion.entered("n", now, true), 1.);
    assert!(!motion.settle(now, true));
}

#[test]
fn a_new_machine_enters_as_one_group() {
    let now = Instant::now();
    let mut motion = HomeMotion::default();
    motion.observe(&[machine("m", false, &["a"])], now);
    motion.observe(
        &[machine("m", false, &["a"]), machine("n", false, &["c"])],
        now,
    );
    assert_eq!(motion.entered("n", now, false), 0.);
    assert_eq!(
        motion.entered("c", now, false),
        1.,
        "its rows ride the group"
    );
}

#[test]
fn expanding_turns_the_chevron_and_opens_rows_over_collapse() {
    let now = Instant::now();
    let mut motion = HomeMotion::default();
    motion.observe(&[machine("m", true, &["a"])], now);
    motion.observe(&[machine("m", false, &["a"])], now);
    assert_eq!(motion.chevron("m", now, false), 0.);
    assert_eq!(motion.entered("a", now, false), 0.);
    let collapse = now + COLLAPSE.total();
    assert_eq!(
        motion.entered("a", collapse, false),
        1.,
        "COLLAPSE, not FADE_IN"
    );
    assert!(
        motion.chevron("m", collapse, false) < 1.,
        "CHEVRON is 200 ms"
    );
    let chevron = now + CHEVRON.total();
    assert_eq!(motion.chevron("m", chevron, false), 1.);
    assert!(!motion.settle(chevron, false));
}

#[test]
fn collapsing_snaps_shut_and_only_turns_the_chevron() {
    let now = Instant::now();
    let mut motion = HomeMotion::default();
    motion.observe(&[machine("m", false, &["a"])], now);
    motion.observe(&[machine("m", true, &["a"])], now);
    assert_eq!(motion.chevron("m", now, false), 0.);
    assert_eq!(motion.entered("a", now, false), 1.);
    assert_eq!(motion.chevron("m", now, true), 1., "reduced: no turn");
}

#[test]
fn closing_home_starts_a_new_visit() {
    let now = Instant::now();
    let mut motion = HomeMotion::default();
    motion.observe(&[machine("m", false, &["a"])], now);
    motion.end();
    motion.observe(&[machine("m", false, &["a", "b"])], now);
    assert_eq!(motion.entered("b", now, false), 1.);
}

#[test]
fn enter_leaves_a_settled_element_untouched() {
    let mut settled = enter(div(), 1.);
    assert_eq!(settled.style().opacity, None);
    let mut start = enter(div(), 0.);
    assert_eq!(start.style().opacity, Some(0.));
}

#[test]
fn glide_runs_over_scroll_glide_and_yields_to_the_user() {
    let _speed = bezel_motion::lock_speed();
    let now = Instant::now();
    let mut glide = Glide::new(px(0.), px(-300.), now);
    let (at, more) = glide.step(px(0.), now + ms(250), false).unwrap();
    assert!(at < px(0.) && at > px(-300.) && more);
    let (end, more) = glide.step(at, now + SCROLL_GLIDE.total(), false).unwrap();
    assert_eq!((end, more), (px(-300.), false));
    // The user scrolled between frames: the glide lets go.
    let mut glide = Glide::new(px(0.), px(-300.), now);
    glide.step(px(0.), now + ms(100), false).unwrap();
    assert_eq!(glide.step(px(-40.), now + ms(116), false), None);
    // Reduced: the first step lands.
    let mut glide = Glide::new(px(0.), px(-300.), now);
    assert_eq!(glide.step(px(0.), now, true), Some((px(-300.), false)));
}

#[test]
fn reveal_offset_moves_the_least_distance() {
    let view = (px(100.), px(300.));
    let max = px(1000.);
    // Below the view: align its bottom.
    assert_eq!(
        reveal_offset(view, (px(500.), px(520.)), px(0.), max),
        px(-220.)
    );
    // Above the view: align its top.
    assert_eq!(
        reveal_offset(view, (px(120.), px(140.)), px(-100.), max),
        px(-20.)
    );
    // Visible: stay.
    assert_eq!(
        reveal_offset(view, (px(150.), px(170.)), px(0.), max),
        px(0.)
    );
    // Never past the end of the list.
    assert_eq!(
        reveal_offset(view, (px(1500.), px(1520.)), px(0.), max),
        px(-1000.)
    );
}
