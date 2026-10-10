#![allow(clippy::unwrap_used)]
use super::{Distros, Outcome, Page, Step, WslSetup, add};
use crate::{HerdrWindow, search_input::SearchInput, sidebar::layout_tests::fixture_window};
use gpui::{AppContext, Context, KeyDownEvent, Keystroke, Modifiers, Point, TestAppContext};
use herdr_client::{ConnectTarget, WslHost};

fn wsl(distro: &str) -> WslHost {
    WslHost {
        distro: distro.into(),
        session: "default".into(),
    }
}

fn open_form(view: &mut HerdrWindow, distros: &[&str], cx: &mut Context<HerdrWindow>) {
    view.menu.wsl_setup = Some(WslSetup {
        distros: Distros::Ready(distros.iter().map(|d| (*d).to_owned()).collect()),
        selected: None,
        session: cx.new(SearchInput::new),
        step: Step::Form,
        task: None,
    });
    view.menu.page = Some(Page::AddWsl);
}

fn key(key: &str) -> KeyDownEvent {
    KeyDownEvent {
        keystroke: Keystroke {
            modifiers: Modifiers::default(),
            key: key.into(),
            key_char: None,
        },
        is_held: false,
        prefer_character_input: false,
    }
}

#[gpui::test]
fn saved_distributions_become_wsl_devices_after_ssh_hosts(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update_in(cx, |view, _, cx| {
        view.endpoints[0].connection.target = ConnectTarget::Local;
        view.reconcile_catalog(
            vec![herdr_client::SavedHost {
                id: "0123456789abcdef0123456789abcdef".into(),
                label: "Box".into(),
                target: "me@box".into(),
                session: "default".into(),
                enabled: true,
            }],
            vec![wsl("Ubuntu"), wsl("Debian")],
            cx,
        );
        let ids: Vec<&str> = view.endpoints.iter().map(|e| e.id.as_str()).collect();
        assert_eq!(ids[2..], ["wsl:Ubuntu", "wsl:Debian"]);
        let ubuntu = &view.endpoints[2];
        assert_eq!(ubuntu.label, "Ubuntu");
        assert!(ubuntu.enabled);
        assert_eq!(
            ubuntu.connection.target,
            ConnectTarget::Wsl {
                distro: "Ubuntu".into(),
                session: "default".into()
            }
        );
        assert_eq!(view.saved_distros(), ["Ubuntu", "Debian"]);
        // The sessions list may point the device at another of its sessions;
        // an unchanged catalog keeps that choice, a removal retires it.
        view.endpoints[2].connection.target = ConnectTarget::Wsl {
            distro: "Ubuntu".into(),
            session: "work".into(),
        };
        view.reconcile_catalog(Vec::new(), vec![wsl("Ubuntu")], cx);
        assert_eq!(
            view.endpoints[1].connection.target.remote_session(),
            Some("work")
        );
        view.reconcile_catalog(Vec::new(), Vec::new(), cx);
        assert_eq!(view.endpoints.len(), 1);
    });
}

#[gpui::test]
fn the_form_skips_saved_distributions_and_cycles_with_arrows(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update_in(cx, |view, window, cx| {
        view.endpoints[0].connection.target = ConnectTarget::Local;
        view.reconcile_catalog(Vec::new(), vec![wsl("Ubuntu")], cx);
        open_form(view, &["Ubuntu", "Arch", "Debian"], cx);
        let selected = |view: &HerdrWindow| view.menu.wsl_setup.as_ref().unwrap().selected.clone();
        view.add_wsl_key(&key("down"), window, cx);
        assert_eq!(selected(view).as_deref(), Some("Arch"));
        view.add_wsl_key(&key("down"), window, cx);
        view.add_wsl_key(&key("down"), window, cx);
        assert_eq!(selected(view).as_deref(), Some("Arch"));
        view.add_wsl_key(&key("up"), window, cx);
        assert_eq!(selected(view).as_deref(), Some("Debian"));
        // A distribution that is already a device is refused before any probe.
        view.menu.wsl_setup.as_mut().unwrap().selected = Some("Ubuntu".into());
        view.submit_add_wsl(window, cx);
        assert_eq!(
            view.menu.error.as_deref(),
            Some("Ubuntu is already a device.")
        );
        let setup = view.menu.wsl_setup.as_ref().unwrap();
        assert_eq!(setup.step, Step::Form);
        assert!(setup.task.is_none());
        view.add_wsl_key(&key("escape"), window, cx);
        assert!(view.menu.page.is_none());
        assert!(view.menu.wsl_setup.is_none());
    });
}

#[gpui::test]
fn nothing_is_submitted_without_a_distribution(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update_in(cx, |view, window, cx| {
        open_form(view, &[], cx);
        view.submit_add_wsl(window, cx);
        assert_eq!(view.menu.error.as_deref(), Some("Pick a distribution."));
        assert!(view.menu.wsl_setup.as_ref().unwrap().task.is_none());
    });
}

#[gpui::test]
fn a_wsl_device_menu_only_offers_removal(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update_in(cx, |view, window, cx| {
        view.endpoints[0].connection.target = ConnectTarget::Local;
        view.reconcile_catalog(Vec::new(), vec![wsl("Ubuntu")], cx);
        view.open_host_menu("wsl:Ubuntu", Point::default(), window, cx);
        assert_eq!(view.menu.page, Some(Page::RemoveWsl));
        assert_eq!(view.menu.wsl_remove.as_deref(), Some("Ubuntu"));
        assert!(view.menu.host.is_none());
        view.remove_wsl_key(&key("escape"), window, cx);
        assert!(view.menu.page.is_none());
        assert!(view.menu.wsl_remove.is_none());
    });
}

#[gpui::test]
fn an_explicit_socket_window_never_offers_wsl_removal(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(fixture_window);
    view.update_in(cx, |view, window, cx| {
        view.reconcile_catalog(Vec::new(), vec![wsl("Ubuntu")], cx);
        view.open_host_menu("wsl:Ubuntu", Point::default(), window, cx);
        assert!(view.menu.page.is_none());
    });
}

#[test]
fn a_platform_without_wsl_refuses_with_its_reason() {
    if cfg!(windows) {
        return;
    }
    let Outcome::Refused(message) = add("Ubuntu", "default") else {
        panic!("WSL saved a device off Windows");
    };
    assert_eq!(
        message,
        "Check Ubuntu: WSL distributions are only available on Windows"
    );
}
