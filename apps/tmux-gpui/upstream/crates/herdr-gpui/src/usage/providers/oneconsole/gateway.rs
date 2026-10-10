//! OneConsole gateway requests, sign-in token, and error mapping, shared with
//! the Alibaba Coding Plan and Qwen Cloud.

use super::{
    CHROME_AGENT, SAFARI_AGENT,
    fields::{find_value, first_match, string},
};
use crate::{
    Error, Result,
    usage::{
        probe::{Part, Probe, Request, Secret},
        values::{self, number},
    },
};
use serde_json::{Map, Value};

/// Maps the gateway's error envelopes: login and token failures are a
/// rejected session, other failures keep their status when it is an HTTP one.
pub(in crate::usage::providers) fn check(value: &Value) -> Result<()> {
    let text = |keys: &[&str], within: &Value| find_value(within, keys, true, string);
    let flag = |value: Option<&Value>| match value {
        Some(Value::Bool(flag)) => Some(*flag),
        Some(Value::String(text)) => match text.to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    };
    let failing = first_match(value, true, &|object: &Map<String, Value>| {
        (flag(object.get("success")) == Some(false)
            || flag(object.get("Success")) == Some(false)
            || flag(object.get("successResponse")) == Some(false))
        .then(|| Value::Object(object.clone()))
    });
    let status = find_value(
        value,
        &["statusCode", "status_code", "code"],
        true,
        |value| number(value).filter(|code| code.fract() == 0.),
    );
    let code = text(
        &["errorCode", "Code", "code", "status", "statusCode"],
        value,
    );
    let message = text(
        &["errorMsg", "Message", "message", "msg", "statusMessage"],
        value,
    );
    let combined = [
        failing
            .as_ref()
            .and_then(|frame| text(&["errorCode", "Code", "code"], frame)),
        failing
            .as_ref()
            .and_then(|frame| text(&["errorMsg", "Message", "message", "msg"], frame)),
        code,
        message,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" ")
    .to_lowercase();
    let login = [
        "needlogin",
        "login",
        "postonlyortokenerror",
        "tokenerror",
        "request has expired",
        "refresh page",
        "请求已经过期",
    ]
    .iter()
    .any(|marker| combined.contains(marker));
    let unauthorized = !combined.contains("workspace.notauthori")
        && [
            "notauthorised",
            "notauthorized",
            "not authorised",
            "not authorized",
            "unauthorised",
            "unauthorized",
            "access denied",
            "forbidden",
        ]
        .iter()
        .any(|marker| combined.contains(marker));
    let bad_status = status.filter(|code| *code != 0. && *code != 200.);
    if login || unauthorized || bad_status.is_some_and(|code| code == 401. || code == 403.) {
        return Err(Error::UsageRejected);
    }
    if failing.is_some() || bad_status.is_some() {
        return Err(
            match bad_status.and_then(|code| u16::try_from(code as i64).ok()) {
                Some(code) if (100..=599).contains(&code) => Error::UsageStatus(code),
                _ => values::invalid(),
            },
        );
    }
    Ok(())
}

pub(in crate::usage::providers) fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// A form body; the security token, when there is one, is spliced in where
/// it lives. It is sent as read, since console tokens are URL-safe.
pub(in crate::usage::providers) fn form_body(
    fields: &[(&str, &str)],
    token: Option<&Secret>,
) -> Vec<Part> {
    let mut text = url::form_urlencoded::Serializer::new(String::new())
        .extend_pairs(fields)
        .finish();
    match token {
        Some(token) => {
            text.push_str("&sec_token=");
            vec![Part::Text(text), Part::Secret(token.clone())]
        }
        None => vec![Part::Text(text)],
    }
}

pub(in crate::usage::providers) fn gateway_request(
    url: String,
    cookie: &Secret,
    origin: &str,
    referer: &str,
    accept: &str,
    body: Vec<Part>,
) -> Request {
    Request::post(url)
        .cookie(cookie)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", accept)
        .header("X-Requested-With", "XMLHttpRequest")
        .header("User-Agent", CHROME_AGENT)
        .header("Origin", origin)
        .header("Referer", referer)
        .body(body)
}

/// The OneConsole envelope every gateway API call carries.
pub(in crate::usage::providers) fn cornerstone(
    dashboard: &str,
    site: &str,
    switch_user: bool,
) -> Value {
    let domain = url::Url::parse(dashboard)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .unwrap_or_default();
    let mut envelope = serde_json::json!({
        "feTraceId": uuid::Uuid::new_v4().to_string(),
        "feURL": dashboard,
        "protocol": "V2",
        "console": "ONE_CONSOLE",
        "productCode": "p_efm",
        "domain": domain,
        "consoleSite": site,
        "userNickName": "",
        "userPrincipalName": "",
        "xsp_lang": "en-US",
    });
    if switch_user && let Some(object) = envelope.as_object_mut() {
        object.insert("switchUserType".into(), Value::from(3));
    }
    envelope
}

/// The `sec_token` setting, else the console's user-info answer. None when
/// neither has one; some gateways still accept the request without it.
pub(in crate::usage::providers) fn sec_token(
    probe: &mut Probe,
    cookie: &Secret,
    gateway: &str,
) -> Option<Secret> {
    if let Some(token) = probe.setting("sec_token") {
        return Some(token);
    }
    let request = Request::get(format!("{gateway}/tool/user/info.json"))
        .cookie(cookie)
        .header("Accept", "application/json, text/plain, */*")
        .header("Referer", format!("{gateway}/"))
        .header("User-Agent", SAFARI_AGENT);
    probe.exchange(request, &["data", "secToken"]).ok()
}
