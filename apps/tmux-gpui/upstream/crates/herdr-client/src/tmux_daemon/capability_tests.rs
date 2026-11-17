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
/// be issued at all, by any daemon. 119 is offered wherever it fits. The one
/// offer that is already full (graphics, native surfaces and input) offers
/// 120 in place of 118, to a daemon that knows 120, and stays as it was for
/// any other: a daemon that predates 120 would give neither 118 nor 119.
#[test]
fn topology_in_place_is_offered_within_the_nine_number_bound() {
    for graphics in [false, true] {
        for local_images in [false, true] {
            for native_surfaces in [false, true] {
                for interactive in [false, true] {
                    for bundle in [false, true] {
                        let offer = offered_versions(
                            graphics,
                            local_images,
                            native_surfaces,
                            interactive,
                            bundle,
                        );
                        let case = (graphics, local_images, native_surfaces, interactive, bundle);
                        assert!(offer.len() <= 9, "{case:?}: {offer:?}");
                        let unique: std::collections::BTreeSet<_> = offer.iter().collect();
                        assert_eq!(unique.len(), offer.len(), "{case:?}");
                        let full = graphics && native_surfaces && interactive;
                        assert_eq!(offer.contains(&119), !full, "{case:?}: {offer:?}");
                        assert_eq!(offer.contains(&120), full && bundle, "{case:?}: {offer:?}");
                        assert_eq!(
                            offer.contains(&118),
                            graphics && !(full && bundle),
                            "{case:?}: {offer:?}"
                        );
                    }
                }
            }
        }
    }
    assert_eq!(
        offered_versions(true, false, false, true, true),
        [1, 101, 113, 118, 103, 104, 105, 106, 119]
    );
    assert_eq!(
        offered_versions(true, true, true, true, false),
        [1, 101, 114, 118, 103, 104, 116, 105, 106]
    );
    assert_eq!(
        offered_versions(true, true, true, true, true),
        [1, 101, 114, 120, 103, 104, 116, 105, 106]
    );
}

#[test]
fn only_a_daemon_release_that_knows_the_bundle_is_offered_it() {
    let [major, minor, patch] = TOPOLOGY_BUNDLE_SINCE;
    let version = |major: u64, minor: u64, patch: u64| format!("{major}.{minor}.{patch}");
    assert!(knows_topology_bundle(Some(&version(major, minor, patch))));
    assert!(knows_topology_bundle(Some(&version(
        major,
        minor,
        patch + 1
    ))));
    assert!(knows_topology_bundle(Some(&version(major, minor + 1, 0))));
    assert!(knows_topology_bundle(Some(&version(major + 1, 0, 0))));
    assert!(patch > 0, "the cases below need an earlier patch release");
    assert!(!knows_topology_bundle(Some(&version(
        major,
        minor,
        patch - 1
    ))));
    assert!(!knows_topology_bundle(Some(&version(
        major,
        minor - 1,
        patch + 5
    ))));
    assert!(!knows_topology_bundle(Some(&version(
        major - 1,
        minor + 5,
        patch + 5
    ))));
    // A build of the release that is not the release, an SSH daemon whose
    // version this side does not hold, and anything that is no version.
    let pre = format!("{}-rc.1", version(major, minor, patch));
    for unknown in [
        Some(pre.as_str()),
        None,
        Some(""),
        Some("2.9"),
        Some("2.9.x"),
        Some("v2.9.99"),
        Some("2.9.99.1"),
    ] {
        assert!(!knows_topology_bundle(unknown), "{unknown:?}");
    }
}

/// Review of 799ce7fc: the gate pinned in released versions, not only
/// relative to its own constant. 120 ships with daemon 2.9.25 (the owner holds
/// 2.9.25 for #723). A released daemon offered 120 would give neither 118 nor
/// 119, and a full interactive stream would silently lose zlib graphics,
/// browser icons and reader badges.
#[test]
fn released_daemons_before_2_9_25_keep_118_and_2_9_25_gets_120() {
    for released in ["2.9.22", "2.9.23", "2.9.24"] {
        assert!(!knows_topology_bundle(Some(released)), "{released}");
        let offer = offered_versions(
            true,
            true,
            true,
            true,
            knows_topology_bundle(Some(released)),
        );
        assert!(offer.contains(&118), "{released}: {offer:?}");
        assert!(
            !offer.contains(&119) && !offer.contains(&120),
            "{released}: {offer:?}"
        );
    }
    for knowing in ["2.9.25", "2.9.26", "2.10.0", "3.0.0"] {
        assert!(knows_topology_bundle(Some(knowing)), "{knowing}");
        let offer = offered_versions(true, true, true, true, knows_topology_bundle(Some(knowing)));
        assert!(
            offer.contains(&120) && !offer.contains(&118),
            "{knowing}: {offer:?}"
        );
    }
    for unknown in ["2.9.25-rc.1", "2.9.25+build", "not a version", "2.9"] {
        assert!(!knows_topology_bundle(Some(unknown)), "{unknown}");
        let offer = offered_versions(true, true, true, true, knows_topology_bundle(Some(unknown)));
        assert!(
            offer.contains(&118) && !offer.contains(&120),
            "{unknown}: {offer:?}"
        );
    }
}

/// #718: capability 123 (each layout pane's browser kind) is offered to a
/// daemon release that knows it, 2.9.26 or later, which also takes up to 16
/// numbers. Released daemons refuse a tenth number, so for them, for a
/// remote daemon (no version) and for anything that is not a plain release
/// number the offer stays exactly as it was. A surface source, which has no
/// header, never asks for it.
#[test]
fn the_browser_kind_is_offered_only_to_a_daemon_that_knows_it() {
    for graphics in [false, true] {
        for local_images in [false, true] {
            for native_surfaces in [false, true] {
                for interactive in [false, true] {
                    for version in [
                        None,
                        Some("2.9.24"),
                        Some("2.9.25"),
                        Some("2.9.26"),
                        Some("2.10.0"),
                        Some("3.0.0"),
                        Some("2.9.26-rc.1"),
                        Some("dev"),
                    ] {
                        let case = (
                            graphics,
                            local_images,
                            native_surfaces,
                            interactive,
                            version,
                        );
                        let before = offered_versions(
                            graphics,
                            local_images,
                            native_surfaces,
                            interactive,
                            knows_topology_bundle(version),
                        );
                        let offer = with_browser_kind(before.clone(), graphics, version);
                        let knows = matches!(version, Some("2.9.26" | "2.10.0" | "3.0.0"));
                        if graphics && knows {
                            assert_eq!(offer[..offer.len() - 1], before[..], "{case:?}");
                            assert_eq!(offer.last(), Some(&123), "{case:?}");
                            assert!(offer.len() <= 16, "{case:?}: {offer:?}");
                        } else {
                            assert_eq!(offer, before, "{case:?}");
                            assert!(offer.len() <= 9, "{case:?}: {offer:?}");
                        }
                    }
                }
            }
        }
    }
    // A full 2.9.26 offer gets no 17th number.
    let full: Vec<u32> = (200..216).collect();
    assert_eq!(with_browser_kind(full.clone(), true, Some("2.9.26")), full);
    assert_eq!(
        with_browser_kind(
            offered_versions(true, true, true, true, true),
            true,
            Some("2.9.26")
        ),
        [1, 101, 114, 120, 103, 104, 116, 105, 106, 123]
    );
}
