#![allow(clippy::unwrap_used)]
use super::*;

pub(crate) mod server;

#[test]
fn steps_read_as_short_status_words() {
    assert_eq!(Step::Creating.text(), "Creating…");
    assert_eq!(Step::Starting.text(), "Starting…");
    assert_eq!(
        Step::Building("pending".into()).text(),
        "Building (pending)…"
    );
    assert_eq!(Step::CheckingHerdr.text(), "Checking for Herdr…");
    assert_eq!(Step::InstallingHerdr.text(), "Installing Herdr…");
}

#[test]
fn every_provider_names_itself_and_its_machines() {
    for &provider in CloudProvider::ALL {
        assert!(!name(provider).is_empty());
        assert!(!noun(provider).is_empty());
        assert!(!provider.key().contains(':'), "keys prefix endpoint IDs");
    }
}

#[test]
fn a_non_cloud_target_is_refused() {
    let Err(error) = connect(&ConnectTarget::Local, &AtomicBool::new(true)) else {
        panic!("a local target is not a cloud machine");
    };
    assert!(error.get_ref().is_some_and(|e| e.is::<Error>()));
}

#[test]
fn cloud_devices_are_offered_only_where_they_can_connect() {
    assert_eq!(unavailable().is_some(), cfg!(windows));
}
