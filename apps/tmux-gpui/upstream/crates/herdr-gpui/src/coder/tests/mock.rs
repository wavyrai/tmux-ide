//! A scripted Coder deployment on loopback, for exercising the real HTTP path.
#![allow(clippy::unwrap_used)]

use crate::coder::{
    Settings,
    api::{Client, Progress, wait_ready},
    oauth,
};
use secrecy::{ExposeSecret, SecretString};
use std::sync::{Arc, Mutex};

type Request = crate::cloud::tests::server::Request;

/// Serve `handler` as the deployment until the test ends.
fn serve(
    handler: impl Fn(&Request) -> (u16, String) + Send + 'static,
) -> (Settings, Arc<Mutex<Vec<Request>>>) {
    let (base, log) = crate::cloud::tests::server::serve(handler);
    let mut settings = super::settings();
    settings.base = base;
    (settings, log)
}

fn workspace(status: &str, transition: &str, lifecycle: &str) -> String {
    format!(
        r#"{{"id":"w1","name":"herdr-box","owner_name":"me","template_name":"docker",
            "latest_build":{{"transition":"{transition}","status":"{status}","job":{{"status":"succeeded"}},
            "resources":[{{"agents":[{{"id":"a1","name":"main","status":"connected","lifecycle_state":"{lifecycle}"}}]}}]}}}}"#
    )
}

#[test]
fn sign_in_exchange_sends_pkce_secret_and_exact_redirect() {
    let (settings, log) = serve(|request| {
        assert_eq!(
            (request.method.as_str(), request.target.as_str()),
            ("POST", "/oauth2/tokens")
        );
        (200, r#"{"access_token":"access-1","token_type":"Bearer","refresh_token":"refresh-1","expires_in":3600}"#.into())
    });
    let credential = oauth::exchange(&settings, &"code-1".into(), &"verifier-1".into()).unwrap();
    assert_eq!(credential.access_token.expose_secret(), "access-1");
    assert!(credential.issued_for(&settings));
    let body = log.lock().unwrap()[0].body.clone();
    let fields: std::collections::HashMap<_, _> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    assert_eq!(fields["grant_type"], "authorization_code");
    assert_eq!(fields["code"], "code-1");
    assert_eq!(fields["code_verifier"], "verifier-1");
    assert_eq!(fields["client_secret"], "secret-fixture");
    assert_eq!(fields["redirect_uri"], settings.redirect.uri);
}

#[test]
fn rejected_grant_reads_as_signed_out_and_other_failures_keep_coder_text() {
    let (settings, _) = serve(|request| match request.target.as_str() {
        "/oauth2/tokens" => (400, r#"{"message":"invalid_grant"}"#.into()),
        _ => (
            500,
            r#"{"message":"Internal error.","detail":"database down"}"#.into(),
        ),
    });
    let saved = crate::coder::token::Credential::new(&settings, "a".into(), Some("r".into()), None)
        .unwrap();
    assert!(matches!(
        oauth::refresh(&settings, &saved),
        Err(crate::coder::Error::Authentication)
    ));
    let error = Client::new(&settings, &"a".into()).me().unwrap_err();
    assert_eq!(
        error.to_string(),
        "Coder request failed (HTTP 500): Internal error. database down"
    );
}

#[test]
fn listing_and_creating_use_the_bearer_token_and_documented_paths() {
    let (mut settings, log) = serve(|request| {
        match (request.method.as_str(), request.target.as_str()) {
        ("GET", "/api/v2/users/me") => (200, r#"{"id":"u1","username":"fabien","email":"x"}"#.into()),
        ("GET", "/api/v2/organizations/acme/templates") => (
            200,
            r#"[{"id":"t2","name":"zeta","display_name":"","active_version_id":"v2"},
                {"id":"t1","name":"docker","display_name":"Docker","active_version_id":"v1"},
                {"id":"t3","name":"old","active_version_id":"v3","deprecated":true}]"#
                .into(),
        ),
        ("GET", "/api/v2/templateversions/v1/presets") => (
            200,
            r#"[{"ID":"p1","Name":"Small","Default":false},{"ID":"p2","Name":"Large","Default":true}]"#.into(),
        ),
        ("GET", "/api/v2/templateversions/v2/presets") => (200, "null".into()),
        ("POST", "/api/v2/organizations/acme/members/me/workspaces") => (200, workspace("pending", "start", "created")),
        ("GET", target) if target.starts_with("/api/v2/workspaces?") => (
            200,
            format!(r#"{{"workspaces":[{}],"count":1}}"#, workspace("running", "start", "ready")),
        ),
        other => panic!("unexpected {other:?}"),
    }
    });
    settings.organization = Some("acme".into());
    let token: SecretString = "access-1".into();
    let client = Client::new(&settings, &token);
    assert_eq!(client.me().unwrap().username, "fabien");
    let templates = client.templates().unwrap();
    assert_eq!(
        templates.iter().map(|t| t.label()).collect::<Vec<_>>(),
        ["Docker", "zeta"]
    );
    let presets = client.presets(&templates[0]).unwrap();
    assert_eq!(presets[0].name, "Large", "the default preset comes first");
    assert!(client.presets(&templates[1]).unwrap().is_empty());
    let created = client
        .create("herdr-box", &templates[0], Some(&presets[0]))
        .unwrap();
    assert_eq!(created.id, "w1");
    assert_eq!(client.workspaces().unwrap().len(), 1);
    assert!(client.create("Bad Name", &templates[0], None).is_err());

    let log = log.lock().unwrap();
    assert!(
        log.iter()
            .all(|r| r.authorization.as_deref() == Some("Bearer access-1"))
    );
    let create = log.iter().find(|r| r.method == "POST").unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&create.body).unwrap(),
        serde_json::json!({"name":"herdr-box","template_id":"t1","template_version_preset_id":"p2"})
    );
    let list = log
        .iter()
        .find(|r| r.target.starts_with("/api/v2/workspaces?"))
        .unwrap();
    assert!(list.target.contains("q=owner%3Ame"));
}

#[test]
fn waiting_starts_a_stopped_workspace_once_and_renews_a_rejected_token() {
    let polls = Arc::new(Mutex::new(0));
    let counter = polls.clone();
    let (settings, log) = serve(move |request| {
        if request.authorization.as_deref() == Some("Bearer expired") {
            return (401, r#"{"message":"expired"}"#.into());
        }
        match (request.method.as_str(), request.target.as_str()) {
            ("GET", "/api/v2/workspaces/w1") => {
                let mut polls = counter.lock().unwrap();
                *polls += 1;
                (
                    200,
                    match *polls {
                        1 => workspace("stopped", "stop", "off"),
                        2 => workspace("starting", "start", "created"),
                        _ => workspace("running", "start", "ready"),
                    },
                )
            }
            ("POST", "/api/v2/workspaces/w1/builds") => {
                assert_eq!(request.body, r#"{"transition":"start"}"#);
                (201, r#"{"id":"b2"}"#.into())
            }
            other => panic!("unexpected {other:?}"),
        }
    });
    let renewals = Mutex::new(0);
    let tokens = |rejected: bool| {
        let mut renewals = renewals.lock().unwrap();
        if rejected {
            *renewals += 1;
        }
        Ok(SecretString::from(if *renewals == 0 {
            "expired"
        } else {
            "fresh"
        }))
    };
    let mut seen = Vec::new();
    let (ready, agent) = wait_ready(
        &settings,
        &tokens,
        "w1",
        || false,
        |progress| seen.push(progress),
    )
    .unwrap();
    assert_eq!((ready.name.as_str(), agent.as_str()), ("herdr-box", "main"));
    assert_eq!(*renewals.lock().unwrap(), 1);
    assert_eq!(seen[0], Progress::Starting);
    assert!(seen.contains(&Progress::Building(
        crate::coder::api::BuildStatus::Starting
    )));
    let log = log.lock().unwrap();
    assert_eq!(
        log.iter().filter(|r| r.method == "POST").count(),
        1,
        "start exactly once"
    );

    let (settings, _) = serve(|_| (200, workspace("running", "start", "starting")));
    let tokens = |_| Ok(SecretString::from("fresh"));
    assert!(matches!(
        wait_ready(&settings, &tokens, "w1", || true, |_| {}),
        Err(crate::coder::Error::Cancelled)
    ));
}

#[test]
fn a_saved_workspace_is_reached_by_id_and_a_missing_one_reads_as_deleted() {
    // The ID now names a renamed workspace; the old name belongs to no one.
    let (settings, _) = serve(|request| match request.target.as_str() {
        "/api/v2/workspaces/w1" => (
            200,
            workspace("running", "start", "ready").replace("herdr-box", "Renamed-Box"),
        ),
        _ => (404, r#"{"message":"Resource not found"}"#.into()),
    });
    let tokens = |_| Ok(SecretString::from("fresh"));
    let (ready, _) = wait_ready(&settings, &tokens, "w1", || false, |_| {}).unwrap();
    assert_eq!(ready.name, "Renamed-Box");
    // Deleted, even if a newer workspace has since taken its old name.
    assert!(matches!(
        wait_ready(&settings, &tokens, "w0", || false, |_| {}),
        Err(crate::coder::Error::Deleted)
    ));
}
