//! Optional surface encodings through the session: negotiation, boot and
//! revision fencing, future-surface buffering, and Herdr encoder fixtures.

use super::*;
use crate::protocol::{
    surface_delta::SurfaceDelta,
    surface_reuse::SurfaceReuse,
    surface_scroll::{ScrollPatch, SurfaceScroll},
};

const ALL: [&str; 3] = [
    surface_reuse::CAPABILITY,
    surface_delta::CAPABILITY,
    surface_scroll::CAPABILITY,
];

/// A session whose welcome advertised `capabilities`, at snapshot revision 7.
fn session_with(capabilities: &[&str]) -> (Session, Vec<ClientEvent>) {
    let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
    welcome["capabilities"] = json!(capabilities);
    let mut session = Session::new(true, false);
    let mut events = Vec::new();
    for (kind, data) in [
        (ENDPOINT_WELCOME_KIND, welcome.to_string()),
        (ENDPOINT_SNAPSHOT_KIND, SNAPSHOT.into()),
    ] {
        session
            .handle_message(
                ServerMessage::EndpointControl {
                    kind: kind.into(),
                    data,
                },
                |e| {
                    events.push(e);
                    Ok(())
                },
            )
            .unwrap();
    }
    (session, events)
}

fn handle(
    session: &mut Session,
    message: ServerMessage,
) -> (Result<()>, Vec<Arc<PaneSurfaceFrame>>) {
    let mut surfaces = Vec::new();
    let result = session.handle_message(message, |event| {
        if let ClientEvent::Surface(surface) = event {
            surfaces.push(surface);
        }
        Ok(())
    });
    (result, surfaces)
}

fn control(kind: &str, data: String) -> ServerMessage {
    ServerMessage::EndpointControl {
        kind: kind.into(),
        data,
    }
}

fn grid() -> PaneSurfaceFrame {
    let mut surface = baseline();
    let rect = SurfaceRect {
        x: 0,
        y: 0,
        width: 2,
        height: 3,
    };
    surface.frame.width = rect.width;
    surface.frame.height = rect.height;
    surface.frame.cells = ["a", "a", "b", "b", "c", "c"]
        .into_iter()
        .map(|symbol| CellData {
            symbol: symbol.into(),
            ..surface.frame.cells[0].clone()
        })
        .collect();
    surface.panes = vec![PaneSurfacePane {
        pane_id: "w1:p1".into(),
        content_revision: 1,
        rect,
        inner_rect: rect,
        scrollbar_rect: None,
        scroll: None,
        focused: true,
        mouse_reporting: false,
        sgr_pixel_mouse: false,
        alternate_screen_active: false,
        pixel_width: 0,
        pixel_height: 0,
    }];
    surface
}

fn symbols(surface: &PaneSurfaceFrame) -> String {
    surface
        .frame
        .cells
        .iter()
        .map(|c| c.symbol.as_str())
        .collect()
}

fn scroll_message(base: &PaneSurfaceFrame) -> ServerMessage {
    let mut last_row = base.frame.cells[..2].to_vec();
    last_row.iter_mut().for_each(|c| c.symbol = "d".into());
    let scroll = ScrollPatch {
        scrolls: vec![SurfaceScroll {
            rect: base.panes[0].inner_rect,
            shift: 1,
        }],
        patch: PaneSurfacePatch {
            boot_id: base.boot_id.clone(),
            projection_revision: base.projection_revision,
            base_surface_revision: base.surface_revision,
            surface_revision: base.surface_revision + 1,
            rows: vec![PaneSurfacePatchRow {
                x: 0,
                y: 2,
                cells: last_row,
            }],
            panes: vec![],
            cursor: None,
        },
    };
    control(surface_scroll::MESSAGE_KIND, scroll.encode().unwrap())
}

fn delta_message(base: &PaneSurfaceFrame, projection_revision: u64) -> ServerMessage {
    let mut surface = base.clone();
    surface.frame.cells.clear();
    surface.projection_revision = projection_revision;
    surface.surface_revision += 1;
    let delta = SurfaceDelta {
        base_projection_revision: base.projection_revision,
        base_surface_revision: base.surface_revision,
        surface,
        rows: vec![PaneSurfacePatchRow {
            x: 1,
            y: 1,
            cells: vec![CellData {
                symbol: "x".into(),
                ..base.frame.cells[0].clone()
            }],
        }],
        popup_cells: None,
    };
    control(surface_delta::MESSAGE_KIND, delta.encode().unwrap())
}

fn reuse_message(base: &PaneSurfaceFrame, projection_revision: u64) -> ServerMessage {
    let mut surface = base.clone();
    surface.frame.cells.clear();
    surface.projection_revision = projection_revision;
    surface.surface_revision += 1;
    let reuse = SurfaceReuse {
        base_surface_revision: base.surface_revision,
        surface,
    };
    control(surface_reuse::MESSAGE_KIND, reuse.encode().unwrap())
}

#[test]
fn hello_requests_every_encoding_and_welcome_selects_them() {
    let (session, _) = session_with(&ALL);
    assert_eq!(
        session.encodings,
        SurfaceEncodings {
            reuse: true,
            delta: true,
            scroll: true,
        }
    );
    let (session, _) = session_with(&[surface_scroll::CAPABILITY]);
    assert_eq!(
        session.encodings,
        SurfaceEncodings {
            scroll: true,
            ..SurfaceEncodings::default()
        }
    );
    // The welcome fixture predates these encodings and advertises none.
    assert_eq!(ready_session().encodings, SurfaceEncodings::default());
}

#[test]
fn unadvertised_encodings_fail_closed() {
    for kind in [
        surface_scroll::MESSAGE_KIND,
        surface_delta::MESSAGE_KIND,
        surface_reuse::MESSAGE_KIND,
    ] {
        let (mut session, _) = session_with(&[]);
        handle(&mut session, ServerMessage::PaneSurface(grid()))
            .0
            .unwrap();
        let (result, _) = handle(&mut session, control(kind, String::new()));
        assert!(
            matches!(result, Err(Error::SurfaceEncodingNotNegotiated)),
            "{kind}"
        );
    }
}

#[test]
fn encodings_need_a_retained_baseline() {
    let (mut session, _) = session_with(&ALL);
    let base = grid();
    assert!(matches!(
        handle(&mut session, scroll_message(&base)).0,
        Err(Error::PatchBeforeBaseline)
    ));
    assert!(matches!(
        handle(&mut session, delta_message(&base, 7)).0,
        Err(Error::EncodedSurfaceBeforeBaseline)
    ));
    assert!(matches!(
        handle(&mut session, reuse_message(&base, 7)).0,
        Err(Error::EncodedSurfaceBeforeBaseline)
    ));
}

#[test]
fn encoded_updates_follow_the_surface_and_patch_paths() {
    let (mut session, _) = session_with(&ALL);
    let base = grid();
    let (result, surfaces) = handle(&mut session, ServerMessage::PaneSurface(base.clone()));
    result.unwrap();
    assert_eq!(symbols(&surfaces[0]), "aabbcc");

    let (result, surfaces) = handle(&mut session, scroll_message(&base));
    result.unwrap();
    assert_eq!(symbols(&surfaces[0]), "bbccdd");
    assert_eq!(surfaces[0].surface_revision, 2);

    let scrolled = session.surface.as_deref().unwrap().clone();
    let (result, surfaces) = handle(&mut session, delta_message(&scrolled, 7));
    result.unwrap();
    assert_eq!(symbols(&surfaces[0]), "bbcxdd");

    let delta = session.surface.as_deref().unwrap().clone();
    let (result, surfaces) = handle(&mut session, reuse_message(&delta, 7));
    result.unwrap();
    assert_eq!(symbols(&surfaces[0]), "bbcxdd");
    assert_eq!(surfaces[0].surface_revision, 4);
}

#[test]
fn encoded_updates_keep_boot_and_revision_fences() {
    let base = grid();
    let mut other_boot = base.clone();
    other_boot.boot_id = "other".into();
    let mut stale = base.clone();
    stale.surface_revision -= 1;
    for message in [
        scroll_message(&other_boot),
        scroll_message(&stale),
        delta_message(&other_boot, 7),
        delta_message(&stale, 7),
        reuse_message(&other_boot, 7),
        reuse_message(&stale, 7),
    ] {
        let (mut session, _) = session_with(&ALL);
        handle(&mut session, ServerMessage::PaneSurface(base.clone()))
            .0
            .unwrap();
        let (result, surfaces) = handle(&mut session, message);
        assert!(matches!(result, Err(Error::Protocol(_))), "{result:?}");
        assert!(surfaces.is_empty());
        assert_eq!(session.surface.as_deref(), Some(&base));
    }
}

#[test]
fn future_encoded_surfaces_wait_for_their_snapshot() {
    let (mut session, _) = session_with(&ALL);
    let base = grid();
    handle(&mut session, ServerMessage::PaneSurface(base.clone()))
        .0
        .unwrap();
    // A delta into projection 8 is retained but not shown under snapshot 7.
    let (result, surfaces) = handle(&mut session, delta_message(&base, 8));
    result.unwrap();
    assert!(surfaces.is_empty());
    // A scroll against the buffered future surface also waits.
    let future = session.surface.as_deref().unwrap().clone();
    let (result, surfaces) = handle(&mut session, scroll_message(&future));
    result.unwrap();
    assert!(surfaces.is_empty());

    let mut snapshot: Value = serde_json::from_str(SNAPSHOT).unwrap();
    snapshot["revision"] = 8.into();
    let (result, surfaces) = handle(
        &mut session,
        control(ENDPOINT_SNAPSHOT_KIND, snapshot.to_string()),
    );
    result.unwrap();
    assert_eq!(surfaces.len(), 1);
    assert_eq!(surfaces[0].projection_revision, 8);
    assert_eq!(symbols(&surfaces[0]), "bxccdd");
}

/// Herdr encoder fixtures replayed through the session exactly as received.
#[test]
fn herdr_fixtures_replay_through_the_session() {
    let fixtures: [&[u8]; 4] = [
        include_bytes!("../../../herdr-protocol/tests/fixtures/surface-scroll-up-v1.bin"),
        include_bytes!("../../../herdr-protocol/tests/fixtures/surface-scroll-down-v1.bin"),
        include_bytes!("../../../herdr-protocol/tests/fixtures/surface-delta-v1.bin"),
        include_bytes!("../../../herdr-protocol/tests/fixtures/surface-reuse-v1.bin"),
    ];
    for bytes in fixtures {
        let mut reader = bytes;
        let mut messages = Vec::new();
        while !reader.is_empty() {
            messages.push(
                read_message::<_, ServerMessage>(&mut reader, MAX_GRAPHICS_FRAME_SIZE).unwrap(),
            );
        }
        let (mut session, _) = session_with(&ALL);
        let mut snapshot: Value = serde_json::from_str(SNAPSHOT).unwrap();
        let mut steps = messages.into_iter();
        let Some(ServerMessage::PaneSurface(mut base)) = steps.next() else {
            panic!("fixture starts with a full surface");
        };
        // Fixtures use their own boot; adopt it with a fresh session snapshot.
        snapshot["boot_id"] = base.boot_id.clone().into();
        snapshot["revision"] = base.projection_revision.into();
        session.snapshot = None;
        handle(
            &mut session,
            control(ENDPOINT_SNAPSHOT_KIND, snapshot.to_string()),
        )
        .0
        .unwrap();
        handle(&mut session, ServerMessage::PaneSurface(base.clone()))
            .0
            .unwrap();
        while let Some(encoded) = steps.next() {
            let Some(ServerMessage::PaneSurface(expected)) = steps.next() else {
                panic!("fixture step ends with the expected surface");
            };
            snapshot["revision"] = expected.projection_revision.into();
            handle(
                &mut session,
                control(ENDPOINT_SNAPSHOT_KIND, snapshot.to_string()),
            )
            .0
            .unwrap();
            handle(&mut session, encoded).0.unwrap();
            assert_eq!(session.surface.as_deref(), Some(&expected));
            base = expected;
        }
        assert_eq!(session.surface.as_deref(), Some(&base));
    }
}
