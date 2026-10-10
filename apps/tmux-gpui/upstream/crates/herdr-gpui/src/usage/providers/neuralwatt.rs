//! Neuralwatt subscription energy and prepaid credits, read from
//! `GET /v1/quota` with an API key: the `api_key` setting (or
//! `NEURALWATT_API_KEY` here), else `NEURALWATT_API_KEY` on the probed host.
//! The subscription's kWh allowance is the monthly window, prepaid USD
//! credits (which never reset) are a balance, and a per-key spending
//! allowance is an extra limit. Everything CodexBar reads is ported.

use crate::{
    Result,
    usage::{
        model::{
            Account, Balance, Kind, Provider, Report, Section, Unit, Window, group, title_case,
        },
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{https_base, invalid, plain},
    },
};
use serde::Deserialize;
use std::time::Duration;

const BASE: &str = "https://api.neuralwatt.com";

pub(crate) struct Neuralwatt;

static META: Meta = Meta::new("neuralwatt", "Neuralwatt")
    .dashboard("https://portal.neuralwatt.com/dashboard")
    .settings(&[
        Setting::new(
            "api_key",
            &["NEURALWATT_API_KEY"],
            "A Neuralwatt API key, created or copied at \
             https://portal.neuralwatt.com/dashboard.",
        ),
        Setting::new(
            "base_url",
            &["NEURALWATT_API_URL"],
            "Optional HTTPS API URL for a proxy. Defaults to https://api.neuralwatt.com.",
        ),
    ]);

impl Service for Neuralwatt {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("NEURALWATT_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    // An override must stay on HTTPS: the key is attached to it.
    let base = https_base(probe.text_setting("base_url"), BASE)?;
    let url = if base.ends_with("/v1") {
        format!("{base}/quota")
    } else {
        format!("{base}/v1/quota")
    };
    let request = Request::get(url)
        .bearer(key)
        .timeout(Duration::from_secs(15));
    parse(&probe.body(request)?)
}

fn parse(body: &str) -> Result<Report> {
    let quota: Quota = json(body)?;
    let balance = quota.balance.ok_or_else(invalid)?;
    let nonnegative = |value: Option<f64>| value.filter(|value| value.is_finite() && *value >= 0.);
    let positive = |value: Option<f64>| value.filter(|value| value.is_finite() && *value > 0.);
    let remaining = nonnegative(balance.credits_remaining_usd);
    let used = nonnegative(balance.credits_used_usd);
    let total = positive(balance.total_credits_usd);
    if remaining.is_none() && used.is_none() && total.is_none() {
        return Err(invalid());
    }
    let total = total.or_else(|| positive(Some(used? + remaining?)));
    let used = used.or_else(|| Some((total? - remaining?).max(0.)));
    let remaining = remaining.or_else(|| Some((total? - used?).max(0.)));

    let subscription = quota.subscription.unwrap_or_default();
    let included = positive(subscription.kwh_included).or_else(|| {
        positive(Some(
            nonnegative(subscription.kwh_used)? + nonnegative(subscription.kwh_remaining)?,
        ))
    });
    let consumed = nonnegative(subscription.kwh_used)
        .or_else(|| Some((included? - nonnegative(subscription.kwh_remaining)?).max(0.)));
    let start = subscription
        .current_period_start
        .and_then(|at| Timestamp::Text(at).time());
    let end = subscription
        .current_period_end
        .and_then(|at| Timestamp::Text(at).time());
    let kind = match subscription.billing_interval.as_deref() {
        Some(interval) if interval.to_lowercase().starts_with("year") => {
            Kind::Named("Yearly".into())
        }
        _ => Kind::Monthly,
    };
    let length = start
        .zip(end)
        .and_then(|(start, end)| end.duration_since(start).ok())
        .filter(|length| !length.is_zero())
        .or_else(|| kind.length());
    let mut facts = Vec::new();
    let windows: Vec<Window> = match (consumed, included) {
        (Some(consumed), Some(included)) => {
            facts.push((
                "Energy".to_owned(),
                format!("{} / {} kWh", plain(consumed), plain(included)),
            ));
            vec![Window::new(kind, consumed / included * 100., end, length)]
        }
        _ => Vec::new(),
    };

    let key = quota.key.unwrap_or_default();
    let allowance = key.allowance.unwrap_or_default();
    let allowance_used = if allowance.blocked == Some(true) {
        Some(100.)
    } else {
        allowance
            .spent_usd
            .zip(positive(allowance.limit_usd))
            .map(|(spent, limit)| spent / limit * 100.)
    };
    let allowance = allowance_used.map(|used| {
        Section::Limit(Window::new(
            Kind::Named(format!(
                "Key {}",
                words(allowance.period.as_deref().unwrap_or("allowance"))
            )),
            used,
            None,
            None,
        ))
    });

    if let Some(month) = quota.usage.and_then(|usage| usage.current_month) {
        let mut spend = format!("${:.2}", month.cost_usd.unwrap_or(0.));
        if let Some(requests) = month.requests {
            spend.push_str(&format!(" · {} requests", group(requests)));
        }
        facts.push(("This month".into(), spend));
    }
    if let Some(total) = total {
        facts.push((
            "Credits used".into(),
            format!("${:.2} of ${total:.2}", used.unwrap_or(0.)),
        ));
    }

    let plan = subscription
        .plan
        .map(|plan| plan.trim().replace('_', " "))
        .filter(|plan| !plan.is_empty())
        .map(|plan| format!("{} plan", words(&plan)))
        .or_else(|| balance.accounting_method.map(|method| words(&method)));
    Ok(Report::new(
        Provider(&Neuralwatt),
        Account { email: None, plan },
        windows,
    )
    .with_balances(
        remaining.map(|left| Balance::new("Prepaid credits", left, Unit::Currency("USD".into()))),
    )
    .with_sections(
        allowance
            .into_iter()
            .chain((!facts.is_empty()).then(|| Section::Facts {
                title: "Usage".into(),
                facts,
            })),
    ))
}

/// `standard` as `Standard`, as CodexBar titles plans and methods.
fn words(text: &str) -> String {
    text.split_whitespace()
        .map(|word| title_case(&word.to_lowercase()))
        .collect::<Vec<_>>()
        .join(" ")
}

#[derive(Deserialize)]
struct Quota {
    balance: Option<Credits>,
    subscription: Option<Subscription>,
    key: Option<Key>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Credits {
    credits_remaining_usd: Option<f64>,
    total_credits_usd: Option<f64>,
    credits_used_usd: Option<f64>,
    accounting_method: Option<String>,
}

#[derive(Default, Deserialize)]
struct Subscription {
    plan: Option<String>,
    billing_interval: Option<String>,
    current_period_start: Option<String>,
    current_period_end: Option<String>,
    kwh_included: Option<f64>,
    kwh_used: Option<f64>,
    kwh_remaining: Option<f64>,
}

#[derive(Default, Deserialize)]
struct Key {
    allowance: Option<Allowance>,
}

#[derive(Default, Deserialize)]
struct Allowance {
    limit_usd: Option<f64>,
    spent_usd: Option<f64>,
    period: Option<String>,
    blocked: Option<bool>,
}

#[derive(Deserialize)]
struct Usage {
    current_month: Option<Month>,
}

#[derive(Deserialize)]
struct Month {
    cost_usd: Option<f64>,
    requests: Option<i64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn reads_subscription_energy_and_prepaid_credits() {
        let report = parse(
            r#"{
                "snapshot_at": "2026-06-10T12:00:00Z",
                "balance": {"credits_remaining_usd": 32.6774, "total_credits_usd": 50,
                            "accounting_method": "energy"},
                "subscription": {"plan": "standard", "status": "active", "billing_interval": "month",
                                 "auto_renew": true,
                                 "current_period_start": "2026-06-01T00:00:00Z",
                                 "current_period_end": "2026-07-01T00:00:00Z",
                                 "kwh_included": 20, "kwh_used": 13.9023, "kwh_remaining": 6.0977,
                                 "in_overage": false},
                "key": {"name": "laptop", "allowance": {"limit_usd": 10, "spent_usd": 2.5,
                        "remaining_usd": 7.5, "period": "monthly", "blocked": false}},
                "limits": {"overage_limit_usd": 0, "rate_limit_tier": "standard"},
                "usage": {"current_month": {"cost_usd": 4.2, "energy_kwh": 13.9, "requests": 1234,
                          "tokens": 99000}}
            }"#,
        )
        .unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Standard plan"));
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 69.5115).abs() < 0.01);
        assert_eq!(window.length, Some(Duration::from_secs(30 * 86_400)));
        assert_eq!(
            window.resets_at,
            Timestamp::Text("2026-07-01T00:00:00Z".into()).time()
        );
        assert_eq!(report.balances[0].text(), "$32.68");
        let Section::Limit(allowance) = &report.sections[0] else {
            panic!("expected the key allowance");
        };
        assert_eq!(allowance.kind, Kind::Named("Key Monthly".into()));
        assert_eq!(allowance.used, 25.);
        let Section::Facts { facts, .. } = &report.sections[1] else {
            panic!("expected facts");
        };
        assert!(facts.contains(&("Energy".into(), "13.90 / 20 kWh".into())));
        assert!(facts.contains(&("This month".into(), "$4.20 · 1,234 requests".into())));
        assert!(facts.contains(&("Credits used".into(), "$17.32 of $50.00".into())));
    }

    #[test]
    fn prepaid_only_accounts_have_no_window() {
        let report = parse(
            r#"{"balance": {"credits_remaining_usd": 51, "accounting_method": "token"},
                "subscription": null}"#,
        )
        .unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("Token"));
        assert_eq!(report.balances[0].text(), "$51.00");
    }

    #[test]
    fn derives_energy_use_from_what_remains() {
        let report = parse(
            r#"{"balance": {"credits_remaining_usd": 0, "total_credits_usd": 0},
                "subscription": {"plan": "pro", "kwh_included": 10, "kwh_remaining": 7.5}}"#,
        )
        .unwrap();
        assert_eq!(report.windows[0].used, 25.);
        assert_eq!(
            report.windows[0].length,
            Some(Kind::Monthly.length().unwrap())
        );
    }

    #[test]
    fn a_blocked_key_is_at_its_limit() {
        let report = parse(
            r#"{"balance": {"credits_remaining_usd": 1},
                "key": {"allowance": {"blocked": true, "period": "daily"}}}"#,
        )
        .unwrap();
        let Section::Limit(allowance) = &report.sections[0] else {
            panic!("expected the key allowance");
        };
        assert_eq!(allowance.used, 100.);
    }

    #[test]
    fn requires_a_balance() {
        assert!(parse(r#"{"subscription": null}"#).is_err());
        assert!(parse(r#"{"balance": {}}"#).is_err());
    }
}
