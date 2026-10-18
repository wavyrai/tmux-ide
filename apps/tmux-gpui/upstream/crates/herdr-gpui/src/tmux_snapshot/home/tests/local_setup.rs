use super::*;
use browser::local_setup::{Phase, Setup};
#[gpui::test]
fn explicit_local_setup_preserves_request_and_refuses_duplicates(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.local_setup = Some(Setup {
                phase: Phase::Available,
            });
            view.home_refresh(6, window, cx);
            assert!(receiver.try_recv().is_err());
            view.home_refresh(7, window, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::LocalSetup { request: 7 }
            ));
            assert_eq!(view.browser_request, 7);
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}
#[gpui::test]
fn setup_cannot_bypass_workspace_picker_or_composition(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.local_setup = Some(Setup {
                phase: Phase::Available,
            });
            view.browser_state.surface = browser::Surface::Workspace;
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
            view.browser_state.surface = browser::Surface::Home;
            view.marked = "composing".into();
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
            view.marked.clear();
            view.open_picker(window, cx);
            view.home_refresh(7, window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}
