//! Internal failures retain their categories and sources until presentation.
use std::io;

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Could not decode an image a pane placed.")]
    PaneImageDecode(#[source] image::ImageError),
    #[error("An image a pane placed exceeds the decoded size limit.")]
    PaneImageLimit,
    #[error("{0}")]
    Io(#[from] io::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Client(#[from] herdr_client::Error),
    #[error("Links open only http and https addresses with a host, of at most 8 KiB.")]
    InvalidBrowserUrl,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::error::Error as _;

    #[test]
    fn client_schema_presentation_remains_redacted() -> anyhow::Result<()> {
        let source = serde_json::from_str::<Vec<String>>("{}")
            .err()
            .ok_or_else(|| anyhow::anyhow!("expected schema error"))?;
        let error = Error::from(herdr_client::Error::CatalogSchema(source));
        assert_eq!(error.to_string(), "invalid endpoint catalog schema");
        assert!(
            error
                .source()
                .and_then(|source| source.source())
                .is_some_and(|source| source.is::<serde_json::Error>())
        );
        Ok(())
    }
}
