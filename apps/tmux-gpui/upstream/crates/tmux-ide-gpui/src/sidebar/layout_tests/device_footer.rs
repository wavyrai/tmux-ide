use super::*;

#[gpui::test]
fn device_footer_filters_both_lists_and_keeps_settings_visible(cx: &mut gpui::TestAppContext) {
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
                "A very long remote device label that must fit".into(),
                ConnectTarget::Ssh {
                    target: "example.invalid".into(),
                    session: "default".into(),
                },
                true,
            );
            remote.live.snapshot = view.live.snapshot.clone();
            view.endpoints.push(remote);
        })
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("host-ssh:fixture").is_some());
    let all_counts = cx.update(|_, cx| {
        view.read(cx)
            .sidebar_scroll
            .each_ref()
            .map(|scroll| scroll.children_count())
    });
    let footer = cx.debug_bounds("device-footer").unwrap();
    let sidebar = cx.debug_bounds("sidebar").unwrap();
    assert_eq!(footer.bottom(), sidebar.bottom());
    let status = cx.debug_bounds("connection-status").unwrap();
    // A worktree build's banner sits at the window's foot, under both.
    let banner = cx
        .debug_bounds("worktree-banner")
        .map_or(px(0.), |b| b.size.height);
    assert_eq!(sidebar.bottom(), px(600.) - banner);
    assert_eq!(status.bottom(), sidebar.bottom());
    assert_eq!(status.left(), sidebar.right());
    assert_eq!(footer.size.height, px(40.));
    assert!(cx.debug_bounds("agents-scroll").unwrap().bottom() <= footer.top());

    let picker_bounds = cx.debug_bounds("device-picker").unwrap();
    let picker = picker_bounds.center();
    for position in [
        picker_bounds.origin + point(px(2.), px(2.)),
        point(
            picker_bounds.right() - px(2.),
            picker_bounds.bottom() - px(2.),
        ),
    ] {
        cx.simulate_click(position, Modifiers::default());
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let menu = cx.debug_bounds("menu-panel").unwrap();
        assert_eq!(menu.size.width, px(280.));
        assert_eq!(menu.left(), picker_bounds.left());
        assert_eq!(picker_bounds.top() - menu.bottom(), px(12.));
        // The current scope is highlighted, not checked.
        assert!(cx.debug_bounds("device-current-0").is_some());
        assert!(cx.debug_bounds("device-current-1").is_none());
        let row = cx.debug_bounds("device-row-1").unwrap();
        let dot = cx.debug_bounds("device-dot-1").unwrap();
        assert!((row.center().y - dot.center().y).abs() <= px(0.5));
        cx.simulate_keystrokes("escape");
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
    }
    cx.simulate_click(picker, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("menu-panel").unwrap().bottom() <= footer.bottom());
    // All Devices -> Local. An explicit-socket fixture must not touch the catalog.
    cx.simulate_keystrokes("down enter");
    cx.update(|window, cx| {
        assert_eq!(view.read(cx).device_filter.as_deref(), Some("local"));
        assert!(!view.read(cx).device_visible("ssh:fixture"));
        assert!(view.read(cx).focus.is_focused(window));
        full_draw(window, cx).clear(cx);
    });
    cx.update(|_, cx| {
        let local_counts = view
            .read(cx)
            .sidebar_scroll
            .each_ref()
            .map(|scroll| scroll.children_count());
        assert_eq!(local_counts.map(|count| count * 2), all_counts);
    });
    cx.simulate_click(picker, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    cx.simulate_keystrokes("enter");
    cx.update(|window, cx| {
        assert!(view.read(cx).device_filter.is_none());
        assert_eq!(view.read(cx).selected_endpoint, 0);
        full_draw(window, cx).clear(cx);
    });
    assert!(cx.debug_bounds("host-ssh:fixture").is_some());
    assert!(cx.debug_bounds("device-settings").is_some());
    // Command routing belongs to settings_window tests; this fixture keeps
    // testing the legacy modal without starting the personal config loader.
    cx.update(|window, cx| {
        view.update(cx, |view, cx| view.open_preferences_fixture(window, cx));
    });
    cx.update(|_, cx| {
        assert_eq!(
            view.read(cx).menu.page,
            Some(crate::menu::Page::Preferences)
        )
    });
    cx.simulate_keystrokes("escape");
    // A narrow sidebar retains both controls without spilling into the terminal.
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.sidebar_width = Some(140.));
        full_draw(window, cx).clear(cx);
    });
    let footer = cx.debug_bounds("device-footer").unwrap();
    assert!(cx.debug_bounds("device-settings").unwrap().right() <= footer.right());
    assert!(
        cx.debug_bounds("device-picker").unwrap().right()
            < cx.debug_bounds("device-settings").unwrap().left()
    );
}

#[gpui::test]
fn add_device_form_keeps_input_local_and_validates_before_launch(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let view = cx.new(|cx| fixture_window(window, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    let picker = cx.debug_bounds("device-picker").unwrap().center();
    cx.simulate_click(picker, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    cx.simulate_keystrokes("down down enter");
    cx.update(|_, cx| assert_eq!(view.read(cx).menu.page, Some(crate::menu::Page::Devices)));
    cx.simulate_keystrokes("escape");
    if cfg!(windows) {
        return;
    }
    // Enable the form without enabling the fixture's isolated catalog worker.
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.endpoints[0].connection.target = ConnectTarget::Local
        });
        full_draw(window, cx).clear(cx);
    });
    cx.simulate_click(picker, Modifiers::default());
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
    cx.simulate_keystrokes("down down enter");
    cx.update(|window, cx| {
        assert_eq!(view.read(cx).menu.page, Some(crate::menu::Page::AddDevice));
        full_draw(window, cx).clear(cx);
    });
    for (width, height) in [(320., 300.), (800., 600.)] {
        cx.simulate_resize(size(px(width), px(height)));
        cx.update(|window, cx| full_draw(window, cx).clear(cx));
        let panel = cx.debug_bounds("menu-panel").unwrap();
        let header = cx.debug_bounds("device-setup-header").unwrap();
        let close = cx.debug_bounds("device-setup-close").unwrap();
        let body = cx.debug_bounds("device-setup-body").unwrap();
        let footer = cx.debug_bounds("device-setup-footer").unwrap();
        let submit = cx.debug_bounds("device-setup-submit").unwrap();
        assert!(close.top() >= header.top() && close.bottom() <= header.bottom());
        assert!(close.center().x > panel.center().x);
        assert!((body.top() - header.bottom()).abs() <= px(1.));
        assert!((body.bottom() - footer.top()).abs() <= px(1.));
        assert!(submit.top() >= footer.top() && submit.bottom() <= footer.bottom());
        assert!(footer.bottom() <= panel.bottom());
        assert!(panel.bottom() <= px(height));
    }
    cx.simulate_input("-invalid-host");
    cx.simulate_keystrokes("tab");
    cx.simulate_input("Test device");
    cx.simulate_keystrokes("tab enter");
    cx.update(|_, cx| assert_eq!(view.read(cx).menu.page, Some(crate::menu::Page::AddDevice)));
    // Native shortcuts cannot escape a device form into the underlying terminal.
    cx.simulate_keystrokes("cmd-b");
    cx.update(|_, cx| assert!(view.read(cx).sidebar_visible));
    cx.simulate_keystrokes("escape");
    cx.update(|window, cx| {
        assert!(view.read(cx).menu.page.is_none());
        assert!(view.read(cx).focus.is_focused(window));
    });
}
