#![allow(clippy::unwrap_used)]
use super::*;
use crate::state::ConnectionStatus;
use herdr_client::protocol::{ClientShellSnapshot, FrameData};

fn snapshot(boot: &str, revision: u64) -> Arc<ClientShellSnapshot> {
    let mut snapshot = crate::sidebar::layout_tests::snapshot(1);
    snapshot.boot_id = boot.into();
    snapshot.revision = revision;
    Arc::new(snapshot)
}

fn surface(boot: &str, revision: u64) -> Arc<PaneSurfaceFrame> {
    Arc::new(PaneSurfaceFrame {
        boot_id: boot.into(),
        projection_revision: revision,
        surface_revision: revision,
        frame: FrameData {
            cells: vec![],
            width: 0,
            height: 0,
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![],
        splits: vec![],
        popup: None,
        graphics: Default::default(),
    })
}

/// `LiveState` keeps private fields, so the fixtures below are built by
/// assignment rather than by struct update syntax.
fn connected(boot: &str, revision: u64) -> LiveState {
    let mut live = LiveState::default();
    live.status = ConnectionStatus::Connected;
    live.snapshot = Some(snapshot(boot, revision));
    live.surface = Some(surface(boot, revision));
    live
}

#[test]
fn a_pending_projection_keeps_the_frame_already_presented() {
    let mut presentation = Presentation::default();
    let live = connected("boot", 7);
    let first = live.surface.clone().unwrap();
    assert!(Arc::ptr_eq(&presentation.frame(&live).unwrap(), &first));

    // The focus fence drops the surface; the snapshot keeps its boot.
    let mut pending = connected("boot", 7);
    pending.surface = None;
    assert!(Arc::ptr_eq(&presentation.frame(&pending).unwrap(), &first));

    // A snapshot ahead of its surface is the same gap, not a new picture.
    let mut ahead = connected("boot", 7);
    ahead.snapshot = Some(snapshot("boot", 8));
    assert!(Arc::ptr_eq(&presentation.frame(&ahead).unwrap(), &first));

    let next = connected("boot", 8);
    let replacement = next.surface.clone().unwrap();
    assert!(Arc::ptr_eq(
        &presentation.frame(&next).unwrap(),
        &replacement
    ));
}

#[test]
fn nothing_is_presented_for_another_boot_a_lost_connection_or_after_clearing() {
    let mut presentation = Presentation::default();
    assert!(presentation.frame(&connected("boot", 1)).is_some());
    let mut rebooted = connected("boot", 1);
    rebooted.snapshot = Some(snapshot("other-boot", 1));
    rebooted.surface = None;
    assert!(presentation.frame(&rebooted).is_none());

    assert!(presentation.frame(&connected("boot", 1)).is_some());
    let mut disconnected = connected("boot", 1);
    disconnected.surface = None;
    disconnected.status = ConnectionStatus::Disconnected;
    assert!(presentation.frame(&disconnected).is_none());

    assert!(presentation.frame(&connected("boot", 1)).is_some());
    presentation.clear();
    let mut gap = connected("boot", 1);
    gap.surface = None;
    assert!(presentation.frame(&gap).is_none());
}

mod stale;
