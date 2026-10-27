use super::*;
fn prepare(view: &mut SnapshotView) -> (u16, u16) {
    view.browser_state.request = view.browser_request;
    view.browser_state.input_ready = true;
    view.browser_state.presence_revision = 1;
    view.browser_state.selected_session = Some("session".into());
    view.browser_state.input_targets = vec![crate::tmux_snapshot::pending_input::Target {
        id: "pane-a".into(),
        token: "a".repeat(64),
    }];
    view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
        id: "pane-a".into(),
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        wrapped: vec![false],
    });
    let f = view.frame.as_ref().unwrap().view();
    (f.width() + 1, f.height())
}
fn resized(view: &SnapshotView, cols: u16) -> browser::State {
    let mut state = view.browser_state.clone();
    state.input_ready = true;
    state.input_targets = vec![crate::tmux_snapshot::pending_input::Target {
        id: "pane-a".into(),
        token: "a".repeat(64),
    }];
    Arc::make_mut(state.frame.as_mut().unwrap().legacy_mut()).width = cols;
    state
}
#[gpui::test]
fn viewport_holds_suffix_until_matching_geometry_and_releases_once(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window,cx|view.update(cx,|view,cx| {
        let (cols,rows)=prepare(view);
        view.replace_text_in_range(None,"prefix",window,cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input{input:Input::Text(s),..} if s=="prefix"));
        view.capture_viewport_input(cols,rows);
        view.replace_text_in_range(None,"held",window,cx);
        let old=view.browser_state.clone();
        view.apply_browser_state(Some(old),cx);
        assert!(receiver.try_recv().is_err(),"old ready geometry must not flush");
        let mut transition=view.browser_state.clone();
        transition.input_ready=false;
        transition.input_targets.clear();
        view.apply_browser_state(Some(transition),cx);
        view.replace_text_in_range(None,"suffix",window,cx);
        assert!(!view.input_interrupted);
        assert!(receiver.try_recv().is_err());
        let state=resized(view,cols);
        view.apply_browser_state(Some(state.clone()),cx);
        for expected in ["held","suffix"] {
            assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input{input:Input::Text(s),input_target:Some(t),..} if s==expected && t=="a".repeat(64)));
        }
        view.apply_browser_state(Some(state),cx);
        assert!(receiver.try_recv().is_err());
    }));
}
#[gpui::test]
fn viewport_buffer_rejects_lifetime_blur_navigation_timeout_and_unowned_gaps(
    cx: &mut TestAppContext,
) {
    for change in 0..6 {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
        receiver.try_iter().for_each(drop);
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                let (cols, rows) = prepare(view);
                if change != 5 {
                    view.capture_viewport_input(cols, rows);
                }
                let mut transition = view.browser_state.clone();
                transition.input_ready = false;
                transition.input_targets.clear();
                view.apply_browser_state(Some(transition), cx);
                view.replace_text_in_range(None, "held", window, cx);
                let mut state = resized(view, cols);
                match change {
                    0 => state.input_targets[0].token = "b".repeat(64),
                    1 => {
                        view.presence.set_active(false);
                    }
                    2 => view.browser_request += 1,
                    3 => view.age_pending_input(),
                    4 => state.selected_pane = Some("other".into()),
                    _ => {}
                }
                view.apply_browser_state(Some(state), cx);
                view.replace_text_in_range(None, "suffix", window, cx);
                assert!(view.input_interrupted, "case {change}");
                assert!(receiver.try_recv().is_err(), "case {change}");
            })
        });
    }
}

#[gpui::test]
fn buffered_viewport_input_survives_command_queue_pressure_without_replay(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(2);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            let (cols, rows) = prepare(view);
            view.capture_viewport_input(cols, rows);
            for text in ["a", "b", "c", "d", "e"] {
                view.replace_text_in_range(None, text, window, cx);
            }
            let state = resized(view, cols);
            view.apply_browser_state(Some(state), cx);
            let mut received = String::new();
            for _ in 0..4 {
                for command in receiver.try_iter() {
                    if let browser::Command::Input {
                        input: Input::Text(text),
                        ..
                    } = command
                    {
                        received.push_str(&text);
                    } else {
                        panic!("unexpected command");
                    }
                }
                view.flush_pending_input(cx);
            }
            assert_eq!(received, "abcde");
            assert!(!view.input_interrupted);
            assert!(view.pending_input.is_none());
            assert!(receiver.try_recv().is_err());
        })
    });
}
