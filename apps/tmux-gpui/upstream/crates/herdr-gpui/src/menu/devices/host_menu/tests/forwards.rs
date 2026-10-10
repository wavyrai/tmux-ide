//! Forwarding a device's ports from its menu.
use super::*;

/// The dialog takes typing, refuses what is not a port, and closes on
/// Escape. A port already forwarded is refused without starting SSH.
#[gpui::test]
fn forwarding_a_port_asks_for_one_and_refuses_bad_or_repeated_ports(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = fixture_window(window, cx);
        add_host(&mut view);
        view.port_forwards
            .fixture("penso@box", 3000, crate::port_forward::State::Starting);
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    view.update_in(cx, |view, window, cx| {
        view.open_host_menu(HOST, point(px(10.), px(10.)), window, cx)
    });
    if cfg!(windows) {
        assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
        return;
    }
    assert_eq!(ACTIONS[2].0, Action::ForwardPort);
    cx.simulate_keystrokes("down down down enter");
    let input = view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(Page::ForwardPort));
        host(view).input.clone().unwrap()
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert!((panel.center().x - px(400.)).abs() <= px(2.));
    assert!(cx.debug_bounds("forward-port-submit").is_some());
    // Row keys are typing here.
    cx.simulate_input("down");
    cx.update(|_, cx| assert_eq!(input.read(cx).text(), "down"));
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(Page::ForwardPort));
        assert_eq!(
            host(view).error.as_deref(),
            Some("Enter a port number from 1 to 65535.")
        );
    });
    cx.update(|_, cx| input.update(cx, |input, cx| input.set_text_selected("3000", cx)));
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert_eq!(
            host(view).error.as_deref(),
            Some("Port 3000 is already forwarded from this host.")
        );
        assert_eq!(view.port_forwards.for_host("penso@box").count(), 1);
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("forward-port-error").is_some());
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
}

/// The menu lists only its own host's forwards, offers Open only once a
/// forward listens, and Stop ends one.
#[gpui::test]
fn the_menu_lists_the_host_forwards_and_stops_one(cx: &mut TestAppContext) {
    use crate::port_forward::State;
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        add_host(&mut view);
        view.port_forwards
            .fixture("penso@box", 3000, State::Listening { local_port: 3000 });
        view.port_forwards.fixture(
            "penso@box",
            80,
            State::Ended("SSH port forward ended".into()),
        );
        view.port_forwards.fixture("other", 5000, State::Starting);
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    view.update_in(cx, |view, window, cx| {
        view.open_host_menu(HOST, point(px(10.), px(10.)), window, cx)
    });
    if cfg!(windows) {
        return;
    }
    let draw = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    };
    draw(cx);
    assert!(cx.debug_bounds("host-forward-3000").is_some());
    assert!(cx.debug_bounds("host-forward-80").is_some());
    assert!(cx.debug_bounds("host-forward-5000").is_none());
    assert!(cx.debug_bounds("host-forward-open-3000").is_some());
    assert!(cx.debug_bounds("host-forward-open-80").is_none());
    assert!(cx.debug_bounds("host-forward-stop-80").is_some());
    // The forwards sit below the actions, and widen the menu to fit.
    assert!(
        cx.debug_bounds("host-menu-3").unwrap().bottom()
            <= cx.debug_bounds("host-forward-3000").unwrap().top()
    );
    assert_eq!(cx.debug_bounds("menu-panel").unwrap().size.width, px(260.));
    let stop = cx.debug_bounds("host-forward-stop-3000").unwrap();
    cx.simulate_click(stop.center(), Modifiers::default());
    view.read_with(cx, |view, _| {
        let ports: Vec<u16> = view
            .port_forwards
            .for_host("penso@box")
            .map(|forward| forward.remote_port().get())
            .collect();
        assert_eq!(ports, [80]);
        assert_eq!(view.menu.page, Some(Page::Host));
    });
    draw(cx);
    assert!(cx.debug_bounds("host-forward-3000").is_none());
}

/// Forwards survive a dropped connection but not their host being
/// disabled or removed.
#[gpui::test]
fn forwards_end_with_their_host(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        add_host(&mut view);
        view.port_forwards
            .fixture("penso@box", 3000, crate::port_forward::State::Starting);
        view
    });
    view.update(cx, |view, cx| {
        view.update_port_forwards(cx);
        assert_eq!(view.port_forwards.for_host("penso@box").count(), 1);
        view.endpoints[1].enabled = false;
        view.update_port_forwards(cx);
        assert_eq!(view.port_forwards.for_host("penso@box").count(), 0);

        view.endpoints[1].enabled = true;
        view.port_forwards
            .fixture("penso@box", 3000, crate::port_forward::State::Starting);
        view.endpoints.truncate(1);
        view.update_port_forwards(cx);
        assert_eq!(view.port_forwards.for_host("penso@box").count(), 0);
    });
}
