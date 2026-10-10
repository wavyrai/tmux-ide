//! Daytona, a `cloud` provider whose sandboxes become devices: an API key
//! against a configured API root, bounded REST calls, sandbox readiness, and
//! an `ssh` command through Daytona's SSH gateway, authorized by a short-lived
//! token the API issues for one sandbox. Everything here blocks, so it runs on
//! background workers and reports back through the window's mailboxes.

mod api;
mod connect;
mod error;
mod gateway;
mod http;
mod settings;
pub(crate) mod setup;
mod store;

pub use error::{Error, Status};
pub(crate) use {
    connect::connect,
    settings::{DEFAULT_API_URL, Settings},
};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[cfg(test)]
pub(crate) mod tests;
