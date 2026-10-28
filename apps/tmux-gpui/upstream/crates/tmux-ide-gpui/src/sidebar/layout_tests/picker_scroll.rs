use super::*;
use gpui::{ScrollDelta, ScrollWheelEvent};

/// A footer picker whose rows fit has nothing to scroll: the wheel over it
/// must leave every row where it was.
#[gpui::test]
fn the_wheel_does_not_move_a_device_picker_that_fits(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:fixture".into(),
                "m4max".into(),
                ConnectTarget::Ssh {
                    target: "m4max".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live.snapshot = view.live.snapshot.clone();
            view.endpoints.push(remote);
        })
    });
    cx.simulate_resize(size(px(1000.), px(900.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let picker = cx.debug_bounds("device-picker").unwrap().center();
    cx.simulate_click(picker, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let first = cx.debug_bounds("device-row-0").unwrap();
    let last = cx.debug_bounds("device-row-3").unwrap();
    assert!(panel.contains(&first.origin) && last.bottom() <= panel.bottom());

    cx.simulate_event(ScrollWheelEvent {
        position: panel.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-40.))),
        ..Default::default()
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert_eq!(cx.debug_bounds("device-row-0").unwrap(), first);
    assert_eq!(cx.debug_bounds("device-row-3").unwrap(), last);
}

/// More devices than fit still scroll, inside the list, and the panel keeps
/// its place above the footer.
#[gpui::test]
fn a_device_picker_that_overflows_scrolls_its_list(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            for index in 0..12 {
                let mut remote = crate::endpoint::Endpoint::new(
                    format!("ssh:fixture{index}"),
                    format!("host{index}"),
                    ConnectTarget::Ssh {
                        target: format!("host{index}"),
                        session: "default".into(),
                    },
                    true,
                );
                remote.live.snapshot = view.live.snapshot.clone();
                view.endpoints.push(remote);
            }
        })
    });
    cx.simulate_resize(size(px(1000.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let picker = cx.debug_bounds("device-picker").unwrap().center();
    cx.simulate_click(picker, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let panel = cx.debug_bounds("menu-panel").unwrap();
    let first = cx.debug_bounds("device-row-0").unwrap();
    cx.simulate_event(ScrollWheelEvent {
        position: panel.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(-40.))),
        ..Default::default()
    });
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("device-row-0").unwrap().top() < first.top());
    assert_eq!(cx.debug_bounds("menu-panel").unwrap(), panel);
}
