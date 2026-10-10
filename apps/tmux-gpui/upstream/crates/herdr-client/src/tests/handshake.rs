use super::*;

#[test]
fn handshake_rejects_every_incompatible_core_selection() {
    for field in [
        "generation",
        "snapshot_codec",
        "surface_codec",
        "input_codec",
        "blob_codec",
        "error",
    ] {
        let (client, mut server, worker) = test_client();
        receive(&mut server);
        let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
        welcome[field] = match field {
            "generation" => json!(2),
            "error" => json!({"code": "no_common_core", "message": "unsupported"}),
            _ => json!("future.codec"),
        };
        send(
            &mut server,
            ServerMessage::EndpointControl {
                kind: ENDPOINT_WELCOME_KIND.into(),
                data: welcome.to_string(),
            },
        );
        assert!(worker.join().unwrap().is_err(), "{field}");
        assert!(client.events.try_recv().is_err());
    }
}

#[test]
fn malformed_handshake_and_patch_fail_closed() {
    let (client, mut server, worker) = test_client();
    receive(&mut server);
    send(
        &mut server,
        ServerMessage::Welcome {
            version: 22,
            encoding: RenderEncoding::SemanticFrame,
            error: None,
        },
    );
    assert!(worker.join().unwrap().is_err());
    drop(client);
    let (client, mut server, worker) = test_client();
    handshake(&mut server);
    event(&client);
    event(&client);
    send(
        &mut server,
        ServerMessage::PaneSurfacePatch(PaneSurfacePatch {
            boot_id: "boot-v1".into(),
            projection_revision: 7,
            base_surface_revision: 1,
            surface_revision: 2,
            rows: vec![],
            panes: vec![],
            cursor: None,
        }),
    );
    assert!(
        worker
            .join()
            .unwrap()
            .unwrap_err()
            .to_string()
            .contains("patch before baseline")
    );
}

#[test]
fn inactive_hello_and_surface_interest_use_upstream_contract() {
    let (client, mut server, worker) = test_client_mode(false, true);
    let ClientMessage::EndpointControl { data, .. } = receive(&mut server) else {
        panic!("hello")
    };
    let hello: EndpointClientHello = serde_json::from_str(&data).unwrap();
    assert!(!hello.surface_active);
    let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
    welcome["methods"] = json!(["client_shell.surface.set"]);
    welcome["capabilities"] = json!([
        "surface_interest",
        "presentation_effects_fence",
        "health_check"
    ]);
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_WELCOME_KIND.into(),
            data: welcome.to_string(),
        },
    );
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: SNAPSHOT.into(),
        },
    );
    assert!(matches!(event(&client), ClientEvent::Connected(_)));
    assert!(matches!(event(&client), ClientEvent::Snapshot(_)));
    let id = client.handle.set_surface_active("boot-v1", true).unwrap();
    let ClientMessage::ClientShellEndpointRequest { boot_id, request } = receive(&mut server)
    else {
        panic!("request")
    };
    assert_eq!(boot_id, "boot-v1");
    assert_eq!(
        serde_json::from_str::<Value>(&request).unwrap(),
        json!({"id":id,"method":"client_shell.surface.set","params":{"active":true}})
    );
    send(
        &mut server,
        ServerMessage::ClientShellEndpointResponseChunk {
            boot_id,
            request_id: id.clone(),
            final_chunk: true,
            data: json!({"id":id,"result":{"active":true}})
                .to_string()
                .into_bytes(),
        },
    );
    assert!(matches!(event(&client), ClientEvent::Response { request_id, .. } if request_id == id));
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}

#[test]
fn inactive_and_remote_require_negotiated_capabilities() {
    for missing in [
        "surface_interest",
        "presentation_effects_fence",
        "health_check",
        "method",
    ] {
        let (client, mut server, worker) = test_client_mode(false, true);
        receive(&mut server);
        let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
        welcome["capabilities"] = json!(
            [
                "surface_interest",
                "presentation_effects_fence",
                "health_check"
            ]
            .into_iter()
            .filter(|c| *c != missing)
            .collect::<Vec<_>>()
        );
        welcome["methods"] = if missing == "method" {
            json!([])
        } else {
            json!(["client_shell.surface.set"])
        };
        send(
            &mut server,
            ServerMessage::EndpointControl {
                kind: ENDPOINT_WELCOME_KIND.into(),
                data: welcome.to_string(),
            },
        );
        assert!(worker.join().unwrap().is_err(), "{missing}");
        assert!(client.events.try_recv().is_err());
    }
    let (client, mut server, worker) = test_client();
    receive(&mut server);
    let mut welcome: Value = serde_json::from_str(WELCOME).unwrap();
    welcome["methods"] = json!(["client_shell.surface.set"]);
    welcome["capabilities"] = json!([]);
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_WELCOME_KIND.into(),
            data: welcome.to_string(),
        },
    );
    send(
        &mut server,
        ServerMessage::EndpointControl {
            kind: ENDPOINT_SNAPSHOT_KIND.into(),
            data: SNAPSHOT.into(),
        },
    );
    event(&client);
    event(&client);
    let id = client.handle.set_surface_active("boot-v1", false).unwrap();
    assert!(
        matches!(event(&client), ClientEvent::CommandRejected { request_id: Some(rejected), reason: Error::UnsupportedSurfaceInterest } if rejected == id)
    );
    client.handle.disconnect();
    worker.join().unwrap().unwrap();
}
