use super::*;

#[test]
fn credentials_and_authorization_debug_are_redacted() {
    let token = credential_bytes(b"fixture-access-secret".to_vec()).unwrap();
    assert!(!format!("{token:?}").contains("fixture-access-secret"));
    let header = authorization(&token).unwrap();
    assert!(header.is_sensitive());
    assert_eq!(header.to_str().unwrap(), "Bearer fixture-access-secret");
    assert!(!format!("{header:?}").contains("fixture-access-secret"));
    let device = device();
    let debug = format!("{device:?}");
    assert!(!debug.contains("fixture-device"));
    assert!(!debug.contains("ABCD-1234"));
    let error = credential_bytes(b"private-invalid-secret\xff".to_vec()).unwrap_err();
    assert!(matches!(error, Error::GitHubEncoding(_)));
    assert_eq!(error.to_string(), "Invalid GitHub credential encoding.");
    assert!(authorization(&SecretString::from("private\nsecret")).is_err());
}
#[test]
fn oauth_responses_deserialize_directly_to_redacted_secrets() {
    let reply = |body: &[u8]| {
        ureq::http::Response::builder()
            .status(200)
            .body(ureq::Body::builder().data(body.to_vec()))
            .unwrap()
    };
    let parsed: TokenResponse = response(
        "test",
        reply(br#"{"access_token":"fixture-access-secret","refresh_token":"fixture-refresh-secret","token_type":"bearer"}"#),
    )
    .unwrap();
    assert!(!format!("{parsed:?}").contains("fixture-access-secret"));
    assert!(!format!("{parsed:?}").contains("fixture-refresh-secret"));
    let Reply::Token(token) = super::super::token_reply(parsed, "fixture-client").unwrap() else {
        panic!()
    };
    assert_eq!(token.access_token.expose_secret(), "fixture-access-secret");
    assert_eq!(
        token.refresh_token.as_ref().unwrap().expose_secret(),
        "fixture-refresh-secret"
    );
    assert!(!format!("{token:?}").contains("fixture-access-secret"));
    assert!(!format!("{token:?}").contains("fixture-refresh-secret"));
    let mut auth = waiting();
    deliver(&mut auth, Ok(Reply::Token(token)));
    assert!(auth.poll_with_store(|value| {
        assert_eq!(thread::current().name(), Some("herdr-github-auth"));
        let value = value.unwrap();
        assert!(!format!("{value:?}").contains("fixture-access-secret"));
        assert!(!format!("{value:?}").contains("fixture-refresh-secret"));
        let record: Value = serde_json::from_str(value.expose_secret()).unwrap();
        assert_eq!(record["version"], 1);
        assert_eq!(record["client_id"], "fixture-client");
        let saved = Credential::decode(value)?;
        assert_eq!(saved.access_token.expose_secret(), "fixture-access-secret");
        assert_eq!(
            saved.refresh_token.as_ref().unwrap().expose_secret(),
            "fixture-refresh-secret"
        );
        Ok(())
    }));
    let persisted = auth
        .incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap()
        .unwrap();
    let Reply::Authenticated(token) = persisted else {
        panic!("the credential must be persisted before authentication completes");
    };
    assert_eq!(token.expose_secret(), "fixture-access-secret");
    for body in [
        br#"{"access_token":"private-secret","token_type":123}"#.as_slice(),
        br#"{"access_token":"private-secret","access_token":"duplicate"}"#,
        b"private-invalid-secret\xff",
    ] {
        assert_eq!(
            response::<TokenResponse>("test", reply(body))
                .unwrap_err()
                .to_string(),
            "Invalid GitHub JSON response."
        );
    }
    let parsed: Device = response("test", reply(br#"{"device_code":"fixture-device","user_code":"ABCD-1234","verification_uri":"https://github.com/login/device","expires_in":900}"#)).unwrap();
    assert_eq!(
        parsed.validate().unwrap().user_code.expose_secret(),
        "ABCD-1234"
    );
}
#[test]
fn pr_rate_limits_have_bounded_account_wide_cooldowns() {
    let now = std::time::UNIX_EPOCH + Duration::from_secs(1000);
    let mut headers = ureq::http::HeaderMap::new();
    assert_eq!(pr_cooldown(200, &headers, now), None);
    for status in [401, 403, 429] {
        assert_eq!(
            pr_cooldown(status, &headers, now),
            Some(Duration::from_secs(3600))
        );
    }
    headers.insert("retry-after", "600".parse().unwrap());
    headers.insert("x-ratelimit-reset", "2200".parse().unwrap());
    assert_eq!(
        pr_cooldown(429, &headers, now),
        Some(Duration::from_secs(1200))
    );
    headers.insert("retry-after", "18446744073709551615".parse().unwrap());
    assert_eq!(
        pr_cooldown(429, &headers, now),
        Some(Duration::from_secs(86400))
    );
    headers.insert("retry-after", "invalid".parse().unwrap());
    headers.insert("x-ratelimit-reset", "0".parse().unwrap());
    assert_eq!(
        pr_cooldown(403, &headers, now),
        Some(Duration::from_secs(300))
    );
}

#[test]
fn bounded_http_parsing_and_safe_errors() {
    let reply = |status, body: Vec<u8>| {
        ureq::http::Response::builder()
            .status(status)
            .body(ureq::Body::builder().data(body))
            .unwrap()
    };
    for (status, message) in [
        (401, "authentication required"),
        (403, "denied access"),
        (429, "rate limit"),
        (302, "request failed"),
        (500, "request failed"),
    ] {
        let error =
            response::<Value>("test", reply(status, b"private-error-secret".to_vec())).unwrap_err();
        assert!(error.to_string().contains(message));
        assert!(!error.to_string().contains("private-error-secret"));
    }
    assert_eq!(
        response::<Value>("test", reply(200, b"{\"ok\":true}".to_vec())).unwrap()["ok"],
        true
    );
    assert!(response::<Value>("test", reply(200, b"not-json".to_vec())).is_err());
    assert!(response::<Value>("test", reply(200, vec![b' '; LIMIT as usize + 1])).is_err());
    assert!(
        graphql(
            "test",
            &"fixture".into(),
            "",
            Value::Null,
            Duration::from_secs(1),
            || true,
            &mut None
        )
        .unwrap_err()
        .to_string()
        .contains("cancelled")
    );
}

#[test]
fn diagnostics_keep_public_details_and_drop_the_sso_request_id() {
    assert_eq!(
        public_sso("required; url=https://github.com/orgs/acme/sso?authorization_request=SECRET"),
        "required; url=https://github.com/orgs/acme/sso"
    );
    assert_eq!(public_sso(""), "");
    let mut headers = ureq::http::HeaderMap::new();
    assert_eq!(header(&headers, "x-github-request-id"), "");
    headers.insert("x-github-request-id", "ABCD:1234".parse().unwrap());
    assert_eq!(header(&headers, "x-github-request-id"), "ABCD:1234");
    // Categories stay stable so a log filter keeps working across releases.
    assert_eq!(kind(&Error::GitHubForbidden), "forbidden");
    assert_eq!(kind(&Error::GitHubStatus(500)), "status");
    assert_eq!(kind(&Error::GitHubWorker("profile")), "worker");
    assert_eq!(kind(&Error::PrTimeout), "other");
}

#[test]
fn token_kind_names_the_credential_without_exposing_it() {
    for (token, expected) in [
        ("ghu_fixture", "github_app_user"),
        ("ghs_fixture", "github_app_installation"),
        ("gho_fixture", "oauth_app"),
        ("ghp_fixture", "classic_pat"),
        ("github_pat_fixture", "fine_grained_pat"),
        ("fixture", "unknown"),
    ] {
        assert_eq!(token_kind(&SecretString::from(token)), expected);
    }
}
