//! Bounded HTTP against a Coder deployment: a size-capped reader, redirects
//! refused, a sensitive bearer header, and failures reduced to Coder's own
//! short `message` so a hostile deployment cannot flood the UI or the log.

use super::{Error, Result, Status};
use secrecy::{ExposeSecret, ExposeSecretMut, SecretBox, SecretString};
use serde::{Serialize, de::DeserializeOwned};
use std::{io::Read, time::Duration};
use zeroize::Zeroizing;

pub(crate) const LIMIT: u64 = 4 * 1024 * 1024;
const MESSAGE_LIMIT: usize = 300;
pub(crate) const TIMEOUT: Duration = Duration::from_secs(20);

pub(crate) fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent("Herdr-GPUI")
        .build()
        .into()
}

pub(crate) fn authorization(token: &SecretString) -> Result<ureq::http::HeaderValue> {
    let mut text = SecretBox::new(Box::new(String::with_capacity(
        7 + token.expose_secret().len(),
    )));
    text.expose_secret_mut().push_str("Bearer ");
    text.expose_secret_mut().push_str(token.expose_secret());
    let mut header =
        ureq::http::HeaderValue::from_str(text.expose_secret()).map_err(Error::Header)?;
    header.set_sensitive(true);
    Ok(header)
}

fn network(context: &'static str) -> impl FnOnce(ureq::Error) -> Error {
    move |error| {
        tracing::warn!(category = "coder_http", context, error = %error, "Coder request failed");
        Error::Network(error)
    }
}

fn body(response: &mut ureq::http::Response<ureq::Body>) -> Result<Zeroizing<Vec<u8>>> {
    // Allocate the bounded capacity up front: no reallocation leaves copies of
    // a token-bearing body behind, and partial reads are wiped on error.
    let mut bytes = Zeroizing::new(Vec::with_capacity(64 * 1024));
    response
        .body_mut()
        .as_reader()
        .take(LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(Error::Read)?;
    if bytes.len() as u64 > LIMIT {
        return Err(Error::Size);
    }
    Ok(bytes)
}

/// Coder's error body is `{"message": ..., "detail": ...}`; keep one short line.
fn message(bytes: &[u8]) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Reply {
        message: Option<String>,
        detail: Option<String>,
    }
    let reply: Reply = serde_json::from_slice(bytes).ok()?;
    let text = match (reply.message, reply.detail) {
        (Some(message), Some(detail)) if !detail.is_empty() => format!("{message} {detail}"),
        (Some(message), _) => message,
        (None, detail) => detail?,
    };
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MESSAGE_LIMIT)
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

pub(crate) fn response<T: DeserializeOwned>(
    context: &'static str,
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T> {
    let status = response.status().as_u16();
    let bytes = body(&mut response)?;
    if !(200..=299).contains(&status) {
        tracing::warn!(
            category = "coder_http",
            context,
            status,
            "Coder request failed"
        );
        return Err(match status {
            401 => Error::Authentication,
            403 => Error::Forbidden,
            code => Status {
                code,
                message: message(&bytes),
            }
            .into(),
        });
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        // The body may hold credentials, so only its shape is recorded.
        tracing::warn!(
            category = "coder_http",
            context,
            status,
            bytes = bytes.len() as u64,
            "Coder response was not the expected JSON"
        );
        Error::json(error)
    })
}

/// An empty-bodied success, e.g. `204 No Content` from a revocation.
pub(crate) fn empty(
    context: &'static str,
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<()> {
    let status = response.status().as_u16();
    if (200..=299).contains(&status) {
        return Ok(());
    }
    let bytes = body(&mut response)?;
    tracing::warn!(
        category = "coder_http",
        context,
        status,
        "Coder request failed"
    );
    Err(match status {
        401 => Error::Authentication,
        403 => Error::Forbidden,
        code => Status {
            code,
            message: message(&bytes),
        }
        .into(),
    })
}

pub(crate) fn form<T: DeserializeOwned>(
    context: &'static str,
    url: &str,
    fields: &[(&str, &str)],
) -> Result<T> {
    // ureq owns form serialization and HTTP/TLS buffers; their copies cannot be
    // zeroized by this module. Never log request fields or response bodies.
    response(
        context,
        agent(TIMEOUT)
            .post(url)
            .header("Accept", "application/json")
            .send_form(fields.iter().copied())
            .map_err(network(context))?,
    )
}

pub(crate) fn get<T: DeserializeOwned>(
    context: &'static str,
    token: &SecretString,
    url: &str,
) -> Result<T> {
    response(
        context,
        agent(TIMEOUT)
            .get(url)
            .header("Accept", "application/json")
            .header("Authorization", authorization(token)?)
            .call()
            .map_err(network(context))?,
    )
}

pub(crate) fn post<T: DeserializeOwned>(
    context: &'static str,
    token: &SecretString,
    url: &str,
    payload: &impl Serialize,
) -> Result<T> {
    let body = serde_json::to_vec(payload).map_err(Error::json)?;
    response(
        context,
        agent(TIMEOUT)
            .post(url)
            .header("Accept", "application/json")
            .header("Content-Type", "application/json")
            .header("Authorization", authorization(token)?)
            .send(&body[..])
            .map_err(network(context))?,
    )
}

pub(crate) fn delete(context: &'static str, token: &SecretString, url: &str) -> Result<()> {
    empty(
        context,
        agent(TIMEOUT)
            .delete(url)
            .header("Authorization", authorization(token)?)
            .call()
            .map_err(network(context))?,
    )
}

#[cfg(test)]
mod tests;
