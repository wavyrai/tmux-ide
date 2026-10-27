use super::*;
use crate::{Command, Error, config::DeviceSettings, keymap::Binding};
use gpui::{Entity, Keystroke, TestAppContext, VisualTestContext};
use std::sync::Arc;

const ID: &str = "0123456789abcdef0123456789abcdef";
const HOST: &str = "ssh:0123456789abcdef0123456789abcdef";
const PROFILE: &str = "[keys]\nprefix = \"cmd+j\"\ntoggle_sidebar = \"prefix+cmd+b\"\n";

fn key(text: &str) -> Keystroke {
    Keystroke::parse(text).unwrap()
}

/// A window with Local and one saved device, which is not enabled so the
/// fixture never dials it.
fn window(cx: &mut TestAppContext) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    let (view, cx) = cx.add_window_view(crate::sidebar::layout_tests::fixture_window);
    view.update(cx, |view, _| {
        view.endpoints.push(crate::endpoint::Endpoint::new(
            HOST.into(),
            "box".into(),
            herdr_client::ConnectTarget::Ssh {
                target: "you@box".into(),
                session: "default".into(),
            },
            false,
        ));
    });
    (view, cx)
}

/// Selects an endpoint as the poll loop would leave it: its snapshot,
/// publishing `profile`, is the window's live one.
fn select(
    view: &mut HerdrWindow,
    index: usize,
    profile: Option<&str>,
    cx: &mut Context<HerdrWindow>,
) {
    view.selected_endpoint = index;
    let mut snapshot = crate::sidebar::layout_tests::snapshot(2);
    snapshot.server_keybindings_toml = profile.map(str::to_owned);
    view.live.snapshot = Some(Arc::new(snapshot));
    view.sync_server_keymap(cx);
}

fn opt_in(view: &mut HerdrWindow, source: KeybindingSource) {
    view.config.devices.insert(
        ID.into(),
        DeviceSettings {
            keybindings: source,
        },
    );
}

fn active_global(cx: &mut VisualTestContext) -> Option<Keymap> {
    cx.update(|_, cx| {
        cx.try_global::<ActiveServerKeymap>()
            .and_then(|active| active.0.clone())
    })
}

#[gpui::test]
fn the_keymap_follows_the_selected_device_only_when_it_opted_in(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    view.update(cx, |view, cx| {
        view.active = true;
        // Opted out by default: the device's profile is ignored.
        select(view, 1, Some(PROFILE), cx);
        assert!(view.server_keys.is_none());
        assert!(view.keymap().is_prefix(&key("ctrl-b")));

        opt_in(view, KeybindingSource::Server);
        view.sync_server_keymap(cx);
        assert!(view.keymap().is_prefix(&key("cmd-j")));
        assert!(!view.keymap().is_prefix(&key("ctrl-b")));
        assert_eq!(
            view.keymap().chord(&key("cmd-b")),
            Some(Command::ToggleSidebar)
        );
        // The window's config, which other windows and reloads compare,
        // keeps the local keymap.
        assert!(view.config.keybindings.is_prefix(&key("ctrl-b")));
    });
    let server = view.read_with(cx, |view, _| view.keymap().clone());
    assert_eq!(
        active_global(cx),
        Some(server),
        "the active window binds its keys"
    );

    view.update(cx, |view, cx| {
        // Moving focus to Local switches back, and so does opting out.
        select(view, 0, Some(PROFILE), cx);
        assert!(view.keymap().is_prefix(&key("ctrl-b")));
        select(view, 1, Some(PROFILE), cx);
        assert!(view.keymap().is_prefix(&key("cmd-j")));
        opt_in(view, KeybindingSource::Local);
        view.sync_server_keymap(cx);
        assert!(view.server_keys.is_none());
        assert!(view.keymap().is_prefix(&key("ctrl-b")));
    });
    assert_eq!(active_global(cx), None);
}

#[gpui::test]
fn an_unusable_profile_falls_back_to_local_and_says_why(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    view.update(cx, |view, cx| {
        opt_in(view, KeybindingSource::Server);
        // No snapshot yet: nothing to judge, so no diagnostic.
        view.selected_endpoint = 1;
        view.live.snapshot = None;
        view.sync_server_keymap(cx);
        assert!(view.server_keys.is_none());
        assert_eq!(view.server_keybindings_error(HOST), None);

        for (profile, expected) in [
            (None, "the host did not publish its keybindings"),
            (Some("[keys"), "the host's keybindings are not valid TOML"),
            (
                Some("prefix = 'cmd+j'"),
                "the host's keybindings have no [keys] table",
            ),
        ] {
            select(view, 1, profile, cx);
            assert!(view.keymap().is_prefix(&key("ctrl-b")), "{profile:?}");
            let error = view.server_keybindings_error(HOST).unwrap();
            assert!(error.starts_with(expected), "{error}");
            assert!(matches!(
                view.server_keys.as_ref().unwrap().keymap,
                Err(Error::ServerKeybindingsMissing
                    | Error::ServerKeybindingsParse(_)
                    | Error::ServerKeybindingsNoKeys)
            ));
        }
        // A later valid profile replaces the fallback.
        select(view, 1, Some(PROFILE), cx);
        assert_eq!(view.server_keybindings_error(HOST), None);
        assert!(view.keymap().is_prefix(&key("cmd-j")));
        // The diagnostic belongs to the device it describes.
        select(view, 1, None, cx);
        assert_eq!(view.server_keybindings_error("local"), None);
    });
}

#[gpui::test]
fn gui_overrides_still_layer_over_server_keys(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    view.update(cx, |view, cx| {
        opt_in(view, KeybindingSource::Server);
        select(view, 1, Some(PROFILE), cx);
        assert_eq!(view.keymap().primary(Command::Tab), "cmd-t");
        // A reload with new overrides rebuilds the server keymap.
        view.config
            .keybinding_overrides
            .insert("new_tab".into(), Binding::One("cmd-y".into()));
        view.sync_server_keymap(cx);
        assert_eq!(view.keymap().primary(Command::Tab), "cmd-y");
        assert!(view.keymap().is_prefix(&key("cmd-j")));
    });
}

#[gpui::test]
fn the_server_prefix_runs_chords_and_a_switch_disarms_it(cx: &mut TestAppContext) {
    let (view, cx) = window(cx);
    let press = |keystroke: &str, cx: &mut VisualTestContext| {
        let handled = cx.update(|window, cx| window.dispatch_keystroke(key(keystroke), cx));
        cx.run_until_parked();
        handled
    };
    view.update(cx, |view, cx| {
        opt_in(view, KeybindingSource::Server);
        select(view, 1, Some(PROFILE), cx);
    });
    cx.update(|window, cx| {
        window.focus(&view.read(cx).focus.clone(), cx);
        window.draw(cx).clear(cx);
    });
    let state = |cx: &mut VisualTestContext| {
        view.read_with(cx, |view, _| (view.prefix_armed, view.sidebar_visible))
    };
    assert!(press("cmd-j", cx));
    assert!(press("cmd-b", cx));
    assert_eq!(state(cx), (false, false), "the server chord ran");

    // A prefix armed under the server keymap does not survive a switch.
    assert!(press("cmd-j", cx));
    view.update(cx, |view, cx| select(view, 0, Some(PROFILE), cx));
    assert_eq!(state(cx), (false, false));
    assert!(!press("cmd-j", cx), "Local's prefix is ctrl-b");
}
