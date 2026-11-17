use super::*;

const SCENE: u64 = 7;

fn at(x: u16, y: u16) -> Target {
    Target {
        cell: Some(Cell { x, y }),
        scene: SCENE,
        animate: true,
    }
}

fn ms(start: Instant, ms: u64) -> Instant {
    start + Duration::from_millis(ms)
}

/// A glide settled at (x, y), observed at `start`.
fn settled(x: u16, y: u16, start: Instant) -> CursorGlide {
    let mut glide = CursorGlide::default();
    assert!(!glide.observe(at(x, y), start));
    glide
}

#[test]
fn a_typed_character_moves_the_cursor_on_its_own_frame() {
    let start = Instant::now();
    let mut glide = settled(4, 2, start);
    assert!(glide.observe(at(5, 2), ms(start, 100)));
    let drawn = glide.drawn(Cell { x: 5, y: 2 });
    // Already past half-way on the frame that shows the move, never at the old cell.
    assert!(drawn.x > 4.5 && drawn.x < 5., "{drawn:?}");
    assert_eq!(drawn.y, 2.);
}

#[test]
fn the_glide_eases_out_and_settles_within_its_duration() {
    let start = Instant::now();
    let mut glide = settled(0, 0, start);
    let moved = ms(start, 10);
    assert!(glide.observe(at(10, 0), moved));
    let mut last = glide.drawn(Cell { x: 10, y: 0 }).x;
    let mut steps = Vec::new();
    for frame in 1..=3 {
        assert!(glide.observe(at(10, 0), moved + Duration::from_micros(16_667 * frame)));
        let x = glide.drawn(Cell { x: 10, y: 0 }).x;
        assert!(x > last, "monotonic");
        steps.push(x - last);
        last = x;
    }
    assert!(steps.windows(2).all(|w| w[1] < w[0]), "ease-out: {steps:?}");
    // GLIDE after its head start: settled exactly, and no further frame asked for.
    assert!(!glide.observe(at(10, 0), moved + GLIDE));
    assert_eq!(glide.drawn(Cell { x: 10, y: 0 }), Drawn { x: 10., y: 0. });
}

#[test]
fn a_still_cursor_asks_for_no_frames() {
    let start = Instant::now();
    let mut glide = settled(3, 3, start);
    for frame in 1..100 {
        assert!(!glide.observe(at(3, 3), ms(start, frame * 16)));
    }
    assert_eq!(glide.drawn(Cell { x: 3, y: 3 }), Drawn { x: 3., y: 3. });
}

#[test]
fn a_new_target_mid_glide_starts_from_the_drawn_position() {
    let start = Instant::now();
    let mut glide = settled(0, 0, start);
    glide.observe(at(10, 0), ms(start, 10));
    glide.observe(at(10, 0), ms(start, 20));
    let midway = glide.drawn(Cell { x: 10, y: 0 }).x;
    assert!(midway > 0. && midway < 10.);
    // The next key arrives before the glide ends: no jump back, no jump ahead.
    assert!(glide.observe(at(11, 0), ms(start, 20)));
    let restarted = glide.drawn(Cell { x: 11, y: 0 }).x;
    assert!(
        restarted > midway && restarted < 11.,
        "{midway} -> {restarted}"
    );
}

#[test]
fn newlines_within_two_rows_glide_and_longer_jumps_snap() {
    let start = Instant::now();
    let mut glide = settled(40, 5, start);
    assert!(glide.observe(at(0, 6), ms(start, 10)), "newline glides");
    let mut glide = settled(40, 5, start);
    assert!(glide.observe(at(0, 7), ms(start, 10)), "two rows glide");
    let mut glide = settled(40, 5, start);
    assert!(!glide.observe(at(0, 8), ms(start, 10)), "three rows snap");
    assert_eq!(glide.drawn(Cell { x: 0, y: 8 }), Drawn { x: 0., y: 8. });
    // A screen clear sends the cursor home from the bottom.
    let mut glide = settled(2, 40, start);
    assert!(!glide.observe(at(0, 0), ms(start, 10)));
    assert_eq!(glide.drawn(Cell { x: 0, y: 0 }), Drawn { x: 0., y: 0. });
}

#[test]
fn a_scene_change_snaps_even_for_a_short_move() {
    // Pane switch, focus change, resize, alternate screen and scroll all
    // reach the glide as a new scene.
    let start = Instant::now();
    let mut glide = settled(4, 4, start);
    let moved = Target {
        scene: SCENE + 1,
        ..at(5, 4)
    };
    assert!(!glide.observe(moved, ms(start, 10)));
    assert_eq!(glide.drawn(Cell { x: 5, y: 4 }), Drawn { x: 5., y: 4. });
}

#[test]
fn a_scene_change_mid_glide_snaps_to_the_cell() {
    let start = Instant::now();
    let mut glide = settled(0, 0, start);
    glide.observe(at(8, 0), ms(start, 10));
    let same_cell = Target {
        scene: SCENE + 1,
        ..at(8, 0)
    };
    assert!(!glide.observe(same_cell, ms(start, 20)));
    assert_eq!(glide.drawn(Cell { x: 8, y: 0 }), Drawn { x: 8., y: 0. });
}

#[test]
fn reduce_motion_or_the_setting_off_snaps() {
    let start = Instant::now();
    let mut glide = settled(4, 4, start);
    let still = Target {
        animate: false,
        ..at(5, 4)
    };
    assert!(!glide.observe(still, ms(start, 10)));
    assert_eq!(glide.drawn(Cell { x: 5, y: 4 }), Drawn { x: 5., y: 4. });
    // Turned off mid-glide: the cursor lands at once and frames stop.
    let mut glide = settled(0, 0, start);
    assert!(glide.observe(at(9, 0), ms(start, 10)));
    let off = Target {
        animate: false,
        ..at(9, 0)
    };
    assert!(!glide.observe(off, ms(start, 20)));
    assert_eq!(glide.drawn(Cell { x: 9, y: 0 }), Drawn { x: 9., y: 0. });
}

#[test]
fn a_hidden_cursor_reappears_where_it_is() {
    let start = Instant::now();
    let mut glide = settled(1, 1, start);
    let hidden = Target {
        cell: None,
        ..at(0, 0)
    };
    assert!(!glide.observe(hidden, ms(start, 10)));
    assert!(!glide.observe(at(2, 1), ms(start, 20)));
    assert_eq!(glide.drawn(Cell { x: 2, y: 1 }), Drawn { x: 2., y: 1. });
}

#[test]
fn another_frames_cursor_draws_at_its_own_cell() {
    // A preview painted with the same painter shows a different cursor.
    let start = Instant::now();
    let mut glide = settled(0, 0, start);
    glide.observe(at(6, 0), ms(start, 10));
    assert_eq!(glide.drawn(Cell { x: 3, y: 9 }), Drawn { x: 3., y: 9. });
}
