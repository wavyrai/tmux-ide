#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
fn reserve(slots: &Slots) {
    let style = TextStyle::default();
    slots.0.slots.borrow_mut().push(Slot {
        origin: point(px(0.), px(0.)),
        mask: ContentMask::default(),
        font: style.font(),
        font_size: px(13.),
        line_height: px(16.),
        color: style.color,
    });
}
#[gpui::test]
fn the_tick_is_scheduled_only_while_visible_allowed_and_reserved(cx: &mut TestAppContext) {
    let slots = Slots::default();
    let shared = slots.clone();
    let (spinner, cx) = cx.add_window_view(move |window, cx| Spinner::new(shared, window, cx));
    let ticking =
        |cx: &mut VisualTestContext| spinner.read_with(cx, |spinner, _| spinner.ticking());
    let wait = |cx: &mut VisualTestContext, period: Duration| {
        cx.executor().advance_clock(period);
        cx.run_until_parked();
    };
    // Moves the clock to the next pending timer, if there is one.
    let timer_pending = |cx: &mut VisualTestContext| {
        cx.run_until_parked();
        cx.dispatcher.advance_clock_to_next_timer()
    };
    assert!(slots.attached());
    assert!(!timer_pending(cx), "control: an idle spinner has no timer");
    cx.update(|_, cx| slots.sync(true, cx));
    assert!(!ticking(cx), "nothing painted, so nothing to animate");
    reserve(&slots);
    cx.update(|_, cx| slots.sync(false, cx));
    assert!(
        !ticking(cx),
        "motion not allowed (inactive window or open menu)"
    );
    cx.update(|_, cx| slots.sync(true, cx));
    assert!(ticking(cx));
    assert!(timer_pending(cx), "control: a running spinner has a timer");
    cx.run_until_parked();
    assert_eq!(slots.frame(), 1);
    cx.simulate_visibility_change(WindowVisibility::Hidden);
    assert!(!ticking(cx), "an occluded window keeps a tick scheduled");
    assert_eq!(slots.frame(), 0);
    wait(cx, TICK * 10);
    assert_eq!(slots.frame(), 0, "a tick ran while occluded");
    cx.simulate_visibility_change(WindowVisibility::Visible);
    assert!(ticking(cx), "showing the window did not resume the tick");
    wait(cx, TICK);
    assert_eq!(slots.frame(), 1);
    cx.update(|_, cx| slots.sync(false, cx));
    assert!(!ticking(cx));
    wait(cx, TICK * 3);
    assert_eq!(slots.frame(), 0);
}
#[gpui::test]
fn a_new_render_without_working_rows_stops_the_tick(cx: &mut TestAppContext) {
    let slots = Slots::default();
    let shared = slots.clone();
    let (spinner, cx) = cx.add_window_view(move |window, cx| Spinner::new(shared, window, cx));
    reserve(&slots);
    cx.update(|_, cx| slots.sync(true, cx));
    cx.executor().advance_clock(TICK);
    cx.run_until_parked();
    assert_eq!(slots.frame(), 1);
    slots.begin_render();
    cx.executor().advance_clock(TICK);
    cx.run_until_parked();
    assert!(!spinner.read_with(cx, |spinner, _| spinner.ticking()));
    assert_eq!(slots.frame(), 0);
}
