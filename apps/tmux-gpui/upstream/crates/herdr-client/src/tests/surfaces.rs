use super::*;

#[test]
fn full_popup_surface_is_delivered_and_invalid_cells_fail_closed() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    let mut surface = baseline();
    surface.popup = Some(Box::new(ClientShellPopupSurface {
        terminal_id: "popup-1".into(),
        title: "Popup".into(),
        width: Some(ClientShellPopupSize::Percent(80)),
        height: Some(ClientShellPopupSize::Cells(1)),
        frame: surface.frame.clone(),
        mouse_reporting: true,
        sgr_pixel_mouse: false,
        pixel_width: 8,
        pixel_height: 16,
    }));
    send(&mut server, ServerMessage::PaneSurface(surface.clone()));
    assert!(matches!(event(&client), ClientEvent::Surface(s) if *s == surface));
    surface.surface_revision += 1;
    surface.popup.as_mut().unwrap().frame.cells.clear();
    send(&mut server, ServerMessage::PaneSurface(surface));
    assert!(
        worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("cell count")
    );
}

#[test]
fn future_surface_and_patch_wait_for_matching_snapshot() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    let mut future = baseline();
    future.projection_revision = 9;
    send(&mut server, ServerMessage::PaneSurface(future));
    send(
        &mut server,
        ServerMessage::PaneSurfacePatch(PaneSurfacePatch {
            boot_id: "boot-v1".into(),
            projection_revision: 9,
            base_surface_revision: 1,
            surface_revision: 2,
            rows: vec![],
            panes: vec![],
            cursor: None,
        }),
    );
    let mut snapshot: Value = serde_json::from_str(SNAPSHOT).unwrap();
    for revision in [8, 9] {
        snapshot["revision"] = revision.into();
        send(
            &mut server,
            ServerMessage::EndpointControl {
                kind: ENDPOINT_SNAPSHOT_KIND.into(),
                data: snapshot.to_string(),
            },
        );
        assert!(matches!(event(&client), ClientEvent::Snapshot(s) if s.revision == revision));
    }
    assert!(matches!(event(&client), ClientEvent::Surface(s)
        if s.projection_revision == 9 && s.surface_revision == 2));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn boot_change_in_partial_frame_prevents_queued_input() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    let mut snapshot: Value = serde_json::from_str(SNAPSHOT).unwrap();
    snapshot["boot_id"] = "replacement".into();
    let bytes = encode_message(
        &ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: snapshot.to_string(),
        },
        MAX_FRAME_SIZE,
    )
    .unwrap();
    server.write_all(&bytes[..5]).unwrap();
    thread::sleep(Duration::from_millis(100));
    client.handle.set_focus("boot-v1", true).unwrap();
    server.write_all(&bytes[5..]).unwrap();
    assert!(
        worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("boot changed")
    );
    let mut byte = [0];
    assert_eq!(server.read(&mut byte).unwrap(), 0);
}

#[test]
fn snapshot_surface_patch_navigation_input_resize_and_response() {
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    assert!(matches!(event(&client), ClientEvent::Connected(_)));
    let ClientEvent::Snapshot(s) = event(&client) else {
        panic!("snapshot missing")
    };
    assert_eq!(s.panes[0].pane_id, "w1:p1");
    send(&mut server, ServerMessage::PaneSurface(baseline()));
    let ClientEvent::Surface(first) = event(&client) else {
        panic!("surface missing")
    };
    send(
        &mut server,
        ServerMessage::PaneSurfacePatch(PaneSurfacePatch {
            boot_id: s.boot_id.clone(),
            projection_revision: 7,
            base_surface_revision: 1,
            surface_revision: 2,
            rows: vec![PaneSurfacePatchRow {
                x: 0,
                y: 0,
                cells: vec![CellData {
                    symbol: "y".into(),
                    ..first.frame.cells[0].clone()
                }],
            }],
            panes: vec![],
            cursor: None,
        }),
    );
    let ClientEvent::Surface(second) = event(&client) else {
        panic!("patched surface missing")
    };
    assert_eq!(first.frame.cells[0].symbol, "x"); // Published Arcs are immutable.
    assert_eq!(second.frame.cells[0].symbol, "y");
    assert_eq!(second.surface_revision, 2);
    client
        .handle
        .send_input(
            &s.boot_id,
            "w1:p1",
            std::iter::once(ClientPaneInputEvent::TextCommit("hello".into())),
        )
        .unwrap();
    client
        .handle
        .resize(
            &s.boot_id,
            ConnectOptions {
                surface_size: ClientSurfaceSize {
                    cols: 100,
                    rows: 30,
                },
                ..ConnectOptions::default()
            },
        )
        .unwrap();
    let id = client.handle.focus_pane(&s.boot_id, "w1:p1").unwrap();
    assert!(
        matches!(receive(&mut server), ClientMessage::ClientShellPaneInput { pane_id, events } if pane_id == "w1:p1" && events == vec![ClientPaneInputEvent::TextCommit("hello".into())])
    );
    assert!(matches!(
        receive(&mut server),
        ClientMessage::ClientShellResize {
            surface_size: ClientSurfaceSize {
                cols: 100,
                rows: 30
            },
            ..
        }
    ));
    let ClientMessage::ClientShellEndpointRequest { boot_id, request } = receive(&mut server)
    else {
        panic!("request missing")
    };
    assert_eq!(boot_id, s.boot_id);
    assert_eq!(
        serde_json::from_str::<Value>(&request).unwrap(),
        json!({"id": id, "method": "pane.focus", "params": {"pane_id": "w1:p1"}})
    );
    let response = json!({"id": id, "result": {"type": "pane_info", "pane": {"pane_id": "w1:p1", "focused": true}}}).to_string();
    let mid = response.len() / 2;
    for (final_chunk, data) in [
        (false, &response.as_bytes()[..mid]),
        (true, &response.as_bytes()[mid..]),
    ] {
        send(
            &mut server,
            ServerMessage::ClientShellEndpointResponseChunk {
                boot_id: s.boot_id.clone(),
                request_id: id.clone(),
                final_chunk,
                data: data.to_vec(),
            },
        );
    }
    assert!(
        matches!(event(&client), ClientEvent::Response { request_id, response } if request_id == id && response["result"]["pane"]["focused"] == true)
    );
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn surface_images_precede_their_surface_and_survive_a_pending_projection() {
    let key = |image_id| SurfaceGraphicsAssetKey {
        source: SurfaceGraphicsSource::Terminal {
            target: SurfaceGraphicsTarget::Pane {
                pane_id: "p1".into(),
            },
            image_id,
        },
        image_width: 1,
        image_height: 1,
        format: SurfaceGraphicsFormat::Rgba,
        data_len: 4,
        data_fingerprint: u64::from(image_id),
    };
    let placing = |key: &SurfaceGraphicsAssetKey, revision, projection| {
        let mut surface = baseline();
        surface.surface_revision = revision;
        surface.projection_revision = projection;
        surface.graphics = SurfaceGraphicsScene {
            assets: vec![SurfaceGraphicsAsset {
                key: key.clone(),
                data: vec![1, 2, 3, 255],
            }],
            placements: vec![SurfaceGraphicsPlacement {
                asset: key.clone(),
                logical_placement_id: 1,
                x: 0,
                y: 0,
                cols: 1,
                rows: 1,
                source_x: 0,
                source_y: 0,
                source_width: 0,
                source_height: 0,
                x_offset: 0,
                y_offset: 0,
                z: 0,
                scrollback_offset: 0,
            }],
            retained_assets: vec![],
        };
        ServerMessage::PaneSurface(surface)
    };
    let mut session = ready_session();
    let mut handle = |message| {
        let mut events = Vec::new();
        session
            .handle_message(message, |event| {
                events.push(event);
                Ok(())
            })
            .unwrap();
        events
    };
    let (a, b) = (key(1), key(2));
    let events = handle(placing(&a, 1, 7));
    let [
        ClientEvent::SurfaceImages(images),
        ClientEvent::Surface(surface),
    ] = events.as_slice()
    else {
        panic!("unexpected events {events:?}");
    };
    assert_eq!(images.get(&a).unwrap().data().as_ref(), [1, 2, 3, 255]);
    assert!(surface.graphics.assets.is_empty());
    assert_eq!(surface.graphics.placements.len(), 1);

    // A surface ahead of its snapshot is held back, but its bytes are kept,
    // and so are those the surface on screen still places.
    let events = handle(placing(&b, 2, 8));
    let [ClientEvent::SurfaceImages(images)] = events.as_slice() else {
        panic!("unexpected events {events:?}");
    };
    assert!(images.get(&a).is_some() && images.get(&b).is_some());

    let events = handle(ServerMessage::EndpointControl {
        kind: ENDPOINT_SNAPSHOT_KIND.into(),
        data: SNAPSHOT.replace("\"revision\": 7", "\"revision\": 8"),
    });
    let [
        ClientEvent::Snapshot(_),
        ClientEvent::SurfaceImages(images),
        ClientEvent::Surface(surface),
    ] = events.as_slice()
    else {
        panic!("unexpected events {events:?}");
    };
    assert!(images.get(&a).is_none() && images.get(&b).is_some());
    assert_eq!(surface.graphics.placements[0].asset, b);
}
