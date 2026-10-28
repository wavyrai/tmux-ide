use super::*;
use crate::tmux_snapshot::session_tabs::Activity;
pub(super) fn complete_inactive(bridge: &Bridge) -> String {
    let before = until(bridge, |s| {
        s.request == 3
            && s.input_ready
            && s.session_tabs.as_ref().is_some_and(|p| {
                p.rows.iter().any(|r| {
                    Some(&r.id) != p.active.as_ref()
                        && matches!(r.activity, Some(Activity::Running))
                })
            })
    });
    let tabs = before.session_tabs.as_ref().unwrap();
    let row = tabs
        .rows
        .iter()
        .find(|r| {
            Some(&r.id) != tabs.active.as_ref() && matches!(r.activity, Some(Activity::Running))
        })
        .unwrap();
    let id = row.id.clone();
    assert!(!row.unread);
    eprintln!("NATIVE_INACTIVE_AGENT_COMPLETION_READY");
    let after = until(bridge, |s| {
        s.request == 3
            && s.session_tabs.as_ref().is_some_and(|p| {
                p.rows
                    .iter()
                    .any(|r| r.id == id && r.unread && matches!(r.activity, Some(Activity::Idle)))
            })
    });
    assert!(after.input_ready);
    assert_eq!(after.selected_pane, before.selected_pane);
    let updated = after.session_tabs.as_ref().unwrap();
    let completed = updated.rows.iter().find(|r| r.id == id).unwrap();
    assert_eq!(updated.revision, tabs.revision);
    assert_eq!(completed.activate, row.activate);
    assert_eq!(completed.close, row.close);
    eprintln!("NATIVE_INACTIVE_AGENT_COMPLETION_VERIFIED");
    id
}
