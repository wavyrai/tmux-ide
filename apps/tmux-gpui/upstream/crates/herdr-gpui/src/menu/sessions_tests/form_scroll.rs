use super::*;
use gpui::{ScrollDelta, ScrollWheelEvent, point};

/// The session form has no scroller of its own, so in a window too short for
/// it the panel around it must still scroll its buttons into reach.
#[gpui::test]
fn a_session_form_taller_than_the_window_still_scrolls(cx: &mut TestAppContext) {
    let (view, cx) =
        on_the_first_device(cx, Some(reported(&[("default", true), ("agents", false)])));
    view.update(cx, |view, cx| {
        view.endpoints[1].live.status = crate::state::ConnectionStatus::Connected;
        cx.notify();
    });
    draw(cx);
    // The device's two sessions come first, then its Add row.
    click(cx, "sessions-row-2");
    cx.update(|_, cx| {
        assert!(matches!(
            view.read(cx).menu.session_edit,
            Some(super::super::sessions::Edit::Create { .. })
        ));
    });
    cx.simulate_resize(size(px(800.), px(120.)));
    cx.run_until_parked();
    draw(cx);
    let panel = bounds(cx, "menu-panel");
    let submit = bounds(cx, "session-edit-submit");
    assert!(
        submit.bottom() > panel.bottom(),
        "the form overflows the panel"
    );

    cx.simulate_event(ScrollWheelEvent {
        position: panel.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-200.))),
        ..Default::default()
    });
    draw(cx);
    let submit = bounds(cx, "session-edit-submit");
    assert!(
        submit.bottom() <= bounds(cx, "menu-panel").bottom(),
        "scrolling brings the buttons into the panel"
    );
}
