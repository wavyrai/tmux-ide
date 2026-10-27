use super::*;

fn token_reply(value: Value) -> Result<Reply> {
    super::super::token_reply(serde_json::from_value(value).unwrap(), "fixture-client")
}

#[test]
fn setup_fixture_describes_public_config_and_environment_override() {
    let auth = Auth::fixture(false);
    assert_eq!(auth.message.as_deref(), Some(SETUP_MESSAGE));
    assert!(SETUP_MESSAGE.contains("[github] oauth_client_id"));
    assert!(SETUP_MESSAGE.contains("HERDR_GITHUB_OAUTH_CLIENT_ID"));
    assert!(SETUP_MESSAGE.contains("GitHub App or OAuth App public client ID"));
}
#[test]
fn rejected_device_responses_name_the_failing_check() {
    let device = |key: &str, value: Value| {
        let mut v = serde_json::json!({"device_code":"fixture", "user_code":"ABCD-1234", "verification_uri":VERIFY_URL, "expires_in":900, "interval":5});
        v[key] = value;
        serde_json::from_value::<Device>(v).unwrap()
    };
    for (key, value, rejection) in [
        ("device_code", serde_json::json!(""), "device_code"),
        ("user_code", serde_json::json!("bad\ncode"), "user_code"),
        ("user_code", serde_json::json!(""), "user_code"),
        (
            "verification_uri",
            serde_json::json!("https://github.example.test/login/device"),
            "verification_uri",
        ),
        ("expires_in", serde_json::json!(901), "expires_in"),
        ("interval", serde_json::json!(0), "interval"),
    ] {
        let device = device(key, value);
        assert_eq!(device.rejection(), Some(rejection));
        assert!(device.validate().is_err());
    }
    assert_eq!(
        device("interval", serde_json::json!(5)).rejection(),
        None,
        "a valid response must not report a rejection"
    );
}

#[test]
fn device_validation_and_oauth_error_lifecycle() {
    for (key, value) in [
        ("verification_uri", serde_json::json!("https://evil.test")),
        ("expires_in", serde_json::json!(901)),
        ("interval", serde_json::json!(0)),
        ("user_code", serde_json::json!("bad\ncode")),
    ] {
        let mut v = serde_json::json!({"device_code":"fixture", "user_code":"ABCD-1234", "verification_uri":VERIFY_URL, "expires_in":900, "interval":5});
        v[key] = value;
        assert!(
            serde_json::from_value::<Device>(v)
                .unwrap()
                .validate()
                .is_err()
        );
    }
    assert!(matches!(
        token_reply(serde_json::json!({"error":"authorization_pending"})),
        Ok(Reply::Pending(false))
    ));
    assert!(matches!(
        token_reply(serde_json::json!({"error":"slow_down"})),
        Ok(Reply::Pending(true))
    ));
    for error in [
        "expired_token",
        "access_denied",
        "incorrect_client_credentials",
        "unknown",
    ] {
        assert!(
            token_reply(serde_json::json!({"error":error, "error_description":"private-secret"}))
                .err()
                .unwrap()
                .to_string()
                .find("private-secret")
                .is_none()
        );
    }
    assert!(
        token_reply(serde_json::json!({"access_token":"fixture", "token_type":"mac"})).is_err()
    );
    assert!(matches!(
        token_reply(serde_json::json!({"access_token":"fixture", "token_type":"bearer"})),
        Ok(Reply::Token(_))
    ));
}
#[test]
fn pending_slowdown_expiry_and_cancel_do_not_store_stale_tokens() {
    let mut auth = waiting();
    assert_eq!(auth.code(), Some("ABCD-1234"));
    deliver(&mut auth, Ok(Reply::Pending(true)));
    auth.poll();
    assert_eq!(auth.flow.as_ref().unwrap().interval, 10);
    deliver(&mut auth, Ok(Reply::Pending(false)));
    auth.poll();
    assert_eq!(auth.flow.as_ref().unwrap().interval, 10);
    auth.flow.as_mut().unwrap().deadline = Instant::now();
    auth.poll();
    assert!(!auth.busy());
    assert!(auth.message.as_ref().unwrap().contains("expired"));
    for reply in [
        Reply::Token(credential("fixture")),
        Reply::Device(device(), "client".into(), Instant::now()),
    ] {
        let mut auth = waiting();
        deliver(&mut auth, Ok(reply));
        auth.cancel();
        auth.poll_with_store(|_| panic!("cancelled token must never be stored"));
        assert!(!auth.busy());
        assert!(auth.code().is_none());
    }
}
#[test]
fn accepted_token_uses_store_off_thread_and_reports_failure() {
    let mut auth = waiting();
    deliver(&mut auth, Ok(Reply::Token(credential("fixture-token"))));
    auth.poll_with_store(|token| {
        assert_eq!(
            token.map(ExposeSecret::expose_secret),
            Some("fixture-token")
        );
        assert_eq!(thread::current().name(), Some("herdr-github-auth"));
        Err(std::io::Error::other("mock Keychain locked").into())
    });
    auth.cancel(); // Accepted commits cannot be cancelled halfway through Keychain I/O.
    let reply = auth
        .incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    deliver(&mut auth, reply);
    auth.poll();
    assert_eq!(auth.message.as_deref(), Some("mock Keychain locked"));
    assert!(!auth.busy());
}

#[test]
fn expired_token_reply_is_not_persisted() {
    let mut auth = waiting();
    auth.flow.as_mut().unwrap().deadline = Instant::now();
    deliver(&mut auth, Ok(Reply::Token(credential("expired-secret"))));
    auth.poll_with_store(|_| panic!("expired token must never be stored"));
    assert!(!auth.busy());
    assert!(auth.code().is_none());
    assert!(auth.message.as_ref().unwrap().contains("expired"));
}
