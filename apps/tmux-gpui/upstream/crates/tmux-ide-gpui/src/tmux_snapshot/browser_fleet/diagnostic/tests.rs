use super::*;

fn group(state: Phase, diagnostic: Option<Diagnostic>) -> Group {
    Group {
        collapsed: false,
        collapse_action: None,
        id: "fixture".into(),
        label: "Fixture".into(),
        state,
        diagnostic,
        conflict: false,
        retry: None,
        disconnect: None,
        omitted_sessions: 0,
        sessions: vec![],
        servers: vec![],
        omitted_servers: 0,
    }
}

#[test]
fn strict_diagnostic_rejects_unknown_or_sensitive_fields() {
    for raw in [
        r#"{"phase":"unknown","failure":null}"#,
        r#"{"phase":"disconnected","failure":"private remote error"}"#,
        r#"{"phase":"disconnected","failure":null,"token":"secret"}"#,
        r#"{"phase":"disconnected","failure":null,"path":"/private"}"#,
    ] {
        assert!(serde_json::from_str::<Diagnostic>(raw).is_err());
    }
}

#[test]
fn canonical_failure_is_contextual_without_changing_catalog_or_authority() {
    let diagnostic = Diagnostic {
        phase: ConnectionPhase::NeedsAttention,
        failure: Some(Failure::SshAuthentication),
    };
    let value = group(Phase::Disconnected, Some(diagnostic));
    assert!(
        value
            .connection_hint()
            .is_some_and(|text| text.contains("SSH authentication failed"))
    );
    assert!(value.state == Phase::Disconnected);
    assert!(value.retry.is_none());
}

#[test]
fn ready_owner_does_not_claim_catalog_readiness_and_conflict_wins() {
    let mut value = group(
        Phase::Disconnected,
        Some(Diagnostic {
            phase: ConnectionPhase::Ready,
            failure: None,
        }),
    );
    assert!(value.connection_hint().is_none());
    assert_eq!(value.state.label(), "Disconnected");
    value.conflict = true;
    assert!(
        value
            .connection_hint()
            .is_some_and(|text| text.contains("identity changed"))
    );
}

#[test]
fn complete_publications_clear_old_reason_and_old_bridge_is_supported() {
    let mut value = group(
        Phase::Connecting,
        Some(Diagnostic {
            phase: ConnectionPhase::Reconnecting,
            failure: None,
        }),
    );
    assert_eq!(
        value.connection_hint(),
        Some("Reconnecting to this machine…")
    );
    value.diagnostic = None;
    assert!(value.connection_hint().is_none());
    value.diagnostic = Some(Diagnostic {
        phase: ConnectionPhase::Disconnected,
        failure: Some(Failure::Incompatible),
    });
    value.state = Phase::Ready;
    assert!(value.connection_hint().is_none());
    let old = r#"{"id":"fixture","label":"Fixture","state":"connecting","conflict":false,"omittedSessions":0,"sessions":[]}"#;
    assert!(serde_json::from_str::<Group>(old).is_ok());
}
