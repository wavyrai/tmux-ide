use super::*;
fn prepare(view: &mut SnapshotView) {
    view.browser_state.request = view.browser_request;
    view.browser_state.selected_session = Some("session".into());
    view.browser_state.presence_revision = 1;
    view.browser_state.native_focus_target = Some(crate::tmux_snapshot::pending_input::Target {
        id: "pane-a".into(),
        token: "a".repeat(64),
    });
    view.browser_state.copy_region = Some(crate::tmux_snapshot::copy::Region {
        id: "pane-a".into(),
        left: 0,
        top: 0,
        width: 1,
        height: 1,
        wrapped: vec![false],
    });
    view.presence.set_active(false);
    view.presence.flush(view.browser_commands.as_ref().unwrap());
    view.presence.set_active(true);
    view.presence.flush(view.browser_commands.as_ref().unwrap());
    assert_eq!(view.presence.queued_active_revision(), Some(3));
}
fn confirmation(view: &SnapshotView) -> browser::State {
    let mut state = view.browser_state.clone();
    state.presence_revision = 3;
    state.input_ready = true;
    state.input_targets = vec![state.native_focus_target.clone().unwrap()];
    state
}
#[gpui::test]
fn focus_click_holds_exact_text_until_presence_and_authority_then_sends_once(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window,cx| view.update(cx,|view,cx| {
        prepare(view); receiver.try_iter().for_each(drop);
        click(view,window,cx);
        assert!(!view.input_interrupted,"zero-input click cannot latch interruption");
        assert!(view.focus_reclaim_ready());
        view.replace_text_in_range(None,"FOCUS-RETURN",window,cx);
        view.terminal_key(&key("enter"),window,cx);
        assert!(receiver.try_recv().is_err(),"no send before presence ACK");
        let mut state = confirmation(view);
        state.input_ready = false;
        state.input_targets.clear();
        view.apply_browser_state(Some(state),cx);
        assert!(view.presence.ready());
        assert!(receiver.try_recv().is_err(),"presence alone is not input authority");
        let state = confirmation(view);
        view.apply_browser_state(Some(state.clone()),cx);
        for expected in [Input::Text("FOCUS-RETURN".into()),Input::Key("Enter".into())] {
            assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input { request:7,id,input_target:Some(token),input } if id=="pane-a" && token=="a".repeat(64) && input==expected));
        }
        view.apply_browser_state(Some(state),cx);
        assert!(receiver.try_recv().is_err(),"confirmed input must never replay");
        assert!(view.pending_input.is_none());
    }));
}
#[gpui::test]
fn focus_buffer_drops_on_scope_blur_rejection_timeout_and_never_sends_suffix(
    cx: &mut TestAppContext,
) {
    for change in 0..9 {
        let (sender, receiver) = mpsc::sync_channel(32);
        let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
        cx.update(|window, cx| {
            view.update(cx, |view, cx| {
                prepare(view);
                receiver.try_iter().for_each(drop);
                click(view, window, cx);
                view.replace_text_in_range(None, "prefix", window, cx);
                let mut state = confirmation(view);
                match change {
                    0 => state.selected_pane = Some("other".into()),
                    1 => state.selected_session = Some("other".into()),
                    2 => state.native_focus_target.as_mut().unwrap().token = "b".repeat(64),
                    3 => view.presence.set_active(false),
                    4 => state.input_target_rejected = true,
                    5 => view.age_pending_input(),
                    6 => view.browser_request += 1,
                    7 => state.history_offset = 1,
                    _ => state.native_focus_target = None,
                }
                view.apply_browser_state(Some(state), cx);
                view.expire_pending_input(cx);
                assert!(view.input_interrupted, "change {change}");
                assert!(view.pending_input.is_none());
                view.replace_text_in_range(None, "suffix", window, cx);
                view.terminal_key(&key("enter"), window, cx);
                assert!(
                    receiver.try_recv().is_err(),
                    "changed focus scope cannot dispatch {change}"
                );
            })
        });
    }
}
#[gpui::test]
fn zero_input_early_click_without_native_proof_does_not_latch(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            receiver.try_iter().for_each(drop);
            click(view, window, cx);
            assert!(!view.input_interrupted);
            assert!(view.pending_input.is_none());
            view.replace_text_in_range(None, "unverified", window, cx);
            assert!(view.input_interrupted);
            assert!(receiver.try_recv().is_err());
        })
    });
}

#[gpui::test]
fn native_copy_selection_identity_does_not_turn_focus_click_into_selection(
    cx: &mut TestAppContext,
) {
    native_focus_case(cx, false, false);
}
#[gpui::test]
fn projected_focus_reclaim_needs_no_copy_identity(cx: &mut TestAppContext) {
    native_focus_case(cx, true, false);
}
#[gpui::test]
fn projected_focus_reclaim_survives_background_cursor_publication(cx: &mut TestAppContext) {
    native_focus_case(cx, true, true);
}
#[gpui::test]
fn complete_focus_reclaim_survives_background_cursor_publication(cx: &mut TestAppContext) {
    native_focus_case(cx, false, true);
}
fn native_focus_case(cx: &mut TestAppContext, partial: bool, background_update: bool) {
    use herdr_client::{
        tmux_delivery::{Update, decode_compact},
        tmux_native_session::{CommittedIdentity, CommittedPane},
        tmux_topology::{CopyRegion, PresentedWindow, Region, WindowPaint},
    };
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window,cx| view.update(cx,|view,cx| {
        prepare(view);
        let value = serde_json::json!({"v":1,"k":"terminal-semantic-compact","f":"s","r":1,"s":[1,1,[[0,[[1,"a",1,0,0,0]]]],[],[0,0,0,"block",0],[0,0,0,0,0,0,1,0,null,null,0],[],["authoritative-stream","observed-from-start"]]});
        let Update::Seed { mut snapshot,.. } = decode_compact(&serde_json::to_vec(&value).unwrap()).unwrap() else { panic!("seed") };
        if partial {
            snapshot.modes.alternate_screen=true;
            snapshot.history=herdr_client::tmux_delivery::History::Deferred(herdr_client::tmux_delivery::DeferredHistory{rows:350,digest:"0123456789abcdef".into()});
        }
        let snapshot = Arc::new(snapshot);
        let present = |snapshot:Arc<herdr_client::tmux_delivery::Snapshot>| {
        let paint = WindowPaint { window:"window".into(),selected_pane:"pane-a".into(),cols:1,rows:1,
            copy_region:CopyRegion {pane:"pane-a".into(),left:0,top:0,width:1,height:1,wrapped:vec![false]},
            modes:snapshot.modes.clone(),cursor:snapshot.cursor.clone(),mode_keys:None,zoomed:false,
            regions:vec![Region {pane:"pane-a".into(),left:0,top:0,width:1,height:1,content_top:0,content_rows:1,
                source:Arc::new(CommittedPane {snapshot:Some(snapshot),identity:Arc::new(CommittedIdentity {generation:"generation".into(),incarnation:"pane:1".into(),delivery_nonce:"nonce".into(),canonical_revision:1,canonical_state_hash:"hash".into()})})}]};
        PresentedWindow {paint:Arc::new(paint),coherent:true}
        };
        let mut presented=present(snapshot.clone());
        let mut projection = crate::tmux_snapshot::browser_direct::NativePresentation::new("connection","workspace");
        projection.apply(&mut view.browser_state,&presented,false,2,0).unwrap();
        view.frame = view.browser_state.frame.clone();
        view.input_geometry=Some((Bounds::new(point(px(0.),px(0.)),size(px(500.),px(500.))),Bounds::default()));
        view.input_cell_width=Some(10.);
        view.painted_frame = view.frame.clone();
        view.record_painted_focus();
        assert!(view.painted_focus.is_some(),"native painted proof captured");
        assert!(view.focus_click_matches_selected(view.test_cell_point(0.5,0.25)),"synthetic painted geometry admits click before publication");
        assert!(previous_focus_click_matches_selected(view,point(px(5.),px(5.))));
        let before_target=view.browser_state.native_focus_target.clone();
        let before_regions=view.browser_state.regions.clone();
        let before_geometry=view.input_geometry;
        let before_width=view.input_cell_width;
        if background_update {
            let mut updated=(*snapshot).clone();updated.cursor.hidden=true;
            presented=present(Arc::new(updated));
            projection.apply(&mut view.browser_state,&presented,false,2,1).unwrap();
            view.frame=view.browser_state.frame.clone();
            assert!(!crate::tmux_snapshot::hit_regions::is_painted(view.frame.as_ref(),view.painted_frame.as_ref()));
            assert!(before_target==view.browser_state.native_focus_target,"same connection/pane/lifetime token");
            assert!(before_regions==view.browser_state.regions,"same pane rectangles");
            assert!(before_geometry==view.input_geometry && before_width==view.input_cell_width,"same pixel geometry");
            assert!(!previous_focus_click_matches_selected(view,point(px(5.),px(5.))),"pre-fix predicate refuses unchanged focus target after content publication");
            let state=view.browser_state.clone();
            let position=view.test_cell_point(0.5,0.25);
            assert!(view.focus_click_matches_selected(position));
            for change in 0..6 {
                match change {
                    0 => view.browser_state.native_focus_target.as_mut().unwrap().token="c".repeat(64),
                    1 => view.browser_state.regions[0].width+=1,
                    2 => {view.browser_request+=1;view.browser_state.request+=1;},
                    3 => view.browser_state.selected_session=Some("other".into()),
                    4 => view.input_cell_width=Some(11.),
                    _ => view.input_geometry.as_mut().unwrap().0.origin.x=px(1.),
                }
                assert!(!view.focus_click_matches_selected(position),"changed painted proof {change}");
                view.browser_state=state.clone();view.browser_request=state.request;
                view.input_cell_width=Some(10.);view.input_geometry.as_mut().unwrap().0.origin.x=px(0.);
            }

        }
        assert_eq!(view.browser_state.selection_identity.is_some(),!partial);
        receiver.try_iter().for_each(drop);
        if background_update {
            view.terminal_click(&MouseDownEvent {position:view.test_cell_point(0.5,0.25),button:MouseButton::Left,..Default::default()},window,cx);
        } else {click(view,window,cx);}
        assert!(view.focus_reclaim_ready());
        assert!(view.selection.is_none());
        view.replace_text_in_range(None,"whole",window,cx);
        let mut state = view.browser_state.clone();
        projection.apply(&mut state,&presented,true,3,0).unwrap();
        view.apply_browser_state(Some(state),cx);
        assert!(matches!(receiver.try_recv().unwrap(),browser::Command::Input{input:Input::Text(t),..} if t=="whole"));
        assert!(receiver.try_recv().is_err());
    }));
}

#[gpui::test]
fn early_click_on_other_pane_cannot_arm_old_pane_when_authority_arrives(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(32);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare(view);
            receiver.try_iter().for_each(drop);
            view.browser_state.regions[0].id = "pane-other".into();
            click(view, window, cx);
            assert!(view.input_interrupted);
            assert!(view.pending_input.is_none());
            let state = confirmation(view);
            view.apply_browser_state(Some(state), cx);
            view.replace_text_in_range(None, "not-for-old-pane", window, cx);
            view.terminal_key(&key("enter"), window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}

// Differential control copied from the pre-fix focus_reclaim.rs predicate.
// This tests that exact old admission predicate, not a separately built app.
fn previous_focus_click_matches_selected(view: &SnapshotView, position: Point<Pixels>) -> bool {
    if !crate::tmux_snapshot::hit_regions::is_painted(
        view.frame.as_ref(),
        view.painted_frame.as_ref(),
    ) {
        return false;
    }
    let (Some((bounds, _)), Some(width), Some(selected)) = (
        view.input_geometry,
        view.input_cell_width,
        view.browser_state.selected_pane.as_deref(),
    ) else {
        return false;
    };
    if !bounds.contains(&position) {
        return false;
    }
    let point = position - bounds.origin;
    crate::tmux_snapshot::hit_regions::hit(
        &view.browser_state.regions,
        f32::from(point.x),
        f32::from(point.y),
        width,
        view.terminal_height(),
    ) == Some(selected)
}
