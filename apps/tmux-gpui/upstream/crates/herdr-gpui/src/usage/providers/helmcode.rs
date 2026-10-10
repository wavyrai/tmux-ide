//! Helmcode model quotas and prepaid balance, read from the dashboard API of
//! Helmcode Cloud (`cloud.helmcode.com`) or NaN Builders
//! (`cloud.nan.builders`) with the dashboard's session cookies. Inference API
//! keys carry no quota, so a browser session is the only sign-in. A pasted
//! `cookie` header goes only to the tenant the `tenant` setting names, as in
//! CodexBar; otherwise Chrome/Safari cookies are tried for Cloud, then NaN.
//! CodexBar's per-tenant keychain cache of imported sessions is not ported:
//! cookies are read again on each refresh.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use chrono::Datelike;
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, SystemTime};

struct Tenant {
    domain: &'static str,
    name: &'static str,
}

static TENANTS: [Tenant; 2] = [
    Tenant {
        domain: "helmcode.com",
        name: "Helmcode Cloud",
    },
    Tenant {
        domain: "nan.builders",
        name: "NaN Builders",
    },
];
const QUOTA_TIMEOUT: Duration = Duration::from_secs(8);
/// Billing and credits are optional, so they may not hold up a valid quota.
const OPTIONAL_TIMEOUT: Duration = Duration::from_secs(2);
/// CodexBar's upper bound on a rolling tier: one year.
const MAX_WINDOW_HOURS: u64 = 8760;

pub(crate) struct Helmcode;

static META: Meta = Meta::new("helmcode", "Helmcode")
    .dashboard("https://cloud.helmcode.com/dashboard")
    .settings(&[
        Setting::new(
            "cookie",
            &[],
            "The dashboard session. Sign in to https://cloud.helmcode.com/dashboard (or \
             https://cloud.nan.builders/dashboard for NaN Builders), open Developer Tools > \
             Network, reload, and copy the Cookie request header of a request to \
             cloud-api.helmcode.com (or cloud-api.nan.builders). Developer Tools > \
             Application > Cookies lists the same cookies. Paste it as \
             \"name=value; name2=value2\".",
        ),
        Setting::new(
            "tenant",
            &[],
            "Which dashboard a pasted cookie belongs to: \"helmcode\" (default) or \
             \"nanBuilders\".",
        ),
    ]);

impl Service for Helmcode {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        // A pasted header has no origin, so it is never tried on both tenants.
        let candidates: Vec<&Tenant> = if probe.setting("cookie").is_some() {
            let nan = probe.text_setting("tenant").is_some_and(|tenant| {
                matches!(
                    tenant.to_lowercase().as_str(),
                    "nanbuilders" | "nan" | "nan.builders" | "nan builders"
                )
            });
            vec![&TENANTS[usize::from(nan)]]
        } else {
            TENANTS.iter().collect()
        };
        let mut rejected = false;
        for tenant in candidates {
            let Some(cookie) = probe.cookies(&[tenant.domain], &[]) else {
                continue;
            };
            match fetch(probe, tenant, &cookie) {
                Err(Error::UsageRejected) => rejected = true,
                other => return Some(other),
            }
        }
        rejected.then_some(Err(Error::UsageRejected))
    }
}

fn fetch(probe: &mut Probe, tenant: &Tenant, cookie: &Secret) -> Result<Report> {
    let domain = tenant.domain;
    let get = |path: &str, timeout: Duration| {
        Request::get(format!("https://cloud-api.{domain}{path}"))
            .cookie(cookie)
            .header("Origin", format!("https://cloud.{domain}"))
            .header("Referer", format!("https://cloud.{domain}/dashboard"))
            .header("Accept", "application/json")
            .timeout(timeout)
    };
    let response = probe.http(get("/api/usage/quota", QUOTA_TIMEOUT))?;
    // An expired session redirects to the sign-in page.
    if (300..400).contains(&response.status) {
        return Err(Error::UsageRejected);
    }
    let quota = response.ok()?;
    let mut optional = |path: &str| {
        probe
            .http(get(path, OPTIONAL_TIMEOUT))
            .ok()
            .filter(|response| response.status == 200)
            .map(|response| response.body)
    };
    let billing = optional("/api/billing");
    let premium = billing
        .as_deref()
        .and_then(|body| serde_json::from_str::<Value>(body).ok())
        .is_some_and(|billing| billing["subscription"]["premium"] == Value::Bool(true));
    let credits = (domain == "helmcode.com")
        .then(|| optional("/api/billing/credits"))
        .flatten();
    parse(&quota, premium, credits.as_deref(), tenant.name)
}

fn parse(quota: &str, premium: bool, credits: Option<&str>, tenant: &str) -> Result<Report> {
    let quota: Quota = json(quota)?;
    let fallback_reset = next_month(&quota.period_start);
    let period_start = Timestamp::Text(quota.period_start.clone()).time();
    let mut models = Vec::new();
    for model in quota.models {
        if model.model.trim().is_empty()
            || model
                .window_hours
                .is_some_and(|hours| !(1..=MAX_WINDOW_HOURS).contains(&hours))
        {
            return Err(invalid());
        }
        // Rolling tiers belong to premium subscriptions; billing must say so.
        if model.cap > 0 && (model.window_hours.is_none() || premium) {
            models.push(model);
        }
    }
    let share = |model: &Model| model.tokens_used as f64 / model.cap as f64;
    models.sort_by(|a, b| {
        share(b)
            .total_cmp(&share(a))
            .then_with(|| a.model.cmp(&b.model))
    });
    let mut windows = Vec::new();
    let mut facts = Vec::new();
    for model in &models {
        let resets_at = model
            .period_end
            .as_ref()
            .and_then(Timestamp::time)
            .or(fallback_reset);
        let length = match model.window_hours {
            Some(hours) => Some(Duration::from_secs(hours * 3600)),
            None => period_start
                .zip(resets_at)
                .and_then(|(start, end)| end.duration_since(start).ok())
                .filter(|length| !length.is_zero())
                .or(Some(MONTH)),
        };
        windows.push(Window::new(
            Kind::Named(model.model.clone()),
            share(model) * 100.,
            resets_at,
            length,
        ));
        let mut tokens = format!(
            "{} / {} tokens",
            group(model.tokens_used as i64),
            group(model.cap as i64)
        );
        if let Some(credit) = model.credit_tokens.filter(|credit| *credit > 0) {
            tokens.push_str(&format!(" · {} credit-funded", group(credit as i64)));
        }
        facts.push((model.model.clone(), tokens));
    }
    Ok(Report::new(
        Provider(&Helmcode),
        Account {
            email: None,
            plan: Some(tenant.to_owned()),
        },
        windows,
    )
    .with_balances(credits.and_then(prepaid))
    .with_sections((!facts.is_empty()).then(|| Section::Facts {
        title: "Model quotas".into(),
        facts,
    })))
}

/// Cloud's prepaid balance, in micros of its currency (EUR when unnamed).
fn prepaid(body: &str) -> Option<Balance> {
    let credits: Value = serde_json::from_str(body).ok()?;
    let micros = credits.get("balanceMicros")?.as_i64()?;
    let currency = match credits.get("currency") {
        None | Some(Value::Null) => "EUR".to_owned(),
        Some(currency) => currency.as_str()?.to_uppercase(),
    };
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_uppercase()) {
        return None;
    }
    Some(Balance::new(
        "Prepaid balance",
        (micros as f64 / 1e6).max(0.),
        Unit::Currency(currency),
    ))
}

/// The first day of the month after a `YYYY-MM-DD…` period start, when a
/// model's own period end is missing.
fn next_month(start: &str) -> Option<SystemTime> {
    let date = chrono::NaiveDate::parse_from_str(start.get(..10)?, "%Y-%m-%d").ok()?;
    let (year, month) = match date.month() {
        12 => (date.year() + 1, 1),
        month => (date.year(), month + 1),
    };
    let seconds = chrono::NaiveDate::from_ymd_opt(year, month, 1)?
        .and_hms_opt(0, 0, 0)?
        .and_utc()
        .timestamp();
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(u64::try_from(seconds).ok()?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Quota {
    period_start: String,
    models: Vec<Model>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Model {
    model: String,
    cap: u64,
    tokens_used: u64,
    credit_tokens: Option<u64>,
    window_hours: Option<u64>,
    period_end: Option<Timestamp>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const QUOTA: &str = r#"{
        "periodStart": "2026-06-01T00:00:00Z",
        "models": [
            {"model": "helm-coder", "cap": 1000000, "tokensUsed": 250000, "creditTokens": 5000,
             "periodEnd": "2026-07-01T00:00:00Z"},
            {"model": "helm-fast", "cap": 2000000, "tokensUsed": 1500000},
            {"model": "helm-unlimited", "cap": 0, "tokensUsed": 42},
            {"model": "helm-burst", "cap": 100000, "tokensUsed": 10000, "windowHours": 5,
             "periodEnd": "2026-06-10T15:00:00Z"}
        ]
    }"#;

    #[test]
    fn reads_model_quotas_by_utilization() {
        let report = parse(QUOTA, false, None, "Helmcode Cloud").unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Helmcode Cloud"));
        // Unlimited models have no percentage; rolling tiers need premium.
        assert_eq!(report.windows.len(), 2);
        let fast = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Named("helm-fast".into()))
            .unwrap();
        assert_eq!(fast.used, 75.);
        // No period end: the first of the next month.
        assert_eq!(
            fast.resets_at,
            Timestamp::Text("2026-07-01T00:00:00Z".into()).time()
        );
        assert_eq!(fast.length, Some(Duration::from_secs(30 * 86_400)));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0].0, "helm-fast");
        assert_eq!(
            facts[1],
            (
                "helm-coder".into(),
                "250,000 / 1,000,000 tokens · 5,000 credit-funded".into()
            )
        );
    }

    #[test]
    fn premium_shows_rolling_tiers_and_credits() {
        let report = parse(
            QUOTA,
            true,
            Some(r#"{"balanceMicros": 12500000, "currency": "usd"}"#),
            "Helmcode Cloud",
        )
        .unwrap();
        let burst = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Named("helm-burst".into()))
            .unwrap();
        assert_eq!(burst.used, 10.);
        assert_eq!(burst.length, Some(Duration::from_secs(5 * 3600)));
        assert_eq!(report.balances[0].text(), "$12.50");
    }

    #[test]
    fn credits_default_to_euros() {
        assert_eq!(
            prepaid(r#"{"balanceMicros": 3000000}"#).unwrap().text(),
            "3.00 EUR"
        );
        assert!(prepaid(r#"{"balanceMicros": 1, "currency": "euro"}"#).is_none());
    }

    #[test]
    fn schema_changes_fail_visibly() {
        assert!(parse(r#"{"models": []}"#, false, None, "x").is_err());
        assert!(
            parse(
                r#"{"periodStart": "2026-06-01", "models": [{"model": "m", "cap": -1, "tokensUsed": 0}]}"#,
                false,
                None,
                "x"
            )
            .is_err()
        );
        assert!(
            parse(
                r#"{"periodStart": "2026-06-01", "models": [{"model": "m", "cap": 1, "tokensUsed": 0, "windowHours": 0}]}"#,
                false,
                None,
                "x"
            )
            .is_err()
        );
    }

    #[test]
    fn december_rolls_into_january() {
        assert_eq!(
            next_month("2026-12-15"),
            Timestamp::Text("2027-01-01T00:00:00Z".into()).time()
        );
    }
}
