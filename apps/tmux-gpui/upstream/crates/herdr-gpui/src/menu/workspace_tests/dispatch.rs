use super::*;

/// A window on a scriptable local daemon showing `snapshot(7)`, with a
/// second connected host, "Box", that has the same repository open.
fn two_hosts(view: &mut HerdrWindow) {
    let snapshot = std::sync::Arc::make_mut(view.live.snapshot.as_mut().unwrap());
    snapshot.workspaces = sidebar::layout_tests::snapshot(7).workspaces;
    view.live.status = crate::state::ConnectionStatus::Connected;
    view.endpoints[0].connection.target = herdr_client::ConnectTarget::Local;
    add_host(view, "box", "Box");
}

/// A connected SSH host showing the window's own snapshot.
fn add_host(view: &mut HerdrWindow, name: &str, label: &str) {
    let mut remote = crate::endpoint::Endpoint::new(
        format!("ssh:{name}"),
        label.into(),
        herdr_client::ConnectTarget::Ssh {
            target: format!("nobody@{name}.invalid"),
            session: "default".into(),
        },
        true,
    );
    remote.live = view.live.clone();
    view.endpoints.push(remote);
}

// Only POSIX clients can script another host, so only they dispatch.
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn dispatched(view: &HerdrWindow) -> Option<String> {
    view.menu
        .dispatch
        .as_ref()?
        .dispatched()
        .map(|host| host.endpoint_id.clone())
}

#[gpui::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn the_new_worktree_dialog_offers_other_hosts_and_keeps_this_one(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            two_hosts(view);
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            let picker = view.menu.dispatch.as_ref().unwrap();
            assert_eq!(picker.best().count(), 2);
            assert_eq!(dispatched(view), None, "this host stays chosen");
            assert_eq!(view.dispatch_choice(WorkspaceAction::NewWorktree), None);
        })
    });
    cx.run_until_parked();
    let local = cx.debug_bounds("dispatch-tile-local").unwrap();
    let remote = cx.debug_bounds("dispatch-tile-ssh:box").unwrap();
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert!(panel.contains(&local.origin) && panel.contains(&remote.origin));
    assert_eq!(local.top(), remote.top(), "tiles share a row");
    assert!(
        cx.debug_bounds("dispatch-other").is_none(),
        "no field without hosts beyond the tiles"
    );
    cx.simulate_click(remote.center(), gpui::Modifiers::none());
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(dispatched(view).as_deref(), Some("ssh:box"));
        assert_eq!(
            view.dispatch_choice(WorkspaceAction::NewWorktree)
                .as_deref(),
            Some("ssh:box")
        );
    });
    cx.simulate_click(local.center(), gpui::Modifiers::none());
    cx.update(|_, cx| assert_eq!(dispatched(view.read(cx)), None));
}

#[gpui::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn hosts_beyond_the_tiles_open_from_the_other_field(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            two_hosts(view);
            for name in ["c", "d", "e"] {
                add_host(view, name, name);
            }
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            let picker = view.menu.dispatch.as_ref().unwrap();
            assert_eq!(picker.best().count(), 3);
            assert_eq!(picker.rest().count(), 2);
        })
    });
    cx.run_until_parked();
    assert!(cx.debug_bounds("dispatch-list").is_none());
    let other = cx.debug_bounds("dispatch-other").unwrap();
    cx.simulate_click(other.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    let list = cx.debug_bounds("dispatch-list").unwrap();
    let panel = cx.debug_bounds("menu-panel").unwrap();
    assert!(panel.contains(&list.origin));
    // Unsampled, hosts rank by name after this one: d and e are listed.
    let last = cx.update(|_, cx| {
        let picker = view.read(cx).menu.dispatch.as_ref().unwrap();
        picker.rest().last().unwrap().endpoint_id.clone()
    });
    assert_eq!(last, "ssh:e");
    let row = cx.debug_bounds("dispatch-row-ssh:e").unwrap();
    cx.simulate_click(row.center(), gpui::Modifiers::none());
    cx.run_until_parked();
    cx.update(|_, cx| {
        let view = view.read(cx);
        assert_eq!(dispatched(view), Some(last.clone()));
        assert_eq!(view.menu.dispatch.as_ref().unwrap().open(), None);
    });
    assert!(
        cx.debug_bounds("dispatch-list").is_none(),
        "choosing closes the list"
    );
}

#[gpui::test]
fn one_host_or_an_unscriptable_one_offers_no_picker(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            two_hosts(view);
            view.endpoints.truncate(1);
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            assert!(view.menu.dispatch.is_none());
            view.dismiss_menu(window, cx);
            two_hosts(view);
            view.endpoints.truncate(2);
            // A custom socket's commit could not be shipped anywhere.
            view.endpoints[0].connection.target =
                herdr_client::ConnectTarget::Socket("/tmp/herdr.sock".into());
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            assert!(view.menu.dispatch.is_none());
        })
    });
}

#[gpui::test]
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn a_second_dispatch_waits_for_the_first(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            two_hosts(view);
            view.open_workspace_menu("w3", Default::default(), window, cx);
            view.open_workspace_dialog(WorkspaceAction::NewWorktree, window, cx);
            view.menu.dispatch.as_mut().unwrap().choose("ssh:box");
            view.menu.input = Some(DialogInput::new("bad branch name".into()));
            assert!(matches!(
                view.submit_dispatch(WorkspaceAction::NewWorktree, "ssh:box", None),
                Err(crate::Error::InvalidBranchName)
            ));
            assert!(view.dispatch_job.is_none(), "nothing starts on a bad name");
            assert!(matches!(
                view.submit_dispatch(WorkspaceAction::NewWorktree, "ssh:gone", None),
                Err(crate::Error::DispatchHostUnavailable(host)) if host == "ssh:gone"
            ));
        })
    });
}

fn setup_for(endpoint: &str, workspace: &str, now: std::time::Instant) -> crate::dispatch::Setup {
    crate::dispatch::Setup::new(
        endpoint.into(),
        workspace.into(),
        "agent-launcher".into(),
        crate::teleport::NewCheckout {
            repo_key: "/repo/.git".into(),
            path: "/nonexistent/herdr-dispatch-test".into(),
            root: None,
        },
        now,
    )
}

/// A worktree made elsewhere runs its setup once the window shows its host
/// and workspace, as one made here does, and gives up rather than wait.
#[gpui::test]
fn a_dispatched_worktree_sets_up_once_its_host_is_shown(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            two_hosts(view);
            let now = std::time::Instant::now();
            // Box is not the host shown, and w-new is not listed: both wait.
            view.queue_dispatch_setup(setup_for("ssh:box", "w3", now), cx);
            view.queue_dispatch_setup(setup_for(crate::endpoint::LOCAL, "w-new", now), cx);
            view.poll_dispatch_setup(now, cx);
            assert_eq!(view.dispatch_setups.len(), 2);
            assert!(view.worktree_script.is_none());
            // A later one that is ready starts without dropping those waiting.
            view.queue_dispatch_setup(setup_for(crate::endpoint::LOCAL, "w3", now), cx);
            view.poll_dispatch_setup(now, cx);
            assert!(view.worktree_script.is_some());
            assert_eq!(view.dispatch_setups.len(), 2, "earlier setups keep waiting");
            assert!(view.flash.is_none());
            // Hosts never shown are given up on, with a word.
            view.worktree_script = None;
            view.poll_dispatch_setup(now + std::time::Duration::from_secs(121), cx);
            assert!(view.dispatch_setups.is_empty());
            assert!(view.worktree_script.is_none());
            assert!(view.flash.is_some());
        })
    });
}

#[gpui::test]
fn waiting_setups_are_bounded(cx: &mut gpui::TestAppContext) {
    let (view, cx) = cx.add_window_view(sidebar::layout_tests::fixture_window);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            let now = std::time::Instant::now();
            for _ in 0..8 {
                view.queue_dispatch_setup(setup_for("ssh:box", "w3", now), cx);
            }
            assert!(view.flash.is_none());
            view.queue_dispatch_setup(setup_for("ssh:box", "w4", now), cx);
            assert_eq!(view.dispatch_setups.len(), 8);
            assert_eq!(view.dispatch_setups.back().unwrap().workspace_id, "w4");
            assert!(
                view.flash.is_some(),
                "the oldest is given up on, with a word"
            );
        })
    });
}
