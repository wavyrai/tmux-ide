#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
const GEN: &str = "12d14eac-0000-4000-8000-000000000001";
const REQUEST: &str = "12d14eac-0000-4000-8000-000000000002";
const GEOMETRY: &str = "12d14eac-0000-4000-8000-000000000003";
const TOKEN: &str = "12d14eac-0000-4000-8000-000000000004";
const CLIENT: &str = "gpui:test";
fn snapshot(revision: u64, input: bool, geometry: bool) -> serde_json::Value {
    json!({"generation":GEN,"session":"tmux-session","revision":revision,"owners":{"input":input.then_some(CLIENT),"focus":null,"geometry":geometry.then_some(CLIENT)},"nativeGeometryYieldUntilMs":0,"clients":[]})
}
fn lease(authority: Authority, revision: u64) -> serde_json::Value {
    json!({"generation":GEN,"session":"tmux-session","clientId":CLIENT,"authority":authority,"token":TOKEN,"revision":revision})
}
fn receipt(
    id: &str,
    authority: Authority,
    status: &str,
    grant: Option<serde_json::Value>,
    snapshot: serde_json::Value,
) -> Vec<u8> {
    serde_json::to_vec(&json!({"type":"authority-receipt","requestId":id,"authority":authority,"status":status,"lease":grant,"snapshot":snapshot})).unwrap()
}
fn lifetime() -> Lifetime {
    Lifetime {
        generation: GEN.into(),
        incarnation: "pane:1".into(),
    }
}
fn policy() -> Policy {
    let mut p = Policy::new(
        GEN.into(),
        "workspace".into(),
        CLIENT.into(),
        vec!["pane.one".into(), "pane.two".into()],
        true,
    )
    .unwrap();
    p.ready(Some(CLIENT), true).unwrap();
    p.bind_lifetime("pane.one", Some(lifetime())).unwrap();
    p.bind_lifetime("pane.two", Some(lifetime())).unwrap();
    p
}
fn granted() -> Policy {
    let mut p = policy();
    let commands = p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    assert_eq!(commands.len(), 2);
    p.accept_json(&receipt(
        REQUEST,
        Authority::Input,
        "granted",
        Some(lease(Authority::Input, 1)),
        snapshot(1, true, false),
    ))
    .unwrap();
    p
}
#[test]
fn foreground_only_requests_input_and_background_releases_both() {
    let mut p = policy();
    let commands = p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    let values: Vec<serde_json::Value> = commands
        .iter()
        .map(|c| serde_json::from_str(c.as_str()).unwrap())
        .collect();
    assert_eq!(
        values,
        vec![
            json!({"type":"presence","generation":GEN,"state":"foreground"}),
            json!({"type":"authority-request","generation":GEN,"requestId":REQUEST,"authority":"input"})
        ]
    );
    assert!(!p.owns(Authority::Input));
    assert!(!p.owns(Authority::Geometry));
    p.accept_json(&receipt(
        REQUEST,
        Authority::Input,
        "granted",
        Some(lease(Authority::Input, 1)),
        snapshot(1, true, false),
    ))
    .unwrap();
    let commands = p.presence(false, REQUEST, GEOMETRY, 1).unwrap();
    assert_eq!(commands.len(), 3);
    assert!(!p.owns(Authority::Input));
    assert!(commands[1].as_str().contains("authority-release"));
    assert!(commands[2].as_str().contains("geometry"));
    assert!(matches!(
        p.input("pane.one", &lifetime(), Input::Text("a".into()), 2),
        Err(Error::Authority)
    ));
}
#[test]
fn snapshot_owner_alone_never_grants_connection_authority() {
    let mut p = policy();
    p.accept_json(
        &serde_json::to_vec(&json!({"type":"authority-snapshot","snapshot":snapshot(1,true,true)}))
            .unwrap(),
    )
    .unwrap();
    assert!(!p.owns(Authority::Input));
    assert!(!p.owns(Authority::Geometry));
}
#[test]
fn input_wire_sequence_lifetime_and_duplicate_ack() {
    let mut p = granted();
    let command = p
        .input("pane.one", &lifetime(), Input::Text("é".into()), 0)
        .unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(command.as_str()).unwrap(),
        json!({"type":"input","pane":"pane.one","seq":1,"kind":"text","data":"é","expectedLifetime":{"generation":GEN,"incarnation":"pane:1"}})
    );
    assert_eq!(p.pending_inputs(), 1);
    let ack = br#"{"type":"input-ack","pane":"pane.one","seq":1}"#;
    assert_eq!(
        p.accept_json(ack).unwrap().inputs[0].result,
        InputResult::Ok
    );
    assert!(p.accept_json(ack).unwrap().inputs.is_empty());
    let next = p
        .input("pane.one", &lifetime(), Input::Key("C-Left".into()), 1)
        .unwrap();
    assert!(next.as_str().contains("\"seq\":2"));
}
#[test]
fn pane_change_keeps_other_pending_ack_but_new_incarnation_retires_old_input() {
    let mut p = granted();
    p.input("pane.one", &lifetime(), Input::Text("a".into()), 0)
        .unwrap();
    p.input("pane.two", &lifetime(), Input::Text("b".into()), 0)
        .unwrap();
    let replaced = Lifetime {
        generation: GEN.into(),
        incarnation: "pane:2".into(),
    };
    let retired = p.bind_lifetime("pane.one", Some(replaced.clone())).unwrap();
    assert_eq!(retired.len(), 1);
    assert_eq!(retired[0].result, InputResult::AuthorityLost);
    assert_eq!(p.pending_inputs(), 1);
    assert!(matches!(
        p.input("pane.one", &lifetime(), Input::Text("stale".into()), 1),
        Err(Error::Lifetime)
    ));
    p.input("pane.one", &replaced, Input::Text("new".into()), 1)
        .unwrap();
    assert!(
        p.accept_json(br#"{"type":"input-ack","pane":"pane.one","seq":1}"#)
            .unwrap()
            .inputs
            .is_empty()
    );
    assert_eq!(p.pending_inputs(), 2);
}
#[test]
fn authority_loss_clears_pending_inputs_without_replay() {
    let mut p = granted();
    p.input("pane.one", &lifetime(), Input::Text("a".into()), 0)
        .unwrap();
    let outcome = p
        .accept_json(
            &serde_json::to_vec(
                &json!({"type":"authority-snapshot","snapshot":snapshot(2,false,false)}),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(outcome.inputs[0].result, InputResult::AuthorityLost);
    assert!(!p.owns(Authority::Input));
    assert_eq!(p.pending_inputs(), 0);
}
#[test]
fn uncertain_input_timeout_reports_without_replay_and_late_ack_is_idempotent() {
    let mut p = granted();
    p.input("pane.one", &lifetime(), Input::Text("a".into()), 0)
        .unwrap();
    assert!(p.expire(1999).unwrap().inputs.is_empty());
    let expiration = p.expire(2000).unwrap();
    assert_eq!(expiration.inputs[0].result, InputResult::Timeout);
    assert_eq!(p.pending_inputs(), 0);
    assert!(
        p.accept_json(br#"{"type":"input-ack","pane":"pane.one","seq":1}"#)
            .unwrap()
            .inputs
            .is_empty()
    );
    // A fresh explicit input keeps monotonically increasing identity. No old text is returned.
    let command = p
        .input("pane.one", &lifetime(), Input::Text("b".into()), 2001)
        .unwrap();
    assert!(command.as_str().contains("\"seq\":2"));
    p.retire();
    assert!(matches!(p.ready(Some(CLIENT), true), Err(Error::Retired)));
}
#[test]
fn input_bound_matches_existing_client_and_barriers_do_not_drop_commands() {
    let mut p = granted();
    for _ in 0..256 {
        p.input("pane.one", &lifetime(), Input::Text("a".into()), 0)
            .unwrap();
    }
    assert!(matches!(
        p.input("pane.one", &lifetime(), Input::Text("b".into()), 0),
        Err(Error::Full)
    ));
    assert!(matches!(
        p.presence(false, REQUEST, GEOMETRY, 1),
        Err(Error::Busy)
    ));
    assert!(!p.owns(Authority::Input));
    assert_eq!(p.pending_inputs(), 256);
}
#[test]
fn viewport_requires_requested_geometry_and_correlates_lease() {
    let mut p = granted();
    assert!(matches!(p.viewport(80, 24, None, 0), Err(Error::Authority)));
    p.request_authority(Authority::Geometry, GEOMETRY, 0)
        .unwrap();
    p.accept_json(&receipt(
        GEOMETRY,
        Authority::Geometry,
        "granted",
        Some(lease(Authority::Geometry, 2)),
        snapshot(2, true, true),
    ))
    .unwrap();
    let c = p.viewport(80, 24, Some("window.one"), 1).unwrap();
    let value: serde_json::Value = serde_json::from_str(c.as_str()).unwrap();
    assert_eq!(value["authorityLease"], lease(Authority::Geometry, 2));
    assert_eq!(value["semanticWindowId"], "window.one");
    let ack = json!({"type":"viewport-ack","seq":1,"cols":80,"rows":24,"authorityLease":lease(Authority::Geometry,2),"outcome":"ok"});
    assert_eq!(
        p.accept_json(&serde_json::to_vec(&ack).unwrap())
            .unwrap()
            .viewport,
        Some((1, ViewportOutcome::Ok))
    );
    assert!(p.accept_json(&serde_json::to_vec(&ack).unwrap()).is_err());
}
#[test]
fn viewport_ack_after_blur_drains_without_restoring_authority() {
    for forged in [false, true] {
        let mut p = granted();
        p.request_authority(Authority::Geometry, GEOMETRY, 0)
            .unwrap();
        p.accept_json(&receipt(
            GEOMETRY,
            Authority::Geometry,
            "granted",
            Some(lease(Authority::Geometry, 2)),
            snapshot(2, true, true),
        ))
        .unwrap();
        p.viewport(111, 47, Some("window.one"), 1).unwrap();
        p.presence(false, REQUEST, GEOMETRY, 2).unwrap();
        assert!(!p.owns(Authority::Input));
        assert!(!p.owns(Authority::Geometry));
        let mut ack = json!({"type":"viewport-ack","seq":1,"cols":111,"rows":47,
            "authorityLease":lease(Authority::Geometry,2),"outcome":"ok"});
        if forged {
            ack["authorityLease"]["token"] = json!(REQUEST);
        }
        let result = p.accept_json(&serde_json::to_vec(&ack).unwrap());
        if forged {
            assert!(matches!(result, Err(Error::Invalid)));
        } else {
            assert_eq!(result.unwrap().viewport, Some((1, ViewportOutcome::Ok)));
            assert!(!p.retired);
            assert!(p.viewports.is_empty());
            assert!(!p.owns(Authority::Input));
            assert!(!p.owns(Authority::Geometry));
            assert!(matches!(p.viewport(60, 20, None, 3), Err(Error::Authority)));
        }
    }
}
#[test]
fn late_viewport_result_cannot_revoke_a_replacement_geometry_grant() {
    for outcome in ["ok", "geometry-authority-conflict"] {
        let mut p = granted();
        p.request_authority(Authority::Geometry, GEOMETRY, 0)
            .unwrap();
        p.accept_json(&receipt(
            GEOMETRY,
            Authority::Geometry,
            "granted",
            Some(lease(Authority::Geometry, 2)),
            snapshot(2, true, true),
        ))
        .unwrap();
        p.viewport(111, 47, None, 1).unwrap();
        p.release_authority(Authority::Geometry, GEOMETRY, 2)
            .unwrap();
        p.accept_json(&receipt(
            GEOMETRY,
            Authority::Geometry,
            "released",
            None,
            snapshot(3, true, false),
        ))
        .unwrap();
        p.request_authority(Authority::Geometry, GEOMETRY, 3)
            .unwrap();
        let replacement = lease(Authority::Geometry, 4);
        p.accept_json(&receipt(
            GEOMETRY,
            Authority::Geometry,
            "granted",
            Some(replacement.clone()),
            snapshot(4, true, true),
        ))
        .unwrap();
        p.accept_json(
            &serde_json::to_vec(&json!({"type":"viewport-ack","seq":1,
            "cols":111,"rows":47,"authorityLease":lease(Authority::Geometry,2),
            "outcome":outcome}))
            .unwrap(),
        )
        .unwrap();
        assert!(p.owns(Authority::Geometry));
        assert!(p.owns(Authority::Input));
        let next: serde_json::Value =
            serde_json::from_str(p.viewport(95, 30, None, 4).unwrap().as_str()).unwrap();
        assert_eq!(next["authorityLease"], replacement);
    }
}
#[test]
fn malformed_or_regressed_receipt_revokes_everything() {
    for mutation in 0..3 {
        let mut p = granted();
        let mut s = snapshot(1, true, false);
        match mutation {
            0 => s["generation"] = json!(TOKEN),
            1 => s["session"] = json!("other"),
            _ => s["owners"]["geometry"] = json!(CLIENT),
        };
        assert!(
            p.accept_json(
                &serde_json::to_vec(&json!({"type":"authority-snapshot","snapshot":s})).unwrap()
            )
            .is_err()
        );
        assert!(!p.owns(Authority::Input));
    }
}
#[test]
fn invalid_input_does_not_consume_sequence_and_debug_does_not_expose_text() {
    let mut p = granted();
    for input in [
        Input::Key("C-C-C-C-a".into()),
        Input::Text("\0".into()),
        Input::Text("a".repeat(1025)),
    ] {
        assert!(p.input("pane.one", &lifetime(), input, 0).is_err());
    }
    let c = p
        .input(
            "pane.one",
            &lifetime(),
            Input::Text("private-sentinel".into()),
            0,
        )
        .unwrap();
    assert!(!format!("{c:?}").contains("private-sentinel"));
    assert!(c.as_str().contains("\"seq\":1"));
}
#[test]
fn commands_and_receipts_match_production_ts_schema_vectors() {
    let vectors: serde_json::Value =
        serde_json::from_str(include_str!("tests/vectors.json")).unwrap();
    let clients = vectors["clients"].as_array().unwrap();
    let servers = vectors["servers"].as_array().unwrap();
    let mut p = policy();
    let equal = |command: &Command, i: usize| {
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(command.as_str()).unwrap(),
            clients[i]
        )
    };
    let commands = p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    equal(&commands[0], 0);
    equal(&commands[1], 1);
    p.accept_json(&serde_json::to_vec(&servers[0]).unwrap())
        .unwrap();
    equal(
        &p.input("pane.one", &lifetime(), Input::Text("é".into()), 0)
            .unwrap(),
        2,
    );
    p.accept_json(&serde_json::to_vec(&servers[1]).unwrap())
        .unwrap();
    equal(
        &p.request_authority(Authority::Geometry, GEOMETRY, 0)
            .unwrap(),
        3,
    );
    p.accept_json(&serde_json::to_vec(&servers[2]).unwrap())
        .unwrap();
    equal(&p.viewport(80, 24, Some("window.one"), 0).unwrap(), 4);
    p.accept_json(&serde_json::to_vec(&servers[3]).unwrap())
        .unwrap();
    let commands = p.presence(false, REQUEST, GEOMETRY, 1).unwrap();
    for (i, c) in commands.iter().enumerate() {
        equal(c, i + 5);
    }
}
#[test]
fn viewport_conflict_releases_geometry_without_revoking_input() {
    let mut p = granted();
    p.request_authority(Authority::Geometry, GEOMETRY, 0)
        .unwrap();
    p.accept_json(&receipt(
        GEOMETRY,
        Authority::Geometry,
        "granted",
        Some(lease(Authority::Geometry, 2)),
        snapshot(2, true, true),
    ))
    .unwrap();
    p.viewport(80, 24, None, 0).unwrap();
    p.accept_json(&serde_json::to_vec(&json!({"type":"viewport-ack","seq":1,"cols":80,"rows":24,"authorityLease":lease(Authority::Geometry,2),"outcome":"geometry-authority-conflict"})).unwrap()).unwrap();
    assert!(!p.owns(Authority::Geometry));
    assert!(p.owns(Authority::Input));
}
#[test]
fn wrong_receipt_lease_identity_never_grants_and_redacted_errors_hide_wire_values() {
    let mut p = policy();
    p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    let mut wrong = lease(Authority::Input, 1);
    wrong["clientId"] = json!("other");
    assert!(
        p.accept_json(&receipt(
            REQUEST,
            Authority::Input,
            "granted",
            Some(wrong),
            snapshot(1, true, false)
        ))
        .is_err()
    );
    assert!(!p.owns(Authority::Input));
    let mut p = granted();
    let error = p
        .accept_json(br#"{"type":"private-sentinel"}"#)
        .unwrap_err();
    assert!(!format!("{error:?}").contains("private-sentinel"));
    assert!(!format!("{:?}", Input::Text("private-sentinel".into())).contains("private-sentinel"));
}
#[test]
fn geometry_timeout_reports_without_disconnecting_or_replaying() {
    let mut p = granted();
    p.request_authority(Authority::Geometry, GEOMETRY, 0)
        .unwrap();
    p.accept_json(&receipt(
        GEOMETRY,
        Authority::Geometry,
        "granted",
        Some(lease(Authority::Geometry, 2)),
        snapshot(2, true, true),
    ))
    .unwrap();
    p.viewport(80, 24, None, 0).unwrap();
    let expired = p.expire(2000).unwrap();
    assert_eq!(expired.viewports, vec![1]);
    assert!(p.owns(Authority::Input));
    assert!(p.owns(Authority::Geometry));
    let fresh = p.viewport(81, 24, None, 2001).unwrap();
    assert!(fresh.as_str().contains("\"seq\":2"));
}
#[test]
fn authority_timeout_accepts_exact_late_receipt_without_resurrecting_grant() {
    let mut p = policy();
    p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    let expired = p.expire(2000).unwrap();
    assert_eq!(
        expired.authorities,
        vec![(REQUEST.into(), Authority::Input)]
    );
    assert!(!p.owns(Authority::Input));
    p.request_authority(Authority::Input, GEOMETRY, 2001)
        .unwrap();
    p.accept_json(&receipt(
        GEOMETRY,
        Authority::Input,
        "granted",
        Some(lease(Authority::Input, 3)),
        snapshot(3, true, false),
    ))
    .unwrap();
    let old = p
        .accept_json(&receipt(
            REQUEST,
            Authority::Input,
            "granted",
            Some(lease(Authority::Input, 1)),
            snapshot(1, true, false),
        ))
        .unwrap();
    assert!(!old.authority_changed);
    assert_eq!(p.snapshot().unwrap().revision, 3);
    assert!(p.owns(Authority::Input));
}
#[test]
fn focus_loss_revokes_immediately_then_barrier_drains_without_deadlock() {
    let mut p = granted();
    p.input("pane.one", &lifetime(), Input::Text("a".into()), 0)
        .unwrap();
    assert!(matches!(
        p.presence(false, REQUEST, GEOMETRY, 1),
        Err(Error::Busy)
    ));
    assert!(!p.owns(Authority::Input));
    assert!(matches!(
        p.input("pane.one", &lifetime(), Input::Text("b".into()), 1),
        Err(Error::Authority)
    ));
    p.accept_json(br#"{"type":"input-ack","pane":"pane.one","seq":1}"#)
        .unwrap();
    assert_eq!(p.presence(false, REQUEST, GEOMETRY, 2).unwrap().len(), 3);
    p.accept_json(&receipt(
        REQUEST,
        Authority::Input,
        "released",
        None,
        snapshot(2, false, false),
    ))
    .unwrap();
    p.accept_json(&receipt(
        GEOMETRY,
        Authority::Geometry,
        "released",
        None,
        snapshot(2, false, false),
    ))
    .unwrap();
    assert_eq!(p.presence(true, REQUEST, GEOMETRY, 3).unwrap().len(), 2);
    assert!(!p.owns(Authority::Input));
}
#[test]
fn focus_loss_while_authority_request_pending_never_installs_late_grant() {
    let mut p = policy();
    p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    assert!(matches!(
        p.presence(false, GEOMETRY, TOKEN, 1),
        Err(Error::Busy)
    ));
    p.accept_json(&receipt(
        REQUEST,
        Authority::Input,
        "granted",
        Some(lease(Authority::Input, 1)),
        snapshot(1, true, false),
    ))
    .unwrap();
    assert!(!p.owns(Authority::Input));
    assert_eq!(p.presence(false, GEOMETRY, TOKEN, 2).unwrap().len(), 3);
}
#[test]
fn readonly_ready_may_omit_connection_identity_but_cannot_grant_input() {
    let mut p = Policy::new(
        GEN.into(),
        "workspace".into(),
        CLIENT.into(),
        vec!["pane.one".into()],
        false,
    )
    .unwrap();
    p.ready(None, false).unwrap();
    let commands = p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    assert_eq!(commands.len(), 1);
    assert!(!p.owns(Authority::Input));
    assert!(matches!(
        p.request_authority(Authority::Input, REQUEST, 0),
        Err(Error::Invalid)
    ));
    let mut interactive = policy();
    assert!(interactive.ready(None, false).is_err());
}
#[test]
fn focus_loss_barrier_clears_on_authority_snapshot_even_after_local_revocation() {
    let mut p = granted();
    p.input("pane.one", &lifetime(), Input::Text("a".into()), 0)
        .unwrap();
    assert!(matches!(
        p.presence(false, REQUEST, GEOMETRY, 1),
        Err(Error::Busy)
    ));
    let outcome = p
        .accept_json(
            &serde_json::to_vec(
                &json!({"type":"authority-snapshot","snapshot":snapshot(2,false,false)}),
            )
            .unwrap(),
        )
        .unwrap();
    assert_eq!(outcome.inputs[0].result, InputResult::AuthorityLost);
    assert!(p.barrier_ready());
    assert_eq!(p.presence(false, REQUEST, GEOMETRY, 2).unwrap().len(), 3);
}

#[test]
fn paste_sequential_utf16_frozen_brackets_and_no_interleaving() {
    let mut p = granted();
    let first = p
        .begin_paste("pane.one", &lifetime(), &"🦀".repeat(600), true, 0)
        .unwrap();
    let first: serde_json::Value = serde_json::from_str(first.as_str()).unwrap();
    assert!(first["data"].as_str().unwrap().starts_with("\x1b[200~"));
    assert_eq!(first["data"].as_str().unwrap().encode_utf16().count(), 1024);
    assert!(matches!(p.next_paste(0), Err(Error::Busy)));
    assert!(matches!(
        p.input("pane.one", &lifetime(), Input::Text("x".into()), 0),
        Err(Error::Busy)
    ));
    p.accept_json(br#"{"type":"input-ack","pane":"pane.one","seq":1}"#)
        .unwrap();
    let second = p.next_paste(1).unwrap().unwrap();
    let second: serde_json::Value = serde_json::from_str(second.as_str()).unwrap();
    assert!(second["data"].as_str().unwrap().ends_with("\x1b[201~"));
    p.accept_json(br#"{"type":"input-ack","pane":"pane.one","seq":2}"#)
        .unwrap();
    assert!(!p.paste_pending());
    assert!(p.barrier_ready());
}
#[test]
fn paste_timeout_lifetime_and_focus_loss_drop_suffix() {
    for case in 0..3 {
        let mut p = granted();
        p.begin_paste("pane.one", &lifetime(), &"a".repeat(2048), false, 0)
            .unwrap();
        match case {
            0 => {
                p.expire(2000).unwrap();
            }
            1 => {
                p.bind_lifetime("pane.one", None).unwrap();
            }
            _ => {
                assert!(p.presence(false, REQUEST, GEOMETRY, 1).is_err());
            }
        }
        assert!(!p.paste_pending());
        assert!(p.next_paste(2001).unwrap().is_none());
    }
}
#[test]
fn paste_admission_rejects_escape_nul_and_oversize() {
    let mut p = granted();
    for text in [
        "".into(),
        "a\0".into(),
        "a\x1b".into(),
        "a".repeat(65537),
        "🦀".repeat(16385),
    ] {
        assert!(
            p.begin_paste("pane.one", &lifetime(), &text, true, 0)
                .is_err()
        );
        assert!(!p.paste_pending());
        assert_eq!(p.pending_inputs(), 0);
    }
}

fn geometry_granted() -> Policy {
    let mut p = granted();
    p.request_authority(Authority::Geometry, GEOMETRY, 0)
        .unwrap();
    p.accept_json(&receipt(
        GEOMETRY,
        Authority::Geometry,
        "granted",
        Some(lease(Authority::Geometry, 2)),
        snapshot(2, true, true),
    ))
    .unwrap();
    p
}
#[test]
fn intent_actual_ts_wire_vectors_and_exact_operation_receipts() {
    let vectors: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("tests/intent-vectors.json")).unwrap();
    for vector in vectors {
        let mut p = geometry_granted();
        let mut intent = vector["command"]["intent"].clone();
        intent.as_object_mut().unwrap().remove("workspaceName");
        let intent = serde_json::from_value(intent).unwrap();
        let cmd = p.submit_intent(REQUEST, intent, 0).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(cmd.as_str()).unwrap(),
            vector["command"]
        );
        let outcome = p
            .accept_json(&serde_json::to_vec(&vector["ack"]).unwrap())
            .unwrap();
        assert!(outcome.intent.unwrap().current);
    }
}
#[test]
fn intent_wrong_generation_target_verb_or_operation_retires() {
    let vectors: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("tests/intent-vectors.json")).unwrap();
    for (key, value) in [
        ("daemonInstanceId", TOKEN),
        ("semanticPaneId", "pane.two"),
        ("verb", "workspace.pane.kill"),
        ("operationId", TOKEN),
    ] {
        let mut p = granted();
        p.submit_intent(
            REQUEST,
            Intent::Select {
                pane: "pane.one".into(),
                window_link: None,
            },
            0,
        )
        .unwrap();
        let mut ack = vectors[0]["ack"].clone();
        ack["outcome"]["result"][key] = json!(value);
        assert!(p.accept_json(&serde_json::to_vec(&ack).unwrap()).is_err());
        assert!(!p.owns(Authority::Input));
    }
}
#[test]
fn intent_lifetime_race_marks_receipt_stale_without_replay() {
    let vectors: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("tests/intent-vectors.json")).unwrap();
    let mut p = granted();
    p.submit_intent(
        REQUEST,
        Intent::Select {
            pane: "pane.one".into(),
            window_link: None,
        },
        0,
    )
    .unwrap();
    p.bind_lifetime("pane.one", None).unwrap();
    let outcome = p
        .accept_json(&serde_json::to_vec(&vectors[0]["ack"]).unwrap())
        .unwrap();
    assert!(!outcome.intent.unwrap().current);
}
#[test]
fn intent_timeout_unknown_late_ack_fails_like_existing_client() {
    let vectors: Vec<serde_json::Value> =
        serde_json::from_str(include_str!("tests/intent-vectors.json")).unwrap();
    let mut p = granted();
    p.submit_intent(
        REQUEST,
        Intent::Select {
            pane: "pane.one".into(),
            window_link: None,
        },
        0,
    )
    .unwrap();
    assert!(p.expire(11999).unwrap().intents.is_empty());
    assert_eq!(p.expire(12000).unwrap().intents, vec![REQUEST]);
    assert!(
        p.accept_json(&serde_json::to_vec(&vectors[0]["ack"]).unwrap())
            .is_err()
    );
}

fn extra_vectors() -> serde_json::Value {
    serde_json::from_str(include_str!("tests/extra-intent-vectors.json")).unwrap()
}
fn topology_policy() -> Policy {
    let mut p = geometry_granted();
    p.bind_split_layout(
        "layout-life",
        serde_json::from_value(extra_vectors()["resource"]["window"].clone()).unwrap(),
        Some(serde_json::from_value(extra_vectors()["resource"].clone()).unwrap()),
    )
    .unwrap();
    p
}
fn vector_intent(vector: &serde_json::Value) -> Intent {
    let mut value = vector["command"]["intent"].clone();
    value.as_object_mut().unwrap().remove("workspaceName");
    serde_json::from_value(value).unwrap()
}
#[test]
fn extra_gui_intents_match_actual_ts_and_preserve_successor() {
    for vector in extra_vectors()["vectors"].as_array().unwrap() {
        let mut p = topology_policy();
        let command = p.submit_intent(REQUEST, vector_intent(vector), 0).unwrap();
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(command.as_str()).unwrap(),
            vector["command"]
        );
        let result = p
            .accept_json(&serde_json::to_vec(&vector["ack"]).unwrap())
            .unwrap();
        assert!(result.intent.unwrap().current);
    }
}
#[test]
fn split_requires_observed_layout_and_successor_exact_window_axis_boundary() {
    let vector = &extra_vectors()["vectors"][5];
    let mut p = geometry_granted();
    assert!(matches!(
        p.submit_intent(REQUEST, vector_intent(vector), 0),
        Err(Error::Lifetime)
    ));
    for field in [
        "axis",
        "boundary",
        "window",
        "missing-split",
        "duplicate-pane",
        "outside-window",
    ] {
        let mut p = topology_policy();
        p.submit_intent(REQUEST, vector_intent(vector), 0).unwrap();
        let mut ack = vector["ack"].clone();
        let result = &mut ack["outcome"]["result"];
        match field {
            "axis" => result["axis"] = json!("rows"),
            "boundary" => result["boundary"] = json!(44),
            "window" => result["successor"]["resource"]["window"]["linkRevision"] = json!(2),
            "missing-split" => result["successor"]["splitId"] = json!(REQUEST),
            "duplicate-pane" => {
                result["successor"]["resource"]["panes"][1]["semanticPaneId"] = json!("pane.one")
            }
            _ => result["successor"]["resource"]["panes"][0]["width"] = json!(4096),
        }
        assert!(
            p.accept_json(&serde_json::to_vec(&ack).unwrap()).is_err(),
            "{field}"
        );
    }
}
#[test]
fn split_receipt_allows_retired_layout_but_not_replaced_lifetime() {
    let vector = &extra_vectors()["vectors"][5];
    for changed_lifetime in [false, true] {
        let mut p = topology_policy();
        p.submit_intent(REQUEST, vector_intent(vector), 0).unwrap();
        let successor = vector["ack"]["outcome"]["result"]["successor"]["resource"].clone();
        p.bind_split_layout(
            if changed_lifetime {
                "other-life"
            } else {
                "layout-life"
            },
            serde_json::from_value(extra_vectors()["resource"]["window"].clone()).unwrap(),
            Some(serde_json::from_value(successor).unwrap()),
        )
        .unwrap();
        let outcome = p
            .accept_json(&serde_json::to_vec(&vector["ack"]).unwrap())
            .unwrap();
        assert_eq!(outcome.intent.unwrap().current, !changed_lifetime);
    }
}

#[test]
fn split_receipt_keeps_scope_when_resource_temporarily_absent() {
    let vector = &extra_vectors()["vectors"][5];
    let mut p = topology_policy();
    p.submit_intent(REQUEST, vector_intent(vector), 0).unwrap();
    p.bind_split_layout(
        "layout-life",
        serde_json::from_value(extra_vectors()["resource"]["window"].clone()).unwrap(),
        None,
    )
    .unwrap();
    let outcome = p
        .accept_json(&serde_json::to_vec(&vector["ack"]).unwrap())
        .unwrap();
    assert!(outcome.intent.unwrap().current);
    assert!(p.submit_intent(TOKEN, vector_intent(vector), 0).is_err());
}

#[test]
fn bytes_require_ready_capability_without_consuming_sequence() {
    let mut p = granted();
    assert!(matches!(
        p.input("pane.one", &lifetime(), Input::Bytes("00ff80".into()), 0),
        Err(Error::Capability)
    ));
    assert_eq!(p.pending_inputs(), 0);
    assert_eq!(
        p.input_submission("pane.one", &lifetime(), Input::Key("Enter".into()), 0)
            .unwrap()
            .0,
        1
    );
}

#[test]
fn negotiated_bytes_preserve_hex_and_validate_before_sequence() {
    let mut p = Policy::new(
        GEN.into(),
        "workspace".into(),
        CLIENT.into(),
        vec!["pane.one".into()],
        true,
    )
    .unwrap();
    p.ready_with_input_bytes(Some(CLIENT), true, true).unwrap();
    p.bind_lifetime("pane.one", Some(lifetime())).unwrap();
    p.presence(true, REQUEST, GEOMETRY, 0).unwrap();
    p.accept_json(&receipt(
        REQUEST,
        Authority::Input,
        "granted",
        Some(lease(Authority::Input, 1)),
        snapshot(1, true, false),
    ))
    .unwrap();
    for value in [
        "".into(),
        "0".into(),
        "gg".into(),
        "é".into(),
        "00".repeat(1025),
    ] {
        assert!(matches!(
            p.input("pane.one", &lifetime(), Input::Bytes(value), 0),
            Err(Error::Invalid)
        ));
    }
    let (seq, command) = p
        .input_submission(
            "pane.one",
            &lifetime(),
            Input::Bytes("1b5b4d20FF8000c328".into()),
            0,
        )
        .unwrap();
    assert_eq!(seq, 1);
    let value: serde_json::Value = serde_json::from_str(command.as_str()).unwrap();
    assert_eq!(
        value,
        json!({"type":"input","pane":"pane.one","seq":1,"kind":"bytes","data":"1b5b4d20FF8000c328","expectedLifetime":lifetime()})
    );
    assert!(
        p.input("pane.one", &lifetime(), Input::Bytes("00".repeat(1024)), 0)
            .is_ok()
    );
}
