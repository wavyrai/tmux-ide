#![allow(clippy::unwrap_used)]
use super::*;
use std::{
    sync::{Mutex, mpsc},
    thread,
    time::Duration,
};

#[test]
fn host_accounts_accept_only_profile_ids_and_use_their_own_entries() {
    let id = "0123456789abcdef0123456789abcdef";
    let host = Account::host(id).unwrap();
    for bad in [
        "",
        "../github-credentials",
        &id.to_uppercase(),
        &id[1..],
        "g".repeat(32).as_str(),
    ] {
        assert_eq!(Account::host(bad), None, "{bad}");
    }
    assert_eq!(
        Account::Main.file_name().to_str().unwrap(),
        "github-credentials"
    );
    assert_eq!(
        host.file_name().to_str().unwrap(),
        format!("github-credentials-{id}")
    );
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        assert_eq!(Account::Main.keyring_account(), "github.com");
        assert_eq!(host.keyring_account(), format!("github.com/host/{id}"));
    }
}

#[test]
fn competing_restores_load_the_rotated_credential_inside_the_transaction() {
    let saved = Mutex::new(
        Credential::new("old-access".into(), Some("old-refresh".into()), "client")
            .unwrap()
            .encode()
            .unwrap(),
    );
    let (refresh_tx, refresh_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (competing_tx, competing_rx) = mpsc::sync_channel(1);
    let (entered_tx, entered_rx) = mpsc::sync_channel(1);
    thread::scope(|scope| {
        let saved = &saved;
        let first = scope.spawn(move || {
            transaction(|| {
                let credential = Credential::decode(&saved.lock().unwrap())?;
                credential.profile_with(
                    |token| {
                        if token.expose_secret() == "old-access" {
                            return Err(Error::GitHubAuthentication);
                        }
                        assert_eq!(token.expose_secret(), "new-access");
                        Ok(Profile {
                            login: "fixture".into(),
                            avatar: None,
                            token,
                            avatar_updates: None,
                        })
                    },
                    |_| {
                        refresh_tx.send(()).unwrap();
                        release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                        Credential::new("new-access".into(), Some("new-refresh".into()), "client")
                    },
                    |value| {
                        *saved.lock().unwrap() = value.expose_secret().into();
                        Ok(())
                    },
                )
            })
            .unwrap()
        });
        refresh_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let second = scope.spawn(move || {
            competing_tx.send(()).unwrap();
            transaction(|| {
                entered_tx.send(()).unwrap();
                let credential = Credential::decode(&saved.lock().unwrap())?;
                assert_eq!(credential.access_token.expose_secret(), "new-access");
                assert_eq!(
                    credential.refresh_token.as_ref().unwrap().expose_secret(),
                    "new-refresh"
                );
                credential.profile_with(
                    |token| {
                        Ok(Profile {
                            login: "fixture".into(),
                            avatar: None,
                            token,
                            avatar_updates: None,
                        })
                    },
                    |_| panic!("the competing restore must not reuse the old refresh token"),
                    |_| panic!("the competing restore must not rewrite the credential"),
                )
            })
            .unwrap()
        });
        competing_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            entered_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release_tx.send(()).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(first.join().unwrap().token.expose_secret(), "new-access");
        assert_eq!(second.join().unwrap().token.expose_secret(), "new-access");
    });
}

#[test]
fn signout_transaction_waits_for_refresh_and_removes_the_rotated_credential() {
    let saved = Mutex::new(Some(SecretString::from("old-access")));
    let (refresh_tx, refresh_rx) = mpsc::sync_channel(1);
    let (release_tx, release_rx) = mpsc::sync_channel(1);
    let (signout_tx, signout_rx) = mpsc::sync_channel(1);
    let (deleted_tx, deleted_rx) = mpsc::sync_channel(1);
    thread::scope(|scope| {
        let saved = &saved;
        let refresh = scope.spawn(move || {
            transaction(|| {
                refresh_tx.send(()).unwrap();
                release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                let renewed =
                    Credential::new("new-access".into(), Some("new-refresh".into()), "client")?;
                *saved.lock().unwrap() = Some(renewed.encode()?);
                // Different return types must still share the process-wide lock.
                Ok(renewed)
            })
            .unwrap()
        });
        refresh_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let signout = scope.spawn(move || {
            signout_tx.send(()).unwrap();
            transaction(|| {
                let removed = saved.lock().unwrap().take().unwrap();
                deleted_tx.send(()).unwrap();
                let credential = Credential::decode(&removed)?;
                assert_eq!(credential.access_token.expose_secret(), "new-access");
                assert_eq!(
                    credential.refresh_token.as_ref().unwrap().expose_secret(),
                    "new-refresh"
                );
                Ok(())
            })
            .unwrap();
        });
        signout_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(matches!(
            deleted_rx.recv_timeout(Duration::from_millis(100)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release_tx.send(()).unwrap();
        deleted_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            refresh.join().unwrap().access_token.expose_secret(),
            "new-access"
        );
        signout.join().unwrap();
    });
    assert!(saved.lock().unwrap().is_none());
}
