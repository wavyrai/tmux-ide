//! Bounded HTTP against the Daytona API: a size-capped reader, redirects
//! refused, a sensitive bearer header, and failures reduced to Daytona's own
//! short `message` so a hostile endpoint cannot flood the UI or the log. The
//! same policy as Coder's client; only the error type and wording differ.

use super::{Error, Result, Settings, Status};
use secrecy::{ExposeSecret, ExposeSecretMut, SecretBox, SecretString};
use serde::{Serialize, de::DeserializeOwned};
use std::{io::Read, time::Duration};
use zeroize::Zeroizing;

const LIMIT: u64 = 4 * 1024 * 1024;
const MESSAGE_LIMIT: usize = 300;
const TIMEOUT: Duration = Duration::from_secs(30);

/// One authenticated API call. Requests go to the configured API root only.
pub(crate) struct Request<'a> {
    pub(crate) settings: &'a Settings,
    pub(crate) key: &'a SecretString,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .max_redirects(0)
        .http_status_as_error(false)
        .user_agent("Herdr-GPUI")
        .build()
        .into()
}

fn authorization(key: &SecretString) -> Result<ureq::http::HeaderValue> {
    let mut text = SecretBox::new(Box::new(String::with_capacity(
        7 + key.expose_secret().len(),
    )));
    text.expose_secret_mut().push_str("Bearer ");
    text.expose_secret_mut().push_str(key.expose_secret());
    let mut header =
        ureq::http::HeaderValue::from_str(text.expose_secret()).map_err(Error::Header)?;
    header.set_sensitive(true);
    Ok(header)
}

fn network(context: &'static str) -> impl FnOnce(ureq::Error) -> Error {
    move |error| {
        tracing::warn!(category = "daytona_http", context, error = %error, "Daytona request failed");
        Error::Network(error)
    }
}

fn body(response: &mut ureq::http::Response<ureq::Body>) -> Result<Zeroizing<Vec<u8>>> {
    // SSH access replies carry a token; partial reads are wiped on error.
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

/// Daytona's error body is `{"message": ...}`; keep one short line.
fn message(bytes: &[u8]) -> Option<String> {
    #[derive(serde::Deserialize)]
    struct Reply {
        message: Option<serde_json::Value>,
    }
    let text = match serde_json::from_slice::<Reply>(bytes).ok()?.message? {
        serde_json::Value::String(text) => text,
        // Validation failures list several messages.
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(serde_json::Value::as_str)
            .collect::<Vec<_>>()
            .join("; "),
        _ => return None,
    };
    let text: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MESSAGE_LIMIT)
        .collect();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

fn failure(context: &'static str, status: u16, bytes: &[u8]) -> Error {
    tracing::warn!(
        category = "daytona_http",
        context,
        status,
        "Daytona request failed"
    );
    match status {
        401 => Error::Authentication,
        403 => Error::Forbidden,
        code => Status {
            code,
            message: message(bytes),
        }
        .into(),
    }
}

fn response<T: DeserializeOwned>(
    context: &'static str,
    mut response: ureq::http::Response<ureq::Body>,
) -> Result<T> {
    let status = response.status().as_u16();
    let bytes = body(&mut response)?;
    if !(200..=299).contains(&status) {
        return Err(failure(context, status, &bytes));
    }
    serde_json::from_slice(&bytes).map_err(|error| {
        // The body may hold an SSH token, so only its shape is recorded.
        tracing::warn!(
            category = "daytona_http",
            context,
            status,
            bytes = bytes.len() as u64,
            "Daytona response was not the expected JSON"
        );
        Error::Json(error)
    })
}

impl Request<'_> {
    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.settings.base)
    }

    fn call<B>(&self, request: ureq::RequestBuilder<B>) -> Result<ureq::RequestBuilder<B>> {
        let request = request
            .header("Accept", "application/json")
            .header("Authorization", authorization(self.key)?)
            .header("X-Daytona-Source", "herdr-gpui");
        Ok(match &self.settings.organization {
            Some(organization) => request.header("X-Daytona-Organization-ID", organization),
            None => request,
        })
    }

    pub(crate) fn get<T: DeserializeOwned>(&self, context: &'static str, path: &str) -> Result<T> {
        response(
            context,
            self.call(agent().get(self.url(path)))?
                .call()
                .map_err(network(context))?,
        )
    }

    pub(crate) fn post<T: DeserializeOwned>(
        &self,
        context: &'static str,
        path: &str,
        payload: &impl Serialize,
    ) -> Result<T> {
        let body = serde_json::to_vec(payload).map_err(Error::Json)?;
        response(
            context,
            self.call(agent().post(self.url(path)))?
                .header("Content-Type", "application/json")
                .send(&body[..])
                .map_err(network(context))?,
        )
    }

    /// A POST whose reply body is not needed, such as starting a sandbox.
    pub(crate) fn post_empty(&self, context: &'static str, path: &str) -> Result<()> {
        let mut reply = self
            .call(agent().post(self.url(path)))?
            .send_empty()
            .map_err(network(context))?;
        let status = reply.status().as_u16();
        if (200..=299).contains(&status) {
            return Ok(());
        }
        let bytes = body(&mut reply)?;
        Err(failure(context, status, &bytes))
    }
}

#[cfg(test)]
mod tests;
