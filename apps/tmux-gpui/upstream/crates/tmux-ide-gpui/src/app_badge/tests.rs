#![allow(clippy::unwrap_used)]

use super::*;
use crate::{
    sidebar::layout_tests::{fixture_window, snapshot},
    state::ConnectionStatus,
};
use herdr_client::ConnectTarget;

#[gpui::test]
fn first_snapshot_counts_existing_attention_without_surface_or_notifications(
    cx: &mut gpui::TestAppContext,
) {
    let handle = cx.add_window(fixture_window);
    handle
        .update(cx, |view, window, cx| {
            install(cx);
            let id = window.window_handle().window_id();
            sync(id, &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(0));

            let mut initial = snapshot(2);
            initial.agents[0].agent_status = AgentStatus::Done;
            initial.agents[1].agent_status = AgentStatus::Blocked;
            view.endpoints[0]
                .live
                .apply(herdr_client::ClientEvent::Snapshot(Arc::new(
                    initial.clone(),
                )));
            assert!(view.endpoints[0].live.surface.is_none());
            assert!(view.endpoints[0].live.notifications.is_empty());
            sync(id, &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(2));

            initial.revision += 1;
            initial.agents[0].agent_status = AgentStatus::Idle;
            view.endpoints[0]
                .live
                .apply(herdr_client::ClientEvent::Snapshot(Arc::new(initial)));
            sync(id, &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(1));
        })
        .unwrap();
}

#[gpui::test]
fn qa_preview_survives_polling_and_restores_daemon_attention(cx: &mut gpui::TestAppContext) {
    use crate::actions::SetBadgePreview;

    let handle = cx.add_window(fixture_window);
    handle.update(cx, |_, _, cx| install(cx)).unwrap();
    // Application-level actions work even without a connected daemon.
    cx.update(|cx| cx.dispatch_action(&SetBadgePreview { enabled: true }));
    cx.run_until_parked();
    handle
        .update(cx, |view, window, cx| {
            sync(window.window_handle().window_id(), &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(2));
        })
        .unwrap();
    cx.update(|cx| cx.dispatch_action(&SetBadgePreview { enabled: false }));
    cx.run_until_parked();
    cx.read_global::<Badge, _>(|badge, _| assert_eq!(badge.published, Some(0)));

    cx.update(|cx| cx.dispatch_action(&SetBadgePreview { enabled: true }));
    cx.run_until_parked();
    handle
        .update(cx, |view, window, cx| {
            let mut state = snapshot(2);
            state.agents[0].agent_status = AgentStatus::Done;
            view.endpoints[0].live.snapshot = Some(Arc::new(state));
            view.endpoints[0].live.status = ConnectionStatus::Connected;
            sync(window.window_handle().window_id(), &view.endpoints, cx);
        })
        .unwrap();
    cx.update(|cx| cx.dispatch_action(&SetBadgePreview { enabled: false }));
    cx.run_until_parked();
    cx.read_global::<Badge, _>(|badge, _| {
        assert!(!badge.preview);
        assert_eq!(badge.published, Some(1), "real attention remains visible");
    });
}

#[gpui::test]
fn only_done_and_blocked_need_attention_even_when_focused(cx: &mut gpui::TestAppContext) {
    let handle = cx.add_window(fixture_window);
    let id = handle.window_id();
    let mut badge = Badge::default();
    for (status, expected) in [
        (AgentStatus::Done, 1),
        (AgentStatus::Idle, 0),
        (AgentStatus::Blocked, 1),
        (AgentStatus::Working, 0),
        (AgentStatus::Unknown, 0),
    ] {
        let mut state = snapshot(2);
        state.agents[0].agent_status = status;
        state.agents[0].focused = true;
        let state = Arc::new(state);
        let contribution = badge.windows.entry(id).or_default();
        assert!(contribution.update(std::iter::once((None, &state))));
        assert!(!contribution.update(std::iter::once((None, &state))));
        badge.publish();
        assert_eq!(badge.published, Some(expected));
    }
    let mut state = snapshot(2);
    state.agents[1].agent_status = AgentStatus::Done;
    let mut state = Arc::new(state);
    assert!(
        badge
            .windows
            .entry(id)
            .or_default()
            .update(std::iter::once((None, &state)))
    );
    badge.publish();
    assert_eq!(badge.published, Some(1));
    // A replacement snapshot need not change its revision for the cache to notice.
    Arc::make_mut(&mut state).agents.clear();
    assert!(
        badge
            .windows
            .entry(id)
            .or_default()
            .update(std::iter::once((None, &state)))
    );
    badge.publish();
    assert_eq!(badge.published, Some(0));
}

#[gpui::test]
fn count_drops_from_two_to_one_despite_a_lagging_duplicate_window(cx: &mut gpui::TestAppContext) {
    let first = cx.add_window(fixture_window).window_id();
    let second = cx.add_window(fixture_window).window_id();
    let mut badge = Badge::default();
    let mut state = snapshot(2);
    state.revision = 500;
    for agent in &mut state.agents {
        agent.agent_status = AgentStatus::Done;
        agent.state_change_seq = 10;
    }
    let stale = Arc::new(state.clone());
    for id in [first, second] {
        badge
            .windows
            .entry(id)
            .or_default()
            .update(std::iter::once((None, &stale)));
    }
    badge.publish();
    assert_eq!(
        badge.published,
        Some(2),
        "two windows must not count four agents"
    );

    // A newly connected client can have a smaller projection revision.
    state.revision = 1;
    state.agents[0].agent_status = AgentStatus::Idle;
    let seen = Arc::new(state.clone());
    badge
        .windows
        .get_mut(&first)
        .unwrap()
        .update(std::iter::once((None, &seen)));
    badge.publish();
    assert_eq!(badge.published, Some(1));
    state.agents[1].agent_status = AgentStatus::Idle;
    let seen = Arc::new(state.clone());
    badge
        .windows
        .get_mut(&first)
        .unwrap()
        .update(std::iter::once((None, &seen)));
    badge.publish();
    assert_eq!(badge.published, Some(0));

    state.agents[0].agent_status = AgentStatus::Blocked;
    state.agents[0].state_change_seq = 11;
    let waiting = Arc::new(state);
    badge
        .windows
        .get_mut(&second)
        .unwrap()
        .update(std::iter::once((None, &waiting)));
    badge.publish();
    assert_eq!(
        badge.published,
        Some(1),
        "a new event supersedes an old acknowledgement"
    );

    // Separate hosts may report identical boot and pane IDs.
    badge
        .windows
        .get_mut(&first)
        .unwrap()
        .update(std::iter::once((Some("remote"), &waiting)));
    badge.publish();
    assert_eq!(badge.published, Some(2));
}

#[gpui::test]
fn hosts_disconnect_reconnect_and_disable_without_local_acknowledgement(
    cx: &mut gpui::TestAppContext,
) {
    let handle = cx.add_window(fixture_window);
    handle
        .update(cx, |view, window, cx| {
            install(cx);
            let mut remote = Endpoint::new(
                "remote".into(),
                "Remote".into(),
                ConnectTarget::Socket("/unused-badge.sock".into()),
                true,
            );
            let mut state = snapshot(2);
            state.agents[0].agent_status = AgentStatus::Blocked;
            remote.live.snapshot = Some(Arc::new(state));
            remote.live.status = ConnectionStatus::Connected;
            remote.collapsed = true;
            view.endpoints.push(remote);
            view.sidebar_visible = false;
            view.active = true;
            view.toasts_hidden = true;
            let id = window.window_handle().window_id();
            sync(id, &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(1));

            for status in [ConnectionStatus::Disconnected, ConnectionStatus::Detached] {
                view.endpoints[1].live.status = status;
                sync(id, &view.endpoints, cx);
                assert_eq!(cx.global::<Badge>().published, Some(0));
                view.endpoints[1].live.status = ConnectionStatus::Connected;
                sync(id, &view.endpoints, cx);
                assert_eq!(cx.global::<Badge>().published, Some(1));
            }
            view.endpoints[1].enabled = false;
            sync(id, &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(0));
            view.endpoints[1].enabled = true;
            sync(id, &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(1));
            view.endpoints.remove(1);
            sync(id, &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(0));
        })
        .unwrap();
}

#[gpui::test]
fn closing_windows_removes_only_their_contribution(cx: &mut gpui::TestAppContext) {
    let first = cx.add_window(fixture_window);
    let second = cx.add_window(fixture_window);
    let quiet = cx.add_window(fixture_window);
    first.update(cx, |_, _, cx| install(cx)).unwrap();
    for handle in [first, second] {
        handle
            .update(cx, |view, window, cx| {
                let mut state = snapshot(2);
                state.agents[0].agent_status = AgentStatus::Done;
                view.endpoints[0].live.snapshot = Some(Arc::new(state));
                view.endpoints[0].live.status = ConnectionStatus::Connected;
                sync(window.window_handle().window_id(), &view.endpoints, cx);
                assert_eq!(cx.global::<Badge>().published, Some(1));
            })
            .unwrap();
    }
    quiet
        .update(cx, |view, window, cx| {
            sync(window.window_handle().window_id(), &view.endpoints, cx);
            assert_eq!(cx.global::<Badge>().published, Some(1));
        })
        .unwrap();
    first
        .update(cx, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    cx.read_global::<Badge, _>(|badge, _| {
        assert_eq!(badge.windows.len(), 2);
        assert_eq!(badge.published, Some(1));
    });
    second
        .update(cx, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    cx.read_global::<Badge, _>(|badge, _| {
        assert_eq!(badge.windows.len(), 1);
        assert_eq!(badge.published, Some(0));
    });
    quiet
        .update(cx, |_, window, _| window.remove_window())
        .unwrap();
    cx.run_until_parked();
    cx.read_global::<Badge, _>(|badge, _| {
        assert!(badge.windows.is_empty());
        assert_eq!(badge.published, Some(0));
    });
}
