//! DeepInfra prepaid balance and spend, read with an API key (`api_key`, or
//! `DEEPINFRA_API_KEY`/`DEEPINFRA_TOKEN` here or on the probed host) from
//! DeepInfra's documented billing endpoints. DeepInfra is API-only, so there
//! is no agent sign-in to find; everything CodexBar reads is ported.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
    },
};
use serde::Deserialize;
use serde_json::error::Category;
use std::time::Duration;

const CHECKLIST_URL: &str = "https://api.deepinfra.com/payment/checklist?compute_owed=true";
const USAGE_URL: &str = "https://api.deepinfra.com/payment/usage?from=current";
const TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) struct Deepinfra;

static META: Meta = Meta::new("deepinfra", "DeepInfra")
    .dashboard("https://deepinfra.com/dash")
    .status_page("https://status.deepinfra.com")
    .settings(&[Setting::new(
        "api_key",
        &["DEEPINFRA_API_KEY", "DEEPINFRA_TOKEN"],
        "A DeepInfra API key from https://deepinfra.com/dash/api_keys, without a \
         \"Bearer \" prefix. It must be allowed to read billing data.",
    )]);

impl Service for Deepinfra {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("DEEPINFRA_API_KEY"))
            .or_else(|| probe.env("DEEPINFRA_TOKEN"))?;
        Some(read(probe, &key))
    }
}

fn read(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let get = |url: &str| Request::get(url).bearer(key).timeout(TIMEOUT);
    let checklist = probe.body(get(CHECKLIST_URL))?;
    let usage = probe.body(get(USAGE_URL))?;
    parse(&checklist, &usage)
}

pub(crate) fn parse(checklist: &str, usage: &str) -> Result<Report> {
    let checklist: Checklist = json(checklist)?;
    let usage: Usage = json(usage)?;
    let recent = checklist
        .recent
        .filter(|value| value.is_finite())
        .ok_or(Error::UsageJson(Category::Data))?
        .max(0.);
    let stripe = checklist
        .stripe_balance
        .filter(|value| value.is_finite())
        .ok_or(Error::UsageJson(Category::Data))?;
    // DeepInfra keeps prepaid funds as a negative balance; unbilled recent
    // spend is added back so the figure matches its dashboard.
    let balance = stripe + recent;
    // Checklist amounts are dollars; the usage endpoint's `total_cost` is cents.
    let month_cost = match usage.months.last() {
        Some(month) => (month.total_cost / 100.).max(0.),
        None => recent,
    };
    let usd = || Unit::Currency("USD".into());
    let mut balances = vec![if balance > 0. {
        Balance::new("Owed", balance, usd())
    } else {
        Balance::new("Available", 0. - balance, usd())
    }];
    balances.push(match checklist.limit.filter(|limit| *limit > 0.) {
        Some(limit) => Balance::new("Billing cycle spend", recent, usd()).out_of(limit),
        None => Balance::new("Spent this month", month_cost, usd()),
    });
    let mut facts = Vec::new();
    if checklist.limit.is_some_and(|limit| limit > 0.) {
        facts.push((
            "Spent this month".to_owned(),
            Balance::new("", month_cost, usd()).amount_text(),
        ));
    }
    if checklist.suspended.unwrap_or(false) {
        let reason = checklist
            .suspend_reason
            .map(|reason| reason.trim().to_owned())
            .filter(|reason| !reason.is_empty())
            .unwrap_or_else(|| "Suspended".into());
        facts.push(("Suspended".into(), reason));
    }
    let sections = (!facts.is_empty()).then(|| Section::Facts {
        title: "Account".into(),
        facts,
    });
    Ok(
        Report::new(Provider(&Deepinfra), Account::default(), Vec::new())
            .with_balances(balances)
            .with_sections(sections),
    )
}

#[derive(Deserialize)]
struct Checklist {
    stripe_balance: Option<f64>,
    recent: Option<f64>,
    limit: Option<f64>,
    suspended: Option<bool>,
    suspend_reason: Option<String>,
}

#[derive(Deserialize)]
struct Usage {
    months: Vec<Month>,
}

#[derive(Deserialize)]
struct Month {
    total_cost: f64,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const USAGE: &str = r#"{"initial_month": "2026-01", "months": [
        {"period": "2026-08", "total_cost": 1234},
        {"period": "2026-09", "total_cost": 450}
    ]}"#;

    #[test]
    fn prepaid_funds_show_as_available_with_month_spend() {
        let checklist =
            r#"{"stripe_balance": -20.5, "recent": 0.5, "limit": null, "suspended": false}"#;
        let report = parse(checklist, USAGE).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Available");
        assert!((report.balances[0].amount - 20.).abs() < 1e-9);
        assert_eq!(report.balances[1].label, "Spent this month");
        assert!((report.balances[1].amount - 4.5).abs() < 1e-9);
        assert!(report.sections.is_empty());
    }

    #[test]
    fn spending_limit_and_suspension_are_shown() {
        let checklist = r#"{"stripe_balance": 3, "recent": 12, "limit": 50,
            "suspended": true, "suspend_reason": " unpaid invoice "}"#;
        let report = parse(checklist, USAGE).unwrap();
        assert_eq!(report.balances[0].label, "Owed");
        assert!((report.balances[0].amount - 15.).abs() < 1e-9);
        assert_eq!(
            report.balances[1],
            Balance::new("Billing cycle spend", 12., Unit::Currency("USD".into())).out_of(50.)
        );
        let Some(Section::Facts { facts, .. }) = report.sections.first() else {
            panic!("expected account facts");
        };
        assert_eq!(
            facts[0],
            ("Spent this month".to_owned(), "$4.50".to_owned())
        );
        assert_eq!(
            facts[1],
            ("Suspended".to_owned(), "unpaid invoice".to_owned())
        );
    }

    #[test]
    fn missing_amounts_are_rejected() {
        assert!(matches!(
            parse(r#"{"recent": 1}"#, USAGE),
            Err(Error::UsageJson(_))
        ));
        assert!(matches!(
            parse(r#"{"stripe_balance": 1, "recent": 1}"#, r#"{}"#),
            Err(Error::UsageJson(_))
        ));
    }
}
