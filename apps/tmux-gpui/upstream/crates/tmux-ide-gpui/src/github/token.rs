//! Persist the device-flow refresh token with its access token and issuing client.
//! Legacy entries contain only an access token; they remain readable.

use super::{Profile, Result, device::TokenResponse, http::oauth, valid_token};
use crate::Error;
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use std::{sync::Arc, time::Duration};
use zeroize::Zeroizing;

pub(super) const LIMIT: usize = 64 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Credential {
    version: u8,
    pub(super) access_token: SecretString,
    pub(super) refresh_token: Option<SecretString>,
    client_id: String,
    #[serde(default)]
    expires_at: Option<u64>,
}

impl Credential {
    pub(super) fn new(
        access_token: SecretString,
        refresh_token: Option<SecretString>,
        client_id: &str,
    ) -> Result<Self> {
        let credential = Self {
            version: 1,
            access_token,
            refresh_token,
            client_id: client_id.into(),
            expires_at: None,
        };
        credential.validate()?;
        Ok(credential)
    }

    fn validate(&self) -> Result<()> {
        if self.version != 1
            || !valid_token(self.access_token.expose_secret())
            || self.refresh_token.as_ref().is_some_and(|token| {
                !valid_token(token.expose_secret())
                    || self.client_id.is_empty()
                    || self.client_id.len() > 256
                    || !self
                        .client_id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
            })
        {
            return Err(Error::GitHubToken);
        }
        Ok(())
    }

    pub(super) fn with_expiry(mut self, seconds: Option<u64>, now: std::time::SystemTime) -> Self {
        self.expires_at = seconds.and_then(|seconds| {
            now.duration_since(std::time::UNIX_EPOCH)
                .ok()?
                .as_secs()
                .checked_add(seconds)
        });
        self
    }

    fn renewal_due(&self, now: std::time::SystemTime) -> bool {
        self.refresh_token.is_some()
            && self.expires_at.is_some_and(|expires| {
                now.duration_since(std::time::UNIX_EPOCH)
                    .is_ok_and(|now| expires <= now.as_secs().saturating_add(10 * 60))
            })
    }

    pub(super) fn decode(value: &SecretString) -> Result<Self> {
        let text = value.expose_secret().trim();
        if text.len() > LIMIT {
            return Err(Error::GitHubToken);
        }
        if !text.starts_with('{') {
            return Self::new(text.into(), None, "");
        }
        let credential: Self = serde_json::from_str(text).map_err(Error::github_json)?;
        credential.validate()?;
        Ok(credential)
    }

    pub(super) fn encode(&self) -> Result<SecretString> {
        self.validate()?;
        // Keep non-expiring OAuth tokens in the legacy format. Explicitly expose
        // the pair only into a preallocated, wiped serialization buffer.
        if self.refresh_token.is_none() {
            return Ok(self.access_token.expose_secret().into());
        }
        #[derive(Serialize)]
        struct Record<'a> {
            version: u8,
            access_token: &'a str,
            refresh_token: Option<&'a str>,
            client_id: &'a str,
            #[serde(skip_serializing_if = "Option::is_none")]
            expires_at: Option<u64>,
        }
        let mut bytes = Zeroizing::new(Vec::with_capacity(LIMIT));
        serde_json::to_writer(
            &mut *bytes,
            &Record {
                version: self.version,
                access_token: self.access_token.expose_secret(),
                refresh_token: self.refresh_token.as_ref().map(ExposeSecret::expose_secret),
                client_id: &self.client_id,
                expires_at: self.expires_at,
            },
        )
        .map_err(Error::github_json)?;
        let text = std::str::from_utf8(&bytes).map_err(Error::GitHubEncoding)?;
        Ok(text.into())
    }

    pub(super) fn refresh(&self) -> Result<Self> {
        let refresh = self
            .refresh_token
            .as_ref()
            .ok_or(Error::GitHubAuthentication)?;
        tracing::info!(category = "github_refresh", "Renewing saved GitHub sign-in");
        let reply: TokenResponse = oauth(
            "oauth/access_token",
            &[
                ("client_id", &self.client_id),
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh.expose_secret()),
            ],
            Duration::from_secs(15),
        )?;
        match super::device::token_reply(reply, &self.client_id)? {
            super::Reply::Token(credential) => Ok(credential),
            _ => Err(Error::GitHubToken),
        }
    }

    /// Renew shortly before expiry, or on rejection for older saved records
    /// without expiry metadata. Persist rotations before using the new token.
    pub(super) fn profile_with(
        self,
        mut profile: impl FnMut(Arc<SecretString>) -> Result<Profile>,
        refresh: impl FnOnce(&Self) -> Result<Self>,
        persist: impl FnOnce(&SecretString) -> Result<()>,
    ) -> Result<Profile> {
        if self.renewal_due(std::time::SystemTime::now()) {
            let renewed = refresh(&self)?;
            persist(&renewed.encode()?)?;
            return profile(Arc::new(renewed.access_token));
        }
        match profile(Arc::new(self.access_token.expose_secret().into())) {
            Err(Error::GitHubAuthentication) if self.refresh_token.is_some() => {
                let renewed = refresh(&self)?;
                // GitHub invalidates the old pair on rotation. Persist the new
                // pair before any further HTTP request, even if profile fails.
                persist(&renewed.encode()?)?;
                profile(Arc::new(renewed.access_token))
            }
            result => result,
        }
    }
}

#[cfg(test)]
mod tests;
