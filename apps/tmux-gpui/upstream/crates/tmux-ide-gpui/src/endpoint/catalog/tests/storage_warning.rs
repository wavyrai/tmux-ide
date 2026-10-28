use super::*;
use herdr_client::StorageOperation;
use std::io;

fn failed(path: &str) -> Result<CatalogUpdate> {
    Err(herdr_client::Error::Storage {
        operation: StorageOperation::Read,
        path: path.into(),
        source: Box::new(io::Error::from(io::ErrorKind::PermissionDenied).into()),
    }
    .into())
}

fn loaded() -> Result<CatalogUpdate> {
    Ok(CatalogUpdate {
        hosts: Vec::new(),
        wsl: Vec::new(),
        selection: None,
        #[cfg(feature = "cloud")]
        cloud: None,
    })
}

fn catalog() -> Catalog {
    Catalog::new(&ConnectTarget::Session {
        name: "test".into(),
        development: false,
    })
}

#[test]
fn a_repeated_load_failure_warns_once() {
    let mut catalog = catalog();
    assert!(
        catalog
            .new_failure(&failed("/private/endpoints.json"))
            .is_some()
    );
    assert!(
        catalog
            .new_failure(&failed("/private/endpoints.json"))
            .is_none()
    );
}

#[test]
fn a_failure_on_another_file_warns_even_with_the_same_text() {
    let mut catalog = catalog();
    assert!(catalog.new_failure(&failed("/private/wsl.json")).is_some());
    assert!(
        catalog
            .new_failure(&failed("/private/endpoints.json"))
            .is_some()
    );
}

#[test]
fn a_successful_load_lets_the_same_failure_warn_again() {
    let mut catalog = catalog();
    assert!(
        catalog
            .new_failure(&failed("/private/endpoints.json"))
            .is_some()
    );
    assert!(catalog.new_failure(&loaded()).is_none());
    assert!(
        catalog
            .new_failure(&failed("/private/endpoints.json"))
            .is_some()
    );
}

#[test]
fn errors_without_a_storage_step_never_warn() {
    let mut catalog = catalog();
    let error: Result<CatalogUpdate> = Err(herdr_client::Error::Disconnected.into());
    assert!(catalog.new_failure(&error).is_none());
}
