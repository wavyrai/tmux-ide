use super::*;
const ID: &str = "00000000-0000-4000-8000-000000000001";
const PIN: &str = "11111111-1111-4111-8111-111111111111";
fn prepare(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.browser_state.machines=Some(serde_json::from_value(serde_json::json!({"revision":12,"available":true,"pending":false,"message":null,"error":null,"machines":[{"id":ID,"label":"Original","sshTarget":"old-host","enabled":true,"expectedEnvironmentId":PIN}]})).unwrap());
    view.input_interrupted = true;
    view.open_picker_mode(Mode::ManageMachines, window, cx);
    view.begin_machine_edit(ID, 12, window, cx);
}
#[gpui::test]
fn edit_machine_typing_tab_save_preserves_uuid_pin_and_waits_for_ack(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| prepare(view, window, cx));
        window.draw(cx).clear(cx);
    });
    cx.simulate_resize(size(px(640.), px(400.)));
    cx.update(|window, cx| window.draw(cx).clear(cx));
    let dialog = cx.debug_bounds("machine-edit-dialog").unwrap();
    assert!(
        dialog.left() >= px(0.)
            && dialog.right() <= px(640.)
            && dialog.top() >= px(0.)
            && dialog.bottom() <= px(400.),
        "dialog: {dialog:?}"
    );
    receiver.try_iter().for_each(drop);
    let selected = view.read_with(cx, |view, _| view.picker.as_ref().unwrap().selected);
    cx.simulate_keystrokes("down up down");
    assert_eq!(
        view.read_with(cx, |view, _| view.picker.as_ref().unwrap().selected),
        selected,
        "edit fields must not navigate the hidden management list"
    );
    cx.simulate_keystrokes("enter");
    assert!(
        receiver.try_recv().is_err(),
        "unchanged form must not queue a save or claim acknowledgement"
    );
    assert!(
        view.read_with(cx, |view, _| view.picker.as_ref().unwrap().error
            == Some("No changes to save."))
    );
    cx.simulate_input("Renamed");
    cx.simulate_keystrokes("tab");
    cx.simulate_input("user@new-host");
    cx.simulate_keystrokes("enter");
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"machines","request":7,"operation":"mutate","revision":12,"change":{"operation":"edit","id":ID,"patch":{"label":"Renamed","sshTarget":"user@new-host"}}})
    );
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |view, _| {
        let profile = &view.browser_state.machines.as_ref().unwrap().machines[0];
        assert_eq!(profile.label, "Original");
        assert_eq!(profile.expected_environment_id.as_deref(), Some(PIN));
        assert!(view.input_interrupted);
        assert_eq!(view.browser_request, 7);
    });
    cx.update(|window, cx| window.draw(cx).clear(cx));
    assert!(cx.debug_bounds("machine-edit-saved").is_none());
    assert!(cx.debug_bounds("machine-edit-unconfirmed").is_some());
    // Matching values in the old publication are not a write acknowledgement.
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            let r = view.browser_state.machines.as_mut().unwrap();
            r.machines[0].label = "Renamed".into();
            r.machines[0].ssh_target = "user@new-host".into();
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("machine-edit-saved").is_none());
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            let r = view.browser_state.machines.as_mut().unwrap();
            r.revision = 13;
            r.error = Some("Could not confirm change".into());
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("machine-edit-saved").is_none());
    cx.update(|window, cx| {
        view.update(cx, |view, _| {
            view.browser_state.machines.as_mut().unwrap().error = None
        });
        window.draw(cx).clear(cx);
    });
    assert!(cx.debug_bounds("machine-edit-saved").is_some());
    assert!(cx.debug_bounds("machine-edit-unconfirmed").is_none());
    cx.simulate_keystrokes("escape");
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn edit_machine_reopen_stale_queue_and_composition_fences(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare(view, window, cx);
            let old = view
                .picker
                .as_ref()
                .unwrap()
                .edit
                .as_ref()
                .unwrap()
                .identity
                .clone();
            view.close_picker(window, cx);
            prepare(view, window, cx);
            let input = view
                .picker
                .as_ref()
                .unwrap()
                .edit
                .as_ref()
                .unwrap()
                .label
                .clone();
            input.update(cx, |input, cx| input.set_text_selected("New", cx));
            view.save_machine_edit_identity(&old, cx);
            assert!(receiver.try_recv().is_err());
            view.browser_state.machines.as_mut().unwrap().revision = 13;
            view.save_machine_edit(cx);
            assert!(receiver.try_recv().is_err());
            view.browser_state.machines.as_mut().unwrap().revision = 12;
            input.update(cx, |input, cx| {
                input.replace_and_mark_text_in_range(None, "界", None, window, cx)
            });
            for key in ["enter", "tab", "escape"] {
                view.picker_key(
                    &KeyDownEvent {
                        keystroke: Keystroke::parse(key).unwrap(),
                        is_held: false,
                        prefer_character_input: false,
                        layout: None,
                    },
                    window,
                    cx,
                );
                assert!(view.picker.as_ref().unwrap().edit.is_some());
                assert!(receiver.try_recv().is_err());
            }
            input.update(cx, |input, cx| {
                input.unmark_text(window, cx);
                input.set_text_selected("New", cx);
            });
            view.browser_commands
                .as_ref()
                .unwrap()
                .try_send(browser::Command::Machines {
                    request: 7,
                    operation: browser::machines::Operation::Read,
                })
                .unwrap();
            view.save_machine_edit(cx);
            assert!(view.picker.as_ref().unwrap().error.is_some());
            receiver.try_recv().unwrap();
            assert!(receiver.try_recv().is_err());
            view.presence.set_active(false);
            view.save_machine_edit(cx);
            assert!(receiver.try_recv().is_err());
            assert!(view.input_interrupted);
        })
    });
}
