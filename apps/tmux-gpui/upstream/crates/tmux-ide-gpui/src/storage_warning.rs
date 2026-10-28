//! Client storage errors keep their path out of display text, which reaches
//! the UI. The warning log is where that path belongs, so debugging a failed
//! file read does not need a debugger.
use herdr_client::StorageOperation;
use std::{error::Error as StdError, path::PathBuf};

/// A failed client storage step, comparable so a retried operation can warn
/// once per distinct failure rather than once per attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StorageFailure {
    operation: StorageOperation,
    path: PathBuf,
    /// The redacted display text, which tells apart causes on the same path.
    message: String,
}

impl StorageFailure {
    /// The outermost client storage step anywhere in `error`'s source chain.
    pub(crate) fn find(error: &(dyn StdError + 'static)) -> Option<Self> {
        std::iter::successors(Some(error), |&error| error.source()).find_map(|error| {
            match error.downcast_ref::<herdr_client::Error>()? {
                storage @ herdr_client::Error::Storage {
                    operation, path, ..
                } => Some(Self {
                    operation: operation.clone(),
                    path: path.clone(),
                    message: storage.to_string(),
                }),
                _ => None,
            }
        })
    }

    pub(crate) fn warn(&self, context: &str) {
        tracing::warn!(
            category = "storage",
            context,
            operation = ?self.operation,
            path = %self.path.display(),
            error = %self.message,
            "Client storage step failed"
        );
    }
}

/// Log a failed storage step with its operation and path. Errors without a
/// client storage step in their source chain are not logged.
pub(crate) fn warn_storage_failure(context: &str, error: &(dyn StdError + 'static)) {
    if let Some(failure) = StorageFailure::find(error) {
        failure.warn(context);
    }
}

#[cfg(test)]
mod tests;
