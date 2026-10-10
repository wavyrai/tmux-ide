//! Coder, the first `cloud` provider: OAuth2 sign-in against a configured
//! deployment, bounded REST calls, workspace readiness, and the `coder ssh`
//! command that reaches a workspace. Everything here blocks, so it runs on
//! background workers and reports back through the window's mailboxes.

mod api;
mod connect;
mod error;
mod http;
mod names;
mod oauth;
mod settings;
pub(crate) mod setup;
mod store;
mod token;

pub use error::{Error, Status};
pub(crate) use {
    api::{Preset, Template, Workspace},
    connect::connect,
    names::{random as random_name, valid as valid_name},
    settings::Settings,
};

pub type Result<T, E = Error> = std::result::Result<T, E>;

#[cfg(test)]
pub(crate) mod tests;
