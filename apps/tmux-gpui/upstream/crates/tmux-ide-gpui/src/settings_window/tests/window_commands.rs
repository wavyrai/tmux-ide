use super::*;

/// Commands on the window itself reach the Settings window too, rather than
/// stopping at its root: Cmd-` from Settings moves on, and full screen works.
#[gpui::test]
fn settings_runs_window_commands(cx: &mut TestAppContext) {
    let source = cx.add_window(crate::sidebar::layout_tests::fixture_window);
    let weak = cx.update(|cx| source.update(cx, |_, _, cx| cx.weak_entity()).unwrap());
    let (_, cx) = cx.add_window_view(|window, cx| {
        let view = SettingsWindow::new(weak, cx);
        window.focus(&view.focus, cx);
        view
    });
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
