use super::*;
use crate::{preferences::AgentSort, state::ConnectionStatus};

/// Priority lists every host's agents in one order, as Herdr's terminal client
/// does, so a blocked agent on a remote host is painted above an idle local
/// one. Grouped keeps hosts apart, and the agent shortcuts step through the
/// rows in the order they are painted either way.
#[gpui::test]
fn priority_paints_every_hosts_agents_in_one_order(cx: &mut gpui::TestAppContext) {
    let (fixture, cx) = cx.add_window_view(|window, cx| {
        let view = cx.new(|cx| {
            let mut view = fixture_window(window, cx);
            let mut listing = snapshot(1);
            listing.agents.truncate(1);
            listing.agents[0].agent_status = AgentStatus::Idle;
            view.live.snapshot = Some(Arc::new(listing.clone()));
            view.live.status = ConnectionStatus::Connected;
            let mut remote = crate::endpoint::Endpoint::new(
                "ssh:test".into(),
                "Remote".into(),
                ConnectTarget::Ssh {
                    target: "unused".into(),
                    session: "default".into(),
                },
                true,
            );
            listing.agents[0].agent_status = AgentStatus::Blocked;
            remote.live.snapshot = Some(Arc::new(listing));
            remote.live.status = ConnectionStatus::Connected;
            view.endpoints.push(remote);
            view
        });
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        SidebarFixture(view)
    });
    let view = cx.update(|_, cx| fixture.read(cx).0.clone());
    cx.simulate_resize(size(px(800.), px(600.)));
    cx.run_until_parked();
    let (local, remote) = ("agent-local-p0", "agent-ssh:test-p0");
    for (sort, above, below, hosts) in [
        (AgentSort::Grouped, local, remote, [0, 1]),
        (AgentSort::Priority, remote, local, [1, 0]),
    ] {
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                view.agent_sort = sort;
                cx.notify();
            });
            window.refresh();
            full_draw(window, cx).clear(cx);
        });
        let (top, bottom) = (
            cx.debug_bounds(above).unwrap(),
            cx.debug_bounds(below).unwrap(),
        );
        assert!(top.top() < bottom.top(), "{sort:?}: {top:?} {bottom:?}");
        cx.update(|_, cx| {
            let stepped: Vec<_> = view
                .read(cx)
                .sidebar_agents()
                .into_iter()
                .map(|(host, _)| host)
                .collect();
            assert_eq!(stepped, hosts, "{sort:?}");
        });
    }
}
