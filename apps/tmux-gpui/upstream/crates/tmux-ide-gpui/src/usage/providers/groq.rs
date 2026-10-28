//! Groq request and token rates from GroqCloud's Prometheus metrics API,
//! read with the `api_key` setting (or `GROQ_API_KEY`). Metrics are an
//! Enterprise feature: other keys get HTTP 404, which the panel explains.
//!
//! Not ported from CodexBar: the console spend history, CodexBar's preferred
//! source. It exchanges the `stytch_session` cookie at Stytch with
//! `Authorization: Basic base64(public token:session)` and reads the
//! organization id from the resulting JWT's claims; the probe can neither
//! encode a secret nor read inside a JWT, and the bare cookie value cannot be
//! cut out of a Cookie header.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Provider, Report, Section},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
        values::invalid,
    },
};
use serde::Deserialize;

const BASE: &str = "https://api.groq.com/v1";
/// Five-minute per-second rates, summed over models and projects.
const QUERIES: [&str; 4] = [
    "sum(model_project_id_status_code:requests:rate5m)",
    "sum(model_project_id:tokens_in:rate5m)",
    "sum(model_project_id:tokens_out:rate5m)",
    "sum(model_project_id:prompt_cache_hits:rate5m)",
];

pub(crate) struct Groq;

static META: Meta = Meta::new("groq", "Groq")
    .dashboard("https://console.groq.com/dashboard/usage")
    .status_page("https://status.groq.com")
    .settings(&[
        Setting::new(
            "api_key",
            &["GROQ_API_KEY"],
            "A GroqCloud Enterprise API key from https://console.groq.com/keys. Only \
             Enterprise organizations can read Prometheus metrics.",
        ),
        Setting::new(
            "base_url",
            &["GROQ_API_URL"],
            "Optional HTTPS API base URL for a private gateway. Defaults to \
             https://api.groq.com/v1.",
        ),
    ]);

impl Service for Groq {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let base = base_url(probe.text_setting("base_url"))?;
    let mut rates = [0.; 4];
    for (rate, query) in rates.iter_mut().zip(QUERIES) {
        let query: String = url::form_urlencoded::byte_serialize(query.as_bytes()).collect();
        let request = Request::get(format!(
            "{base}/metrics/prometheus/api/v1/query?query={query}"
        ))
        .bearer(key)
        .header("Accept", "application/json");
        let response = probe.http(request)?;
        if response.status == 404 {
            return Ok(enterprise_only());
        }
        *rate = parse_scalar(&response.ok()?)?;
    }
    Ok(report(rates))
}

/// An override must stay on HTTPS: the key is attached to it.
fn base_url(raw: Option<String>) -> Result<String> {
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return Ok(BASE.to_owned());
    };
    let parsed = url::Url::parse(&raw).map_err(|_| Error::UsageNotSignedIn)?;
    if parsed.scheme() != "https" || !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(Error::UsageNotSignedIn);
    }
    Ok(raw.trim_end_matches('/').to_owned())
}

/// The sum of a Prometheus instant vector; an empty result is zero.
pub(crate) fn parse_scalar(body: &str) -> Result<f64> {
    let answer: Answer = json(body)?;
    if answer.status != "success" {
        return Err(invalid());
    }
    let data = answer.data.ok_or_else(invalid)?;
    data.result
        .iter()
        .try_fold(0., |total, series| -> Result<f64> {
            let value = match series.value.as_slice() {
                [_, Sample::Text(text)] => text.trim().parse::<f64>().ok(),
                [_, Sample::Number(value)] => Some(*value),
                _ => None,
            }
            .filter(|value| value.is_finite() && *value >= 0.)
            .ok_or_else(invalid)?;
            Ok(total + value)
        })
}

fn report([requests, tokens_in, tokens_out, cache]: [f64; 4]) -> Report {
    let per_minute = |rate: f64| {
        let value = rate * 60.;
        let digits = if value >= 100. {
            0
        } else if value >= 10. {
            1
        } else {
            2
        };
        format!("{value:.digits$}")
    };
    let mut facts = vec![
        ("Requests / min".to_owned(), per_minute(requests)),
        (
            "Tokens / min".to_owned(),
            per_minute(tokens_in + tokens_out),
        ),
    ];
    if cache > 0. {
        facts.push(("Cache hits / min".to_owned(), per_minute(cache)));
    }
    Report::new(Provider(&Groq), metrics_account(), Vec::new()).with_sections([Section::Facts {
        title: "Last 5 minutes".into(),
        facts,
    }])
}

fn enterprise_only() -> Report {
    Report::new(Provider(&Groq), metrics_account(), Vec::new()).with_sections([Section::Facts {
        title: "Metrics".into(),
        facts: vec![(
            "Unavailable".into(),
            "Prometheus metrics need a GroqCloud Enterprise key".into(),
        )],
    }])
}

fn metrics_account() -> Account {
    Account {
        email: None,
        plan: Some("Prometheus metrics".into()),
    }
}

#[derive(Deserialize)]
struct Answer {
    status: String,
    data: Option<Data>,
}

#[derive(Deserialize)]
struct Data {
    #[serde(default)]
    result: Vec<Series>,
}

#[derive(Deserialize)]
struct Series {
    #[serde(default)]
    value: Vec<Sample>,
}

/// Prometheus sends `[<unix time>, "<value>"]`.
#[derive(Deserialize)]
#[serde(untagged)]
enum Sample {
    Number(f64),
    Text(String),
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn sums_series() {
        let body = r#"{"status":"success","data":{"resultType":"vector","result":[
            {"metric":{"model":"llama-3.3-70b-versatile"},"value":[1714000000.123,"1.5"]},
            {"metric":{"model":"qwen-qwq-32b"},"value":[1714000000.123,"0.5"]}]}}"#;
        assert_eq!(parse_scalar(body).unwrap(), 2.);
    }

    #[test]
    fn empty_vector_is_zero() {
        let body = r#"{"status":"success","data":{"resultType":"vector","result":[]}}"#;
        assert_eq!(parse_scalar(body).unwrap(), 0.);
    }

    #[test]
    fn rejects_errors_and_bad_samples() {
        let error = r#"{"status":"error","errorType":"bad_data","error":"parse error"}"#;
        assert!(parse_scalar(error).is_err());
        let negative = r#"{"status":"success","data":{"result":[{"value":[1,"-1"]}]}}"#;
        assert!(parse_scalar(negative).is_err());
    }

    #[test]
    fn reports_per_minute_rates() {
        let report = report([2., 100., 50., 0.]);
        assert!(report.windows.is_empty());
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0], ("Requests / min".into(), "120".into()));
        assert_eq!(facts[1], ("Tokens / min".into(), "9000".into()));
        assert_eq!(facts.len(), 2);
    }

    #[test]
    fn base_url_must_be_https() {
        assert_eq!(base_url(None).unwrap(), BASE);
        assert!(base_url(Some("http://api.groq.com/v1".into())).is_err());
        assert_eq!(
            base_url(Some("https://gateway.example.com/v1/".into())).unwrap(),
            "https://gateway.example.com/v1"
        );
    }
}
