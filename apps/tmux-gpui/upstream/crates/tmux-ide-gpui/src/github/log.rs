//! Diagnostics for a failing GitHub exchange. Records go to the process-local
//! log window only, and carry public metadata: status, response headers that
//! explain an enterprise rejection, and the connection's own diagnosis. Never a
//! token, a device code, a request field, or a response body.

use crate::Error;
use secrecy::{ExposeSecret, SecretString};
use serde_json::Value;

/// A short, public response header, or `""` when GitHub did not send it.
pub(super) fn header<'a>(headers: &'a ureq::http::HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
}

/// The SSO challenge without its one-time authorization request identifier, so
/// the log names the organization that must approve the token and nothing more.
pub(super) fn public_sso(challenge: &str) -> &str {
    challenge.split('?').next().unwrap_or(challenge)
}

/// Why a GitHub call failed, from public headers only. Enterprise sign-ins fail
/// on exactly these (SSO, scopes, org policy), and the request id is what GitHub
/// support asks for.
pub(super) fn http(context: &'static str, status: u16, headers: &ureq::http::HeaderMap) {
    tracing::warn!(
        category = "github_http",
        context,
        status,
        request_id = header(headers, "x-github-request-id"),
        scopes = header(headers, "x-oauth-scopes"),
        accepted_scopes = header(headers, "x-accepted-oauth-scopes"),
        sso = public_sso(header(headers, "x-github-sso")),
        "GitHub request failed"
    );
}

/// Public headers of a GraphQL exchange, kept past the body read.
pub(super) struct Exchange {
    request_id: String,
    scopes: String,
    sso: String,
}

impl Exchange {
    pub(super) fn new(headers: &ureq::http::HeaderMap) -> Self {
        Self {
            request_id: header(headers, "x-github-request-id").to_owned(),
            scopes: header(headers, "x-oauth-scopes").to_owned(),
            sso: public_sso(header(headers, "x-github-sso")).to_owned(),
        }
    }
}

/// Which kind of credential made a request, from GitHub's documented token
/// prefixes. A GitHub App user token only sees repositories the App is
/// installed on, so an existing repository still resolves as `NOT_FOUND`.
pub(super) fn token_kind(token: &SecretString) -> &'static str {
    let token = token.expose_secret();
    [
        ("ghu_", "github_app_user"),
        ("ghs_", "github_app_installation"),
        ("gho_", "oauth_app"),
        ("ghp_", "classic_pat"),
        ("github_pat_", "fine_grained_pat"),
    ]
    .into_iter()
    .find_map(|(prefix, kind)| token.starts_with(prefix).then_some(kind))
    .unwrap_or("unknown")
}

/// Most GraphQL errors, all but a handful being redundant.
const GRAPHQL_ERRORS: usize = 3;
/// GitHub's messages are a sentence; anything longer is not worth keeping.
const GRAPHQL_MESSAGE: usize = 300;

/// Each GraphQL error with the exchange around it. GitHub explains SAML/SSO,
/// org policy, and missing App installations only in these messages, which
/// name the repository asked for.
pub(super) fn graphql(
    context: &'static str,
    token_kind: &str,
    exchange: &Exchange,
    errors: &Value,
) {
    let errors = errors.as_array().map(Vec::as_slice).unwrap_or_default();
    for error in errors.iter().take(GRAPHQL_ERRORS) {
        let message: String = error["message"]
            .as_str()
            .unwrap_or_default()
            .chars()
            .take(GRAPHQL_MESSAGE)
            .collect();
        let path = error["path"]
            .as_array()
            .map(|path| {
                path.iter()
                    .take(8)
                    .map(|segment| match segment {
                        Value::String(field) => field.chars().take(64).collect(),
                        segment => segment.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(".")
            })
            .unwrap_or_default();
        tracing::warn!(
            category = "github_graphql",
            context,
            error_type = error["type"].as_str().unwrap_or_default(),
            path = path.as_str(),
            detail = message.as_str(),
            count = errors.len() as u64,
            token_kind,
            request_id = exchange.request_id.as_str(),
            scopes = exchange.scopes.as_str(),
            sso = exchange.sso.as_str(),
            "GitHub GraphQL query returned errors"
        );
    }
}

/// Transport failures carry the connection's own diagnosis, not the exchange:
/// a proxy, TLS interception, or DNS failure is invisible otherwise.
pub(super) fn network(context: &'static str) -> impl FnOnce(ureq::Error) -> Error {
    move |error| {
        tracing::warn!(
            category = "github_network",
            context,
            transport = %error,
            "GitHub request did not complete"
        );
        Error::GitHubNetwork(error)
    }
}

/// Stable label for a failure, so the log window can be filtered by cause
/// without matching on user-facing sentences.
pub(super) fn kind(error: &Error) -> &'static str {
    match error {
        Error::GitHubAuthentication => "authentication",
        Error::GitHubForbidden => "forbidden",
        Error::GitHubRateLimit => "rate_limit",
        Error::GitHubStatus(_) => "status",
        Error::GitHubRead(_) => "read",
        Error::GitHubSize => "size",
        Error::GitHubJson(_) => "json",
        Error::GitHubToken => "token",
        Error::GitHubTokenType => "token_type",
        Error::GitHubEncoding(_) => "encoding",
        Error::GitHubNetwork(_) => "network",
        Error::GitHubHeader(_) => "header",
        Error::GitHubDevice => "device",
        Error::GitHubExpired => "expired",
        Error::GitHubDenied => "denied",
        Error::GitHubAuthorization => "authorization",
        Error::GitHubQuery => "query",
        Error::GitHubRejected(_) => "rejected",
        Error::GitHubWorker(_) => "worker",
        #[cfg(target_os = "macos")]
        Error::KeychainRead(_) => "keychain_read",
        #[cfg(target_os = "macos")]
        Error::KeychainWrite(_) => "keychain_write",
        #[cfg(target_os = "linux")]
        Error::SecretServiceRead(_) => "secret_service_read",
        #[cfg(target_os = "linux")]
        Error::SecretServiceWrite(_) => "secret_service_write",
        #[cfg(target_os = "linux")]
        Error::SecretServiceUnavailable => "secret_service_unavailable",
        Error::CredentialDirectory => "credential_directory",
        Error::CredentialPermissions => "credential_permissions",
        Error::CredentialIo(_) => "credential_io",
        Error::CredentialPolicy => "credential_policy",
        Error::CredentialUnsupported => "credential_unsupported",
        _ => "other",
    }
}

/// Records the failed step next to the message the menu shows.
pub(super) fn failure(context: &'static str, error: &Error) {
    let transport = match error {
        Error::GitHubNetwork(source) => source.to_string(),
        _ => String::new(),
    };
    tracing::warn!(
        category = "github_failure",
        context,
        kind = kind(error),
        transport = transport.as_str(),
        detail = %error,
        "GitHub operation failed"
    );
}
