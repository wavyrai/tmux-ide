use super::{settings::Redirect, *};

mod mock;

/// A valid deployment for unit tests; nothing here is ever contacted.
pub(crate) fn settings() -> Settings {
    Settings {
        base: "https://coder.example.com".into(),
        client_id: "client-fixture".into(),
        client_secret: Some("secret-fixture".into()),
        redirect: Redirect {
            uri: "http://127.0.0.1:47823/callback".into(),
            path: "/callback".into(),
            address: std::net::SocketAddr::from(([127, 0, 0, 1], 47823)),
        },
        organization: None,
        workspace_prefix: "herdr".into(),
        cli: None,
        store: crate::github::Store::Environment,
    }
}
