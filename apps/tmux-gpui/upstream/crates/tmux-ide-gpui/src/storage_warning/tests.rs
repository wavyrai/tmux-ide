use super::*;
use std::{io, path::Path};

fn storage(path: &str) -> herdr_client::Error {
    herdr_client::Error::Storage {
        operation: StorageOperation::Read,
        path: PathBuf::from(path),
        source: Box::new(io::Error::from(io::ErrorKind::PermissionDenied).into()),
    }
}

fn located(failure: Option<StorageFailure>) -> Option<(StorageOperation, PathBuf)> {
    failure.map(|failure| (failure.operation, failure.path))
}

#[test]
fn finds_the_storage_step_at_the_top_of_the_chain() {
    let error = storage("/private/endpoints.json");
    assert_eq!(
        located(StorageFailure::find(&error)),
        Some((
            StorageOperation::Read,
            Path::new("/private/endpoints.json").into()
        ))
    );
}

#[test]
fn finds_the_storage_step_inside_a_wrapping_gui_error() {
    let error = crate::Error::from(storage("/private/wsl.json"));
    assert_eq!(
        located(StorageFailure::find(&error)),
        Some((
            StorageOperation::Read,
            Path::new("/private/wsl.json").into()
        ))
    );
}

#[test]
fn ignores_errors_without_a_storage_step() {
    let error = crate::Error::from(herdr_client::Error::Disconnected);
    assert_eq!(StorageFailure::find(&error), None);
}

#[test]
fn failures_with_the_same_text_on_different_paths_differ() {
    let first = StorageFailure::find(&storage("/private/wsl.json"));
    let second = StorageFailure::find(&storage("/private/endpoints.json"));
    assert_eq!(
        storage("/private/wsl.json").to_string(),
        storage("/private/endpoints.json").to_string()
    );
    assert_ne!(first, second);
}
