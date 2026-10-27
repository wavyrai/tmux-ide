#![allow(clippy::unwrap_used)]
use super::*;
use herdr_client::protocol::{
    FrameData, PaneSurfacePane, PaneSurfaceScrollMetrics, SurfaceGraphicsScene,
    endpoint::EndpointServerWelcome,
};

fn rect(x: u16, y: u16, width: u16, height: u16) -> SurfaceRect {
    SurfaceRect {
        x,
        y,
        width,
        height,
    }
}

fn surface(content_revision: u64, offset: u64) -> PaneSurfaceFrame {
    PaneSurfaceFrame {
        boot_id: "boot".into(),
        projection_revision: 1,
        surface_revision: 1,
        frame: FrameData {
            width: 40,
            height: 10,
            cells: vec![],
            cursor: None,
            hyperlinks: vec![],
            graphics: vec![],
        },
        panes: vec![PaneSurfacePane {
            pane_id: "p1".into(),
            content_revision,
            rect: rect(0, 0, 40, 10),
            inner_rect: rect(2, 1, 30, 8),
            scrollbar_rect: None,
            scroll: Some(PaneSurfaceScrollMetrics {
                offset_from_bottom: offset,
                max_offset_from_bottom: 100,
                viewport_rows: 8,
            }),
            focused: true,
            mouse_reporting: false,
            sgr_pixel_mouse: false,
            alternate_screen_active: false,
            pixel_width: 0,
            pixel_height: 0,
        }],
        splits: Vec::new(),
        popup: None,
        graphics: SurfaceGraphicsScene::default(),
    }
}

/// The cell at surface column `x`, row `y`, with 10x20 pixel cells.
fn cell(surface: &PaneSurfaceFrame, x: u16, y: u16) -> Option<LinkCell> {
    LinkCell::at(
        surface,
        f32::from(x) * 10. + 5.,
        f32::from(y) * 20. + 5.,
        10.,
        20.,
    )
}

fn resolved(regions: Value) -> Value {
    json!({"id": "gpui-1", "result": {"type": "pane_link_resolved", "regions": regions}})
}

fn welcome(methods: &[&str]) -> ClientEvent {
    ClientEvent::Connected(EndpointServerWelcome {
        generation: 1,
        server_version: "test".into(),
        snapshot_codec: String::new(),
        surface_codec: String::new(),
        input_codec: String::new(),
        blob_codec: String::new(),
        methods: methods.iter().map(|method| (*method).into()).collect(),
        capabilities: Vec::new(),
        error: None,
    })
}

#[test]
fn cells_are_pane_relative_and_carry_the_content_they_read() {
    let surface = surface(4, 3);
    let target = cell(&surface, 5, 3).unwrap();
    assert_eq!((target.row, target.col), (2, 3));
    assert_eq!(
        target.params(),
        json!({
            "pane_id": "p1", "viewport_row": 2, "col": 3,
            "content_revision": 4, "offset_from_bottom": 3,
        })
    );
    // Borders and the area outside the pane are not pane cells.
    assert!(cell(&surface, 1, 3).is_none());
    assert!(cell(&surface, 5, 0).is_none());
    assert!(cell(&surface, 32, 3).is_none());
    // A write in progress is not a revision the daemon would answer for.
    assert!(cell(&self::surface(5, 3), 5, 3).is_none());
}

#[test]
fn a_cell_goes_stale_when_its_pane_changes_scrolls_or_is_covered() {
    let target = cell(&surface(4, 3), 5, 3).unwrap();
    assert!(target.current(&surface(4, 3)));
    assert!(!target.current(&surface(6, 3)));
    assert!(!target.current(&surface(4, 2)));
    let mut moved = surface(4, 3);
    moved.panes[0].inner_rect = rect(2, 1, 29, 8);
    assert!(!target.current(&moved));
    let mut other_boot = surface(4, 3);
    other_boot.boot_id = "next".into();
    assert!(!target.current(&other_boot));
    assert!(target.same_content(&cell(&surface(4, 3), 9, 6).unwrap()));
    assert!(!target.same_content(&cell(&surface(6, 3), 5, 3).unwrap()));
}

#[test]
fn a_wrapped_link_covers_every_row_it_continues_onto() {
    let surface = surface(4, 0);
    let target = cell(&surface, 5, 3).unwrap();
    let link = ResolvedLink::from_response(
        target,
        &resolved(json!([
            {"row": 2, "start_col": 1, "end_col": 29},
            {"row": 3, "start_col": 0, "end_col": 6},
        ])),
    );
    assert_eq!(link.regions.len(), 2);
    // The continuation on the next row is part of the same link.
    assert!(link.covers(&cell(&surface, 4, 4).unwrap()));
    assert!(!link.covers(&cell(&surface, 9, 4).unwrap()));
    assert!(!link.covers(&cell(&surface, 2, 3).unwrap()));
    // Painted in frame coordinates, past the pane's inner origin, with
    // the inclusive end column made exclusive.
    assert_eq!(
        link.frame_rows().collect::<Vec<_>>(),
        vec![(3, 3..32), (4, 2..9)]
    );
}

#[test]
fn untrusted_resolutions_that_leave_the_pane_or_miss_the_cell_are_no_link() {
    let target = cell(&surface(4, 0), 5, 3).unwrap();
    for response in [
        resolved(json!([{"row": 2, "start_col": 0, "end_col": 30}])),
        resolved(json!([{"row": 8, "start_col": 0, "end_col": 3}])),
        resolved(json!([{"row": 2, "start_col": 5, "end_col": 4}])),
        resolved(json!([{"row": 2, "start_col": 4, "end_col": 9}])),
        resolved(Value::Array(vec![
            json!({"row": 2, "start_col": 0, "end_col": 9});
            9
        ])),
        resolved(json!([])),
        resolved(json!("nonsense")),
        json!({"id": "gpui-1", "result": {"type": "pane_link_activated", "handled": false}}),
        json!({"id": "gpui-1", "error": {"code": "stale_content", "message": "changed"}}),
        json!({"id": "gpui-1"}),
    ] {
        let link = ResolvedLink::from_response(target.clone(), &response);
        assert!(link.regions.is_empty(), "{response}");
    }
}

#[test]
fn a_handled_click_opens_nothing_and_a_declined_one_opens_only_web_addresses() {
    let local = || crate::browser::WebUrl::try_from("https://local.example/").ok();
    let activated = |result: Value| Ok(json!({"id": "gpui-2", "result": result}));
    let opened = |response, fallback| activation_fallback(response, fallback).map(String::from);
    assert_eq!(
        opened(
            activated(
                json!({"type": "pane_link_activated", "url": "https://x.example/", "handled": true})
            ),
            local()
        ),
        None
    );
    assert_eq!(
        opened(
            activated(
                json!({"type": "pane_link_activated", "url": "https://wrapped.example/a/b", "handled": false})
            ),
            local()
        ),
        Some("https://wrapped.example/a/b".into())
    );
    // A destination this client must never open falls back to the local
    // reading of the row, and to nothing without one.
    for url in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "x-man-page://ls",
    ] {
        let declined =
            || activated(json!({"type": "pane_link_activated", "url": url, "handled": false}));
        assert_eq!(
            opened(declined(), local()),
            Some("https://local.example/".into())
        );
        assert_eq!(opened(declined(), None), None);
    }
    for failed in [
        activated(json!({"type": "pane_link_activated", "handled": false})),
        Ok(json!({"id": "gpui-2", "error": {"code": "stale_content", "message": "moved"}})),
        Err(crate::Error::NotConnected),
    ] {
        assert_eq!(
            opened(failed, local()),
            Some("https://local.example/".into())
        );
    }
}

#[test]
fn link_methods_are_advertised_separately() {
    let methods = ["pane.link.resolve".to_string()];
    assert!(LinkRequest::Resolve.advertised_in(&methods));
    assert!(!LinkRequest::Activate.advertised_in(&methods));
}

#[test]
fn the_mailbox_keeps_its_answers_and_passes_everything_else_on() {
    let mut inbox = LinkInbox::default();
    assert!(inbox.apply(welcome(&["pane.link.resolve"])).is_some());
    inbox.resolving = Some(Pending {
        id: "gpui-1".into(),
        result: None,
    });
    let other = ClientEvent::Response {
        request_id: "gpui-9".into(),
        response: json!({"id": "gpui-9", "error": {"code": "x", "message": "y"}}),
    };
    assert!(inbox.apply(other).is_some());
    assert!(inbox.take(LinkRequest::Resolve, "gpui-1").is_none());
    // A stale-content error is the hover's own business, not the window's.
    let stale = ClientEvent::Response {
        request_id: "gpui-1".into(),
        response: json!({"id": "gpui-1", "error": {"code": "stale_content", "message": "changed"}}),
    };
    assert!(inbox.apply(stale).is_none());
    // Another request's id does not claim the answer or free the slot.
    assert!(inbox.take(LinkRequest::Resolve, "gpui-2").is_none());
    assert!(inbox.take(LinkRequest::Activate, "gpui-1").is_none());
    assert!(inbox.take(LinkRequest::Resolve, "gpui-1").unwrap().is_ok());
    assert!(inbox.resolving.is_none());
}

#[test]
fn rejection_and_disconnection_answer_the_pending_request() {
    let mut inbox = LinkInbox {
        activating: Some(Pending {
            id: "gpui-3".into(),
            result: None,
        }),
        ..Default::default()
    };
    let rejected = ClientEvent::CommandRejected {
        request_id: Some("gpui-3".into()),
        reason: herdr_client::Error::UnsupportedMethod,
    };
    assert!(inbox.apply(rejected).is_none());
    assert!(matches!(
        inbox.take(LinkRequest::Activate, "gpui-3"),
        Some(Err(crate::Error::Client(
            herdr_client::Error::UnsupportedMethod
        )))
    ));
    inbox.resolving = Some(Pending {
        id: "gpui-4".into(),
        result: None,
    });
    let disconnected = ClientEvent::Disconnected {
        reason: "gone".into(),
        ssh: None,
    };
    assert!(inbox.apply(disconnected).is_some());
    assert!(matches!(
        inbox.take(LinkRequest::Resolve, "gpui-4"),
        Some(Err(crate::Error::NotConnected))
    ));
}
