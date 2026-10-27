use super::*;
use crate::tmux_snapshot::picker::pane_commands::Action as PaneAction;
#[gpui::test]
fn old_global_callbacks_cannot_escape_replacement_pane_context(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            view.browser_state.surface = browser::Surface::Workspace;
            view.browser_state.selected_session = Some("session-a".into());
            view.browser_state.pane_actions = Some(browser::PaneActions {
                token: "312b2c16-a13d-4411-82e5-1fdb58adab92".into(),
                id: "pane-a".into(),
                zoomed: false,
            });
            view.open_commands(window, cx);
            let stale: Vec<_> = view
                .picker
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .filter(|row| {
                    matches!(
                        row.target,
                        Target::Command(_)
                            | Target::PaneAction {
                                action: PaneAction::NewWindow | PaneAction::NewAgent,
                                ..
                            }
                    )
                })
                .map(|row| row.target.clone())
                .collect();
            assert!(!stale.is_empty());
            view.open_header_actions(window, cx);
            assert!(view.picker.as_ref().unwrap().pane_scope.is_some());
            for target in stale {
                view.choose_picker(target, window, cx);
                let picker = view.picker.as_ref().unwrap();
                assert!(picker.pane_scope.is_some());
                assert!(picker.agent.is_none());
                assert!(picker.closing.is_none());
                assert!(receiver.try_recv().is_err());
            }
        });
    });
    cx.simulate_resize(size(px(900.), px(650.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let bounds = cx.debug_bounds("commands-popover").unwrap();
    assert_eq!(bounds.size.width, px(360.));
    assert!(bounds.size.height > px(0.) && bounds.size.height <= px(340.));
    cx.simulate_resize(size(px(300.), px(260.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let bounds = cx.debug_bounds("commands-popover").unwrap();
    assert!(bounds.size.width <= px(276.) && bounds.size.height <= px(240.));
}
