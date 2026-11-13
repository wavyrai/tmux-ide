use super::visible;

#[test]
fn routine_ready_guidance_is_opt_in() {
    for message in [
        "Connected",
        "Keyboard ready",
        "Keyboard ready — click terminal to type",
    ] {
        assert!(!visible(message, false, true));
        assert!(visible(message, true, true));
        assert!(visible(message, false, false));
    }
}

#[test]
fn failures_and_interactions_remain_visible() {
    for message in [
        "Connection unavailable — refresh the catalog",
        "Reconnecting terminal",
        "Connection recovery paused — refresh or select the session again",
        "Input interrupted; click terminal when ready, then retype — Keyboard ready",
        "Selecting captured frame — Cmd-C copies; Escape or click resumes",
        "Copy failed",
        "Unrecognized future status",
    ] {
        assert!(visible(message, false, true), "{message}");
        assert!(visible(message, false, false), "{message}");
    }
}

/// #739: a zoomed window shows one pane and no dividers. With nothing else
/// to say, the status line says why; anything that matters still comes first.
#[gpui::test]
fn a_zoomed_window_says_so_when_nothing_else_needs_saying(cx: &mut gpui::TestAppContext) {
    use crate::tmux_snapshot::browser;
    let (sender, _receiver) = std::sync::mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| {
        crate::tmux_snapshot::fit_test_support::fixture_view(
            window,
            cx,
            sender,
            7,
            browser::State {
                request: 7,
                surface: browser::Surface::Workspace,
                input_ready: true,
                status: "Connected".into(),
                ..Default::default()
            },
        )
    });
    let zoom = |zoomed: bool| {
        Some(browser::PaneActions {
            token: "token".into(),
            id: "pane-a".into(),
            zoomed,
        })
    };
    view.update(cx, |view, _| {
        assert_eq!(view.status_line(), "Connected");
        view.browser_state.pane_actions = zoom(false);
        assert_eq!(view.status_line(), "Connected");
        view.browser_state.pane_actions = zoom(true);
        assert_eq!(view.status_line(), super::ZOOMED);
        assert!(visible(&view.status_line(), false, true));
        assert_eq!(
            crate::tmux_snapshot::connection::jargon(super::ZOOMED),
            None
        );
        for status in ["", "Keyboard ready"] {
            view.browser_state.status = status.into();
            assert_eq!(view.status_line(), super::ZOOMED, "{status}");
        }
        // A real notice is not replaced.
        view.browser_state.status = "Copy failed".into();
        assert_eq!(view.status_line(), "Copy failed");
        view.browser_state.status = "Connected".into();
        view.input_interrupted = true;
        assert!(view.status_line().starts_with("Input interrupted"));
    });
}
