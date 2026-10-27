//! sub2api group quota, subscription spend, and wallet balance, read from a
//! self-hosted deployment's `GET /v1/usage` with a group API key: the
//! `api_key` setting (or `SUB2API_API_KEY` here), else `SUB2API_API_KEY` on
//! the probed host, sent to the `base_url` setting (`SUB2API_BASE_URL`),
//! which has no default. CodexBar's several labelled group keys per account
//! are not ported: one key is read, so configure the group to watch.
//! Daily totals use UTC days, where CodexBar passes the Mac's time zone.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
    },
};
use serde::Deserialize;
use std::time::Duration;

pub(crate) struct Sub2api;

static META: Meta = Meta::new("sub2api", "sub2api").settings(&[
    Setting::new(
        "api_key",
        &["SUB2API_API_KEY"],
        "A sub2api group API key (sk-…), created in your sub2api deployment's dashboard \
             under API keys. Usage is scoped to that key's group.",
    ),
    Setting::new(
        "base_url",
        &["SUB2API_BASE_URL"],
        "Your sub2api deployment, e.g. https://sub2api.example.com. HTTPS is required, \
             except plain HTTP on a loopback address such as http://127.0.0.1:8080.",
    ),
]);

impl Service for Sub2api {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("SUB2API_API_KEY"))?;
        Some(fetch(probe, &key))
    }
}

fn fetch(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let base = probe
        .text_setting("base_url")
        .and_then(|raw| endpoint(&raw))
        .ok_or(Error::UsageNotSignedIn)?;
    let request = Request::get(format!("{base}?days=30&timezone=UTC"))
        .bearer(key)
        .timeout(Duration::from_secs(15));
    parse(&probe.body(request)?)
}

/// The usage endpoint of a deployment URL, which may already name `/v1` or
/// `/v1/usage`. The key is attached to it, so it must be HTTPS or loopback.
fn endpoint(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_end_matches('/');
    let url = url::Url::parse(raw).ok()?;
    let loopback = match url.host()? {
        url::Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    };
    let allowed = url.scheme() == "https" || (url.scheme() == "http" && loopback);
    if !allowed || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let mut endpoint = raw.to_owned();
    if !(endpoint.ends_with("/v1") || endpoint.ends_with("/v1/usage")) {
        endpoint.push_str("/v1");
    }
    if !endpoint.ends_with("/usage") {
        endpoint.push_str("/usage");
    }
    Some(endpoint)
}

fn parse(body: &str) -> Result<Report> {
    let usage: Usage = json(body)?;
    if usage.is_valid == Some(false) {
        return Err(Error::UsageRejected);
    }
    let unit = usage
        .unit
        .clone()
        .or_else(|| usage.quota.as_ref().and_then(|quota| quota.unit.clone()))
        .unwrap_or_else(|| "USD".into());
    let limit = |kind: Kind, used: f64, limit: Option<f64>| {
        let limit = limit.filter(|limit| *limit > 0.)?;
        let length = kind.length();
        Some(Window::new(kind, used / limit * 100., None, length))
    };
    let mut windows = Vec::new();
    let mut facts = Vec::new();
    let mut expires = usage.expires_at.clone();
    if let Some(subscription) = &usage.subscription {
        windows.extend(
            [
                limit(
                    Kind::Daily,
                    subscription.daily_usage_usd.unwrap_or(0.),
                    subscription.daily_limit_usd,
                ),
                limit(
                    Kind::Weekly,
                    subscription.weekly_usage_usd.unwrap_or(0.),
                    subscription.weekly_limit_usd,
                ),
                limit(
                    Kind::Monthly,
                    subscription.monthly_usage_usd.unwrap_or(0.),
                    subscription.monthly_limit_usd,
                ),
            ]
            .into_iter()
            .flatten(),
        );
        expires = subscription.expires_at.clone().or(expires);
    } else if let Some(quota) = &usage.quota {
        let quota_unit = quota.unit.as_deref().unwrap_or(&unit);
        windows.extend(limit(
            Kind::Named("Quota".into()),
            quota.used,
            Some(quota.limit),
        ));
        facts.push((
            "Quota".to_owned(),
            format!(
                "{} / {}",
                money(quota.used, quota_unit),
                money(quota.limit, quota_unit)
            ),
        ));
    }
    let rates: Vec<Window> = usage
        .rate_limits
        .iter()
        .flatten()
        .filter(|rate| rate.limit > 0.)
        .map(|rate| {
            let (kind, length) = match rate.window.trim().to_lowercase().as_str() {
                "5h" => (Kind::Session, Kind::Session.length()),
                "1d" => (Kind::Daily, Kind::Daily.length()),
                "7d" => (Kind::Weekly, Kind::Weekly.length()),
                _ => (Kind::Named(format!("{} limit", rate.window.trim())), None),
            };
            Window::new(
                kind,
                rate.used / rate.limit * 100.,
                rate.reset_at.as_ref().and_then(Timestamp::time),
                length,
            )
        })
        .collect();
    // A subscription already has daily and weekly windows; rate limits
    // beside them would read as duplicates.
    let rate_sections: Vec<Section> = if usage.subscription.is_some() {
        rates.into_iter().map(Section::Limit).collect()
    } else {
        windows.extend(rates);
        Vec::new()
    };

    if let Some(totals) = &usage.usage {
        for (title, total) in [("Today", &totals.today), ("All time", &totals.total)] {
            let Some(total) = total else {
                continue;
            };
            facts.push((
                format!("{title} requests"),
                group(total.requests.unwrap_or(0)),
            ));
            facts.push((
                format!("{title} tokens"),
                format!(
                    "{} · {}",
                    group(total.total_tokens.unwrap_or(0)),
                    money(total.actual_cost.unwrap_or(0.), "USD")
                ),
            ));
        }
    }
    if let Some(expires) = expires.filter(|at| Timestamp::Text(at.clone()).time().is_some()) {
        facts.push((
            "Expires".into(),
            expires.get(..10).unwrap_or(&expires).to_owned(),
        ));
    }
    let plan = usage.plan_name.filter(|plan| !plan.trim().is_empty());
    Ok(
        Report::new(Provider(&Sub2api), Account { email: None, plan }, windows)
            .with_balances(
                usage
                    .balance
                    .map(|balance| Balance::new("Balance", balance, currency(&unit))),
            )
            .with_sections(
                rate_sections
                    .into_iter()
                    .chain((!facts.is_empty()).then(|| Section::Facts {
                        title: "Usage summary".into(),
                        facts,
                    })),
            ),
    )
}

fn currency(unit: &str) -> Unit {
    let code = unit.trim().to_uppercase();
    if code.len() == 3 && code.chars().all(|c| c.is_ascii_uppercase()) {
        Unit::Currency(code)
    } else {
        Unit::Count(unit.trim().to_owned())
    }
}

fn money(amount: f64, unit: &str) -> String {
    Balance::new("", amount, currency(unit)).amount_text()
}

#[derive(Deserialize)]
struct Usage {
    #[serde(rename = "isValid")]
    is_valid: Option<bool>,
    #[serde(rename = "planName")]
    plan_name: Option<String>,
    balance: Option<f64>,
    unit: Option<String>,
    quota: Option<Quota>,
    subscription: Option<Subscription>,
    rate_limits: Option<Vec<RateLimit>>,
    expires_at: Option<String>,
    usage: Option<Totals>,
}

#[derive(Deserialize)]
struct Quota {
    limit: f64,
    used: f64,
    unit: Option<String>,
}

#[derive(Deserialize)]
struct Subscription {
    daily_usage_usd: Option<f64>,
    weekly_usage_usd: Option<f64>,
    monthly_usage_usd: Option<f64>,
    daily_limit_usd: Option<f64>,
    weekly_limit_usd: Option<f64>,
    monthly_limit_usd: Option<f64>,
    expires_at: Option<String>,
}

#[derive(Deserialize)]
struct RateLimit {
    window: String,
    limit: f64,
    used: f64,
    reset_at: Option<Timestamp>,
}

#[derive(Deserialize)]
struct Totals {
    today: Option<Total>,
    total: Option<Total>,
}

#[derive(Deserialize)]
struct Total {
    requests: Option<i64>,
    total_tokens: Option<i64>,
    actual_cost: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn facts(report: &Report) -> &[(String, String)] {
        report
            .sections
            .iter()
            .find_map(|section| match section {
                Section::Facts { facts, .. } => Some(facts.as_slice()),
                _ => None,
            })
            .unwrap()
    }

    #[test]
    fn reads_a_quota_limited_key() {
        let report = parse(
            r#"{
              "mode": "quota_limited", "isValid": true, "status": "active", "remaining": 75,
              "unit": "USD",
              "quota": {"limit": 100, "used": 25, "remaining": 75, "unit": "USD"},
              "rate_limits": [
                {"window": "5h", "limit": 20, "used": 5, "remaining": 15,
                 "reset_at": "2026-07-11T12:30:00Z"},
                {"window": "7d", "limit": 200, "used": 40, "remaining": 160}
              ],
              "expires_at": "2026-08-01T00:00:00Z",
              "usage": {
                "today": {"requests": 4, "total_tokens": 1200, "actual_cost": 1.25},
                "total": {"requests": 40, "total_tokens": 12000, "actual_cost": 25}
              }
            }"#,
        )
        .unwrap();
        let quota = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Named("Quota".into()))
            .unwrap();
        assert_eq!(quota.used, 25.);
        let session = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Session)
            .unwrap();
        assert_eq!(session.used, 25.);
        assert_eq!(session.length, Kind::Session.length());
        assert_eq!(
            session.resets_at,
            Timestamp::Text("2026-07-11T12:30:00Z".into()).time()
        );
        let weekly = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Weekly)
            .unwrap();
        assert_eq!(weekly.used, 20.);
        assert!(report.balances.is_empty());
        let facts = facts(&report);
        assert!(facts.contains(&("Today requests".into(), "4".into())));
        assert!(facts.contains(&("Today tokens".into(), "1,200 · $1.25".into())));
        assert!(facts.contains(&("All time requests".into(), "40".into())));
        assert!(facts.contains(&("Expires".into(), "2026-08-01".into())));
    }

    #[test]
    fn reads_subscription_windows() {
        let report = parse(
            r#"{
              "mode": "unrestricted", "isValid": true, "planName": "Claude Team",
              "remaining": 8, "unit": "USD",
              "subscription": {
                "daily_usage_usd": 2, "weekly_usage_usd": 10, "monthly_usage_usd": 30,
                "daily_limit_usd": 10, "weekly_limit_usd": 40, "monthly_limit_usd": 100,
                "expires_at": "2026-08-15T00:00:00.123Z"
              }
            }"#,
        )
        .unwrap();
        let used: Vec<(Kind, f32)> = report
            .windows
            .iter()
            .map(|window| (window.kind.clone(), window.used))
            .collect();
        assert_eq!(
            used,
            [
                (Kind::Daily, 20.),
                (Kind::Weekly, 25.),
                (Kind::Monthly, 30.)
            ]
        );
        assert_eq!(report.account.plan.as_deref(), Some("Claude Team"));
        assert!(facts(&report).contains(&("Expires".into(), "2026-08-15".into())));
    }

    #[test]
    fn wallet_groups_show_a_balance() {
        let report = parse(r#"{"mode": "wallet", "isValid": true, "balance": 12.5}"#).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].text(), "$12.50");
    }

    #[test]
    fn an_invalid_key_is_rejected() {
        assert!(matches!(
            parse(r#"{"isValid": false}"#),
            Err(Error::UsageRejected)
        ));
    }

    #[test]
    fn endpoints_are_https_or_loopback() {
        assert_eq!(
            endpoint("https://sub2api.example.com/").as_deref(),
            Some("https://sub2api.example.com/v1/usage")
        );
        assert_eq!(
            endpoint("https://sub2api.example.com/v1").as_deref(),
            Some("https://sub2api.example.com/v1/usage")
        );
        assert_eq!(
            endpoint("http://127.0.0.1:8080").as_deref(),
            Some("http://127.0.0.1:8080/v1/usage")
        );
        assert_eq!(endpoint("http://sub2api.example.com"), None);
    }
}
