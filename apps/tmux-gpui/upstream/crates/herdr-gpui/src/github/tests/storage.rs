use super::*;
use crate::github::store::resolve_token;

#[test]
fn keyring_is_used_by_signed_macos_releases_and_linux() {
    assert_eq!(Store::choose(false, true, false), Store::Keyring);
    // The plaintext opt-in wins over a keyring where it is honoured at all, so
    // a Linux desktop without a Secret Service still has a way to save.
    assert_eq!(Store::choose(true, true, false), Store::File);
    // An unsigned macOS development build gets a new code identity on every
    // rebuild, so it uses the private file instead of re-prompting for Keychain.
    assert_eq!(Store::choose(false, false, true), Store::File);
    assert_eq!(Store::choose(true, false, true), Store::File);
    // Everywhere else unencrypted storage stays an explicit opt-in.
    assert_eq!(Store::choose(false, false, false), Store::Environment);
    assert_eq!(Store::choose(true, false, false), Store::File);
    assert_eq!(
        KEYRING,
        cfg!(target_os = "linux") || (cfg!(target_os = "macos") && crate::RELEASE_BUILD)
    );
    let mut config = crate::config::Config::default();
    #[cfg(target_os = "macos")]
    assert_eq!(
        Store::select(&config),
        if crate::RELEASE_BUILD {
            Store::Keyring
        } else {
            Store::File
        }
    );
    #[cfg(target_os = "linux")]
    assert_eq!(Store::select(&config), Store::Keyring);
    config.github.allow_plaintext_credentials = true;
    // macOS picks its store from the build alone and ignores the opt-in.
    #[cfg(target_os = "macos")]
    assert_eq!(
        Store::select(&config),
        Store::choose(false, KEYRING, store::FILE_DEFAULT)
    );
    #[cfg(target_os = "linux")]
    assert_eq!(Store::select(&config), Store::File);
    // Platforms without POSIX ownership and mode bits cannot keep the file
    // private, so opting in must not select it there.
    assert_eq!(store::FILE, cfg!(unix));
    if !store::FILE {
        assert_eq!(Store::select(&config), Store::Environment);
        assert!(matches!(
            credentials::store(
                std::path::Path::new("."),
                c"github-credentials",
                Some(&"token".into()),
                true
            ),
            Err(Error::CredentialUnsupported)
        ));
        assert!(
            credentials::store(
                std::path::Path::new("."),
                c"github-credentials",
                None,
                false
            )
            .is_ok()
        );
    }
}
#[test]
fn credential_notes_state_where_tokens_are_kept() {
    assert!(Store::Environment.note(false).is_none());
    assert!(Store::Environment.note(true).is_none());
    assert!(matches!(Store::Keyring.note(false), Some(Note::Info(_))));
    assert!(
        Store::Keyring.note(true).is_none(),
        "a connected account already proved keyring access"
    );
    for connected in [false, true] {
        let Some(Note::Warning(text)) = Store::File.note(connected) else {
            panic!("unencrypted storage must always warn");
        };
        assert!(text.starts_with("WARNING: "));
    }
}
fn load_fixture_profile(auth: &mut Auth, store: Store, profile: Option<Profile>) {
    assert!(auth.poll_with(
        |_| panic!("policy reload must not change stored credentials"),
        move |token, policy| {
            assert!(token.is_none(), "must resolve under the new policy");
            assert_eq!(policy, store);
            assert_eq!(thread::current().name(), Some("herdr-github-profile"));
            Ok(profile)
        },
    ));
    let result = auth
        .profile_incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let (tx, rx) = mpsc::sync_channel(1);
    tx.send(result).ok().unwrap();
    auth.profile_incoming = Some(rx);
    assert!(auth.poll_with(
        |_| panic!("profile does not persist tokens"),
        |_, _| panic!("no duplicate profile request"),
    ));
}

#[test]
fn enabling_plaintext_reloads_saved_token_but_explicit_signout_stays_suppressed() {
    let mut auth = Auth::default();
    // Drive the backend directly: which one a configuration selects depends on
    // the build, but every transition between them must behave the same way.
    assert!(auth.initialize_with(Store::Environment));
    load_fixture_profile(&mut auth, Store::Environment, None);
    assert!(!auth.connected());
    assert!(auth.initialize_with(Store::File));
    load_fixture_profile(&mut auth, Store::File, Auth::connected_fixture().profile);
    assert!(auth.connected());
    assert!(
        !auth.initialize_with(Store::File),
        "unchanged policy must not poll"
    );
    auth.sign_out();
    auth.poll_with(
        |token| {
            assert!(token.is_none());
            Ok(())
        },
        |_, _| panic!("signed out"),
    );
    let reply = auth
        .incoming
        .take()
        .unwrap()
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    deliver(&mut auth, reply);
    auth.poll_with(|_| panic!("already removed"), |_, _| panic!("signed out"));
    for store in [Store::Environment, Store::File, Store::Keyring] {
        assert!(!auth.initialize_with(store));
        assert_eq!(auth.store(), store);
        assert!(auth.signed_out);
        assert!(!auth.loading_profile());
        assert!(!auth.connected());
        assert!(!auth.poll_with(
            |_| panic!("no store access"),
            |_, _| panic!("no credential reload")
        ));
    }
}

#[test]
fn disabling_plaintext_clears_session_and_rejects_late_profile() {
    let mut auth = Auth::default();
    assert!(auth.initialize_with(Store::File));
    load_fixture_profile(&mut auth, Store::File, Auth::connected_fixture().profile);
    assert!(auth.connected());
    assert!(auth.initialize_with(Store::Environment));
    assert!(
        !auth.connected(),
        "old token cannot remain usable during reload"
    );
    assert!(!auth.signed_out, "policy changes are not explicit sign-out");
    load_fixture_profile(&mut auth, Store::Environment, None);
    assert!(!auth.connected());

    assert!(auth.initialize_with(Store::File));
    // A pending load from the opted-in policy must not win after opting out.
    auth.reload_pending = false;
    let (tx, rx) = mpsc::sync_channel(1);
    auth.profile_incoming = Some(rx);
    assert!(auth.initialize_with(Store::Environment));
    assert!(tx.send(Ok(Auth::connected_fixture().profile)).is_ok());
    assert!(auth.poll_with(
        |_| panic!("no store access"),
        |_, _| panic!("old worker must drain")
    ));
    assert!(!auth.connected());
    // An environment credential is still allowed under the new policy.
    load_fixture_profile(
        &mut auth,
        Store::Environment,
        Auth::connected_fixture().profile,
    );
    assert!(auth.connected());
}

#[test]
fn policy_reload_drains_accepted_write_without_applying_its_token() {
    let mut auth = Auth::connected_fixture();
    auth.store = Store::File;
    auth.committing = true;
    deliver(
        &mut auth,
        Ok(Reply::Authenticated(Arc::new("late-fixture".into()))),
    );
    assert!(auth.initialize_with(Store::Environment));
    assert!(auth.poll_with(
        |_| panic!("write was already accepted"),
        |_, _| panic!("must drain the accepted write first"),
    ));
    assert!(!auth.committing);
    assert!(auth.reload_pending);
    assert!(!auth.connected());
    load_fixture_profile(&mut auth, Store::Environment, None);
    assert!(!auth.connected());
}

#[test]
fn auth_priority_and_storage_errors_never_fall_back_silently() {
    assert_eq!(
        resolve_token(Some(" gh ".into()), Some("github".into()), || panic!(
            "must not read Keychain"
        ))
        .unwrap()
        .expose_secret(),
        "gh"
    );
    assert_eq!(
        resolve_token(Some(" ".into()), Some("github".into()), || panic!(
            "must not read Keychain"
        ))
        .unwrap()
        .expose_secret(),
        "github"
    );
    assert_eq!(
        resolve_token(None, None, || Ok(Some("saved".into())))
            .unwrap()
            .expose_secret(),
        "saved"
    );
    assert!(
        resolve_token(None, None, || Ok(None))
            .unwrap_err()
            .to_string()
            .contains("authentication required")
    );
    assert_eq!(
        resolve_token(None, None, || Err(std::io::Error::other("locked").into()))
            .unwrap_err()
            .to_string(),
        "locked"
    );
    assert!(resolve_token(Some("bad\nsecret".into()), None, || panic!()).is_err());
    assert!(resolve_token(None, None, || Ok(Some("  ".into()))).is_err());
    assert_eq!(
        resolve_token(Some(" \t".into()), Some("\n".into()), || Ok(Some(
            " saved ".into()
        )))
        .unwrap()
        .expose_secret(),
        "saved"
    );
    assert!(
        resolve_token(
            Some("bad\nsecret".into()),
            Some("valid".into()),
            || panic!()
        )
        .is_err()
    );
}
