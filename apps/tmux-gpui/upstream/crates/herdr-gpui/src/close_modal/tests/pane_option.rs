use super::*;

fn fixture(cx: &mut TestAppContext) -> (Entity<HerdrWindow>, &mut VisualTestContext) {
    cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(
            serde_json::from_str(include_str!(
                "../../../../herdr-protocol/tests/fixtures/endpoint-snapshot-v1.json"
            ))
            .unwrap(),
        ));
        view
    })
}

fn ticked(view: &HerdrWindow) -> bool {
    view.menu.close.as_ref().unwrap().do_not_ask_again
}

#[gpui::test]
fn disabled_pane_confirmation_closes_at_once_and_keeps_connection_checks(cx: &mut TestAppContext) {
    let (view, cx) = fixture(cx);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.confirm_close_pane = false;
            view.open_close_confirmation(Command::ClosePane, window, cx);
            // The disconnected fixture attempts the close at once and refuses it.
            assert!(view.menu.close.as_ref().unwrap().error.is_some());
            view.dismiss_menu(window, cx);
            // Tabs keep their own option.
            view.open_close_confirmation(Command::CloseTab, window, cx);
            assert!(view.menu.close.as_ref().unwrap().error.is_none());
        })
    });
}

#[gpui::test]
fn do_not_ask_again_is_a_pane_only_checkbox_and_a_refused_close_saves_nothing(
    cx: &mut TestAppContext,
) {
    let (view, cx) = fixture(cx);
    let space = KeyDownEvent {
        keystroke: Keystroke::parse("space").unwrap(),
        is_held: false,
        prefer_character_input: false,
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_close_confirmation(Command::CloseTab, window, cx);
            view.close_confirmation_key(&space, window, cx);
            assert!(!ticked(view));
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("close-do-not-ask").is_none());

    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.dismiss_menu(window, cx);
            view.open_close_confirmation(Command::ClosePane, window, cx);
            assert!(!ticked(view));
            view.close_confirmation_key(&space, window, cx);
            assert!(ticked(view));
            // Cancel stays selected: Space must not move the button selection.
            assert!(!view.menu.close.as_ref().unwrap().confirm_selected);
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let checkbox = cx.debug_bounds("close-do-not-ask").unwrap().center();
    cx.simulate_click(checkbox, Modifiers::default());
    view.read_with(cx, |view, _| assert!(!ticked(view)));
    cx.simulate_click(checkbox, Modifiers::default());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            assert!(ticked(view));
            assert_eq!(view.send_close(window, cx), None);
            assert!(view.menu.close.as_ref().unwrap().error.is_some());
            assert!(view.config.confirm_close_pane);
        })
    });
}

#[gpui::test]
fn refused_immediate_pane_close_does_not_offer_do_not_ask_again(cx: &mut TestAppContext) {
    let (view, cx) = fixture(cx);
    let space = KeyDownEvent {
        keystroke: Keystroke::parse("space").unwrap(),
        is_held: false,
        prefer_character_input: false,
    };
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.config.confirm_close_pane = false;
            view.open_close_confirmation(Command::ClosePane, window, cx);
            // The refusal falls back to the dialog, whose option is already off.
            assert!(view.menu.close.as_ref().unwrap().error.is_some());
            view.close_confirmation_key(&space, window, cx);
            assert!(!ticked(view));
        })
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("close-do-not-ask").is_none());
}
