use super::*;
use crate::tmux_native_surface::{Image, driver::Inbox};
use std::sync::atomic::Ordering;
use tmux_native_surface_sdk::publisher::{Publisher, RgbaCanvas};

pub(super) fn roundtrip(
    owner: &Arc<LocalDaemon>,
    scope: &herdr_client::tmux_handoff::ServerScope,
    selection: &TerminalSelection,
) {
    let client = owner.select_server(scope).unwrap();
    let handoff = client.issue_terminal(selection).unwrap();
    assert!(handoff.native_surfaces);
    let (driver, inbox) = crate::tmux_native_surface::driver::Driver::new(
        Uuid::parse_str(owner.instance_id()).unwrap(),
    );
    let mut target = Controller::spawn_with_surfaces(handoff, Box::new(driver)).unwrap();
    let start = Instant::now();
    let deadline = start + Duration::from_secs(25);
    // The five-second kernel handshake deadline must not run before a producer exists.
    while start.elapsed() < Duration::from_secs(6) {
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(target.committed(&selection.selected_pane).is_some());
    let mut first = Publisher::connect(owner, scope, selection).unwrap();
    let old = receive_canvas(
        &mut first,
        &mut target,
        &inbox,
        selection,
        start,
        deadline,
        10,
    );
    assert!(old.live.load(Ordering::Acquire));
    first.close();
    while old.live.load(Ordering::Acquire) {
        assert!(Instant::now() < deadline, "old provider remained drawable");
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut second = Publisher::connect(owner, scope, selection).unwrap();
    let current = receive_canvas(
        &mut second,
        &mut target,
        &inbox,
        selection,
        start,
        deadline,
        80,
    );
    assert!(
        !old.live.load(Ordering::Acquire),
        "replacement revived the old image"
    );
    assert!(current.live.load(Ordering::Acquire));
    assert_eq!(second.retained_frames(), 1);
    drop(old);
    for _ in 0..20 {
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        second.poll().unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        second.retained_frames(),
        1,
        "old ACK retired replacement storage"
    );
    drop(current);
    while second.retained_frames() != 0 {
        assert!(
            Instant::now() < deadline,
            "replacement storage did not retire"
        );
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        second.poll().unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    second.close();
    target.retire();
}

fn receive_canvas(
    publisher: &mut Publisher,
    target: &mut Controller,
    inbox: &Inbox,
    selection: &TerminalSelection,
    start: Instant,
    deadline: Instant,
    red: u8,
) -> Image {
    while publisher.receivers() == 0 {
        assert!(Instant::now() < deadline, "late receiver did not negotiate");
        publisher.poll().unwrap();
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    let current = target.committed(&selection.selected_pane).unwrap();
    let snapshot = current.snapshot.as_ref().unwrap();
    publisher
        .present_rgba(RgbaCanvas {
            width: 1,
            height: 1,
            rows: snapshot.rows,
            columns: snapshot.cols,
            rgba: &[red, 20, 40, 255],
            premultiplied: false,
        })
        .unwrap();
    loop {
        assert!(
            Instant::now() < deadline,
            "late native canvas was not imported"
        );
        publisher.poll().unwrap();
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        if let Some(mut images) = inbox.drain().unwrap()
            && !images.is_empty()
        {
            assert_eq!(images.len(), 1);
            let image = images.remove(0);
            assert_eq!(first_pixel(&image), [40, 20, red, 255]);
            return image;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}
