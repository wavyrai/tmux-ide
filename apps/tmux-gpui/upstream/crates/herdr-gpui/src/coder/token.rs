//! The saved Coder sign-in: access and refresh tokens, when the access token
//! expires, and which deployment and OAuth client issued them. A record from
//! another deployment or client is never sent anywhere; it reads as signed out.

use super::{Error, Result, Settings};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

pub(crate) const LIMIT: usize = 64 * 1024;
/// Renew this long before expiry, so a connection never starts with a token
/// that lapses during the handshake.
const RENEW_BEFORE: Duration = Duration::from_secs(5 * 60);

pub(crate) fn valid(token: &str) -> bool {
    !token.is_empty() && token.len() <= 4096 && token.bytes().all(|b| b.is_ascii_graphic())
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Credential {
    version: u8,
    pub(crate) deployment: String,
    pub(crate) client_id: String,
    pub(crate) access_token: SecretString,
    pub(crate) refresh_token: Option<SecretString>,
    #[serde(default)]
    pub(crate) expires_at: Option<u64>,
}

impl Credential {
    pub(crate) fn new(
        settings: &Settings,
        access_token: SecretString,
        refresh_token: Option<SecretString>,
        expires_at: Option<u64>,
    ) -> Result<Self> {
        let credential = Self {
            version: 1,
            deployment: settings.base.clone(),
            client_id: settings.client_id.clone(),
            access_token,
            refresh_token,
            expires_at,
        };
        credential.validate()?;
        Ok(credential)
    }

    fn validate(&self) -> Result<()> {
        if self.version != 1
            || self.deployment.is_empty()
            || self.deployment.len() > 2048
            || self.client_id.is_empty()
            || self.client_id.len() > 256
            || !valid(self.access_token.expose_secret())
            || self
                .refresh_token
                .as_ref()
                .is_some_and(|token| !valid(token.expose_secret()))
        {
            return Err(Error::Token);
        }
        Ok(())
    }

    /// Whether this record was issued for the configured deployment and client.
    pub(crate) fn issued_for(&self, settings: &Settings) -> bool {
        self.deployment == settings.base && self.client_id == settings.client_id
    }

    pub(crate) fn renewal_due(&self, now: SystemTime) -> bool {
        self.refresh_token.is_some()
            && self.expires_at.is_some_and(|expires| {
                now.checked_add(RENEW_BEFORE)
                    .and_then(|soon| soon.duration_since(UNIX_EPOCH).ok())
                    .is_none_or(|soon| expires <= soon.as_secs())
            })
    }

    pub(crate) fn decode(value: &SecretString) -> Result<Self> {
        let text = value.expose_secret();
        if text.len() > LIMIT {
            return Err(Error::Token);
        }
        let credential: Self = serde_json::from_str(text).map_err(Error::json)?;
        credential.validate()?;
        Ok(credential)
    }

    pub(crate) fn encode(&self) -> Result<SecretString> {
        self.validate()?;
        #[derive(Serialize)]
        struct Record<'a> {
            version: u8,
            deployment: &'a str,
            client_id: &'a str,
            access_token: &'a str,
            refresh_token: Option<&'a str>,
            #[serde(skip_serializing_if = "Option::is_none")]
            expires_at: Option<u64>,
        }
        // Serialize into a preallocated buffer that is wiped when dropped.
        let mut bytes = Zeroizing::new(Vec::with_capacity(LIMIT));
        serde_json::to_writer(
            &mut *bytes,
            &Record {
                version: self.version,
                deployment: &self.deployment,
                client_id: &self.client_id,
                access_token: self.access_token.expose_secret(),
                refresh_token: self.refresh_token.as_ref().map(ExposeSecret::expose_secret),
                expires_at: self.expires_at,
            },
        )
        .map_err(Error::json)?;
        let text = std::str::from_utf8(&bytes).map_err(|_| Error::Token)?;
        Ok(text.into())
    }
}

/// Absolute expiry from a relative lifetime, `None` when absent or overflowing.
pub(crate) fn expiry(seconds: Option<u64>, now: SystemTime) -> Option<u64> {
    now.duration_since(UNIX_EPOCH)
        .ok()?
        .as_secs()
        .checked_add(seconds?)
}

#[cfg(test)]
mod tests;
