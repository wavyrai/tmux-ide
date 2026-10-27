use super::*;

#[test]
fn avatar_refresh_is_scoped_to_the_verified_profile() {
    let mut auth = Auth::connected_fixture();
    let (tx, rx) = mpsc::sync_channel(1);
    auth.profile.as_mut().unwrap().avatar_updates = Some(rx);
    let image = Arc::new(gpui::Image::empty());
    tx.send(image.clone()).unwrap();
    assert!(auth.poll_with_store(|_| panic!("avatar must not access credentials")));
    assert!(Arc::ptr_eq(
        auth.profile.as_ref().unwrap().avatar.as_ref().unwrap(),
        &image
    ));
    let (tx, rx) = mpsc::sync_channel(1);
    auth.profile.as_mut().unwrap().avatar_updates = Some(rx);
    auth.sign_out();
    assert!(!auth.connected());
    assert!(tx.send(image.clone()).is_err());
    auth.profile = Auth::connected_fixture().profile;
    assert!(auth.profile.as_ref().unwrap().avatar.is_none());
    let (tx, rx) = mpsc::sync_channel(1);
    auth.profile.as_mut().unwrap().avatar_updates = Some(rx);
    auth.signed_out = false;
    auth.initialized = false;
    auth.initialize(&crate::config::Config::default());
    assert!(!auth.connected());
    assert!(tx.send(image).is_err());
}

#[test]
fn copy_feedback_is_scoped_to_live_flow_and_expires() {
    let mut auth = Auth::fixture(true);
    assert!(!auth.copied());
    assert!(!auth.can_sign_out());
    assert_eq!(auth.copy_code(), Some("ABCD-1234"));
    assert!(auth.copied());
    auth.flow.as_mut().unwrap().copied_until = Some(Instant::now() - Duration::from_secs(1));
    assert!(auth.poll_with_store(|_| panic!("no storage for copy")));
    assert!(!auth.copied());
    auth.copy_code();
    auth.cancel();
    assert!(auth.copy_code().is_none());
    assert!(!auth.copied());
    auth = Auth::fixture(true);
    assert!(!auth.copied());
    auth.flow.as_mut().unwrap().deadline = Instant::now() - Duration::from_secs(1);
    assert!(auth.code().is_none());
    assert!(auth.copy_code().is_none());
    assert!(auth.poll_with_store(|_| panic!("expired code must not write")));
    assert!(auth.failed);
    assert!(!auth.busy());
    assert!(Auth::connected_fixture().can_sign_out());
}

#[test]
fn live_session_renews_off_thread_without_restart_and_preserves_token_identity() {
    let mut auth = Auth::connected_fixture();
    auth.store = Store::File;
    let now = Instant::now();
    auth.next_session_check = Some(now + Duration::from_secs(1));
    assert!(!auth.poll_at(now, |_| panic!(), |_, _| panic!("not due")));
    let old = auth.profile.as_ref().unwrap().token.clone();
    assert!(auth.poll_at(
        now + Duration::from_secs(1),
        |_| panic!(),
        |token, store| {
            assert!(token.is_none(), "resolve the latest saved credential");
            assert_eq!(store, Store::File);
            assert_eq!(thread::current().name(), Some("herdr-github-profile"));
            let loaded =
                Credential::new("expired-access".into(), Some("refresh".into()), "client")?
                    .profile_with(
                        |token| {
                            if token.expose_secret() == "expired-access" {
                                return Err(Error::GitHubAuthentication);
                            }
                            let mut profile = Auth::connected_fixture().profile.unwrap();
                            profile.token = token;
                            Ok(profile)
                        },
                        |_| {
                            Credential::new(
                                "rotated-access".into(),
                                Some("rotated-refresh".into()),
                                "client",
                            )
                        },
                        |_| Ok(()),
                    )?;
            Ok(Some(loaded))
        },
    ));
    assert!(auth.connected(), "renewal must not flash the signed-out UI");
    let result = auth
        .profile_incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let (tx, rx) = mpsc::sync_channel(1);
    tx.send(result).ok().unwrap();
    auth.profile_incoming = Some(rx);
    assert!(auth.poll_at(now, |_| panic!(), |_, _| panic!("one worker only")));
    let rotated = auth.profile.as_ref().unwrap().token.clone();
    assert!(!Arc::ptr_eq(&old, &rotated));
    assert_eq!(rotated.expose_secret(), "rotated-access");
    assert!(!auth.poll_at(now, |_| panic!(), |_, _| panic!("bounded check interval")));

    let mut same = Auth::connected_fixture().profile.unwrap();
    same.token = Arc::new("rotated-access".into());
    let (tx, rx) = mpsc::sync_channel(1);
    tx.send(Ok(Some(same))).ok().unwrap();
    auth.profile_incoming = Some(rx);
    auth.poll_at(now, |_| panic!(), |_, _| panic!());
    assert!(Arc::ptr_eq(&rotated, &auth.profile.as_ref().unwrap().token));
}

#[test]
fn live_session_transient_failures_preserve_account_and_retry_but_rejection_disconnects() {
    for error in [
        Error::GitHubStatus(503),
        Error::GitHubRateLimit,
        Error::GitHubForbidden,
        Error::CredentialPolicy,
    ] {
        let mut auth = Auth::connected_fixture();
        let now = Instant::now();
        let (tx, rx) = mpsc::sync_channel(1);
        tx.send(Err(error)).ok().unwrap();
        auth.profile_incoming = Some(rx);
        auth.poll_at(now, |_| panic!(), |_, _| panic!());
        assert!(auth.connected());
        assert!(auth.failed);
        assert!(auth.next_session_check.unwrap() > now);
        assert!(!auth.poll_at(now, |_| panic!(), |_, _| panic!("no tight retry")));
    }
    let mut auth = Auth::connected_fixture();
    let (tx, rx) = mpsc::sync_channel(1);
    tx.send(Err(Error::GitHubAuthentication)).ok().unwrap();
    auth.profile_incoming = Some(rx);
    auth.poll_at(Instant::now(), |_| panic!(), |_, _| panic!());
    assert!(!auth.connected());
}

#[test]
fn profile_loading_success_error_and_idle_do_not_start_device_auth() {
    let mut auth = Auth::default();
    for result in [
        Ok(Auth::connected_fixture().profile),
        Err(std::io::Error::other("mock profile failure").into()),
        Ok(None),
    ] {
        let (tx, rx) = mpsc::sync_channel(1);
        tx.send(result).ok().unwrap();
        auth.profile_incoming = Some(rx);
        assert!(auth.loading_profile());
        assert!(auth.poll_with_store(|_| panic!("profile does not persist tokens")));
        assert!(!auth.loading_profile());
        assert!(auth.incoming.is_none());
        assert!(auth.flow.is_none());
        assert_eq!(auth.failed, auth.message.is_some());
    }
    assert!(!auth.connected());
}
