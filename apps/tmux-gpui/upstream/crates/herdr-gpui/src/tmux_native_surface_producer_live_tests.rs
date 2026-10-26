#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::tmux_daemon::LocalDaemon;
use herdr_client::tmux_graphics::surface_offer::Placement;
use herdr_client::{
    tmux_controller::Controller,
    tmux_daemon::{ServerRegistration, TerminalSelection},
    tmux_stream::ViewerMode,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use uuid::Uuid;
#[test]
#[ignore = "requires explicitly owned daemon/tmux fixture"]
fn owned_daemon_native_provider_roundtrip() {
    assert_eq!(
        std::env::var("TMUX_IDE_NATIVE_PROVIDER_FIXTURE").unwrap(),
        "owned"
    );
    let path = std::env::var_os("TMUX_IDE_NATIVE_PROVIDER_RECORD").unwrap();
    let owner = Arc::new(LocalDaemon::discover(std::path::Path::new(&path)).unwrap());
    let scope = owner
        .list_servers()
        .unwrap()
        .into_iter()
        .find_map(|s| match s {
            ServerRegistration::Online { scope, .. } if scope.generation == owner.instance_id() => {
                Some(scope)
            }
            _ => None,
        })
        .unwrap();
    let client = owner.select_server(&scope).unwrap();
    let sessions = client.sessions().unwrap();
    assert_eq!(sessions.len(), 1);
    let session = &sessions[0];
    let workspace = session
        .workspace_name
        .as_ref()
        .unwrap_or(&session.session_name);
    let panes = client
        .workspace_panes(&session.live_session_id, workspace)
        .unwrap();
    assert_eq!(panes.len(), 1);
    let pane = &panes[0];
    let selection = TerminalSelection {
        workspace_name: workspace.clone(),
        live_session_id: session.live_session_id.clone(),
        selected_pane: pane.clone(),
        visible_panes: panes.clone(),
        mode: ViewerMode::ReadOnly,
    };
    let source_handoff = client.issue_surface_source(&selection).unwrap();
    assert!(!source_handoff.graphics && source_handoff.local_images.is_none());
    assert!(!source_handoff.native_surfaces);
    let mut source = Controller::spawn(source_handoff).unwrap();
    let mut producer = Producer::connect(&owner).unwrap();
    let target_handoff = client.issue_terminal(&selection).unwrap();
    assert!(
        target_handoff.native_surfaces,
        "registered producer was not negotiated"
    );
    let (driver, inbox) = crate::tmux_native_surface::driver::Driver::new(
        Uuid::parse_str(owner.instance_id()).unwrap(),
    );
    let mut target = Controller::spawn_with_surfaces(target_handoff, Box::new(driver)).unwrap();
    let start = Instant::now();
    let deadline = start + Duration::from_secs(20);
    let connection = loop {
        assert!(
            Instant::now() < deadline,
            "native source/receiver did not become ready"
        );
        let elapsed = start.elapsed().as_millis() as u64;
        source.poll(elapsed).unwrap();
        target.poll(elapsed).unwrap();
        producer.poll(Instant::now()).unwrap();
        if source.committed(pane).is_some()
            && target.committed(pane).is_some()
            && let Some((id, _)) = producer.receivers().next()
        {
            break id;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let committed = source.committed(pane).unwrap().clone();
    let target_commit = target.committed(pane).unwrap().clone();
    assert_ne!(
        committed.identity.delivery_nonce,
        target_commit.identity.delivery_nonce
    );
    assert_eq!(
        committed.identity.canonical_state_hash,
        target_commit.identity.canonical_state_hash
    );
    let (fixture, _pool, _window) = crate::tmux_native_surface::tests::fixture();
    producer
        .submit(
            connection,
            pane,
            &committed,
            Uuid::new_v4(),
            Placement {
                row: 0,
                column: 0,
                rows: 1,
                columns: 1,
            },
            fixture.buffer.0.clone(),
        )
        .unwrap();
    let imported = loop {
        assert!(Instant::now() < deadline, "native frame was not imported");
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        producer.poll(Instant::now()).unwrap();
        if let Some(mut images) = inbox.drain().unwrap()
            && !images.is_empty()
        {
            break images.remove(0);
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    assert!(imported.accepted.is_current(pane, &target_commit));
    assert_eq!(producer.outstanding(connection).unwrap(), 1);
    let live = Arc::clone(&imported.live);
    drop(imported);
    loop {
        assert!(
            Instant::now() < deadline,
            "original-socket retirement did not reach producer"
        );
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        producer.poll(Instant::now()).unwrap();
        if producer.outstanding(connection).unwrap() == 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    producer.close();
    while live.load(std::sync::atomic::Ordering::Acquire) {
        assert!(
            Instant::now() < deadline,
            "viewer did not enter native fallback"
        );
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(target.committed(pane).is_some());
    let fallback_handoff = client.issue_terminal(&selection).unwrap();
    assert!(fallback_handoff.native_surfaces);
    target.retire();
    source.retire();
    canvas_roundtrip(&owner, &scope, &selection);
    replacement::roundtrip(&owner, &scope, &selection);
}

fn canvas_roundtrip(
    owner: &Arc<LocalDaemon>,
    scope: &herdr_client::tmux_handoff::ServerScope,
    selection: &TerminalSelection,
) {
    use tmux_native_surface_sdk::publisher::{Publisher, RgbaCanvas};
    let mut publisher = Publisher::connect(owner, scope, selection).unwrap();
    let client = owner.select_server(scope).unwrap();
    let handoff = client.issue_terminal(selection).unwrap();
    assert!(handoff.native_surfaces);
    let (driver, inbox) = crate::tmux_native_surface::driver::Driver::new(
        Uuid::parse_str(owner.instance_id()).unwrap(),
    );
    let mut target = Controller::spawn_with_surfaces(handoff, Box::new(driver)).unwrap();
    let start = Instant::now();
    let deadline = start + Duration::from_secs(20);
    let pane = &selection.selected_pane;
    loop {
        assert!(Instant::now() < deadline, "canvas receiver not ready");
        publisher.poll().unwrap();
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        if publisher.receivers() == 1 && target.committed(pane).is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    let current = target.committed(pane).unwrap();
    let snapshot = current.snapshot.as_ref().unwrap();
    let (rows, columns) = (snapshot.rows, snapshot.cols);
    // Keep the receiver unpolled while producing many changed canvases. Only
    // the two retirement-owned submissions plus the latest canvas may survive.
    for value in 0..12u8 {
        let pixels = [value, 20, 40, 255].repeat(6);
        publisher
            .present_rgba(RgbaCanvas {
                width: 3,
                height: 2,
                rows,
                columns,
                rgba: &pixels,
                premultiplied: false,
            })
            .unwrap();
        assert!(publisher.retained_frames() <= 2);
    }
    let mut last = None;
    loop {
        assert!(
            Instant::now() < deadline,
            "latest canvas did not replace old frames"
        );
        publisher.poll().unwrap();
        target.poll(start.elapsed().as_millis() as u64).unwrap();
        if let Some(images) = inbox.drain().unwrap() {
            for image in images {
                last = Some(first_pixel(&image));
                drop(image);
            }
        }
        assert!(publisher.retained_frames() <= 2);
        if last == Some([40, 20, 11, 255]) {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    publisher.close();
    target.retire();
}

#[allow(unsafe_code)] // Test-only read of a retained imported buffer, under a matched CPU lock.
fn first_pixel(image: &crate::tmux_native_surface::Image) -> [u8; 4] {
    use objc2_core_video::{
        CVPixelBufferGetBaseAddress, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
        CVPixelBufferUnlockBaseAddress, kCVReturnSuccess,
    };
    let buffer = &image.buffer.0;
    assert_eq!(
        unsafe { CVPixelBufferLockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) },
        kCVReturnSuccess
    );
    let address = CVPixelBufferGetBaseAddress(buffer).cast::<u8>();
    assert!(!address.is_null());
    let pixel = unsafe { [*address, *address.add(1), *address.add(2), *address.add(3)] };
    assert_eq!(
        unsafe { CVPixelBufferUnlockBaseAddress(buffer, CVPixelBufferLockFlags::ReadOnly) },
        kCVReturnSuccess
    );
    pixel
}

#[path = "tmux_native_surface_replacement_live_tests.rs"]
mod replacement;
