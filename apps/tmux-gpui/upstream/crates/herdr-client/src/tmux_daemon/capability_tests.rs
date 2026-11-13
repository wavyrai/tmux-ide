#![allow(clippy::unwrap_used)]
use super::*;
use crate::tmux_handoff::ServerScope;
fn scope() -> ServerScope {
    ServerScope {
        server_id: "tmux-server.0123456789abcdef0123456789abcdef".into(),
        generation: "d9c81ebd-5785-45a3-9206-a2aa497d68fc".into(),
    }
}
fn selection() -> TerminalSelection {
    TerminalSelection {
        workspace_name: "fixture".into(),
        live_session_id: "live-session.0123456789abcdef0123".into(),
        selected_pane: "pane.first".into(),
        visible_panes: vec!["pane.first".into(), "pane.second".into()],
        mode: ViewerMode::Interactive,
    }
}
fn descriptor(request: &str) -> serde_json::Value {
    serde_json::json!({"status":"issued","descriptor":{"protocolVersion":2,"webSocketUrl":"ws://127.0.0.1:4321/v2/terminal/pane-streams/redeem","subprotocol":"tmux-ide-pane-stream.v2","redemptionTicket":format!("ps2_{}","x".repeat(43)),"daemonInstanceId":scope().generation,"requestId":request,"expiresAt":9999999999999u64,"panes":["pane.second","pane.first"],"effectiveViewerMode":"interactive"}})
}
#[test]
fn exact_offer_accepts_reordered_panes_and_redacts_the_ticket() {
    let id = Uuid::new_v4().to_string();
    let value = descriptor(&id);
    let parsed = parse(
        &serde_json::to_vec(&value).unwrap(),
        &selection(),
        &scope(),
        &id,
        &url::Url::parse("http://127.0.0.1:4321/").unwrap(),
    )
    .unwrap();
    assert!(!format!("{parsed:?}").contains("ps2_"));
}
#[test]
fn wrong_origin_request_generation_panes_mode_and_expiry_fail_closed() {
    let id = Uuid::new_v4().to_string();
    for (field, value) in [
        (
            "webSocketUrl",
            serde_json::json!("ws://127.0.0.1:9999/v2/terminal/pane-streams/redeem"),
        ),
        ("requestId", serde_json::json!(Uuid::new_v4().to_string())),
        (
            "daemonInstanceId",
            serde_json::json!(Uuid::new_v4().to_string()),
        ),
        ("panes", serde_json::json!(["pane.first"])),
        ("effectiveViewerMode", serde_json::json!("read-only")),
        ("expiresAt", serde_json::json!(1)),
    ] {
        let mut response = descriptor(&id);
        response["descriptor"][field] = value;
        assert!(
            parse(
                &serde_json::to_vec(&response).unwrap(),
                &selection(),
                &scope(),
                &id,
                &url::Url::parse("http://127.0.0.1:4321/").unwrap()
            )
            .is_err(),
            "{field}"
        );
    }
}
#[test]
fn invalid_selections_cannot_reach_the_owner() {
    for pane in ["%1", "terminal.discovered.fake", "constructor", "pane:bad"] {
        let mut s = selection();
        s.selected_pane = pane.into();
        s.visible_panes = vec![pane.into()];
        assert!(s.validate().is_err(), "{pane}");
    }
    let mut s = selection();
    s.visible_panes.push(s.visible_panes[0].clone());
    assert!(s.validate().is_err());
}
#[test]
fn refusal_preserves_code_without_peer_text() {
    let value = serde_json::json!({"status":"error","error":{"code":"stream-unavailable","reason":"never expose ps2_private-material","retryable":true}});
    let error = parse(
        &serde_json::to_vec(&value).unwrap(),
        &selection(),
        &scope(),
        "request",
        &url::Url::parse("http://127.0.0.1:4321/").unwrap(),
    )
    .unwrap_err();
    assert!(matches!(
        error,
        Error::StreamRefused {
            code: IssueCode::AttachmentUnavailable,
            retryable: true
        }
    ));
    assert!(!format!("{error:?}").contains("private-material"));
}

/// #723. The daemon's schema allows nine numbers; one more and no stream can
/// be issued at all, by any daemon. 119 is offered wherever it fits.
#[test]
fn topology_in_place_is_offered_wherever_the_nine_number_bound_allows() {
    for graphics in [false, true] {
        for local_images in [false, true] {
            for native_surfaces in [false, true] {
                for interactive in [false, true] {
                    let offer =
                        offered_versions(graphics, local_images, native_surfaces, interactive);
                    let case = (graphics, local_images, native_surfaces, interactive);
                    assert!(offer.len() <= 9, "{case:?}: {offer:?}");
                    let unique: std::collections::BTreeSet<_> = offer.iter().collect();
                    assert_eq!(unique.len(), offer.len(), "{case:?}");
                    // The one offer that is already full: graphics, native
                    // surfaces and input.
                    let full = graphics && native_surfaces && interactive;
                    assert_eq!(offer.contains(&119), !full, "{case:?}: {offer:?}");
                    assert_eq!(offer.contains(&118), graphics, "{case:?}");
                }
            }
        }
    }
    assert_eq!(
        offered_versions(true, false, false, true),
        [1, 101, 113, 118, 103, 104, 105, 106, 119]
    );
    assert_eq!(
        offered_versions(true, true, true, true),
        [1, 101, 114, 118, 103, 104, 116, 105, 106]
    );
}
