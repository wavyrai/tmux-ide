use super::*;

#[gpui::test]
fn connected_ssh_hosts_get_their_own_pane_history_rows(cx: &mut TestAppContext) {
    let (view, cx) = cx.add_window_view(skill_fixture);
    cx.simulate_resize(size(px(680.), px(2200.)));
    let long = "a-very-long-ssh-host-label.with.many.domain.parts.example.internal";
    view.update(cx, |view, cx| {
        let jobs = view.remote_history.sync(
            [
                (long.to_owned(), "ready".to_owned()),
                ("loading".to_owned(), "loading".to_owned()),
            ],
            false,
        );
        let ready = &jobs[0];
        let history = crate::herdr_settings::RemotePaneHistory::parse_text(Some(
            "[experimental]\npane_history = true\n".into(),
        ))
        .unwrap();
        assert!(
            view.remote_history
                .finish(&ready.target, ready.generation, Ok(history))
        );
        cx.notify();
    });
    cx.update(|window, cx| crate::sidebar::layout_tests::full_draw(window, cx).clear(cx));
    let body = cx.debug_bounds("settings-pane-history").unwrap();
    for id in [
        "settings-pane-history-host-0",
        "settings-pane-history-host-1",
    ] {
        let row = cx.debug_bounds(id).unwrap();
        assert!(
            row.left() >= body.left() && row.right() <= body.right(),
            "{id}"
        );
        assert!(row.top() >= body.bottom(), "{id}");
    }
    // A host still being read cannot be toggled.
    let loading = cx.debug_bounds("settings-pane-history-host-1").unwrap();
    cx.simulate_click(loading.center(), Default::default());
    view.read_with(cx, |view, _| {
        let hosts = view.remote_history.hosts();
        assert!(matches!(hosts[1].state, HostState::Loading));
        assert!(matches!(&hosts[0].state, HostState::Ready(history) if history.enabled));
    });
}
