//! The freedesktop Secret Service (GNOME Keyring, KWallet, KeePassXC) as the
//! Linux keyring for saved GitHub sign-ins. `oo7` is the client GPUI's Linux
//! platform already links, built with the same async-io backend, so this adds
//! no runtime: zbus drives its own connection thread and these calls block the
//! background worker that makes them. Never call them on the UI thread.

use super::{Result, store::credential_bytes};
use crate::Error;
use futures_lite::future::block_on;
use oo7::{Keyring, zbus};
use secrecy::{ExposeSecret, SecretString};

const SERVICE: &str = "dev.herdr.gpui.github";
const LABEL: &str = "Herdr GPUI GitHub sign-in";

// `oo7::Error` is several times larger than the crate's other variants.
fn read_error(error: oo7::Error) -> Error {
    Error::SecretServiceRead(Box::new(error))
}

fn write_error(error: oo7::Error) -> Error {
    Error::SecretServiceWrite(Box::new(error))
}

/// Why a Secret Service could not be opened.
fn unavailable(error: &oo7::Error) -> bool {
    use oo7::dbus::{Error as DBus, ServiceError};
    // D-Bus error names are protocol identifiers, not display text.
    const MISSING: [&str; 2] = [
        "org.freedesktop.DBus.Error.ServiceUnknown",
        "org.freedesktop.DBus.Error.NameHasNoOwner",
    ];
    let error = match error {
        // A provider with no default collection has never stored anything.
        oo7::Error::DBus(DBus::NotFound(_)) => return true,
        oo7::Error::DBus(DBus::ZBus(error) | DBus::Service(ServiceError::ZBus(error))) => error,
        _ => return false,
    };
    match error {
        // No session bus to connect to, as over SSH or in a bare container.
        zbus::Error::Address(_) | zbus::Error::Connection(..) | zbus::Error::InputOutput(_) => true,
        // A session bus with nothing providing org.freedesktop.secrets.
        zbus::Error::FDO(error) => matches!(
            **error,
            zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_)
        ),
        zbus::Error::MethodError(name, ..) => MISSING.contains(&name.as_str()),
        _ => false,
    }
}

/// Opens and unlocks the default collection, or `None` when no Secret Service
/// runs. Unlocking may show the desktop's keyring password prompt.
async fn open() -> Result<Option<Keyring>> {
    let keyring = match Keyring::new().await {
        Ok(keyring) => keyring,
        Err(error) if unavailable(&error) => {
            tracing::info!(
                category = "github_keyring",
                ?error,
                "No Secret Service is available"
            );
            return Ok(None);
        }
        Err(error) => return Err(read_error(error)),
    };
    keyring.unlock().await.map_err(read_error)?;
    Ok(Some(keyring))
}

fn attributes<'a>(service: &'a str, account: &'a str) -> [(&'static str, &'a str); 2] {
    [("service", service), ("account", account)]
}

/// A missing Secret Service holds nothing, so reading one is not an error:
/// the environment remains the source of a token, exactly as before.
pub(super) fn read(account: &str) -> Result<Option<SecretString>> {
    read_in(SERVICE, account)
}

/// `read` for an entry under another feature's service name.
pub(super) fn read_in(service: &str, account: &str) -> Result<Option<SecretString>> {
    block_on(async {
        let Some(keyring) = open().await? else {
            return Ok(None);
        };
        let items = keyring
            .search_items(&attributes(service, account))
            .await
            .map_err(read_error)?;
        let Some(item) = items.into_iter().next() else {
            return Ok(None);
        };
        item.unlock().await.map_err(read_error)?;
        let secret = item.secret().await.map_err(read_error)?;
        // `Secret` wipes itself on drop; the copy is wiped by `credential_bytes`.
        credential_bytes(secret.to_vec()).map(Some)
    })
}

/// Saves `token`, or removes the entry when it is `None`. Removing from a
/// missing Secret Service succeeds, since nothing can have been saved there.
pub(super) fn save(token: Option<&SecretString>, account: &str) -> Result<()> {
    save_in(SERVICE, LABEL, token, account)
}

/// `save` for an entry under another feature's service name and label.
pub(super) fn save_in(
    service: &str,
    label: &str,
    token: Option<&SecretString>,
    account: &str,
) -> Result<()> {
    block_on(async {
        let keyring = match (open().await, token) {
            (Ok(Some(keyring)), _) => keyring,
            (Ok(None), None) => return Ok(()),
            (Ok(None), Some(_)) => return Err(Error::SecretServiceUnavailable),
            (Err(Error::SecretServiceRead(error)), _) => {
                return Err(Error::SecretServiceWrite(error));
            }
            (Err(error), _) => return Err(error),
        };
        let attributes = attributes(service, account);
        match token {
            Some(token) => {
                keyring
                    .create_item(
                        label,
                        &attributes,
                        oo7::Secret::text(token.expose_secret()),
                        true,
                    )
                    .await
            }
            None => keyring.delete(&attributes).await,
        }
        .map_err(write_error)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use oo7::dbus::Error as DBus;

    fn fdo(error: zbus::fdo::Error) -> oo7::Error {
        oo7::Error::DBus(DBus::ZBus(zbus::Error::FDO(Box::new(error))))
    }

    #[test]
    #[allow(clippy::unwrap_used)]
    fn only_a_missing_service_counts_as_unavailable() {
        for error in [
            oo7::Error::DBus(DBus::ZBus(zbus::Error::Address("unset".into()))),
            oo7::Error::DBus(DBus::ZBus(zbus::Error::Connection(
                std::sync::Arc::new(std::io::Error::from(std::io::ErrorKind::NotFound)),
                "unix:path=/nonexistent/bus".parse().unwrap(),
            ))),
            oo7::Error::DBus(DBus::ZBus(zbus::Error::InputOutput(std::sync::Arc::new(
                std::io::Error::from(std::io::ErrorKind::NotFound),
            )))),
            fdo(zbus::fdo::Error::ServiceUnknown("secrets".into())),
            fdo(zbus::fdo::Error::NameHasNoOwner("secrets".into())),
            oo7::Error::DBus(DBus::Service(oo7::dbus::ServiceError::ZBus(
                zbus::Error::FDO(Box::new(zbus::fdo::Error::ServiceUnknown("secrets".into()))),
            ))),
            oo7::Error::DBus(DBus::NotFound("default".into())),
        ] {
            assert!(unavailable(&error), "{error:?}");
        }
        // A running service that refuses must be reported, never read as
        // "nothing saved": a locked or dismissed keyring still holds the token.
        for error in [
            oo7::Error::DBus(DBus::Dismissed),
            oo7::Error::DBus(DBus::Deleted),
            oo7::Error::DBus(DBus::Service(oo7::dbus::ServiceError::IsLocked(
                "login".into(),
            ))),
            fdo(zbus::fdo::Error::AccessDenied("locked".into())),
        ] {
            assert!(!unavailable(&error), "{error:?}");
        }
    }

    /// Needs an unlocked Secret Service on the session bus, for example
    /// `dbus-run-session` with `gnome-keyring-daemon --unlock`.
    #[test]
    #[ignore = "requires a running Secret Service"]
    #[allow(clippy::unwrap_used)]
    fn saves_reads_replaces_and_removes_a_live_entry() {
        let account = format!("test/{}", std::process::id());
        let other = format!("{account}/other");
        assert!(read(&account).unwrap().is_none());
        save(Some(&"first".into()), &account).unwrap();
        save(Some(&"elsewhere".into()), &other).unwrap();
        save(Some(&"second".into()), &account).unwrap();
        assert_eq!(read(&account).unwrap().unwrap().expose_secret(), "second");
        save(None, &account).unwrap();
        assert!(read(&account).unwrap().is_none());
        // Removing is idempotent and leaves other accounts alone.
        save(None, &account).unwrap();
        assert_eq!(read(&other).unwrap().unwrap().expose_secret(), "elsewhere");
        save(None, &other).unwrap();
    }

    /// Run with no session bus, as over SSH: nothing is saved, nothing fails
    /// on read or removal, and a save reports the missing keyring.
    #[test]
    #[ignore = "requires an environment without a session bus"]
    #[allow(clippy::unwrap_used)]
    fn a_missing_secret_service_holds_nothing() {
        assert!(read("github.com").unwrap().is_none());
        save(None, "github.com").unwrap();
        assert!(matches!(
            save(Some(&"token".into()), "github.com"),
            Err(Error::SecretServiceUnavailable)
        ));
    }

    #[test]
    fn entries_are_keyed_by_service_and_account() {
        assert_eq!(
            attributes(SERVICE, "github.com/host/0123"),
            [("service", SERVICE), ("account", "github.com/host/0123")]
        );
        assert_eq!(
            attributes("dev.herdr.gpui.coder", "coder"),
            [("service", "dev.herdr.gpui.coder"), ("account", "coder")]
        );
    }
}
