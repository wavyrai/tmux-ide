use super::*;

#[gpui::test]
fn diagnostics_work_offline_with_developer_mode_off_without_navigation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    let request = view.read_with(cx, |v, _| v.browser_request);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.browser_commands = None;
            v.browser_state.input_ready = false;
            v.browser_state.status = "SECRET_STATUS token=private".into();
            v.open_picker_mode(Mode::Commands, window, cx);
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .rows
                    .iter()
                    .any(|row| row.target == Target::Command(Action::CopyDiagnostics))
            );
            v.choose_picker(Target::Command(Action::CopyDiagnostics), window, cx);
            assert!(!v.developer_mode.enabled);
            assert_eq!(v.browser_request, request);
            assert!(v.picker.as_ref().unwrap().note.is_some());
            let text = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(!text.contains("SECRET_STATUS"));
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert_eq!(value["product"], "tmux-ide-gpui");
            assert_eq!(value["developerMode"], false);
        });
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn diagnostics_do_not_replace_clipboard_during_composition(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |v, cx| {
            v.open_picker_mode(Mode::Commands, window, cx);
            cx.write_to_clipboard(ClipboardItem::new_string("previous".into()));
            v.marked = "composing".into();
            v.choose_picker(Target::Command(Action::CopyDiagnostics), window, cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().as_deref(),
                Some("previous")
            );
        });
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn offline_f5_search_can_copy_diagnostics(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |v, _| {
            v.browser_commands = None;
            v.browser_state.input_ready = false;
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("f5");
    cx.simulate_input("copy diagnostics");
    view.read_with(cx, |v, _| {
        let picker = v.picker.as_ref().unwrap();
        assert_eq!(picker.rows.len(), 1);
        assert_eq!(
            picker.rows[0].target,
            Target::Command(Action::CopyDiagnostics)
        );
    });
    cx.simulate_keystrokes("enter");
    cx.update(|_, cx| {
        let text = cx.read_from_clipboard().unwrap().text().unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["inputReady"], false);
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn failed_diagnostics_preparation_preserves_clipboard_and_connection(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let request = view.browser_request;
            view.browser_state.request = request;
            view.browser_state.surface = browser::Surface::Workspace;
            view.browser_state.diagnostics = Some(crate::tmux_snapshot::diagnostics::Versions {
                daemon_version: Some("secret/path".into()),
            });
            cx.write_to_clipboard(ClipboardItem::new_string("previous".into()));
            view.open_picker_mode(Mode::Commands, window, cx);
            view.choose_picker(Target::Command(Action::CopyDiagnostics), window, cx);
            assert_eq!(
                cx.read_from_clipboard().unwrap().text().as_deref(),
                Some("previous")
            );
            assert_eq!(view.browser_request, request);
            assert_eq!(
                view.picker.as_ref().unwrap().error,
                Some("Could not prepare diagnostics. Clipboard unchanged.")
            );
            assert!(!view.developer_mode.enabled);
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn diagnostics_do_not_reuse_version_after_local_request_retirement(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.diagnostics = Some(crate::tmux_snapshot::diagnostics::Versions {
                daemon_version: Some("2.9.7".into()),
            });
            view.browser_state.request = view.browser_request;
            view.browser_state.surface = browser::Surface::Workspace;
            view.copy_diagnostics(window, cx);
            let before = cx.read_from_clipboard().unwrap().text().unwrap();
            let before: serde_json::Value = serde_json::from_str(&before).unwrap();
            assert_eq!(before["daemonVersion"], "2.9.7");
            view.browser_request += 1;
            let request = view.browser_request;
            view.copy_diagnostics(window, cx);
            let text = cx.read_from_clipboard().unwrap().text().unwrap();
            let report: serde_json::Value = serde_json::from_str(&text).unwrap();
            assert!(report["daemonVersion"].is_null());
            assert_eq!(view.browser_request, request);
        })
    });
    assert!(receiver.try_recv().is_err());
}
