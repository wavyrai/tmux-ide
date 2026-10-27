//! LLM Proxy usage from an LLM-API-Key-Proxy compatible `/v1/quota-stats`
//! endpoint, read with the proxy's API key (the `api_key` setting or
//! `LLM_PROXY_API_KEY`, here or on the probed host) at the configured
//! `base_url`. Everything CodexBar reads is ported.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values,
    },
};
use serde::Deserialize;
use std::{collections::BTreeMap, time::SystemTime};

/// Providers listed by request count in the panel.
const TOP: usize = 3;

pub(crate) struct Llmproxy;

static META: Meta = Meta::new("llmproxy", "LLM Proxy").settings(&[
    Setting::new(
        "api_key",
        &["LLM_PROXY_API_KEY"],
        "The API key your LLM-API-Key-Proxy accepts (its PROXY_API_KEY), sent as a \
             bearer token to base_url.",
    ),
    Setting::new(
        "base_url",
        &["LLM_PROXY_BASE_URL"],
        "The proxy's URL, with or without /v1, e.g. https://proxy.example.com. It must \
             be HTTPS unless it is on localhost, a private network, or a .local host.",
    ),
]);

impl Service for Llmproxy {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("LLM_PROXY_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let base = probe
        .text_setting("base_url")
        .filter(|base| !base.is_empty())
        .ok_or(Error::UsageNotSignedIn)?;
    let request = Request::get(quota_url(&base)?)
        .bearer(key)
        .header("Accept", "application/json");
    let body = probe.body(request)?;
    parse(&body, SystemTime::now())
}

/// `/v1/quota-stats` under the base, whether or not it already ends in `/v1`.
fn quota_url(raw: &str) -> Result<String> {
    let mut url = values::gateway(raw)?;
    let path = url.path().trim_end_matches('/').to_owned();
    let versioned = if path.ends_with("/v1") {
        path
    } else {
        format!("{path}/v1")
    };
    url.set_path(&format!("{versioned}/quota-stats"));
    url.set_fragment(None);
    Ok(url.to_string())
}

pub(crate) fn parse(body: &str, now: SystemTime) -> Result<Report> {
    let stats: Stats = json(body)?;
    let mut remaining: Option<f64> = None;
    let mut reset: Option<SystemTime> = None;
    let (mut credentials, mut active) = (0., 0.);
    let mut providers: Vec<(String, Summary)> = Vec::with_capacity(stats.providers.len());
    for (name, provider) in stats.providers {
        credentials += provider.credential_count.unwrap_or(0.);
        active += provider.active_count.unwrap_or(0.);
        for quota in quota_groups(provider.quota_groups.as_ref()) {
            if let Some(left) = quota.remaining_percent.filter(|left| left.is_finite()) {
                remaining = Some(remaining.map_or(left, |least| least.min(left)));
            }
            if let Some(at) = quota
                .reset_time
                .and_then(|at| Timestamp::Text(at).time())
                .filter(|at| *at > now)
            {
                reset = Some(reset.map_or(at, |soonest| soonest.min(at)));
            }
        }
        let tokens = provider.tokens.unwrap_or_default();
        providers.push((
            name,
            Summary {
                requests: provider.total_requests.unwrap_or(0.),
                tokens: tokens.input_cached.unwrap_or(0.)
                    + tokens.input_uncached.unwrap_or(0.)
                    + tokens.output.unwrap_or(0.),
                cost: provider.approx_cost,
            },
        ));
    }
    // Names arrive sorted, so the stable sort breaks ties by name.
    providers.sort_by(|a, b| b.1.requests.total_cmp(&a.1.requests));
    let summary = stats.summary.unwrap_or_default();
    let requests = summary
        .total_requests
        .unwrap_or_else(|| providers.iter().map(|(_, p)| p.requests).sum());
    let tokens = summary
        .total_tokens
        .unwrap_or_else(|| providers.iter().map(|(_, p)| p.tokens).sum());
    let summed: f64 = providers.iter().filter_map(|(_, p)| p.cost).sum();
    let cost = summary.approx_cost.or((summed > 0.).then_some(summed));

    let windows = remaining
        .map(|left| Window::new(Kind::Named("Quota".into()), 100. - left, reset, None))
        .into_iter()
        .collect();
    let account = Account {
        email: None,
        plan: Some(format!("{active}/{credentials} active keys")),
    };
    let totals = Section::Facts {
        title: "Totals".into(),
        facts: vec![
            ("Requests".into(), count(requests)),
            ("Tokens".into(), count(tokens)),
        ],
    };
    let top = (!providers.is_empty()).then(|| Section::Facts {
        title: "Providers".into(),
        facts: providers
            .iter()
            .take(TOP)
            .map(|(name, provider)| {
                let mut text = format!(
                    "{} req · {} tok",
                    count(provider.requests),
                    count(provider.tokens)
                );
                if let Some(cost) = provider.cost {
                    text.push_str(&format!(" · ${cost:.2}"));
                }
                (name.clone(), text)
            })
            .collect(),
    });
    Ok(Report::new(Provider(&Llmproxy), account, windows)
        .with_balances(
            cost.map(|cost| Balance::new("Approx. spend", cost, Unit::Currency("USD".into()))),
        )
        .with_sections(std::iter::once(totals).chain(top)))
}

fn count(value: f64) -> String {
    group(value.round() as i64)
}

/// Quota groups come as a list or keyed by name; a malformed list is
/// skipped rather than failing the whole answer, as CodexBar does.
fn quota_groups(value: Option<&serde_json::Value>) -> Vec<QuotaGroup> {
    let items: Vec<&serde_json::Value> = match value {
        Some(serde_json::Value::Array(items)) => items.iter().collect(),
        Some(serde_json::Value::Object(items)) => items.values().collect(),
        _ => return Vec::new(),
    };
    items
        .into_iter()
        .map(|item| QuotaGroup::deserialize(item).ok())
        .collect::<Option<Vec<_>>>()
        .unwrap_or_default()
}

struct Summary {
    requests: f64,
    tokens: f64,
    cost: Option<f64>,
}

#[derive(Deserialize)]
struct Stats {
    #[serde(default)]
    providers: BTreeMap<String, ProviderStats>,
    summary: Option<Totals>,
}

#[derive(Deserialize)]
struct ProviderStats {
    credential_count: Option<f64>,
    active_count: Option<f64>,
    total_requests: Option<f64>,
    tokens: Option<Tokens>,
    approx_cost: Option<f64>,
    quota_groups: Option<serde_json::Value>,
}

#[derive(Default, Deserialize)]
struct Tokens {
    input_cached: Option<f64>,
    input_uncached: Option<f64>,
    output: Option<f64>,
}

#[derive(Default, Deserialize)]
struct Totals {
    total_requests: Option<f64>,
    total_tokens: Option<f64>,
    approx_cost: Option<f64>,
}

#[derive(Deserialize)]
struct QuotaGroup {
    remaining_percent: Option<f64>,
    reset_time: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const BODY: &str = r#"{
      "providers": {
        "openai": {
          "credential_count": 3,
          "active_count": 2,
          "exhausted_count": 1,
          "total_requests": 120,
          "tokens": {"input_cached": 1000, "input_uncached": 2000, "output": 3000},
          "approx_cost": 12.5,
          "quota_groups": {
            "default": {"remaining_percent": 42, "reset_time": "2026-05-18T12:00:00Z"}
          }
        },
        "anthropic": {
          "credential_count": 1,
          "active_count": 1,
          "exhausted_count": 0,
          "total_requests": 40,
          "tokens": {"input_cached": 0, "input_uncached": 500, "output": 500},
          "approx_cost": 3.0,
          "quota_groups": [{"remaining_percent": 80}]
        }
      },
      "summary": {"total_requests": 160, "total_tokens": 7000, "approx_cost": 15.5}
    }"#;

    fn may() -> SystemTime {
        Timestamp::Text("2026-05-17T00:00:00Z".into())
            .time()
            .unwrap()
    }

    #[test]
    fn parses_quota_stats() {
        let report = parse(BODY, may()).unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].percent(), 58);
        assert_eq!(
            report.windows[0].resets_at,
            Timestamp::Text("2026-05-18T12:00:00Z".into()).time()
        );
        assert_eq!(report.account.plan.as_deref(), Some("3/4 active keys"));
        assert_eq!(report.balances[0].amount, 15.5);
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected totals");
        };
        assert_eq!(facts[0].1, "160");
        assert_eq!(facts[1].1, "7,000");
        let Section::Facts { facts, .. } = &report.sections[1] else {
            panic!("expected providers");
        };
        assert_eq!(
            facts[0],
            ("openai".into(), "120 req · 6,000 tok · $12.50".into())
        );
    }

    #[test]
    fn past_resets_are_dropped_and_empty_answer_parses() {
        let later = Timestamp::Text("2026-06-01T00:00:00Z".into())
            .time()
            .unwrap();
        assert_eq!(parse(BODY, later).unwrap().windows[0].resets_at, None);
        let empty = parse(r#"{"providers":{}}"#, may()).unwrap();
        assert!(empty.windows.is_empty());
        assert!(empty.balances.is_empty());
    }

    #[test]
    fn builds_quota_url() {
        for base in [
            "https://proxy.example.com",
            "https://proxy.example.com/v1/",
            "http://192.168.1.10/v1",
            "http://proxy.local",
        ] {
            assert!(
                quota_url(base).unwrap().ends_with("/v1/quota-stats"),
                "{base}"
            );
        }
        assert!(quota_url("http://proxy.example.com").is_err());
        assert!(quota_url("https://user:pass@proxy.example.com").is_err());
    }
}
