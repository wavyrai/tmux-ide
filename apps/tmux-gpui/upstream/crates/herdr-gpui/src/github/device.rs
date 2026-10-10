//! GitHub's device authorization flow: the codes it hands back, the replies it
//! can give, and the verified profile a completed flow yields. Secrets are
//! deserialized straight into redacted types and never pass through a String.

use super::{
    Result,
    http::{agent, authorization, response},
    log,
    token::Credential,
    valid_token,
};
use crate::Error;
use secrecy::{ExposeSecret, SecretString};
use serde::Deserialize;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) const VERIFY_URL: &str = "https://github.com/login/device";
pub(super) const SETUP_MESSAGE: &str = "Connect with Herdr GPUI's GitHub App. Optionally set [github] oauth_client_id in config-gpui.local.toml, or HERDR_GITHUB_OAUTH_CLIENT_ID, to another GitHub App or OAuth App public client ID with Device Flow enabled. Reload GUI config after file edits.";

#[derive(Debug, Deserialize)]
pub(super) struct Device {
    pub(super) device_code: SecretString,
    pub(super) user_code: SecretString,
    pub(super) verification_uri: String,
    pub(super) expires_in: u64,
    #[serde(default = "default_interval")]
    pub(super) interval: u64,
}
pub(super) fn default_interval() -> u64 {
    5
}

impl Device {
    /// The single check that rejected this response, for diagnostics only.
    pub(super) fn rejection(&self) -> Option<&'static str> {
        let user_code = self.user_code.expose_secret();
        if !valid_token(self.device_code.expose_secret()) {
            Some("device_code")
        } else if user_code.is_empty()
            || user_code.len() > 32
            || !user_code
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            Some("user_code")
        } else if self.verification_uri != VERIFY_URL {
            Some("verification_uri")
        } else if !(1..=900).contains(&self.expires_in) {
            Some("expires_in")
        } else if !(1..=900).contains(&self.interval) {
            Some("interval")
        } else {
            None
        }
    }

    pub(super) fn validate(self) -> Result<Self> {
        if let Some(rejection) = self.rejection() {
            // The verification URI is a public endpoint. An enterprise or data
            // residency host is exactly what this rejection would be hiding, so
            // it is logged; the device and user codes never are.
            tracing::warn!(
                category = "github_device",
                rejection,
                verification_uri = self.verification_uri.as_str(),
                expires_in = self.expires_in,
                interval = self.interval,
                "GitHub device authorization response rejected"
            );
            return Err(Error::GitHubDevice);
        }
        Ok(self)
    }
}

pub(super) enum Reply {
    Device(Device, String, Instant),
    Pending(bool),
    Token(Credential),
    SignedOut,
    Authenticated(Arc<SecretString>),
}

pub(crate) struct Profile {
    pub login: String,
    pub avatar: Option<Arc<gpui::Image>>,
    pub token: Arc<SecretString>,
    pub(super) avatar_updates: Option<crate::avatars::AvatarUpdates>,
}

pub(super) fn profile(token: Arc<SecretString>) -> Result<Profile> {
    #[derive(Deserialize)]
    struct User {
        login: String,
        avatar_url: String,
    }
    let user: User = response(
        "profile",
        agent(Duration::from_secs(15))
            .get("https://api.github.com/user")
            .header("User-Agent", "Herdr-GPUI")
            .header("Accept", "application/vnd.github+json")
            .header("Authorization", authorization(&token)?)
            .call()
            .map_err(log::network("profile"))?,
    )?;
    // The login is shown in the menu and logged, never persisted or placed in a
    // URL, so GitHub stays the authority on the shape of its own account names.
    // Enterprise managed users (`handle_shortcode`) are why guessing that shape
    // here was worse than useless.
    tracing::info!(
        category = "github_profile",
        login = user.login.as_str(),
        "GitHub profile loaded"
    );
    // The image transport receives no Authorization header and follows no redirects.
    let (avatar, avatar_updates) = crate::avatars::profile_avatar(&user.avatar_url);
    Ok(Profile {
        login: user.login,
        avatar,
        token,
        avatar_updates,
    })
}

#[derive(Debug, Deserialize)]
pub(super) struct TokenResponse {
    pub(super) access_token: Option<SecretString>,
    pub(super) refresh_token: Option<SecretString>,
    expires_in: Option<u64>,
    pub(super) token_type: Option<String>,
    pub(super) error: Option<String>,
    /// Logged, never displayed: GitHub's own wording is the only place an
    /// enterprise policy or app-approval denial is explained.
    pub(super) error_description: Option<String>,
}

pub(super) fn token_reply(value: TokenResponse, client: &str) -> Result<Reply> {
    match value.error.as_deref() {
        Some("authorization_pending") => Ok(Reply::Pending(false)),
        Some("slow_down") => Ok(Reply::Pending(true)),
        Some(code) => {
            tracing::warn!(
                category = "github_oauth",
                code,
                detail = value.error_description.as_deref().unwrap_or_default(),
                "GitHub rejected the device authorization"
            );
            Err(match code {
                "expired_token" => Error::GitHubExpired,
                "access_denied" => Error::GitHubDenied,
                _ => Error::GitHubAuthorization,
            })
        }
        None => {
            let token = value
                .access_token
                .filter(|t| valid_token(t.expose_secret()))
                .ok_or_else(|| {
                    tracing::warn!(
                        category = "github_oauth",
                        "GitHub returned no usable access token"
                    );
                    Error::GitHubToken
                })?;
            if value
                .token_type
                .as_deref()
                .is_none_or(|t| !t.eq_ignore_ascii_case("bearer"))
            {
                tracing::warn!(
                    category = "github_oauth",
                    token_type = value.token_type.as_deref().unwrap_or_default(),
                    "GitHub returned an unsupported token type"
                );
                return Err(Error::GitHubTokenType);
            }
            Ok(Reply::Token(
                Credential::new(token, value.refresh_token, client)?
                    .with_expiry(value.expires_in, std::time::SystemTime::now()),
            ))
        }
    }
}
