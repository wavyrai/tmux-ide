//! Bounded HTTP against GitHub: a size-capped reader, redacted authorization
//! headers, the GraphQL call, and the account-wide rate-limit cooldown. Remote
//! diagnostics stay bounded so a hostile response cannot flood the UI.

use super::{Result, log};
use crate::Error;
use secrecy::{ExposeSecret, ExposeSecretMut, SecretBox as Secret, SecretString};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::{
    io::Read,
    time::{Duration, Instant},
};
use zeroize::Zeroizing;

pub(super) const LIMIT: u64 = 2 * 1024 * 1024;

pub(super) fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .build()
        .into()
}

pub(super) fn response<T: DeserializeOwned>(
    context: &'static str,
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T> {
    let status = response.status().as_u16();
    if !(200..=299).contains(&status) {
        log::http(context, status, response.headers());
        return Err(match status {
            401 => Error::GitHubAuthentication,
            403 => Error::GitHubForbidden,
            429 => Error::GitHubRateLimit,
            status => Error::GitHubStatus(status),
        });
    }
    // Allocate the bounded capacity up front: no reallocations leave old body
    // fragments behind, and partial reads are wiped even on I/O errors.
    let mut bytes = Zeroizing::new(Vec::with_capacity(LIMIT as usize + 1));
    response
        .body_mut()
        .as_reader()
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(Error::GitHubRead)?;
    if bytes.len() > LIMIT as usize {
        tracing::warn!(
            category = "github_http",
            context,
            status,
            "GitHub response exceeded the size limit"
        );
        return Err(Error::GitHubSize);
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        // The body may hold credentials, so only its shape is recorded.
        tracing::warn!(
            category = "github_http",
            context,
            status,
            bytes = bytes.len() as u64,
            "GitHub response was not the expected JSON"
        );
        Error::github_json(error)
    })
}

pub(crate) fn graphql(
    context: &'static str,
    token: &SecretString,
    query: &str,
    variables: Value,
    timeout: Duration,
    cancelled: impl Fn() -> bool,
    cooldown: &mut Option<Duration>,
) -> Result<Value> {
    let deadline = Instant::now() + timeout;
    if cancelled() {
        return Err(Error::PrCancelled);
    }
    if cancelled() {
        return Err(Error::PrCancelled);
    }
    let (result, exchange) = post(token, query, variables, deadline, cooldown)?;
    if cancelled() {
        return Err(Error::PrCancelled);
    }
    if let Some(errors) = result.get("errors") {
        log::graphql(context, log::token_kind(token), &exchange, errors);
        if result["errors"].as_array().is_some_and(|errors| {
            errors.iter().any(|error| {
                matches!(
                    error["type"].as_str(),
                    Some("RATE_LIMITED" | "FORBIDDEN" | "UNAUTHORIZED")
                )
            })
        }) {
            *cooldown = Some(Duration::from_secs(3600));
        }
        return Err(Error::GitHubQuery);
    }
    Ok(result)
}

/// A GraphQL mutation the user asked for. It is sent once and never retried
/// or cancelled midway; a refusal carries GitHub's own reason (cleaned and
/// bounded) because "the branch moved" or "not mergeable" is the answer the
/// user needs, and a generic failure would invite a blind retry.
pub(crate) fn mutation(
    context: &'static str,
    token: &SecretString,
    query: &str,
    variables: Value,
    timeout: Duration,
) -> Result<Value> {
    // No account-wide cooldown: nothing retries a mutation to honour one.
    let (result, exchange) = post(token, query, variables, Instant::now() + timeout, &mut None)?;
    if let Some(errors) = result.get("errors") {
        log::graphql(context, log::token_kind(token), &exchange, errors);
        return Err(rejection(errors).map_or(Error::GitHubQuery, Error::GitHubRejected));
    }
    Ok(result)
}

/// One GraphQL POST, its bounded JSON body, and the headers that explain a
/// failure GraphQL reports with a 200.
fn post(
    token: &SecretString,
    query: &str,
    variables: Value,
    deadline: Instant,
    cooldown: &mut Option<Duration>,
) -> Result<(Value, log::Exchange)> {
    let body = serde_json::json!({"query":query,"variables":variables}).to_string();
    let timeout = deadline
        .checked_duration_since(Instant::now())
        .ok_or(Error::PrTimeout)?;
    let reply = agent(timeout)
        .post("https://api.github.com/graphql")
        .header("User-Agent", "Herdr-GPUI")
        .header("Accept", "application/vnd.github+json")
        .header("Content-Type", "application/json")
        .header("Authorization", authorization(token)?)
        .send(body.as_bytes())
        .map_err(log::network("graphql"))?;
    *cooldown = pr_cooldown(
        reply.status().as_u16(),
        reply.headers(),
        std::time::SystemTime::now(),
    );
    // GraphQL reports failures with a 200, so the headers that explain them are
    // captured before the body consumes the response.
    let exchange = log::Exchange::new(reply.headers());
    let result: Value = response("graphql", reply)?;
    Ok((result, exchange))
}

/// GitHub's first error message, as display text. Remote text is untrusted:
/// controls and bidirectional overrides are blanked and the length bounded.
pub(super) fn rejection(errors: &Value) -> Option<String> {
    let message = errors.get(0)?.get("message")?.as_str()?;
    let message: String = crate::pull_request::clean(message)
        .trim()
        .chars()
        .take(REJECTION_LIMIT)
        .collect();
    (!message.is_empty()).then_some(message)
}

const REJECTION_LIMIT: usize = 240;

pub(super) fn authorization(token: &SecretString) -> Result<ureq::http::HeaderValue> {
    let mut text = Secret::new(Box::new(String::with_capacity(
        7 + token.expose_secret().len(),
    )));
    text.expose_secret_mut().push_str("Bearer ");
    text.expose_secret_mut().push_str(token.expose_secret());
    let mut header =
        ureq::http::HeaderValue::from_str(text.expose_secret()).map_err(Error::GitHubHeader)?;
    header.set_sensitive(true);
    Ok(header)
}

pub(super) fn pr_cooldown(
    status: u16,
    headers: &ureq::http::HeaderMap,
    now: std::time::SystemTime,
) -> Option<Duration> {
    if !matches!(status, 401 | 403 | 429) {
        return None;
    }
    let seconds = |name| {
        headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
    };
    let reset = seconds("x-ratelimit-reset").map(|reset| {
        reset.saturating_sub(
            now.duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
        )
    });
    Some(Duration::from_secs(
        seconds("retry-after")
            .into_iter()
            .chain(reset)
            .max()
            .unwrap_or(3600)
            .clamp(300, 86400),
    ))
}

pub(super) fn oauth<T: DeserializeOwned>(
    path: &'static str,
    fields: &[(&str, &str)],
    timeout: Duration,
) -> Result<T> {
    // ureq owns form serialization and HTTP/TLS buffers; their copies cannot be
    // zeroized by this module. Never log request fields or response bodies.
    response(
        path,
        agent(timeout)
            .post(format!("https://github.com/login/{path}"))
            .header("User-Agent", "Herdr-GPUI")
            .header("Accept", "application/json")
            .send_form(fields.iter().copied())
            .map_err(log::network(path))?,
    )
}
