#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::picker::tests::make_view;
use core::prelude::v1::test;
use gpui::TestAppContext;
use std::sync::mpsc;

fn publication() -> crate::tmux_snapshot::workspace_fleet_agents::Publication {
    serde_json::from_value(serde_json::json!({"request":7,"scope":2,"revision":3,"phase":"live","selectedKey":null,"observedSessions":1,"totalSessions":1,"truncatedSessions":0,"truncatedRows":0,"note":null,"rows":[{"key":"target","sessionId":"session","paneId":"pane","name":"Agent","sessionLabel":"Session","status":"IDLE","attention":false,"available":true}]})).unwrap()
}

#[gpui::test]
fn workspace_agent_pending_blocks_palette_and_attention_until_admission(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| view.update(cx, |v, cx| exercise(v, cx, &receiver)));
}

fn exercise(
    v: &mut SnapshotView,
    cx: &mut Context<SnapshotView>,
    receiver: &mpsc::Receiver<browser::Command>,
) {
    v.browser_state.request = 7;
    v.browser_state.surface = browser::Surface::Workspace;
    v.browser_state.workspace_fleet_agents = Some(publication());
    v.select_workspace_fleet_agent(7, 2, 3, "target", cx);
    assert!(matches!(
        receiver.try_recv().unwrap(),
        browser::Command::OpenWorkspaceFleetAgent { request: 8, .. }
    ));
    v.palette.active = Some((7, 5));
    v.attention.active = Some((7, 6));
    v.choose_palette(5, 3, "other", cx);
    v.choose_attention(6, 3, "other", cx);
    assert!(
        receiver.try_recv().is_err(),
        "No competing old-request agent navigation may be queued"
    );
    assert!(v.palette.pending.is_none());
    assert!(v.attention.pending.is_none());
    // The mailbox may omit Loading: the final admitted state must still settle request 8.
    let mut accepted = v.browser_state.clone();
    accepted.request = 8;
    accepted.workspace_fleet_agents = None;
    v.apply_browser_state(Some(accepted), cx);
    assert_eq!(v.browser_request, 8);
    assert!(v.workspace_fleet_agents.pending.is_none());
}
