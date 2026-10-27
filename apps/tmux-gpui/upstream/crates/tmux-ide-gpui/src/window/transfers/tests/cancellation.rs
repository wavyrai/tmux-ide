use super::*;

#[gpui::test]
fn captured_target_fences_cancel_and_reset_cancels_immediately(cx: &mut TestAppContext) {
    let (fixture, cx) = cx.add_window_view(fixture);
    let view = fixture.read_with(cx, |fixture, _| fixture.view.clone().unwrap());
    let peer = Peer::new();
    view.update(cx, |view, cx| {
        peer.prepare(view, cx);
        let live = view.live.clone();
        let epoch = view.selection_epoch;
        let generation = view.endpoints[0].generation;
        let id = view.endpoints[0].id.clone();
        for case in 0..12 {
            view.live = live.clone();
            view.selection_epoch = epoch;
            view.endpoints[0].generation = generation;
            view.endpoints[0].id = id.clone();
            view.endpoints[0].connection.target = ConnectTarget::Ssh {
                target: HOST.into(),
                session: "default".into(),
            };
            let target = if matches!(case, 7 | 8) {
                popup(view, "popup");
                InputTarget::Popup("popup".into())
            } else {
                InputTarget::Pane("w1:p1".into())
            };
            view.file_transfer = Some(pending(view, target));
            assert!(view.file_transfer_current(view.file_transfer.as_ref().unwrap()));
            match case {
                0 => view.selection_epoch += 1,
                1 => view.endpoints[0].generation += 1,
                2 => Arc::make_mut(view.live.snapshot.as_mut().unwrap())
                    .boot_id
                    .push_str("-new"),
                3 => Arc::make_mut(view.live.snapshot.as_mut().unwrap())
                    .panes
                    .clear(),
                4 => Arc::make_mut(view.live.surface.as_mut().unwrap())
                    .panes
                    .clear(),
                5 => view.endpoints[0].id.push_str("-new"),
                6 => popup(view, "popup"),
                7 => popup(view, "replacement"),
                8 => Arc::make_mut(view.live.surface.as_mut().unwrap()).popup = None,
                9 => view.live.status = ConnectionStatus::Disconnected,
                10 => {
                    view.endpoints[0].connection.target = ConnectTarget::Ssh {
                        target: "other.invalid".into(),
                        session: "default".into(),
                    }
                }
                11 => {
                    let cancelled = view.file_transfer.as_ref().unwrap().cancelled.clone();
                    view.detach_endpoint(cx);
                    assert!(
                        cancelled.load(Ordering::Acquire),
                        "reset must cancel without polling"
                    );
                }
                _ => unreachable!(),
            }
            view.poll_file_transfer(cx);
            assert!(view.file_transfer.as_ref().unwrap().shown.2, "case {case}");
        }
    });
}

#[gpui::test]
fn dropping_entity_cancels_but_detached_completion_still_cleans(cx: &mut TestAppContext) {
    let (fixture, cx) = cx.add_window_view(fixture);
    let view = fixture.read_with(cx, |fixture, _| fixture.view.clone().unwrap());
    let weak = view.downgrade();
    let peer = Peer::new();
    let (tx, rx) = mpsc::channel();
    let cancelled = view.update(cx, |view, cx| {
        peer.prepare(view, cx);
        view.start_file_transfer_with(
            InputTarget::Pane("w1:p1".into()),
            vec!["source".into()],
            |_, _, _, _| Ok(vec![REMOTE.into()]),
            move |host, paths| {
                tx.send((host.to_owned(), paths.to_vec())).unwrap();
                Ok(())
            },
            cx,
        );
        view.file_transfer.as_ref().unwrap().cancelled.clone()
    });
    fixture.update(cx, |fixture, _| {
        fixture.view = None;
    });
    drop(view);
    cx.update(|_, _| {});
    assert!(weak.upgrade().is_none());
    assert!(cancelled.load(Ordering::Acquire));
    cx.run_until_parked();
    assert_eq!(rx.try_recv().unwrap(), (HOST.into(), vec![REMOTE.into()]));
}
