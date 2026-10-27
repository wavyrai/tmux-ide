//! The validated `[coder]` table. Parsed once at the boundary so every later
//! request works with a known-good deployment URL, client, and redirect.

use super::{Error, Result};
use crate::{config::CoderConfig, github::Store};
use secrecy::{ExposeSecret, SecretString};
use std::{
    ffi::OsString,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
};
use url::Url;

const DEFAULT_PREFIX: &str = "herdr";
/// Coder caps workspace names at 32 characters; the prefix leaves room for a suffix.
pub(super) const PREFIX_LIMIT: usize = 16;

#[derive(Clone, Debug)]
pub(crate) struct Settings {
    /// Deployment root without a trailing slash, e.g. `https://coder.example.com`.
    pub(crate) base: String,
    pub(crate) client_id: String,
    /// From `HERDR_CODER_OAUTH_CLIENT_SECRET` or `[coder] oauth_client_secret`;
    /// `None` means the one saved from Settings, read only when needed because
    /// the credential store blocks. See [`Settings::client_secret`].
    pub(crate) client_secret: Option<SecretString>,
    pub(crate) redirect: Redirect,
    pub(crate) organization: Option<String>,
    pub(crate) workspace_prefix: String,
    /// An explicit `coder` executable; otherwise it is found on PATH.
    pub(crate) cli: Option<PathBuf>,
    pub(crate) store: Store,
}

/// The loopback redirect registered with the Coder OAuth2 app. Coder compares
/// redirect URIs as exact strings, so the configured text is sent unchanged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Redirect {
    pub(crate) uri: String,
    pub(crate) path: String,
    pub(crate) address: SocketAddr,
}

impl Settings {
    pub(crate) fn resolve(
        config: &CoderConfig,
        var: impl Fn(&str) -> Option<OsString>,
    ) -> Result<Option<Self>> {
        let text = |name: &'static str, value: &Option<String>| -> Result<Option<String>> {
            match var(name) {
                Some(value) => value
                    .into_string()
                    .map(Some)
                    .map_err(|_| Error::Encoding(name)),
                None => Ok(value.clone()),
            }
        };
        let Some(url) = text("HERDR_CODER_URL", &config.url)? else {
            return Ok(None);
        };
        let base = deployment(&url)?;
        let client_id = text("HERDR_CODER_OAUTH_CLIENT_ID", &config.oauth_client_id)?
            .ok_or(Error::Missing("oauth_client_id"))?;
        check_client_id(&client_id)?;
        let client_secret = match var("HERDR_CODER_OAUTH_CLIENT_SECRET") {
            Some(value) => Some({
                // Own and wipe the copy, even when it is not valid UTF-8.
                let bytes = zeroize::Zeroizing::new(value.into_encoded_bytes());
                std::str::from_utf8(&bytes)
                    .map(SecretString::from)
                    .map_err(|_| Error::Encoding("HERDR_CODER_OAUTH_CLIENT_SECRET"))?
            }),
            None => config.oauth_client_secret.clone(),
        };
        if let Some(secret) = &client_secret {
            check_secret(secret)?;
        }
        let redirect = redirect(
            &text("HERDR_CODER_OAUTH_REDIRECT_URI", &config.oauth_redirect_uri)?
                .ok_or(Error::Missing("oauth_redirect_uri"))?,
        )?;
        check_file_only(config)?;
        Ok(Some(Self {
            cli: config.cli.clone(),
            base,
            client_id,
            client_secret,
            redirect,
            organization: config.organization.clone(),
            workspace_prefix: config
                .workspace_prefix
                .clone()
                .unwrap_or_else(|| DEFAULT_PREFIX.into()),
            store: Store::for_policy(config.allow_plaintext_credentials),
        }))
    }

    /// Each value the file sets, checked on its own. Whether the settings are
    /// complete is judged only by `resolve`, once the `HERDR_CODER_*`
    /// variables have had their chance to fill what the file leaves out.
    pub(crate) fn check(config: &CoderConfig) -> Result<()> {
        if let Some(url) = &config.url {
            deployment(url)?;
        }
        if let Some(client_id) = &config.oauth_client_id {
            check_client_id(client_id)?;
        }
        if let Some(secret) = &config.oauth_client_secret {
            check_secret(secret)?;
        }
        if let Some(uri) = &config.oauth_redirect_uri {
            redirect(uri)?;
        }
        check_file_only(config)
    }

    /// The OAuth client secret: the configured one, else the one saved from
    /// Settings. Blocks on the credential store; call from a worker.
    pub(crate) fn client_secret(&self) -> Result<SecretString> {
        match &self.client_secret {
            Some(secret) => Ok(secret.clone()),
            None => super::store::client_secret(self)?.ok_or(Error::Missing("oauth_client_secret")),
        }
    }

    /// `path` must start with `/`; it is appended to the deployment root.
    pub(crate) fn endpoint(&self, path: &str) -> String {
        format!("{}{path}", self.base)
    }
}

fn check_client_id(client_id: &str) -> Result<()> {
    if identifier(client_id, 256) {
        Ok(())
    } else {
        Err(Error::Field("coder.oauth_client_id"))
    }
}

fn check_secret(secret: &SecretString) -> Result<()> {
    if super::token::valid(secret.expose_secret()) {
        Ok(())
    } else {
        Err(Error::Field("coder.oauth_client_secret"))
    }
}

/// The keys no environment variable overrides.
fn check_file_only(config: &CoderConfig) -> Result<()> {
    if config
        .organization
        .as_deref()
        .is_some_and(|name| !identifier(name, 64))
    {
        return Err(Error::Field("coder.organization"));
    }
    if config
        .workspace_prefix
        .as_deref()
        .is_some_and(|prefix| !super::names::valid(prefix) || prefix.len() > PREFIX_LIMIT)
    {
        return Err(Error::Field("coder.workspace_prefix"));
    }
    if config
        .cli
        .as_deref()
        .is_some_and(|path| !path.is_absolute())
    {
        return Err(Error::Field("coder.cli"));
    }
    Ok(())
}

fn identifier(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(host)) => host.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

fn plain(url: &Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.host().is_some()
}

fn deployment(text: &str) -> Result<String> {
    let url = Url::parse(text.trim()).map_err(|_| Error::Url("coder.url"))?;
    if !plain(&url) || !(url.scheme() == "https" || (url.scheme() == "http" && loopback(&url))) {
        return Err(Error::Url("coder.url"));
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
}

fn redirect(text: &str) -> Result<Redirect> {
    let field = "coder.oauth_redirect_uri";
    let url = Url::parse(text).map_err(|_| Error::Url(field))?;
    // The listener binds this exact address, so a missing port is ambiguous.
    let port = url
        .port()
        .filter(|port| *port != 0)
        .ok_or(Error::Field(field))?;
    if url.scheme() != "http" || !plain(&url) || !loopback(&url) {
        return Err(Error::Url(field));
    }
    let ip = match url.host() {
        Some(url::Host::Ipv4(ip)) => IpAddr::V4(ip),
        Some(url::Host::Ipv6(ip)) => IpAddr::V6(ip),
        _ => IpAddr::V4(Ipv4Addr::LOCALHOST),
    };
    Ok(Redirect {
        uri: text.to_owned(),
        path: url.path().to_owned(),
        address: SocketAddr::new(ip, port),
    })
}

#[cfg(test)]
mod tests;
