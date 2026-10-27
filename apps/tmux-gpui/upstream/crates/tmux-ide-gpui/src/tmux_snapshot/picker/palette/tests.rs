#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_snapshot::picker::tests::make_view;
use core::prelude::v1::test;
use gpui::TestAppContext;
use std::sync::mpsc;
#[allow(clippy::unwrap_used, clippy::expect_used)]
fn publication(scope: u64) -> attention::Publication {
    serde_json::from_value(serde_json::json!({"scope":scope,"revision":3,"phase":"live","rows":[
    {"key":"other-session-agent","sessionId":"other","paneId":"pane-other","name":"Same","sessionLabel":"Elsewhere","status":"IDLE","attention":false,"available":true}],
    "observedSessions":2,"totalSessions":2,"truncatedSessions":0,"truncatedRows":0,"note":null})).unwrap()
}
#[gpui::test]
#[allow(clippy::unwrap_used, clippy::expect_used)]
fn workspace_f5_global_agent_query_replaces_scope_and_preserves_terminal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w,cx|view.update(cx,|v,cx|{
  v.browser_state.fleet=Some(serde_json::from_value(serde_json::json!({"groups":[],"omittedGroups":0})).unwrap());
  v.browser_state.request=7;v.browser_state.palette_supported=true;v.browser_state.surface=browser::Surface::Workspace;
  v.open_commands(w,cx);v.palette.due=Some(Instant::now());v.flush_palette(cx);
  assert!(matches!(receiver.try_recv().unwrap(),browser::Command::PaletteObserve{scope:1,active:true,..}));
  v.browser_state.palette_agents=Some(publication(1));v.refresh_picker(cx);
  let old=v.picker.as_ref().unwrap().rows.iter().find(|r| r.label.contains("Elsewhere")).unwrap().target.clone();
  v.picker.as_ref().unwrap().search.update(cx,|s,cx|s.set_text_selected("Elsewhere",cx));v.refresh_picker(cx);
  assert!(receiver.try_recv().is_err(),"Query replacement must retain the scanner");
  v.choose_picker(old,w,cx);assert!(receiver.try_recv().is_err());
  v.palette.due=Some(Instant::now());v.flush_palette(cx);
  assert!(matches!(receiver.try_recv().unwrap(),browser::Command::PaletteObserve{scope:2,active:true,query,..} if query=="Elsewhere"));
  v.browser_state.palette_agents=Some(publication(2));v.refresh_picker(cx);
  let target=v.picker.as_ref().unwrap().rows.iter().find(|r|matches!(&r.target,Target::DirectNavigation(_))).unwrap().target.clone();
  v.attention.last_request=20;
  let previous=v.browser_request;let frame=v.frame.clone();
  v.choose_picker(target.clone(),w,cx);
  assert!(matches!(receiver.try_recv().unwrap(),browser::Command::OpenPaletteAgent{request:21,scope:2,roster_revision:3,key,..}if key=="other-session-agent"));
  assert_eq!(v.browser_request,previous);assert_eq!(v.frame.is_some(),frame.is_some());
  v.choose_picker(target,w,cx);assert!(receiver.try_recv().is_err());
  let mut rejected=v.browser_state.clone();rejected.palette_selection_rejected=v.palette.pending;
  v.apply_browser_state(Some(rejected),cx);assert!(v.palette.pending.is_none());assert_eq!(v.browser_request,previous);
  v.open_attention(w,cx);assert!(matches!(receiver.try_recv().unwrap(),browser::Command::PaletteObserve{active:false,..}));
 }));
}
fn enable(v: &mut SnapshotView) {
    v.browser_state.request = v.browser_request;
    v.browser_state.palette_supported = true;
    v.browser_state.fleet =
        Some(serde_json::from_value(serde_json::json!({"groups":[],"omittedGroups":0})).unwrap());
}
#[gpui::test]
fn palette_close_exhaustion_recovers_only_after_explicit_reopen(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            enable(v);
            v.open_commands(w, cx);
            v.palette.due = Some(Instant::now());
            v.flush_palette(cx);
            // Keep the observation command occupying the channel while close retries exhaust.
            v.cancel_palette();
            for _ in 0..301 {
                v.flush_palette_close();
            }
            assert!(v.palette.pending_close.is_some_and(|(_, _, n)| n == 300));
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::PaletteObserve {
                    active: true,
                    scope: 1,
                    ..
                }
            ));
            v.flush_palette_close();
            assert!(receiver.try_recv().is_err());
            v.open_commands(w, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::PaletteObserve {
                    active: false,
                    scope: 1,
                    ..
                }
            ));
            v.palette.due = Some(Instant::now());
            v.flush_palette(cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::PaletteObserve {
                    active: true,
                    scope: 2,
                    ..
                }
            ));
        })
    });
}
#[gpui::test]
fn palette_replaced_picker_marked_text_background_and_pending_fences(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            enable(v);
            v.open_commands(w, cx);
            v.palette.due = Some(Instant::now());
            v.flush_palette(cx);
            receiver.try_iter().for_each(drop);
            v.browser_state.palette_agents = Some(publication(1));
            v.refresh_picker(cx);
            let old = v
                .picker
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .find(|r| r.label.contains("Elsewhere"))
                .unwrap()
                .target
                .clone();
            v.marked = "marked".into();
            v.choose_picker(old.clone(), w, cx);
            assert!(receiver.try_recv().is_err());
            v.marked.clear();
            v.open_commands(w, cx);
            receiver.try_iter().for_each(drop);
            v.choose_picker(old, w, cx);
            assert!(receiver.try_recv().is_err());
            v.palette.due = Some(Instant::now());
            v.flush_palette(cx);
            receiver.try_iter().for_each(drop);
            v.browser_state.palette_agents = Some(publication(2));
            v.refresh_picker(cx);
            let target = v
                .picker
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .find(|r| r.label.contains("Elsewhere"))
                .unwrap()
                .target
                .clone();
            v.choose_picker(target, w, cx);
            let pending = v.palette.pending.unwrap();
            receiver.try_iter().for_each(drop);
            v.presence.set_active(false);
            v.cancel_palette();
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::PaletteObserve {
                    active: false,
                    scope: 2,
                    ..
                }
            ));
            let mut accepted = v.browser_state.clone();
            accepted.request = pending.request;
            v.apply_browser_state(Some(accepted), cx);
            assert_eq!(v.browser_request, pending.request);
            assert!(v.picker.is_none());
            assert!(!v.presence.ready());
            assert!(receiver.try_recv().is_err());
        })
    });
}
#[test]
fn palette_wire_encoding_and_bounded_publication_reuse_are_strict() {
    let command = browser::Command::PaletteObserve {
        request: 7,
        scope: 2,
        active: true,
        query: "界🙂".into(),
    };
    assert_eq!(
        serde_json::to_value(command).unwrap(),
        serde_json::json!({"type":"palette-observe","request":7,"scope":2,"active":true,"query":"界🙂"})
    );
    let mut p = publication(0);
    assert!(!p.valid());
    p.scope = 1;
    assert!(p.valid());
    p.scope = 9_007_199_254_740_992;
    assert!(!p.valid());
    let rejected = Rejected {
        request: 8,
        from_request: 7,
        scope: 1,
    };
    assert!(rejected.valid());
    assert!(
        !Rejected {
            request: 7,
            ..rejected
        }
        .valid()
    );
}
#[gpui::test]
fn close_during_query_debounce_cancels_last_remote_scope(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            enable(v);
            v.open_commands(w, cx);
            v.palette.due = Some(Instant::now());
            v.flush_palette(cx);
            receiver.try_iter().for_each(drop);
            v.browser_state.palette_agents = Some(publication(1));
            v.refresh_picker(cx);
            let old = v
                .picker
                .as_ref()
                .unwrap()
                .rows
                .iter()
                .find(|r| r.label.contains("Elsewhere"))
                .unwrap()
                .target
                .clone();
            v.picker
                .as_ref()
                .unwrap()
                .search
                .update(cx, |s, cx| s.set_text_selected("new query", cx));
            v.refresh_picker(cx);
            assert!(v.palette.active.is_none());
            assert_eq!(v.palette.remote_observed, Some((7, 1)));
            v.choose_picker(old, w, cx);
            assert!(receiver.try_recv().is_err());
            v.close_picker(w, cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::PaletteObserve {
                    active: false,
                    scope: 1,
                    ..
                }
            ));
            v.flush_palette(cx);
            assert!(receiver.try_recv().is_err());
            assert!(v.palette.remote_observed.is_none());
        })
    });
}
#[gpui::test]
fn f7_and_generic_navigation_exceed_rejected_palette_watermark(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            v.browser_state.request = 7;
            v.palette.last_request = 21;
            v.browser_state.attention_supported = true;
            v.open_attention(w, cx);
            receiver.try_iter().for_each(drop);
            v.choose_attention(1, 3, "attention-key", cx);
            assert!(matches!(
                receiver.try_recv().unwrap(),
                browser::Command::OpenAttentionAgent { request: 22, .. }
            ));
            v.select(Selection::Home, w, cx);
            assert!(
                receiver
                    .try_iter()
                    .any(|c| matches!(c, browser::Command::Home { request: 23 }))
            );
        })
    });
}

#[test]
fn palette_projection_is_not_refiltered_after_authoritative_query() {
    let state = browser::State {
        palette_supported: true,
        fleet: Some(
            serde_json::from_value(serde_json::json!({"groups":[],"omittedGroups":0})).unwrap(),
        ),
        palette_agents: Some(publication(1)),
        ..Default::default()
    };
    let mut rows = navigation_commands::rows(&state, "workspace agent elsewhere");
    navigation_commands::retain_palette_scope(&mut rows, Some((0, 1)));
    assert_eq!(rows.len(), 1);
    navigation_commands::retain_palette_scope(&mut rows, None);
    assert!(rows.is_empty());
}

#[test]
fn older_fleet_helper_preserves_context_agents_without_global_claim() {
    let mut state = browser::State {
        surface: browser::Surface::Home,
        fleet: Some(
            serde_json::from_value(serde_json::json!({"groups":[],"omittedGroups":0})).unwrap(),
        ),
        home_agents: Some(publication(1).roster),
        ..Default::default()
    };
    assert_eq!(
        navigation_commands::rows(&state, "agent elsewhere").len(),
        1
    );
    state.palette_supported = true;
    assert!(navigation_commands::rows(&state, "agent elsewhere").is_empty());
    state.palette_agents = Some(publication(1));
    assert_eq!(
        navigation_commands::rows(&state, "agent elsewhere").len(),
        1
    );
}
