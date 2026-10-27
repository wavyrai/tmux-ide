#![allow(clippy::unwrap_used)]
use super::*;
use core::prelude::v1::test;
use gpui::TestAppContext;
use std::sync::mpsc;

fn prepare(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.browser_state.machines = Some(
        serde_json::from_value(serde_json::json!({
            "revision":12,"available":true,"pending":false,"message":null,"error":null,
            "machines":[{"id":"00000000-0000-4000-8000-000000000001","label":"Original",
            "sshTarget":"old-host","enabled":true,"expectedEnvironmentId":null}]
        }))
        .unwrap(),
    );
    view.input_interrupted = true;
    view.open_picker_mode(Mode::ManageMachines, window, cx);
    view.begin_machine_edit("00000000-0000-4000-8000-000000000001", 12, window, cx);
}

#[gpui::test]
fn footer_reverse_traversal_cancel_and_escape_preserve_terminal(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| tests::make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("shift-tab");
    cx.update(|w, cx| {
        view.read_with(cx, |v, _| {
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .edit
                    .as_ref()
                    .unwrap()
                    .cancel_focus
                    .is_focused(w)
            )
        })
    });
    cx.simulate_keystrokes("shift-tab");
    cx.update(|w, cx| {
        view.read_with(cx, |v, _| {
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .edit
                    .as_ref()
                    .unwrap()
                    .save_focus
                    .is_focused(w)
            )
        })
    });
    cx.simulate_keystrokes("tab enter");
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    view.read_with(cx, |v, _| {
        assert!(v.picker.is_none());
        assert!(v.input_interrupted);
    });
    assert!(receiver.try_recv().is_err());
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_keystrokes("tab tab escape");
    view.read_with(cx, |v, _| assert!(v.picker.is_none()));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn save_footer_activates_once_and_pending_skips_save_but_keeps_cancel(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| tests::make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_input("Renamed");
    cx.simulate_keystrokes("tab tab enter");
    cx.simulate_event(KeyDownEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
        is_held: true,
        prefer_character_input: false,
        layout: None,
    });
    assert!(receiver.try_recv().is_err(), "footer must wait for key-up");
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    let command = serde_json::to_value(receiver.try_recv().unwrap()).unwrap();
    assert_eq!(command["change"]["patch"]["label"], "Renamed");
    assert_eq!(command["operation"], "mutate");
    assert!(receiver.try_recv().is_err());
    cx.update(|w, cx| {
        view.update(cx, |v, _| {
            v.browser_state.machines.as_mut().unwrap().pending = true
        });
        w.draw(cx).clear(cx);
        view.read_with(cx, |v, _| {
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .edit
                    .as_ref()
                    .unwrap()
                    .cancel_focus
                    .is_focused(w)
            )
        });
    });
    cx.simulate_keystrokes("shift-tab");
    cx.update(|w, cx| {
        view.read_with(cx, |v, cx| {
            assert!(
                v.picker
                    .as_ref()
                    .unwrap()
                    .edit
                    .as_ref()
                    .unwrap()
                    .target
                    .read(cx)
                    .focus
                    .is_focused(w)
            )
        })
    });
    cx.simulate_keystrokes("tab enter");
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    view.read_with(cx, |v, _| assert!(v.picker.is_none()));
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn stale_request_footer_keyup_and_pointer_cannot_close_or_save(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| tests::make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_input("Renamed");
    cx.simulate_keystrokes("shift-tab enter");
    cx.update(|_, cx| view.update(cx, |v, _| v.browser_request += 1));
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    view.read_with(cx, |v, _| {
        assert!(v.picker.as_ref().unwrap().edit.is_some())
    });
    cx.update(|w, cx| w.draw(cx).clear(cx));
    let cancel = cx.debug_bounds("machine-edit-cancel").unwrap();
    cx.simulate_click(cancel.center(), Modifiers::default());
    view.read_with(cx, |v, _| {
        assert!(v.picker.as_ref().unwrap().edit.is_some())
    });
    let save = cx.debug_bounds("machine-edit-save").unwrap();
    cx.simulate_click(save.center(), Modifiers::default());
    assert!(receiver.try_recv().is_err());
}
