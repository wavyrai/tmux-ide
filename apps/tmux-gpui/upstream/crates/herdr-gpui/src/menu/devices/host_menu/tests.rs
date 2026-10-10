use super::{ACTIONS, Action, HostMenu};
use crate::{config::KeybindingSource, menu::Page, sidebar::layout_tests::fixture_window};
use gpui::{Modifiers, MouseButton, TestAppContext, VisualTestContext, point, px, size};

mod forwards;
mod menu_width;

// Endpoint IDs carry the `ssh:` prefix; the profile ID is the rest.
const HOST: &str = "ssh:0123456789abcdef0123456789abcdef";
const HOST_HEADER: &str = "host-ssh:0123456789abcdef0123456789abcdef";
const LOCAL_HEADER: &str = "host-local";

fn add_host(view: &mut crate::HerdrWindow) {
    view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
    // Fold Local's many fixture workspaces so the new host's header is on screen.
    view.endpoints[0].collapsed = true;
    view.endpoints.push(crate::endpoint::Endpoint::new(
        HOST.into(),
        "m5max-ms".into(),
        herdr_client::ConnectTarget::Ssh {
            target: "penso@box".into(),
            session: "default".into(),
        },
        true,
    ));
}

fn host(view: &crate::HerdrWindow) -> &HostMenu {
    view.menu.host.as_ref().unwrap()
}

#[gpui::test]
fn right_clicking_a_saved_host_offers_removal_but_local_has_no_menu(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = fixture_window(window, cx);
        add_host(&mut view);
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    let local = cx.debug_bounds(LOCAL_HEADER).unwrap();
    cx.simulate_mouse_down(local.center(), MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(local.center(), MouseButton::Right, Modifiers::default());
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));

    let remote = cx.debug_bounds(HOST_HEADER).unwrap();
    cx.simulate_mouse_down(remote.center(), MouseButton::Right, Modifiers::default());
    cx.simulate_mouse_up(remote.center(), MouseButton::Right, Modifiers::default());
    // Saved SSH devices are unavailable on Windows, so there is nothing to remove.
    if cfg!(windows) {
        assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
        return;
    }
    view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(Page::Host));
        assert_eq!(host(view).target, "penso@box");
        // `herdr machine remove` takes the bare catalog ID.
        assert_eq!(host(view).profile, "0123456789abcdef0123456789abcdef");
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    let header = cx.debug_bounds("host-menu-header").unwrap();
    assert!(header.bottom() <= cx.debug_bounds("host-menu-0").unwrap().top());
    // Rename comes first; Remove is last, in the danger color.
    cx.simulate_keystrokes("up enter");
    assert!(view.read_with(cx, |view, _| view.menu.page == Some(Page::RemoveDevice)));
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    assert!(cx.debug_bounds("remove-device").is_some());
    // Without a GitHub sign-in of its own, there is nothing else to delete.
    assert!(cx.debug_bounds("remove-device-github").is_none());
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
}

/// The opt-in reads the device's saved choice, and a device on local keys
/// despite opting in says why. Activating the row saves the GUI config, so
/// this only checks what the menu shows.
#[gpui::test]
fn the_menu_shows_the_server_keybindings_choice(cx: &mut TestAppContext) {
    if cfg!(windows) {
        return;
    }
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = fixture_window(window, cx);
        add_host(&mut view);
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    view.update_in(cx, |view, window, cx| {
        view.open_host_menu(HOST, point(px(20.), px(20.)), window, cx)
    });
    let row = |cx: &mut VisualTestContext| {
        cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
        (
            cx.debug_bounds("host-menu-1").is_some(),
            cx.debug_bounds("host-menu-keybindings-error").is_some(),
        )
    };
    assert_eq!(row(cx), (true, false));
    assert_eq!(ACTIONS[1].0, Action::ServerKeybindings);
    view.update(cx, |view, cx| {
        view.config.devices.insert(
            "0123456789abcdef0123456789abcdef".into(),
            crate::config::DeviceSettings {
                keybindings: KeybindingSource::Server,
            },
        );
        view.selected_endpoint = 1;
        let mut snapshot = crate::sidebar::layout_tests::snapshot(2);
        snapshot.server_keybindings_toml = None;
        view.live.snapshot = Some(std::sync::Arc::new(snapshot));
        view.sync_server_keymap(cx);
    });
    assert_eq!(row(cx), (true, true));
}

/// The menu speaks for the saved device: after the sessions list attached it
/// to another session, it still names, and removal still claims, the session
/// the device was saved with.
#[gpui::test]
fn the_menu_names_the_saved_session_after_a_session_pick(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update_in(cx, |view, window, cx| {
        view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
        view.reconcile_catalog(
            vec![herdr_client::SavedHost {
                id: "0123456789abcdef0123456789abcdef".into(),
                label: "m5max-ms".into(),
                target: "penso@box".into(),
                session: "default".into(),
                enabled: true,
            }],
            Vec::new(),
            cx,
        );
        // What choosing another session from the list does to the target.
        view.endpoints[1].connection.target = herdr_client::ConnectTarget::Ssh {
            target: "penso@box".into(),
            session: "work".into(),
        };
        view.open_host_menu(HOST, point(px(0.), px(0.)), window, cx);
        // Saved SSH devices are unavailable on Windows, so there is no menu.
        if cfg!(windows) {
            assert!(view.menu.host.is_none());
            return;
        }
        assert_eq!(host(view).target, "penso@box");
        assert_eq!(host(view).session, "default");
    });
}

#[gpui::test]
fn removal_offers_the_github_sign_in_and_reports_each_outcome(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            add_host(view);
            view.menu
                .github_hosts
                .insert(HOST.into(), crate::github::Auth::connected_fixture());
            view.open_host_menu(HOST, point(px(10.), px(10.)), window, cx);
            if !cfg!(windows) {
                view.activate_host_menu(Action::Remove, window, cx);
            }
        });
        crate::sidebar::layout_tests::full_draw(window, cx).clear(cx);
    });
    if cfg!(windows) {
        assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
        return;
    }
    assert!(cx.debug_bounds("remove-device-github").is_some());
    cx.simulate_keystrokes("space");
    assert!(view.read_with(cx, |view, _| !host(view).forget_github));
    cx.simulate_keystrokes("space");
}

#[gpui::test]
fn a_removal_pulses_the_host_header_until_the_device_leaves(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            add_host(view);
            view.menu
                .github_hosts
                .insert(HOST.into(), crate::github::Auth::connected_fixture());
            // As confirming does: the dialog is gone, the device marked.
            view.menu.removing_devices.insert(HOST.into());
            cx.notify();
        });
        crate::sidebar::layout_tests::full_draw(window, cx).clear(cx);
    });
    let dot = cx.debug_bounds("host-removing").unwrap();
    assert!(
        cx.debug_bounds(HOST_HEADER)
            .unwrap()
            .contains(&dot.center())
    );
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            // No second removal while one is running.
            view.open_host_menu(HOST, point(px(10.), px(10.)), window, cx);
            assert!(view.menu.page.is_none());

            // A failure clears the mark and says why in the status bar.
            view.device_removed(HOST, "m5max-ms", true, Err(crate::Error::DeviceAdding), cx);
            assert!(view.menu.removing_devices.is_empty());
            assert_eq!(
                view.local_error.as_deref(),
                Some("Remove m5max-ms: This host is already being added.")
            );
            assert!(view.menu.github_hosts.contains_key(HOST));

            // Success keeps the mark until the catalog drops the device,
            // even when its GitHub credential could not be deleted.
            view.menu.removing_devices.insert(HOST.into());
            view.device_removed(
                HOST,
                "m5max-ms",
                true,
                Ok(Err(crate::Error::CredentialPolicy)),
                cx,
            );
            assert!(!view.menu.github_hosts.contains_key(HOST));
            assert!(
                view.local_error
                    .as_deref()
                    .unwrap()
                    .starts_with("Removed m5max-ms, but could not delete its GitHub sign-in")
            );
            view.prune_device_removals();
            assert!(view.menu.removing_devices.contains(HOST));
            view.endpoints.truncate(1);
            view.prune_device_removals();
            assert!(view.menu.removing_devices.is_empty());
        });
    });
}

#[gpui::test]
fn renaming_edits_the_name_in_place_and_keeps_typing_in_the_field(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::bind_keys(cx);
        let mut view = fixture_window(window, cx);
        add_host(&mut view);
        view
    });
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_host_menu(HOST, point(px(10.), px(10.)), window, cx)
        });
    });
    if cfg!(windows) {
        assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
        return;
    }
    cx.simulate_keystrokes("down enter");
    let input = view.read_with(cx, |view, _| {
        assert_eq!(view.menu.page, Some(Page::RenameDevice));
        host(view).input.clone().unwrap()
    });
    cx.update(|window, cx| {
        // The current name is selected, so typing replaces it.
        assert_eq!(input.read(cx).text(), "m5max-ms");
        crate::sidebar::layout_tests::full_draw(window, cx).clear(cx);
    });
    // A modal like Add Device: header above the field, footer below it.
    let header = cx.debug_bounds("rename-device-header").unwrap();
    let body = cx.debug_bounds("rename-device").unwrap();
    let footer = cx.debug_bounds("rename-device-footer").unwrap();
    assert!(header.bottom() <= body.top() && body.bottom() <= footer.top());
    assert!(cx.debug_bounds("rename-device-close").is_some());
    // Centered over the window rather than at the pointer.
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert!((panel.center().x - px(400.)).abs() <= px(2.));
    // Letters, including the menu's own row keys, go to the field.
    cx.simulate_input("down");
    cx.update(|_, cx| assert_eq!(input.read(cx).text(), "down"));
    assert!(view.read_with(cx, |view, _| view.menu.page == Some(Page::RenameDevice)));
    cx.update(|_, cx| input.update(cx, |input, cx| input.set_text_selected("bad\u{7}name", cx)));
    cx.simulate_keystrokes("enter");
    view.read_with(cx, |view, _| {
        assert!(!host(view).renaming);
        assert!(
            host(view)
                .error
                .as_deref()
                .unwrap()
                .starts_with("Device names are")
        );
    });
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |view, _| view.menu.page.is_none()));
}
