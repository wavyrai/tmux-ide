#![allow(clippy::unwrap_used)]
use super::super::{browser, tests::make_view};
use super::*;
use core::prelude::v1::test;
use gpui::{EntityInputHandler, TestAppContext};
use std::sync::mpsc;

fn prepare(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.input_interrupted = true;
    view.open_picker_mode(Mode::Machine, window, cx);
}

#[gpui::test]
fn add_machine_footer_follows_visible_order_and_cancel_restores_focus(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    for (keys, focused) in [
        ("tab", 1),
        ("tab", 2),
        ("tab", 0),
        ("shift-tab", 2),
        ("shift-tab", 1),
    ] {
        cx.simulate_keystrokes(keys);
        cx.update(|w, cx| {
            view.read_with(cx, |v, cx| {
                let picker = v.picker.as_ref().unwrap();
                let form = picker.machine.as_ref().unwrap();
                assert_eq!(picker.search.read(cx).focus.is_focused(w), focused == 0);
                assert_eq!(form.cancel_focus.is_focused(w), focused == 1);
                assert_eq!(form.connect_focus.is_focused(w), focused == 2);
            })
        });
    }
    cx.simulate_keystrokes("space");
    assert!(view.read_with(cx, |v, _| v.picker.is_some()));
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("space").unwrap(),
    });
    cx.update(|w, cx| {
        view.read_with(cx, |v, _| {
            assert!(v.picker.is_none());
            assert!(v.terminal_focus.is_focused(w));
            assert!(v.input_interrupted);
        })
    });
    assert!(receiver.try_recv().is_err());
}

#[gpui::test]
fn add_machine_footer_validates_then_submits_once_on_keyup(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| prepare(v, w, cx));
        w.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    cx.simulate_input("-invalid");
    cx.simulate_keystrokes("shift-tab enter");
    assert!(receiver.try_recv().is_err());
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(view.read_with(cx, |v, _| v.picker.as_ref().unwrap().error.is_some()));
    assert!(receiver.try_recv().is_err());
    cx.update(|_, cx| {
        view.update(cx, |v, cx| {
            v.picker
                .as_ref()
                .unwrap()
                .search
                .update(cx, |input, cx| input.set_text_selected("user@spark", cx));
        })
    });
    cx.simulate_keystrokes("enter");
    cx.simulate_event(KeyDownEvent {
        keystroke: Keystroke::parse("enter").unwrap(),
        is_held: true,
        prefer_character_input: false,
        layout: None,
    });
    assert!(receiver.try_recv().is_err());
    cx.simulate_event(KeyUpEvent {
        layout: None,
        keystroke: Keystroke::parse("enter").unwrap(),
    });
    assert!(
        matches!(receiver.try_recv().unwrap(), browser::Command::Machine { request: 8, ssh_target: Some(target) } if target == "user@spark")
    );
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |v, _| v.picker.is_none()));
}

#[gpui::test]
fn add_machine_stale_keyup_and_pointer_cannot_submit_or_cancel(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    for keys in ["tab enter", "shift-tab enter"] {
        cx.update(|w, cx| {
            view.update(cx, |v, cx| prepare(v, w, cx));
            w.draw(cx).clear(cx);
        });
        receiver.try_iter().for_each(drop);
        cx.simulate_input("spark");
        cx.simulate_keystrokes(keys);
        cx.update(|_, cx| view.update(cx, |v, _| v.browser_request += 1));
        cx.simulate_event(KeyUpEvent {
            layout: None,
            keystroke: Keystroke::parse("enter").unwrap(),
        });
        assert!(view.read_with(cx, |v, _| v.picker.is_some()));
        cx.update(|w, cx| w.draw(cx).clear(cx));
        for id in ["machine-connect", "machine-cancel"] {
            let bounds = cx.debug_bounds(id).unwrap();
            cx.simulate_click(bounds.center(), Modifiers::default());
            assert!(view.read_with(cx, |v, _| v.picker.is_some()));
        }
        assert!(receiver.try_recv().is_err());
    }
}

#[gpui::test]
fn add_machine_reopened_form_and_composition_reject_captured_actions(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|w, cx| make_view(w, cx, sender));
    cx.update(|w, cx| {
        view.update(cx, |v, cx| {
            prepare(v, w, cx);
            let old = v
                .picker
                .as_ref()
                .unwrap()
                .machine
                .as_ref()
                .unwrap()
                .identity
                .clone();
            prepare(v, w, cx);
            assert!(!v.machine_identity_current(&old, cx));
            let current = v
                .picker
                .as_ref()
                .unwrap()
                .machine
                .as_ref()
                .unwrap()
                .identity
                .clone();
            assert!(v.machine_identity_current(&current, cx));
            let search = v.picker.as_ref().unwrap().search.clone();
            search.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "spark", None, w, cx);
            });
            assert!(!v.machine_identity_current(&current, cx));
            for key in ["tab", "enter", "escape"] {
                v.picker_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                        layout: None,
                    },
                    w,
                    cx,
                );
                assert!(v.picker.is_some());
                assert!(search.read(cx).is_composing());
                assert!(search.read(cx).focus.is_focused(w));
            }
            v.submit_machine(w, cx);
        })
    });
    assert!(
        !receiver
            .try_iter()
            .any(|command| matches!(command, browser::Command::Machine { .. }))
    );
}
