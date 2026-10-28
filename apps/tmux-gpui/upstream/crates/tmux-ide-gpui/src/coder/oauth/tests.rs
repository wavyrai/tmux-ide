#![allow(clippy::unwrap_used)]
use super::*;
use crate::coder::tests::settings;

#[test]
fn pkce_matches_rfc_7636_and_uses_unreserved_characters() {
    // RFC 7636 appendix B.
    assert_eq!(
        challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
    let pkce = Pkce::new().unwrap();
    let verifier = pkce.verifier.expose_secret();
    assert_eq!(verifier.len(), 43);
    assert!(
        verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
    );
    assert_ne!(verifier, Pkce::new().unwrap().verifier.expose_secret());
}

#[test]
fn only_the_matching_state_on_the_registered_path_is_accepted() {
    let get = |target: &str| format!("GET {target} HTTP/1.1\r\nHost: x\r\n\r\n");
    let accept = |target: &str| callback(get(target).as_bytes(), "/callback", "s1");
    assert_eq!(
        accept("/callback?code=abc&state=s1")
            .unwrap()
            .unwrap()
            .expose_secret(),
        "abc"
    );
    assert!(accept("/callback?code=abc&state=other").is_none());
    assert!(accept("/callback?code=abc").is_none());
    assert!(accept("/favicon.ico?state=s1&code=abc").is_none());
    assert!(
        callback(
            b"POST /callback?state=s1&code=abc HTTP/1.1\r\n\r\n",
            "/callback",
            "s1"
        )
        .is_none()
    );
    assert!(matches!(
        accept("/callback?state=s1&error=access_denied%0A%3Cscript%3E"),
        Some(Err(Error::Authorization(code))) if code == "access_deniedscript"
    ));
    assert!(matches!(
        accept("/callback?state=s1"),
        Some(Err(Error::Token))
    ));
    assert!(matches!(
        accept("/callback?state=s1&code=bad%20code"),
        Some(Err(Error::Token))
    ));
}

#[test]
fn authorize_url_carries_pkce_state_and_the_exact_redirect() {
    let mut settings = settings();
    settings.redirect.address = "127.0.0.1:0".parse().unwrap();
    let pending = begin(&settings).unwrap();
    let url = url::Url::parse(&pending.url).unwrap();
    assert_eq!(url.path(), "/oauth2/authorize");
    let pairs: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
    assert_eq!(pairs["client_id"], settings.client_id);
    assert_eq!(pairs["redirect_uri"], settings.redirect.uri);
    assert_eq!(pairs["response_type"], "code");
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert_eq!(
        pairs["code_challenge"],
        challenge(pending.pkce.verifier.expose_secret())
    );
    assert_eq!(pairs["state"], pending.state);
    assert!(!pending.url.contains(pending.pkce.verifier.expose_secret()));
    assert!(!pending.url.contains("secret-fixture"));
}

#[test]
fn listener_ignores_strays_answers_the_browser_and_honours_cancellation() {
    let mut settings = settings();
    settings.redirect.address = "127.0.0.1:0".parse().unwrap();
    let pending = begin(&settings).unwrap();
    let address = pending.listener.local_addr().unwrap();
    let state = pending.state.clone();
    let browser = std::thread::spawn(move || {
        let send = |target: String| {
            let mut stream = TcpStream::connect(address).unwrap();
            write!(stream, "GET {target} HTTP/1.1\r\nHost: localhost\r\n\r\n").unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).unwrap();
            reply
        };
        let stray = send("/callback?code=forged&state=wrong".into());
        let real = send(format!("/callback?code=real-code&state={state}"));
        (stray, real)
    });
    let code = pending
        .wait(
            "/callback",
            &|| false,
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();
    assert_eq!(code.expose_secret(), "real-code");
    let (stray, real) = browser.join().unwrap();
    assert!(stray.starts_with("HTTP/1.1 404"));
    assert!(real.starts_with("HTTP/1.1 200"));
    assert!(real.contains("Cache-Control: no-store"));

    let pending = begin(&settings).unwrap();
    assert!(matches!(
        pending.wait(
            "/callback",
            &|| true,
            Instant::now() + Duration::from_secs(10)
        ),
        Err(Error::Cancelled)
    ));
    assert!(matches!(
        pending.wait("/callback", &|| false, Instant::now()),
        Err(Error::Timeout)
    ));
}

#[test]
fn a_busy_redirect_port_is_reported_before_the_browser_opens() {
    let taken = TcpListener::bind("127.0.0.1:0").unwrap();
    let mut settings = settings();
    settings.redirect.address = taken.local_addr().unwrap();
    assert!(matches!(begin(&settings), Err(Error::Listen { .. })));
}

#[test]
fn token_replies_accept_relative_or_absolute_expiry() {
    let settings = settings();
    let parse = |json: &str| credential(&settings, serde_json::from_str(json).unwrap());
    let relative = parse(
        r#"{"access_token":"a","token_type":"Bearer","refresh_token":"r","expires_in":3600}"#,
    )
    .unwrap();
    assert!(relative.expires_at.is_some());
    assert!(relative.refresh_token.is_some());
    let absolute =
        parse(r#"{"access_token":"a","token_type":"bearer","expiry":"2030-01-01T00:00:00Z"}"#)
            .unwrap();
    assert_eq!(absolute.expires_at, Some(1_893_456_000));
    assert!(absolute.refresh_token.is_none());
    let empty_refresh = parse(r#"{"access_token":"a","refresh_token":""}"#).unwrap();
    assert!(empty_refresh.refresh_token.is_none());
    assert!(parse(r#"{"access_token":"a","token_type":"mac"}"#).is_err());
    assert!(parse(r#"{"access_token":""}"#).is_err());
}
