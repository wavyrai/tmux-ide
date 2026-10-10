use super::*;

/// The Log window has no commands of its own, yet those on the window itself
/// still work there: Cmd-` moves on, and full screen toggles.
#[gpui::test]
fn logs_run_window_commands(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let (_, cx) = cx.add_window_view(LogWindow::new);
    cx.update(|window, cx| window.draw(cx).clear(cx));
    cx.dispatch_action(crate::RunCommand {
        command: crate::controls::Command::ToggleFullScreen,
    });
    cx.update(|window, _| assert!(window.is_fullscreen()));
    cx.dispatch_action(crate::RunCommand {
        command: crate::controls::Command::CycleWindows,
    });
    cx.run_until_parked();
    cx.update(|_, cx| assert_eq!(cx.active_window(), Some(source.into())));
}
