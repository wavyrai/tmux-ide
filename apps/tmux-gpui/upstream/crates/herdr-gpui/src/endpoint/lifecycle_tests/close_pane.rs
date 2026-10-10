use super::*;
use crate::config::preferences::Preference;

#[gpui::test]
fn do_not_ask_again_persists_only_with_a_sent_pane_close(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let space = gpui::KeyDownEvent {
        keystroke: gpui::Keystroke::parse("space").unwrap(),
        is_held: false,
        prefer_character_input: false,
    };
    for (ticks, expected) in [
        (1, Some(Preference::ConfirmClosePane(false))),
        (2, None),
        (0, None),
    ] {
        let (endpoint, mut server) = connected_endpoint("ssh:close-pane");
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.endpoints.truncate(1);
                view.endpoints.push(endpoint);
                view.selected_endpoint = 1;
                view.options = ConnectOptions::default();
                view.reset_selected(cx);
                view.activation_deadline = None;
                assert!(view.config.confirm_close_pane);
                assert!(view.input_ready());
                view.command(Command::ClosePane, window, cx);
                assert_eq!(view.menu.page, Some(crate::menu::Page::ConfirmClose));
                for _ in 0..ticks {
                    view.close_confirmation_key(&space, window, cx);
                }
                assert_eq!(view.menu.page, Some(crate::menu::Page::ConfirmClose));
                assert_eq!(view.send_close(window, cx), expected);
                assert!(view.menu.page.is_none());
            })
        });
        let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
            panic!("missing pane close");
        };
        let request: serde_json::Value = serde_json::from_str(&request).unwrap();
        assert_eq!(request["method"], Method::PaneClose.as_str());
    }
}

#[gpui::test]
fn pane_menu_close_sends_at_once_when_confirmation_is_off(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        Fixture(cx.new(|cx| crate::sidebar::layout_tests::fixture_window(window, cx)))
    });
    let view = fixture.update(cx, |fixture, _| fixture.0.clone());
    let (endpoint, mut server) = connected_endpoint("ssh:close-pane-menu");
    let pane = snapshot().panes[0].pane_id.clone();
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.endpoints.truncate(1);
            view.endpoints.push(endpoint);
            view.selected_endpoint = 1;
            view.options = ConnectOptions::default();
            view.reset_selected(cx);
            view.activation_deadline = None;
            view.config.confirm_close_pane = false;
            assert!(view.input_ready());
            crate::pane_menu::tests::close_option::close_from_menu(view, &pane, window, cx);
            // No dialog: the close went out and dismissed the menu.
            assert!(view.menu.page.is_none());
            assert!(view.menu.close.is_none());
        })
    });
    let ClientMessage::ClientShellEndpointRequest { request, .. } = server.receive() else {
        panic!("missing pane close");
    };
    let request: serde_json::Value = serde_json::from_str(&request).unwrap();
    assert_eq!(request["method"], Method::PaneClose.as_str());
    assert_eq!(request["params"]["pane_id"], pane.as_str());
}
