//! ClawRouter policy budget and spend, read from `GET /v1/usage` with a
//! policy API key: the `api_key` setting (or `CLAWROUTER_API_KEY` here), else
//! `CLAWROUTER_API_KEY` on the probed host. A configured monthly budget is the
//! monthly window; spend is a balance, and routed providers are listed by
//! cost. CodexBar's per-provider cost chart is shown as shares. Everything
//! CodexBar reads is ported.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
        values::https_base,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const BASE: &str = "https://clawrouter.openclaw.ai";
/// CodexBar lists up to five routed providers.
const SHOWN_PROVIDERS: usize = 5;

pub(crate) struct Clawrouter;

static META: Meta = Meta::new("clawrouter", "ClawRouter")
    .dashboard("https://clawrouter.openclaw.ai/dashboard/access")
    .settings(&[
        Setting::new(
            "api_key",
            &["CLAWROUTER_API_KEY"],
            "A ClawRouter policy API key, created at \
             https://clawrouter.openclaw.ai/dashboard/access.",
        ),
        Setting::new(
            "base_url",
            &["CLAWROUTER_BASE_URL"],
            "Optional HTTPS service root or /v1 URL of another ClawRouter deployment. \
             Defaults to https://clawrouter.openclaw.ai.",
        ),
    ]);

impl Service for Clawrouter {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("CLAWROUTER_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    // An override must stay on HTTPS: the key is attached to it.
    let base = https_base(probe.text_setting("base_url"), BASE)?;
    let url = if base.ends_with("/v1") {
        format!("{base}/usage")
    } else {
        format!("{base}/v1/usage")
    };
    parse(&probe.body(Request::get(url).bearer(key))?)
}

fn parse(body: &str) -> Result<Report> {
    let payload: Payload = json(body)?;
    let budget = payload.budget;
    let summary = payload.usage.summary;
    let dollars = |micros: i64| micros as f64 / 1e6;
    let limit = budget.limit_micros.map(dollars);
    let spent = budget.spent_micros.map(dollars);
    let remaining = budget.remaining_micros.map(dollars);
    let resets_at = budget.window_key.as_deref().and_then(month_after);
    let actual = dollars(summary.actual_cost_micros);

    let mut providers = payload.usage.providers;
    providers.sort_by(|a, b| {
        b.actual_cost_micros
            .cmp(&a.actual_cost_micros)
            .then_with(|| b.request_count.cmp(&a.request_count))
            .then_with(|| a.provider.cmp(&b.provider))
    });

    let mut windows = Vec::new();
    let mut balances = Vec::new();
    let mut facts = vec![
        (
            "Requests".to_owned(),
            format!(
                "{} · {} succeeded · {} failed",
                group(summary.request_count),
                group(summary.success_count),
                group(summary.error_count)
            ),
        ),
        (
            "Tokens".to_owned(),
            format!(
                "{} · {} input · {} output",
                group(summary.total_tokens),
                group(summary.input_tokens),
                group(summary.output_tokens)
            ),
        ),
        ("Actual cost".to_owned(), format!("${actual:.6}")),
        ("Budget ledger".to_owned(), budget.ledger.clone()),
    ];
    match (spent, limit) {
        (Some(spent), Some(limit)) => {
            if limit > 0. {
                let length = resets_at.and_then(|end| end.duration_since(month_before(end)?).ok());
                windows.push(Window::new(
                    Kind::Monthly,
                    spent / limit * 100.,
                    resets_at,
                    length.or_else(|| Kind::Monthly.length()),
                ));
            }
            balances.push(
                Balance::new("Spent this month", spent, Unit::Currency("USD".into())).out_of(limit),
            );
            let mut text = format!("${spent:.6} / ${limit:.2}");
            if let Some(remaining) = remaining {
                text.push_str(&format!(" · ${remaining:.6} remaining"));
            }
            facts.push(("Monthly budget".into(), text));
        }
        _ if actual > 0. => {
            balances.push(Balance::new(
                "Spent this month",
                actual,
                Unit::Currency("USD".into()),
            ));
        }
        _ => {}
    }

    let total: i64 = providers
        .iter()
        .map(|provider| provider.actual_cost_micros.max(0))
        .sum();
    let routed = providers.iter().take(SHOWN_PROVIDERS).map(|provider| {
        (
            name(&provider.provider).to_owned(),
            format!(
                "{} requests · ${:.6} · {} tokens",
                group(provider.request_count),
                dollars(provider.actual_cost_micros),
                group(provider.total_tokens)
            ),
        )
    });
    let routed = Section::Facts {
        title: "Routed providers".into(),
        facts: routed.collect(),
    };
    let shares = (total > 0).then(|| Section::Shares {
        title: "Provider cost".into(),
        shares: providers
            .iter()
            .take(SHOWN_PROVIDERS)
            .map(|provider| {
                (
                    name(&provider.provider).to_owned(),
                    (provider.actual_cost_micros.max(0) as f64 / total as f64 * 100.) as f32,
                )
            })
            .collect(),
    });
    let account = Account {
        email: Some(format!("{} routed providers", providers.len())),
        plan: Some(
            if budget.configured {
                "Managed monthly budget"
            } else {
                "Unmetered"
            }
            .into(),
        ),
    };
    Ok(Report::new(Provider(&Clawrouter), account, windows)
        .with_balances(balances)
        .with_sections(
            [Section::Facts {
                title: "Usage".into(),
                facts,
            }]
            .into_iter()
            .chain((!providers.is_empty()).then_some(routed))
            .chain(shares),
        ))
}

fn name(provider: &str) -> &str {
    match provider.trim() {
        "" => "Unknown",
        name => name,
    }
}

/// A `…/YYYY-MM` budget window resets at the start of the next month (UTC).
fn month_after(window_key: &str) -> Option<SystemTime> {
    let (year, month) = window_key
        .rsplit_once('/')
        .map_or(window_key, |(_, tail)| tail)
        .split_once('-')?;
    let (year, month): (i32, u32) = (year.parse().ok()?, month.parse().ok()?);
    if !(1..=12).contains(&month) {
        return None;
    }
    let (year, month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    month_start(year, month)
}

/// The start of the month before the one `end` starts.
fn month_before(end: SystemTime) -> Option<SystemTime> {
    use chrono::Datelike;
    let end = chrono::DateTime::<chrono::Utc>::from(end);
    let (year, month) = match end.month() {
        1 => (end.year() - 1, 12),
        month => (end.year(), month - 1),
    };
    month_start(year, month)
}

fn month_start(year: i32, month: u32) -> Option<SystemTime> {
    let seconds = chrono::NaiveDate::from_ymd_opt(year, month, 1)?
        .and_hms_opt(0, 0, 0)?
        .and_utc()
        .timestamp();
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(u64::try_from(seconds).ok()?))
}

#[derive(Deserialize)]
struct Payload {
    budget: Budget,
    usage: Usage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Budget {
    configured: bool,
    ledger: String,
    window_key: Option<String>,
    limit_micros: Option<i64>,
    spent_micros: Option<i64>,
    remaining_micros: Option<i64>,
}

#[derive(Deserialize)]
struct Usage {
    summary: Summary,
    providers: Vec<Routed>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    request_count: i64,
    success_count: i64,
    error_count: i64,
    input_tokens: i64,
    output_tokens: i64,
    total_tokens: i64,
    actual_cost_micros: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Routed {
    provider: String,
    request_count: i64,
    total_tokens: i64,
    actual_cost_micros: i64,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::usage::service::Timestamp;

    const BUDGETED: &str = r#"{
      "policyId": "openclaw-smoke",
      "budget": {"configured": true, "ledger": "durable_object",
                 "windowKey": "openclaw/openclaw-smoke/2026-07",
                 "limitMicros": 25000000, "spentMicros": 6000, "remainingMicros": 24994000},
      "usage": {
        "ledger": "ready",
        "summary": {"requestCount": 6, "successCount": 5, "errorCount": 1, "inputTokens": 50000,
                    "outputTokens": 4191, "totalTokens": 54191, "actualCostMicros": 6000},
        "providers": [
          {"provider": "anthropic", "requestCount": 2, "successCount": 2, "errorCount": 0,
           "totalTokens": 12191, "actualCostMicros": 2000},
          {"provider": "openai", "requestCount": 4, "successCount": 3, "errorCount": 1,
           "totalTokens": 42000, "actualCostMicros": 4000}
        ],
        "events": []
      }
    }"#;

    const UNMETERED: &str = r#"{
      "policyId": "any-provider-policy",
      "budget": {"configured": false, "ledger": "unmetered", "windowKey": null,
                 "limitMicros": null, "spentMicros": null, "remainingMicros": null},
      "usage": {
        "ledger": "ready",
        "summary": {"requestCount": 3, "successCount": 3, "errorCount": 0, "inputTokens": 0,
                    "outputTokens": 0, "totalTokens": 0, "actualCostMicros": 1250000},
        "providers": [
          {"provider": "tavily", "requestCount": 2, "successCount": 2, "errorCount": 0,
           "totalTokens": 0, "actualCostMicros": 250000},
          {"provider": "replicate", "requestCount": 1, "successCount": 1, "errorCount": 0,
           "totalTokens": 0, "actualCostMicros": 1000000}
        ]
      }
    }"#;

    #[test]
    fn reads_a_monthly_budget() {
        let report = parse(BUDGETED).unwrap();
        assert_eq!(
            report.account.plan.as_deref(),
            Some("Managed monthly budget")
        );
        assert_eq!(report.account.email.as_deref(), Some("2 routed providers"));
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 0.024).abs() < 1e-4);
        assert_eq!(
            window.resets_at,
            Timestamp::Text("2026-08-01T00:00:00Z".into()).time()
        );
        assert_eq!(window.length, Some(Duration::from_secs(31 * 86_400)));
        assert_eq!(report.balances[0].text(), "$0.01 of $25.00");
        let Section::Facts { facts, .. } = &report.sections[1] else {
            panic!("expected routed providers");
        };
        assert_eq!(facts[0].0, "openai");
        assert_eq!(facts[0].1, "4 requests · $0.004000 · 42,000 tokens");
        let Section::Shares { shares, .. } = &report.sections[2] else {
            panic!("expected cost shares");
        };
        assert!((shares[0].1 - 66.67).abs() < 0.01);
    }

    #[test]
    fn unmetered_policies_show_spend_only() {
        let report = parse(UNMETERED).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("Unmetered"));
        assert_eq!(report.balances[0].text(), "$1.25");
        let Section::Facts { facts, .. } = &report.sections[1] else {
            panic!("expected routed providers");
        };
        assert_eq!(facts[0].0, "replicate");
    }

    #[test]
    fn rejects_an_invalid_shape() {
        assert!(parse(r#"{"budget": {"configured": true, "ledger": "x"}}"#).is_err());
    }

    #[test]
    fn december_budgets_reset_in_january() {
        assert_eq!(
            month_after("policy/2026-12"),
            Timestamp::Text("2027-01-01T00:00:00Z".into()).time()
        );
        assert_eq!(month_after("nonsense"), None);
    }
}
