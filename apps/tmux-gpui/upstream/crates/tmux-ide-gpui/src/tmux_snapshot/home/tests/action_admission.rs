use super::*;

#[gpui::test]
fn home_refresh_cannot_activate_behind_picker(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.open_picker(window, cx);
            view.home_refresh(7, window, cx);
            assert!(
                receiver.try_recv().is_err(),
                "background Refresh bypassed picker ownership"
            );
            assert!(view.picker.is_some());
            assert_eq!(view.browser_request, 7);
        })
    });
}
