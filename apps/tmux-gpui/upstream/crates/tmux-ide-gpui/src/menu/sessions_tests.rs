//! The sessions popup: the footer control that opens it, the state every row
//! carries, and where choosing a row takes this window.

#![allow(clippy::unwrap_used)]

use crate::{
    endpoint::LOCAL,
    menu::Page,
    sidebar::layout_tests::{fixture_window, full_draw},
};
use gpui::{Bounds, Entity, Modifiers, Pixels, TestAppContext, VisualTestContext, px, size};
use herdr_client::{ConnectTarget, LocalSession, SessionState};

// Adding a session needs SSH, which Windows does not offer.
#[cfg(not(windows))]
mod form_scroll;

/// A session as discovery reports it. The socket comes from the same path rules
/// the window resolves, so no test hard-codes a home directory.
fn session(name: &str, state: SessionState) -> LocalSession {
    LocalSession {
        name: name.into(),
        state,
        socket: development(name).socket_path().unwrap(),
    }
}

/// A development target. The fixture stays attach-only this way: a release
/// session target would let a test start a real daemon.
fn development(name: &str) -> ConnectTarget {
    ConnectTarget::Session {
        name: name.into(),
        development: true,
    }
}

/// A saved device, as the catalog creates its endpoint.
fn remote(id: &str, label: &str, target: &str, session: &str) -> crate::endpoint::Endpoint {
    crate::endpoint::Endpoint::new(
        id.into(),
        label.into(),
        ConnectTarget::Ssh {
            target: target.into(),
            session: session.into(),
        },
        true,
    )
}

fn bounds(cx: &mut VisualTestContext, selector: &'static str) -> Bounds<Pixels> {
    cx.debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} was not painted"))
}

fn draw(cx: &mut VisualTestContext) {
    cx.update(|window, cx| full_draw(window, cx).clear(cx));
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let point = bounds(cx, selector).center();
    cx.simulate_click(point, Modifiers::default());
}

/// A window attached to `current`, holding `entries`, with its list open.
fn open_list(
    cx: &mut TestAppContext,
    entries: Vec<LocalSession>,
    current: ConnectTarget,
) -> (Entity<crate::HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = fixture_window(window, cx);
        view.endpoints[0].connection.target = current;
        view.sessions.entries = entries;
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    click(cx, "device-sessions");
    draw(cx);
    (view, cx)
}

#[gpui::test]
fn the_footer_icon_opens_the_list_between_the_picker_and_the_settings(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    let footer = bounds(cx, "device-footer");
    let picker = bounds(cx, "device-picker");
    let control = bounds(cx, "device-sessions");
    let settings = bounds(cx, "device-settings");
    assert!(
        picker.right() < control.left(),
        "the picker keeps the left side"
    );
    assert!(
        control.right() <= settings.left(),
        "settings stays the rightmost control"
    );
    assert!(control.left() >= footer.left() && control.right() <= footer.right());
    assert_eq!(control.size, size(px(28.), px(28.)));

    // A narrow sidebar still fits all three controls.
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.sidebar_width = Some(140.));
        full_draw(window, cx).clear(cx);
    });
    let footer = bounds(cx, "device-footer");
    for selector in ["device-picker", "device-sessions", "device-settings"] {
        let control = bounds(cx, selector);
        assert!(control.left() >= footer.left(), "{selector}");
        assert!(control.right() <= footer.right(), "{selector}");
    }

    // The icon opens the session list, anchored above the control that asked.
    cx.update(|window, cx| {
        view.update(cx, |view, _| view.sidebar_width = None);
        full_draw(window, cx).clear(cx);
    });
    click(cx, "device-sessions");
    draw(cx);
    let panel = bounds(cx, "menu-panel");
    let footer = bounds(cx, "device-footer");
    assert!(panel.bottom() <= footer.top(), "the list opens above it");
    assert_eq!(panel.size.width, px(280.));
    assert!(
        panel.right() <= px(800.),
        "the list stays inside the window"
    );
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, Some(Page::Sessions));
        assert_eq!(view.menu.selected, Some(0));
    });
    assert!(cx.debug_bounds("sessions-list").is_some());
}

#[gpui::test]
fn the_configured_shortcut_opens_the_list_where_the_button_sits(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        fixture_window(window, cx)
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    // A keystroke reaches a binding through the focused element, as it does in
    // the running app, where the terminal holds focus from the first frame.
    cx.update(|window, cx| view.read(cx).focus.clone().focus(window, cx));
    draw(cx);
    cx.simulate_keystrokes("cmd-shift-s");
    draw(cx);
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, Some(Page::Sessions));
        assert_eq!(view.menu.selected, Some(0));
    });
    // The shortcut anchors where the footer button painted, not at the corner a
    // window that had never drawn it would leave the cell at.
    let panel = bounds(cx, "menu-panel");
    let footer = bounds(cx, "device-footer");
    assert!(
        panel.bottom() <= footer.top(),
        "the list opens above the footer it belongs to"
    );
    assert_eq!(panel.size.width, px(280.));
    assert!(cx.debug_bounds("sessions-list").is_some());
}

/// One device's sessions as its own host reported them.
fn reported(sessions: &[(&str, bool)]) -> crate::sessions::DeviceScan {
    crate::sessions::DeviceScan::Sessions(
        sessions
            .iter()
            .map(|(name, running)| herdr_client::RemoteSession {
                name: (*name).into(),
                running: *running,
            })
            .collect(),
    )
}

/// A window attached to the first saved device, with a second one below it, and
/// its list open. `answer` is what that first device's probe came back with.
fn on_the_first_device(
    cx: &mut TestAppContext,
    answer: Option<crate::sessions::DeviceScan>,
) -> (Entity<crate::HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = fixture_window(window, cx);
        view.endpoints[0].connection.target = development("default");
        view.sessions.entries = vec![
            session("default", SessionState::Running),
            session("work", SessionState::Stopped),
        ];
        view.endpoints
            .push(remote("ssh:build", "Build", "build.invalid", "default"));
        view.endpoints
            .push(remote("ssh:prod", "Prod", "prod.invalid", "main"));
        if let Some(answer) = answer {
            view.sessions
                .devices
                .answers
                .insert("ssh:build".into(), answer);
        }
        // The window is attached to the first saved device.
        view.selected_endpoint = 1;
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    click(cx, "device-sessions");
    draw(cx);
    (view, cx)
}

#[gpui::test]
fn the_device_this_window_is_on_leads_with_all_of_its_sessions(cx: &mut TestAppContext) {
    let (_view, cx) =
        on_the_first_device(cx, Some(reported(&[("default", true), ("agents", false)])));
    let current = bounds(cx, "sessions-current-device");
    let local = bounds(cx, "sessions-local-header");
    let others = bounds(cx, "sessions-others-header");
    assert!(current.top() < local.top(), "the device it is on leads");
    assert!(local.top() < others.top(), "the devices left over follow");
    // Every session that host reported, above this machine's own.
    let first = bounds(cx, "sessions-row-0");
    let second = bounds(cx, "sessions-row-1");
    assert!(current.top() < first.top() && second.top() < local.top());
    // The session this window is on is marked, and the host's other one is not.
    assert!(cx.debug_bounds("sessions-current-0").is_some());
    assert!(cx.debug_bounds("sessions-dot-1").is_some());
    assert!(cx.debug_bounds("sessions-current-1").is_none());
    // Five session rows and one Add row per section.
    assert!(cx.debug_bounds("sessions-row-7").is_some());
    assert!(cx.debug_bounds("sessions-row-8").is_none());
    assert!(cx.debug_bounds("sessions-device-note-ssh:prod").is_some());
}

#[gpui::test]
fn choosing_another_session_of_the_device_it_is_on_retargets_that_device(cx: &mut TestAppContext) {
    let (view, cx) =
        on_the_first_device(cx, Some(reported(&[("default", true), ("agents", false)])));
    click(cx, "sessions-row-1");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, None, "choosing closes the list");
        assert_eq!(view.selected_endpoint, 1, "it stays on the same device");
        assert_eq!(view.device_filter.as_deref(), Some("ssh:build"));
        assert_eq!(
            view.endpoints[1].connection.target,
            ConnectTarget::Ssh {
                target: "build.invalid".into(),
                session: "agents".into(),
            }
        );
    });
}

#[gpui::test]
fn a_device_whose_list_could_not_be_read_still_offers_its_saved_session(cx: &mut TestAppContext) {
    let (view, cx) = on_the_first_device(
        cx,
        Some(crate::sessions::DeviceScan::Failed(
            "ssh timed out".to_owned(),
        )),
    );
    // The host stays selectable while its own list is unreadable, and the row
    // says what it was saved to attach to.
    assert!(cx.debug_bounds("sessions-device-note-ssh:build").is_some());
    click(cx, "sessions-row-0");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.selected_endpoint, 1);
        assert_eq!(
            view.endpoints[1].connection.target,
            ConnectTarget::Ssh {
                target: "build.invalid".into(),
                session: "default".into(),
            }
        );
    });
}

#[gpui::test]
fn a_disabled_device_says_so_instead_of_waiting_for_an_answer(cx: &mut TestAppContext) {
    let (_view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.endpoints.push(crate::endpoint::Endpoint::new(
            "ssh:off".into(),
            "Off".into(),
            ConnectTarget::Ssh {
                target: "off.invalid".into(),
                session: "default".into(),
            },
            false,
        ));
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    click(cx, "device-sessions");
    draw(cx);
    // Its saved session is still offered, and the row says why nothing more came.
    assert!(cx.debug_bounds("sessions-row-0").is_some());
    assert!(cx.debug_bounds("sessions-device-note-ssh:off").is_some());
}

#[gpui::test]
fn clicking_a_disabled_device_does_not_filter_the_list_to_it(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.sessions.entries = Vec::new();
        view.endpoints.push(crate::endpoint::Endpoint::new(
            "ssh:off".into(),
            "Off".into(),
            ConnectTarget::Ssh {
                target: "off.invalid".into(),
                session: "default".into(),
            },
            false,
        ));
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    click(cx, "device-sessions");
    draw(cx);
    // The row is there, and choosing it does nothing: the picker refuses the same
    // click, and filtering the sidebar to a device it cannot dial empties it.
    click(cx, "sessions-row-0");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, Some(Page::Sessions), "the menu stays open");
        assert_eq!(view.selected_endpoint, 0, "nothing was attached");
        assert_ne!(view.device_filter.as_deref(), Some("ssh:off"));
    });
}

#[gpui::test]
fn a_disabled_device_is_never_asked_for_its_sessions(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        view.endpoints
            .push(remote("ssh:build", "Build", "build.invalid", "default"));
        view.endpoints.push(crate::endpoint::Endpoint::new(
            "ssh:off".into(),
            "Off".into(),
            ConnectTarget::Ssh {
                target: "off.invalid".into(),
                session: "default".into(),
            },
            false,
        ));
        view
    });
    let targets = cx.update(|_, cx| view.read(cx).probe_targets());
    assert_eq!(
        targets,
        [(
            "ssh:build".to_owned(),
            herdr_client::RemoteHost::Ssh("build.invalid".to_owned())
        )],
        "a device the user disabled is never dialled"
    );
}

#[gpui::test]
fn a_window_on_this_machine_leads_with_its_own_sessions(cx: &mut TestAppContext) {
    let (_view, cx) = open_list(
        cx,
        vec![session("default", SessionState::Running)],
        development("default"),
    );
    let local = bounds(cx, "sessions-local-header");
    let devices = bounds(cx, "sessions-others-header");
    assert!(local.top() < devices.top());
    // Nothing marks a device as current while the window is on this machine.
    assert!(cx.debug_bounds("sessions-current-device").is_none());
    assert!(cx.debug_bounds("sessions-current-0").is_some());
}

#[gpui::test]
fn local_rows_paint_a_dot_and_mark_the_current_session(cx: &mut TestAppContext) {
    // GPUI reports a selector once it has painted in this window, even after the
    // element is gone, so each case below renders in its own window: an absence
    // assertion is only meaningful for something this window never painted.
    let (_view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("work", SessionState::Stopped),
        ],
        development("default"),
    );
    for selector in [
        "sessions-row-0",
        "sessions-row-1",
        "sessions-dot-0",
        "sessions-dot-1",
    ] {
        assert!(cx.debug_bounds(selector).is_some(), "{selector} is missing");
    }
    // Scan order puts `default` first, and it is the session this window dials.
    assert!(cx.debug_bounds("sessions-current-0").is_some());
    assert!(cx.debug_bounds("sessions-current-1").is_none());
    assert!(cx.debug_bounds("sessions-check-0").is_none());
    assert!(
        cx.debug_bounds("sessions-dot-2").is_none(),
        "Add has no status dot"
    );
    assert_eq!(
        bounds(cx, "sessions-dot-0").left(),
        bounds(cx, "sessions-dot-1").left()
    );
    assert_eq!(
        bounds(cx, "sessions-delete-0").left(),
        bounds(cx, "sessions-delete-1").left()
    );
    assert_eq!(bounds(cx, "sessions-delete-0").size, size(px(24.), px(24.)));
    assert_eq!(
        bounds(cx, "sessions-delete-icon-0").size,
        size(px(14.), px(14.))
    );
    // Add ends in a plus, lined up with the trash icons above it.
    assert_eq!(
        bounds(cx, "sessions-add-icon-2").center().x,
        bounds(cx, "sessions-delete-icon-0").center().x
    );
    // A stopped session says what selecting it does, and the fixture has no
    // saved devices to list.
    assert!(cx.debug_bounds("sessions-stopped").is_some());
    assert!(cx.debug_bounds("sessions-no-devices").is_some());
}

#[gpui::test]
fn the_mark_follows_the_session_this_window_dials(cx: &mut TestAppContext) {
    let (_view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("work", SessionState::Stopped),
        ],
        development("work"),
    );
    assert!(cx.debug_bounds("sessions-current-1").is_some());
    assert!(cx.debug_bounds("sessions-current-0").is_none());
}

#[gpui::test]
fn a_machine_where_every_session_runs_has_no_stopped_note(cx: &mut TestAppContext) {
    let (_view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("work", SessionState::Running),
        ],
        development("default"),
    );
    assert!(cx.debug_bounds("sessions-stopped").is_none());
}

#[gpui::test]
fn choosing_a_local_session_retargets_the_local_endpoint(cx: &mut TestAppContext) {
    let (view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("work", SessionState::Stopped),
        ],
        development("default"),
    );
    click(cx, "sessions-row-1");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, None, "choosing closes the list");
        assert_eq!(
            view.selected_endpoint, 0,
            "the local endpoint stays current"
        );
        assert_eq!(view.device_filter.as_deref(), Some(LOCAL));
        assert_eq!(view.endpoints[0].connection.target, development("work"));
    });
}

#[gpui::test]
fn choosing_a_local_session_leaves_a_remote_endpoint(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = fixture_window(window, cx);
        view.endpoints[0].connection.target = development("default");
        view.sessions.entries = vec![
            session("default", SessionState::Running),
            session("work", SessionState::Stopped),
        ];
        view.endpoints.push(crate::endpoint::Endpoint::new(
            "ssh:fixture".into(),
            "Build".into(),
            ConnectTarget::Ssh {
                target: "example.invalid".into(),
                session: "default".into(),
            },
            true,
        ));
        // The list opens while the window is on the saved device.
        view.selected_endpoint = 1;
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    click(cx, "device-sessions");
    draw(cx);
    // The device's session and Add row precede the two local sessions and Add.
    assert!(cx.debug_bounds("sessions-row-4").is_some());
    assert!(cx.debug_bounds("sessions-row-5").is_none());
    click(cx, "sessions-row-3");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, None, "choosing closes the list");
        assert_eq!(view.selected_endpoint, 0, "the local endpoint takes over");
        assert_eq!(view.device_filter.as_deref(), Some(LOCAL));
        assert_eq!(view.endpoints[0].connection.target, development("work"));
    });
}

#[gpui::test]
fn choosing_the_session_this_window_already_dials_does_not_reattach(cx: &mut TestAppContext) {
    let (view, cx) = open_list(
        cx,
        vec![session("default", SessionState::Running)],
        development("default"),
    );
    // Retiring a transport bumps this, so an unchanged generation means the
    // window never left the session the list was showing as current.
    let generation = cx.update(|_, cx| view.read(cx).endpoints[0].generation);
    click(cx, "sessions-row-0");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, None, "choosing still closes the list");
        assert_eq!(view.endpoints[0].generation, generation);
        assert_eq!(view.endpoints[0].connection.target, development("default"));
    });
}

#[gpui::test]
fn keys_walk_the_rows_and_enter_chooses(cx: &mut TestAppContext) {
    let (view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("work", SessionState::Stopped),
        ],
        development("default"),
    );
    cx.simulate_keystrokes("down enter");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, None);
        assert_eq!(view.endpoints[0].connection.target, development("work"));
    });
}

#[gpui::test]
fn deleted_row_selection_does_not_transfer_to_add_session(cx: &mut TestAppContext) {
    let (view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("old", SessionState::Stopped),
        ],
        development("default"),
    );
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            assert_eq!(view.menu.selected, Some(1));
            // A failed deletion has no departing row and keeps the selection.
            view.finish_session_departure();
            assert_eq!(view.menu.selected, Some(1));
            view.sessions.departure = Some(crate::sessions::Departure::new(
                development("old"),
                std::time::Instant::now(),
            ));
            view.finish_session_departure();
            assert_eq!(view.menu.selected, None);
        })
    });
    draw(cx);
    // Add now occupies ordinal 1, but neither its highlight nor its action may
    // inherit the deleted session's keyboard selection.
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.menu.page, Some(Page::Sessions));
        assert!(view.menu.session_edit.is_none());
        assert_eq!(view.menu.selected, None);
    });
    cx.simulate_keystrokes("down");
    cx.update(|_, cx| assert_eq!(view.read(cx).menu.selected, Some(0)));
    cx.simulate_keystrokes("up");
    cx.update(|_, cx| assert_eq!(view.read(cx).menu.selected, Some(1)));
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.menu.page = Some(Page::Devices);
            view.sessions.departure = Some(crate::sessions::Departure::new(
                development("old"),
                std::time::Instant::now(),
            ));
            view.finish_session_departure();
            assert_eq!(
                view.menu.selected,
                Some(1),
                "completion must not change another menu's selection"
            );
        })
    });
}

#[gpui::test]
fn clicking_delete_never_selects_or_starts_the_session(cx: &mut TestAppContext) {
    let (view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("old", SessionState::Stopped),
        ],
        development("default"),
    );
    click(cx, "sessions-delete-1");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.endpoints[0].connection.target, development("default"));
        assert_eq!(view.menu.page, Some(Page::Sessions));
        assert!(
            view.sessions.mutation_error.is_some(),
            "development management is refused"
        );
    });
}

#[gpui::test]
fn deletion_keeps_picker_geometry_stable_until_the_fade_finishes(cx: &mut TestAppContext) {
    let (view, cx) = open_list(
        cx,
        vec![
            session("default", SessionState::Running),
            session("old", SessionState::Stopped),
        ],
        development("default"),
    );
    let original = bounds(cx, "sessions-row-1").size.height;
    let panel = bounds(cx, "menu-panel");
    let kept = bounds(cx, "sessions-row-0");
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.sessions.mutation_target = Some(development("old"));
        })
    });
    draw(cx);
    assert_eq!(
        bounds(cx, "menu-panel"),
        panel,
        "progress must not insert a header or resize the picker"
    );
    cx.update(|_, cx| {
        view.update(cx, |view, _| {
            view.sessions.departure = Some(crate::sessions::Departure::new(
                development("old"),
                std::time::Instant::now() - crate::sessions::DELETION_ANIMATION / 2,
            ));
        })
    });
    draw(cx);
    let fading = bounds(cx, "sessions-departing-1");
    assert_eq!(fading.size.height, original);
    assert_eq!(bounds(cx, "menu-panel"), panel);
    assert_eq!(bounds(cx, "sessions-row-0"), kept);
    assert!(cx.debug_bounds("sessions-departing-0").is_none());
    cx.update(|_, cx| view.update(cx, |view, _| view.sessions.finish_departure()));
    draw(cx);
    assert!(cx.debug_bounds("sessions-departing-1").is_none());
    cx.update(|_, cx| assert_eq!(view.read(cx).sessions.entries.len(), 1));
}

#[gpui::test]
fn choosing_a_remote_row_selects_that_device(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(move |window, cx| {
        let mut view = fixture_window(window, cx);
        view.endpoints[0].connection.target = development("default");
        view.sessions.entries = vec![session("default", SessionState::Running)];
        view.endpoints.push(crate::endpoint::Endpoint::new(
            "ssh:fixture".into(),
            "Build".into(),
            ConnectTarget::Ssh {
                target: "example.invalid".into(),
                session: "default".into(),
            },
            true,
        ));
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    draw(cx);
    click(cx, "device-sessions");
    draw(cx);
    // The local session and Add row precede the saved device.
    assert!(cx.debug_bounds("sessions-row-2").is_some());
    assert!(cx.debug_bounds("sessions-dot-2").is_some());
    assert!(cx.debug_bounds("sessions-current-2").is_none());
    click(cx, "sessions-row-2");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(view.selected_endpoint, 1, "the device became current");
        assert_eq!(view.device_filter.as_deref(), Some("ssh:fixture"));
        assert_eq!(view.menu.page, None);
    });
}

#[gpui::test]
fn a_device_offers_add_session_only_while_it_is_online(cx: &mut TestAppContext) {
    let (view, cx) =
        on_the_first_device(cx, Some(reported(&[("default", true), ("agents", false)])));
    // The device's two sessions come first, then its Add row.
    click(cx, "sessions-row-2");
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert!(
            view.menu.session_edit.is_none(),
            "an offline host adds nothing"
        );
        assert!(view.menu.page.is_some(), "the list stays open");
    });
    view.update(cx, |view, cx| {
        view.endpoints[1].live.status = crate::state::ConnectionStatus::Connected;
        cx.notify();
    });
    draw(cx);
    click(cx, "sessions-row-2");
    cx.update(|_, cx| {
        // Windows has no SSH route, so even an online device adds nothing there.
        assert_eq!(
            matches!(
                view.read(cx).menu.session_edit,
                Some(super::sessions::Edit::Create { .. })
            ),
            !cfg!(windows)
        );
    });
}
