//! Pending and stale presentation of the kept controls.
use super::*;
use std::time::{Duration, Instant};
fn publication(view: &SnapshotView, state: BrowserState) -> browser::State {
    let mut next = view.browser_state.clone();
    next.browser_pending = None;
    next.browser_controls.insert("pane-a".into(), state);
    next
}
#[gpui::test]
fn a_pending_click_blocks_repeats_until_a_new_observation(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            ready(view, observed(7));
            let back = BrowserCommand::new(&observed(7), BrowserAction::Back, None);
            view.send_browser("pane-a", back.clone(), cx);
            assert!(view.pending_browser("pane-a") == Some(BrowserAction::Back));
            view.send_browser("pane-a", back.clone(), cx);
            assert!(sent(&receiver) == [(BrowserAction::Back, 7)]);
            // A publication with the same observation (a terminal frame) keeps it pending.
            let same = publication(view, observed(7));
            view.apply_browser_state(Some(same), cx);
            assert!(view.pending_browser("pane-a") == Some(BrowserAction::Back));
            // The next read confirms: pending clears and the controls stay.
            let next = publication(view, observed(8));
            view.apply_browser_state(Some(next), cx);
            assert!(view.pending_browser("pane-a").is_none());
            assert!(view.browser_header("pane-a", cx).is_some());
            let back = BrowserCommand::new(&observed(8), BrowserAction::Back, None);
            view.send_browser("pane-a", back, cx);
            assert!(sent(&receiver) == [(BrowserAction::Back, 8)]);
        })
    });
}
#[gpui::test]
fn a_rejection_or_timeout_settles_the_pending_click(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            ready(view, observed(7));
            view.browser_state
                .browser_marks
                .insert("pane-a".into(), Mark::Rejected(1));
            let back = BrowserCommand::new(&observed(7), BrowserAction::Back, None);
            view.send_browser("pane-a", back, cx);
            // The old rejection still in flight does not settle the new click.
            let mut old = publication(view, observed(7));
            old.browser_marks.insert("pane-a".into(), Mark::Rejected(1));
            view.apply_browser_state(Some(old.clone()), cx);
            assert!(view.pending_browser("pane-a") == Some(BrowserAction::Back));
            old.browser_marks.insert("pane-a".into(), Mark::Rejected(2));
            view.apply_browser_state(Some(old), cx);
            assert!(view.pending_browser("pane-a").is_none());
            assert!(view.browser_header("pane-a", cx).is_some());
            view.browser_state.browser_marks.clear();
            view.browser_state.browser_pending = Some(Pending {
                pane: "pane-a".into(),
                action: BrowserAction::Back,
                basis: observed(7),
                mark: None,
                at: Instant::now().checked_sub(Duration::from_secs(4)).unwrap(),
            });
            assert!(view.pending_browser("pane-a").is_none());
            assert!(sent(&receiver).len() == 1);
        })
    });
}
#[gpui::test]
fn stale_controls_stay_visible_but_inert(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            ready(view, observed(7));
            view.browser_state
                .browser_marks
                .insert("pane-a".into(), Mark::Stale);
            assert!(view.browser_header("pane-a", cx).is_some());
            assert!(view.current_browser("pane-a").is_none());
            let back = BrowserCommand::new(&observed(7), BrowserAction::Back, None);
            view.send_browser("pane-a", back, cx);
            assert!(sent(&receiver).is_empty());
        })
    });
}
#[test]
fn rebase_keeps_only_clicks_that_still_mean_the_same() {
    let basis = observed(7);
    let back = BrowserCommand::new(&basis, BrowserAction::Back, None);
    let title_only = observed(8);
    assert!(rebase(&back, &basis, &title_only).map(|c| c.revision) == Some(8));
    let mut navigated = observed(8);
    navigated.url = "https://example.com/next".into();
    assert!(rebase(&back, &basis, &navigated).is_none());
    let mut loading = observed(8);
    loading.loading = true;
    assert!(rebase(&back, &basis, &loading).is_none());
    let mut no_history = observed(8);
    no_history.can_go_back = false;
    assert!(rebase(&back, &basis, &no_history).is_none());
    let mut other_tab = observed(8);
    other_tab.tab = 2;
    assert!(rebase(&back, &basis, &other_tab).is_none());
}
