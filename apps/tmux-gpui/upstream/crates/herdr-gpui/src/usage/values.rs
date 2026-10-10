//! Small readings and formats providers share: numbers that services send as
//! JSON numbers or strings, strict decimals, configured service addresses,
//! URL components, and how amounts read in facts.

use super::model::group;
use crate::{Error, Result};
use serde_json::Value;

/// A response that parsed but does not hold what the service documents.
pub(crate) fn invalid() -> Error {
    Error::UsageJson(serde_json::error::Category::Data)
}

/// A finite number sent as a JSON number or a numeric string.
pub(crate) fn number(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
    .filter(|number: &f64| number.is_finite())
}

/// `12`, `-3.50`: digits with at most one point, as money fields are sent.
/// Rejects exponents, signs other than a leading minus, and blanks.
pub(crate) fn decimal(text: &str) -> Option<f64> {
    let digits = text.strip_prefix('-').unwrap_or(text);
    let (whole, fraction) = match digits.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (digits, None),
    };
    let all_digits =
        |part: &str| !part.is_empty() && part.bytes().all(|byte| byte.is_ascii_digit());
    if !all_digits(whole) || !fraction.is_none_or(all_digits) {
        return None;
    }
    text.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// A configured service address, or `default` when none is set: HTTPS only
/// (a bare host gets it), without credentials, and without a trailing slash.
/// Keys go to this address, so anything else is refused.
pub(crate) fn https_base(raw: Option<String>, default: &str) -> Result<String> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(default.to_owned());
    };
    let url = if raw.contains("://") {
        raw
    } else {
        format!("https://{raw}")
    };
    let parsed = url::Url::parse(&url).map_err(|_| Error::UsageNotSignedIn)?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Error::UsageNotSignedIn);
    }
    Ok(url.trim_end_matches('/').to_owned())
}

/// A self-hosted gateway's address: HTTPS, or plain HTTP only to this
/// machine or a private network, and never with credentials in it.
pub(crate) fn gateway(raw: &str) -> Result<url::Url> {
    let url = url::Url::parse(raw.trim()).map_err(|_| Error::UsageNotSignedIn)?;
    let private = match url.host() {
        Some(url::Host::Domain(name)) => {
            let name = name.to_ascii_lowercase();
            name == "localhost" || name.ends_with(".local")
        }
        Some(url::Host::Ipv4(ip)) => ip.is_loopback() || ip.is_private() || ip.is_link_local(),
        Some(url::Host::Ipv6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
        None => return Err(Error::UsageNotSignedIn),
    };
    let secure = url.scheme() == "https" || (url.scheme() == "http" && private);
    if !secure || !url.username().is_empty() || url.password().is_some() {
        return Err(Error::UsageNotSignedIn);
    }
    Ok(url)
}

/// A URL query or path component, with only unreserved characters left bare.
pub(crate) fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// `$12.30`, never negative, for spend shown in facts.
pub(crate) fn usd(amount: f64) -> String {
    format!("${:.2}", amount.max(0.))
}

/// `12` for a whole amount, else `12.34`.
pub(crate) fn plain(value: f64) -> String {
    if value.fract() == 0. {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

/// `1,250` for a whole count, else `12.34`.
pub(crate) fn count(value: f64) -> String {
    let whole = value.round();
    if (value - whole).abs() < 0.005 {
        group(whole as i64)
    } else {
        format!("{value:.2}")
    }
}

/// `12.3` or `12`: two places at most, trailing zeros dropped.
pub(crate) fn trimmed(value: f64) -> String {
    let text = format!("{value:.2}");
    text.trim_end_matches('0').trim_end_matches('.').to_owned()
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn numbers_and_decimals() {
        assert_eq!(number(&serde_json::json!(1.5)), Some(1.5));
        assert_eq!(number(&serde_json::json!(" 2 ")), Some(2.));
        assert_eq!(number(&serde_json::json!("x")), None);
        assert_eq!(number(&serde_json::json!(true)), None);
        assert_eq!(decimal("-3.50"), Some(-3.5));
        assert_eq!(decimal("1e3"), None);
        assert_eq!(decimal("1."), None);
        assert_eq!(decimal(""), None);
    }

    #[test]
    fn addresses_refuse_what_could_leak_a_key() {
        assert_eq!(
            https_base(None, "https://a.example").unwrap(),
            "https://a.example"
        );
        assert_eq!(
            https_base(Some("b.example/".into()), "").unwrap(),
            "https://b.example"
        );
        assert!(https_base(Some("http://b.example".into()), "").is_err());
        assert!(https_base(Some("https://u:p@b.example".into()), "").is_err());
        assert!(gateway("http://127.0.0.1:4000").is_ok());
        assert!(gateway("http://10.1.2.3").is_ok());
        assert!(gateway("http://proxy.example").is_err());
        assert!(gateway("https://proxy.example").is_ok());
        assert!(gateway("https://u@proxy.example").is_err());
    }

    #[test]
    fn formats() {
        assert_eq!(encode("a b/é"), "a%20b%2F%C3%A9");
        assert_eq!(usd(-1.), "$0.00");
        assert_eq!(plain(3.), "3");
        assert_eq!(plain(3.456), "3.46");
        assert_eq!(count(1250.), "1,250");
        assert_eq!(trimmed(1.50), "1.5");
    }
}
