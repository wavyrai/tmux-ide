use super::*;

#[test]
fn signout_discards_late_profile_and_auth_without_environment_reactivation() {
    let mut auth = Auth::connected_fixture();
    let (tx, rx) = mpsc::sync_channel(1);
    auth.profile_incoming = Some(rx);
    deliver(&mut auth, Ok(Reply::Token(credential("late-fixture"))));
    auth.sign_out();
    assert!(!auth.connected());
    assert!(!auth.loading_profile());
    assert!(auth.incoming.is_none());
    assert!(tx.send(Ok(Auth::connected_fixture().profile)).is_ok());
    auth.poll_with_store(|_| panic!("profile must drain before deletion"));
    assert!(auth.profile_incoming.is_none());
    assert!(!auth.connected());
    // Reload/reconnect cannot read environment or disk after explicit sign-out.
    auth.initialize(&crate::config::Config::default());
    assert!(!auth.loading_profile());
    auth.poll_with_store(|token| {
        assert!(token.is_none());
        Err(std::io::Error::other("mock removal failure").into())
    });
    let reply = auth
        .incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    deliver(&mut auth, reply);
    auth.poll_with_store(|_| panic!("no second store operation"));
    assert!(!auth.connected());
    assert!(auth.failed);
    assert_eq!(auth.message.as_deref(), Some("mock removal failure"));
}

#[test]
fn signout_serializes_after_accepted_write_and_discards_its_profile() {
    let mut auth = Auth::connected_fixture();
    auth.committing = true;
    deliver(
        &mut auth,
        Ok(Reply::Authenticated(Arc::new("late-fixture".into()))),
    );
    auth.sign_out();
    auth.cancel(); // Dismissal must not cancel credential removal.
    auth.poll_with_store(|_| panic!("write must complete before deletion"));
    assert!(!auth.connected());
    assert!(!auth.loading_profile());
    assert!(auth.signout_pending);
    auth.poll_with_store(|token| {
        assert!(token.is_none());
        Ok(())
    });
    let reply = auth
        .incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    deliver(&mut auth, reply);
    auth.poll_with_store(|_| panic!("already removed"));
    assert!(!auth.busy());
    assert!(!auth.connected());
    assert!(
        auth.message
            .as_deref()
            .unwrap()
            .contains("Environment tokens are suppressed")
    );
}

#[test]
fn signout_drains_inflight_profile_refresh_before_deleting_its_rotated_credential() {
    let saved = Arc::new(std::sync::Mutex::new(Some(
        Credential::new("old-access".into(), Some("old-refresh".into()), "client")
            .unwrap()
            .encode()
            .unwrap(),
    )));
    let (started_tx, started_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let mut auth = Auth::connected_fixture();
    let worker_saved = saved.clone();
    auth.load_profile_with(None, move |token, _| {
        assert!(token.is_none());
        let credential = Credential::decode(worker_saved.lock().unwrap().as_ref().unwrap())?;
        credential
            .profile_with(
                |token| {
                    if token.expose_secret() == "old-access" {
                        return Err(Error::GitHubAuthentication);
                    }
                    assert_eq!(token.expose_secret(), "new-access");
                    let mut profile = Auth::connected_fixture().profile.unwrap();
                    profile.token = token;
                    Ok(profile)
                },
                |_| {
                    started_tx.send(()).unwrap();
                    release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                    Credential::new("new-access".into(), Some("new-refresh".into()), "client")
                },
                |value| {
                    *worker_saved.lock().unwrap() = Some(value.expose_secret().into());
                    Ok(())
                },
            )
            .map(Some)
    });
    started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    auth.sign_out();
    assert!(!auth.poll_with(
        |_| panic!("refresh must finish before deletion"),
        |_, _| panic!("signed out"),
    ));
    assert!(auth.profile_incoming.is_some());
    assert!(auth.signout_pending);
    assert!(!auth.committing);
    assert!(auth.incoming.is_none());
    assert!(!auth.connected());
    assert!(!auth.loading_profile());

    release_tx.send(()).unwrap();
    let result = auth
        .profile_incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    assert_eq!(
        result
            .as_ref()
            .unwrap()
            .as_ref()
            .unwrap()
            .token
            .expose_secret(),
        "new-access"
    );
    let (tx, rx) = mpsc::sync_channel(1);
    tx.send(result).ok().unwrap();
    auth.profile_incoming = Some(rx);
    assert!(auth.poll_with(
        |_| panic!("drain the late result before deletion"),
        |_, _| panic!("signed out"),
    ));
    assert!(auth.profile_incoming.is_none());
    assert!(auth.signout_pending);
    assert!(!auth.connected());
    let worker_saved = saved.clone();
    assert!(auth.poll_with(
        move |token| {
            assert!(token.is_none());
            let value = worker_saved.lock().unwrap().take().unwrap();
            let credential = Credential::decode(&value)?;
            assert_eq!(credential.access_token.expose_secret(), "new-access");
            assert_eq!(
                credential.refresh_token.as_ref().unwrap().expose_secret(),
                "new-refresh"
            );
            Ok(())
        },
        |_, _| panic!("signed out"),
    ));
    let reply = auth
        .incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    deliver(&mut auth, reply);
    assert!(auth.poll_with(
        |_| panic!("already removed"),
        |_, _| panic!("late profile must not reactivate the session"),
    ));
    assert!(saved.lock().unwrap().is_none());
    assert!(auth.signed_out);
    assert!(!auth.connected());
    assert!(!auth.busy());
    assert!(!auth.failed);
}
