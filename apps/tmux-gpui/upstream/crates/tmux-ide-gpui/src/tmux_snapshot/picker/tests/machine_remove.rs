use super::*;
const ID: &str = "00000000-0000-4000-8000-000000000001";
fn prepare(view: &mut SnapshotView, window: &mut Window, cx: &mut Context<SnapshotView>) {
    view.browser_state.machines=Some(serde_json::from_value(serde_json::json!({"revision":12,"available":true,"pending":false,"error":null,"message":null,"machines":[{"id":ID,"label":"Build","sshTarget":"host","enabled":true}]})).unwrap());
    view.input_interrupted = true;
    view.open_picker_mode(Mode::ManageMachines, window, cx);
}
#[gpui::test]
fn remove_machine_requires_confirmation_and_waits_for_registry_without_replay(
    cx: &mut TestAppContext,
) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| view.update(cx, |view, cx| prepare(view, window, cx)));
    cx.simulate_input("remove build");
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    cx.simulate_keystrokes("enter");
    assert_eq!(
        serde_json::to_value(receiver.try_recv().unwrap()).unwrap(),
        serde_json::json!({"type":"machines","request":7,"operation":"mutate","revision":12,"change":{"operation":"remove","id":ID}})
    );
    cx.simulate_keystrokes("enter");
    assert!(receiver.try_recv().is_err());
    view.read_with(cx, |v, _| {
        assert_eq!(v.browser_state.machines.as_ref().unwrap().machines.len(), 1);
        assert!(v.input_interrupted);
        assert_eq!(v.browser_request, 7);
    });
    cx.update(|_, cx| {
        view.update(cx, |view, cx| {
            view.browser_state
                .machines
                .as_mut()
                .unwrap()
                .machines
                .clear();
            view.refresh_picker(cx);
        })
    });
    cx.simulate_keystrokes("escape");
    assert!(view.read_with(cx, |v, _| v.picker.is_none() && v.input_interrupted));
    assert!(receiver.try_recv().is_err());
}
#[gpui::test]
fn removal_stale_revision_modal_and_queue_failure_are_inert(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(1);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            for case in 0..4 {
                prepare(view, window, cx);
                view.begin_machine_removal(ID, 12, window, cx);
                match case {
                    0 => view.browser_state.machines.as_mut().unwrap().revision += 1,
                    1 => view.picker.as_mut().unwrap().mode = Mode::Commands,
                    2 => {
                        view.browser_state.machines.as_mut().unwrap().machines[0].id =
                            "replacement".into()
                    }
                    _ => view.browser_state.machines.as_mut().unwrap().pending = true,
                }
                view.confirm_machine_removal(window, cx);
                assert!(receiver.try_recv().is_err());
            }
            prepare(view, window, cx);
            view.begin_machine_removal(ID, 12, window, cx);
            view.browser_commands
                .as_ref()
                .unwrap()
                .try_send(browser::Command::Machines {
                    request: 7,
                    operation: browser::machines::Operation::Read,
                })
                .unwrap();
            view.confirm_machine_removal(window, cx);
            assert!(view.picker.as_ref().unwrap().error.is_some());
            assert_eq!(
                view.browser_state.machines.as_ref().unwrap().machines.len(),
                1
            );
            receiver.try_recv().unwrap();
            assert!(receiver.try_recv().is_err());
            view.close_picker(window, cx);
            view.confirm_machine_removal(window, cx);
            assert!(receiver.try_recv().is_err());
            assert!(view.input_interrupted);
        })
    });
}

#[gpui::test]
fn removal_pointer_identity_cannot_confirm_reopened_dialog_or_background(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    receiver.try_iter().for_each(drop);
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare(view, window, cx);
            view.begin_machine_removal(ID, 12, window, cx);
            let old = view
                .picker
                .as_ref()
                .unwrap()
                .removal
                .as_ref()
                .unwrap()
                .identity
                .clone();
            view.close_picker(window, cx);
            prepare(view, window, cx);
            view.begin_machine_removal(ID, 12, window, cx);
            view.confirm_machine_removal_identity(&old, window, cx);
            assert!(receiver.try_recv().is_err());
            let current = view
                .picker
                .as_ref()
                .unwrap()
                .removal
                .as_ref()
                .unwrap()
                .identity
                .clone();
            view.presence.set_active(false);
            view.confirm_machine_removal_identity(&current, window, cx);
            assert!(receiver.try_recv().is_err());
        })
    });
}
#[gpui::test]
fn rendered_removal_pointer_confirm_and_cancel_do_not_type_into_pane(cx: &mut TestAppContext) {
    let (sender, receiver) = mpsc::sync_channel(64);
    let (view, cx) = cx.add_window_view(|window, cx| make_view(window, cx, sender));
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare(view, window, cx);
            view.begin_machine_removal(ID, 12, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    receiver.try_iter().for_each(drop);
    let cancel = cx.debug_bounds("machine-remove-cancel").unwrap();
    cx.simulate_click(cancel.center(), Modifiers::default());
    assert!(receiver.try_recv().is_err());
    cx.update(|window, cx| {
        view.update(cx, |view, cx| {
            prepare(view, window, cx);
            view.begin_machine_removal(ID, 12, window, cx);
        });
        window.draw(cx).clear(cx);
    });
    let confirm = cx.debug_bounds("machine-remove-confirm").unwrap();
    cx.simulate_click(confirm.center(), Modifiers::default());
    assert!(
        matches!(receiver.try_recv().unwrap(),browser::Command::Machines{operation:browser::machines::Operation::Mutate{change:browser::machines::Change::Remove{id},..},..} if id==ID)
    );
    assert!(receiver.try_recv().is_err());
    assert!(view.read_with(cx, |view, _| view.input_interrupted));
}
