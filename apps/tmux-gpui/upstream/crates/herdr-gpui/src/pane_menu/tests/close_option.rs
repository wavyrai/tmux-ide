use super::*;

/// Chooses Close from the pane menu of `pane`, for `endpoint::lifecycle_tests`,
/// which owns the connected fixture.
#[cfg(unix)]
pub(crate) fn close_from_menu(
    view: &mut HerdrWindow,
    pane: &str,
    window: &mut Window,
    cx: &mut Context<HerdrWindow>,
) {
    view.open_pane_menu(pane, Point::default(), window, cx);
    assert_eq!(view.menu.page, Some(Page::Pane));
    view.activate_pane_menu(Action::Close, window, cx);
}

#[gpui::test]
fn close_from_the_pane_menu_asks_while_confirmation_is_on(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot()));
        view
    });
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            assert!(v.config.confirm_close_pane);
            v.open_pane_menu("inactive", Point::default(), window, cx);
            v.activate_pane_menu(Action::Close, window, cx);
            assert_eq!(v.menu.page, Some(Page::ConfirmClose));
            // A waiting dialog equals a fresh capture: nothing was attempted.
            let fresh =
                CloseConfirmation::capture_pane(v.live.snapshot.as_ref().unwrap(), "inactive");
            assert_eq!(v.menu.close, fresh);
        })
    });
}

#[gpui::test]
fn refused_close_from_the_pane_menu_stays_visible_without_confirmation(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = crate::sidebar::layout_tests::fixture_window(window, cx);
        view.live.snapshot = Some(Arc::new(snapshot()));
        view
    });
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.config.confirm_close_pane = false;
            v.open_pane_menu("inactive", Point::default(), window, cx);
            v.activate_pane_menu(Action::Close, window, cx);
            // The disconnected fixture attempts the close at once and refuses
            // it, so the dialog stays open carrying the refusal.
            assert_eq!(v.menu.page, Some(Page::ConfirmClose));
            let fresh =
                CloseConfirmation::capture_pane(v.live.snapshot.as_ref().unwrap(), "inactive");
            assert!(v.menu.close.is_some());
            assert_ne!(v.menu.close, fresh);
        })
    });
}
