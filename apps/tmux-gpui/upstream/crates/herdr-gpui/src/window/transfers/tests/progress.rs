use super::*;

#[test]
fn progress_sizes_and_percentages_are_readable_and_bounded() {
    for (sent, total, fraction, label) in [
        (0, 0, 0., "0 B / 0 B (0%)"),
        (512, 1024, 0.5, "512 B / 1 KiB (50%)"),
        (1024 * 1024, 2 * 1024 * 1024, 0.5, "1 MiB / 2 MiB (50%)"),
        (1_288_490_189, 4_294_967_296, 0.3, "1.2 GiB / 4 GiB (30%)"),
        (4_294_967_296, 8_589_934_592, 0.5, "4 GiB / 8 GiB (50%)"),
        (2048, 1024, 1., "2 KiB / 1 KiB (100%)"),
        (u64::MAX, u64::MAX, 1., "16 EiB / 16 EiB (100%)"),
    ] {
        assert_eq!(transfer_progress(sent, total), (fraction, label.into()));
    }
}

#[gpui::test]
fn progress_above_four_gib_and_real_cancel_click_are_isolated(cx: &mut TestAppContext) {
    let (fixture, cx) = cx.add_window_view(fixture);
    let view = fixture.read_with(cx, |fixture, _| fixture.view.clone().unwrap());
    let mut peer = Peer::new();
    let cancelled = view.update(cx, |view, cx| {
        peer.prepare(view, cx);
        let transfer = pending(view, InputTarget::Pane("w1:p1".into()));
        let cancelled = transfer.cancelled.clone();
        transfer
            .sent
            .store(4 * 1024 * 1024 * 1024, Ordering::Relaxed);
        transfer
            .total
            .store(8 * 1024 * 1024 * 1024, Ordering::Relaxed);
        view.file_transfer = Some(transfer);
        view.poll_file_transfer(cx);
        assert_eq!(
            view.file_transfer.as_ref().unwrap().shown,
            (4_294_967_296, 8_589_934_592, false)
        );
        cancelled
    });
    cx.update(|window, cx| {
        window.refresh();
        window.draw(cx).clear(cx);
    });
    let track = cx.debug_bounds("file-transfer-track").unwrap();
    let progress = cx.debug_bounds("file-transfer-progress").unwrap();
    assert!((f32::from(progress.size.width) / f32::from(track.size.width) - 0.5).abs() < 0.001);
    let cancel = cx.debug_bounds("cancel-file-transfer").unwrap();
    cx.simulate_click(cancel.center(), Modifiers::default());
    assert!(cancelled.load(Ordering::Acquire));
    fixture.read_with(cx, |fixture, _| assert_eq!(fixture.fallthrough, 0));
    view.read_with(cx, |view, _| {
        assert!(view.file_transfer.as_ref().unwrap().shown.2);
        assert!(view.terminal_mouse.is_none());
        assert!(view.local_error.is_none());
    });
    peer.sentinel(&view, cx);
}
