use super::*;
#[gpui::test]
fn developer_command_persists_without_terminal_input_or_navigation(cx: &mut TestAppContext) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("gpui-developer.json");
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.developer_mode = super::super::super::developer_mode::Settings::for_test(path.clone());
        view
    });
    receiver.try_iter().for_each(drop);
    let request = view.read_with(cx, |v, _| v.browser_request);
    for enabled in [true, false] {
        cx.update(|window, cx| {
            view.update(cx, |v, cx| {
                v.open_picker_mode(Mode::Commands, window, cx);
                assert!(
                    v.picker
                        .as_ref()
                        .unwrap()
                        .rows
                        .iter()
                        .any(|row| row.target == Target::Command(Action::DeveloperMode(enabled)))
                );
                v.choose_picker(Target::Command(Action::DeveloperMode(enabled)), window, cx);
            })
        });
        cx.run_until_parked();
        view.read_with(cx, |v, _| {
            assert_eq!(v.developer_mode.enabled, enabled);
            assert!(!v.developer_mode.saving);
            assert_eq!(v.browser_request, request);
            assert_eq!(v.developer_mode.note, Some("Developer mode saved"));
        });
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["enabled"], enabled);
        assert!(receiver.try_recv().is_err());
    }
}

#[gpui::test]
fn developer_save_failure_is_visible_and_keeps_off(cx: &mut TestAppContext) {
    let directory = tempfile::tempdir().unwrap();
    let parent = directory.path().join("not-a-directory");
    std::fs::write(&parent, "occupied").unwrap();
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        let mut view = make_view(window, cx, sender);
        view.developer_mode = super::super::super::developer_mode::Settings::for_test(
            parent.join("gpui-developer.json"),
        );
        view
    });
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_picker_mode(Mode::Commands, window, cx);
            v.choose_picker(Target::Command(Action::DeveloperMode(true)), window, cx);
        })
    });
    cx.run_until_parked();
    view.read_with(cx, |v, _| {
        assert!(!v.developer_mode.enabled);
        assert!(!v.developer_mode.saving);
        assert_eq!(
            v.developer_mode.note,
            Some("Could not save Developer mode; previous setting retained")
        );
        assert!(matches!(v.picker.as_ref().unwrap().mode, Mode::Commands));
    });
    assert!(receiver.try_recv().is_err());
}
