//! DevPass usage, read from the LLM Gateway API with a regular gateway API
//! key from the config or `DEVPASS_API_KEY`: the billing-cycle plan credits,
//! the premium weekly allowance, and the key's own all-time spend.
//! Publishable keys cannot read plan state. As in CodexBar, there is no local
//! sign-in or dashboard cookie to find.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, WEEK, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{self, invalid},
    },
};
use serde::Deserialize;

const URL: &str = "https://api.llmgateway.io/v1/key";

pub(crate) struct Devpass;

static META: Meta = Meta::new("devpass", "DevPass")
    .dashboard("https://devpass.llmgateway.io/dashboard")
    .settings(&[Setting::new(
        "api_key",
        &["DEVPASS_API_KEY"],
        "A regular LLM Gateway API key from https://devpass.llmgateway.io/dashboard. \
         Publishable keys cannot read plan usage.",
    )]);

impl Service for Devpass {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        Some(
            probe
                .body(Request::get(URL).bearer(&key))
                .and_then(|body| parse(&body)),
        )
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let data = json::<Envelope>(body)?.data.ok_or_else(invalid)?;
    let key_used = money(&data.usage)?;
    let key_limit = data.limit.as_deref().map(money).transpose()?;
    let mut key_facts = vec![("All-time key usage".into(), usd(key_used))];
    if let Some(limit) = key_limit {
        key_facts.push(("Key spending limit".into(), usd(limit)));
    }
    let key_section = Section::Facts {
        title: "API key (all time)".into(),
        facts: key_facts,
    };
    let plan = match data.dev_plan.as_str() {
        "none" => {
            let mut spend = Balance::new("Key usage (all time)", key_used, usd_unit());
            if let Some(limit) = key_limit {
                spend = spend.out_of(limit);
            }
            let account = Account {
                email: None,
                plan: Some("Pay as you go".into()),
            };
            return Ok(Report::new(Provider(&Devpass), account, Vec::new())
                .with_balances([spend])
                .with_sections([key_section]));
        }
        "lite" => "DevPass Lite",
        "pro" => "DevPass Pro",
        "max" => "DevPass Max",
        _ => return Err(invalid()),
    };
    let required = |value: &Option<String>| value.as_deref().ok_or_else(invalid).and_then(money);
    let used = required(&data.dev_plan_credits_used)?;
    let limit = required(&data.dev_plan_credits_limit)?;
    let remaining = required(&data.dev_plan_credits_remaining)?;
    let weekly_used = required(&data.dev_plan_premium_credits_used)?;
    let weekly_limit = required(&data.dev_plan_premium_weekly_limit)?;
    let resets_at = data
        .dev_plan_premium_week_resets_at
        .map(|reset| Timestamp::Text(reset).time().ok_or_else(invalid))
        .transpose()?;
    // The endpoint reports no cycle end, so the plan window has no reset and
    // therefore no pace; the premium window starts with its first request.
    let mut windows = Vec::new();
    if limit > 0. {
        windows.push(Window::new(
            Kind::Monthly,
            used / limit * 100.,
            None,
            Some(MONTH),
        ));
    }
    if weekly_limit > 0. {
        windows.push(Window::new(
            Kind::Weekly,
            weekly_used / weekly_limit * 100.,
            resets_at,
            Some(WEEK),
        ));
    }
    let credits = Section::Facts {
        title: "DevPass credits".into(),
        facts: vec![
            (
                "Cycle used".into(),
                format!("{} / {}", usd(used), usd(limit)),
            ),
            ("Cycle remaining".into(), usd(remaining)),
            (
                "Premium weekly".into(),
                format!("{} / {}", usd(weekly_used), usd(weekly_limit)),
            ),
        ],
    };
    let account = Account {
        email: None,
        plan: Some(plan.into()),
    };
    Ok(Report::new(Provider(&Devpass), account, windows)
        .with_balances([Balance::new("Plan credits left", remaining, usd_unit()).out_of(limit)])
        .with_sections([credits, key_section]))
}

fn usd_unit() -> Unit {
    Unit::Currency("USD".into())
}

fn usd(amount: f64) -> String {
    Balance::new("", amount, usd_unit()).amount_text()
}

/// Amounts arrive as unsigned decimal strings; anything else is a changed
/// response, never a zero.
fn money(text: &str) -> Result<f64> {
    if text.starts_with('-') {
        return Err(invalid());
    }
    values::decimal(text).ok_or_else(invalid)
}

#[derive(Deserialize)]
struct Envelope {
    data: Option<Data>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    usage: String,
    limit: Option<String>,
    dev_plan: String,
    dev_plan_credits_used: Option<String>,
    dev_plan_credits_limit: Option<String>,
    dev_plan_credits_remaining: Option<String>,
    dev_plan_premium_credits_used: Option<String>,
    dev_plan_premium_weekly_limit: Option<String>,
    dev_plan_premium_week_resets_at: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const PRO: &str = r#"{"data":{
        "label": "Fixture key", "usage": "31.42", "limit": null, "devPlan": "pro",
        "devPlanCreditsUsed": "25", "devPlanCreditsLimit": "237", "devPlanCreditsRemaining": "212.00",
        "devPlanPremiumWeeklyLimit": "35.55", "devPlanPremiumCreditsUsed": "5.00",
        "devPlanPremiumWeekResetsAt": "2026-10-01T12:00:00.000Z"
    }}"#;

    #[test]
    fn plan_credits_and_premium_week_become_windows() {
        let report = parse(PRO).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("DevPass Pro"));
        assert_eq!(report.windows.len(), 2);
        // Windows are ordered by kind: weekly before monthly.
        let monthly = &report.windows[1];
        assert_eq!(monthly.kind, Kind::Monthly);
        assert!((monthly.used - 10.548).abs() < 0.01);
        assert!(monthly.resets_at.is_none());
        let weekly = &report.windows[0];
        assert_eq!(weekly.kind, Kind::Weekly);
        assert!((weekly.used - 14.065).abs() < 0.01);
        assert!(weekly.resets_at.is_some());
        assert_eq!(weekly.length, Some(WEEK));
        assert_eq!(report.balances[0].amount, 212.);
        assert_eq!(report.balances[0].total, Some(237.));
        assert_eq!(report.sections.len(), 2);
    }

    #[test]
    fn pay_as_you_go_shows_key_spend_only() {
        let body = r#"{"data":{"usage":"3.50","limit":"10","devPlan":"none",
            "devPlanCreditsUsed":null}}"#;
        let report = parse(body).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("Pay as you go"));
        assert_eq!(report.balances[0].amount, 3.5);
        assert_eq!(report.balances[0].total, Some(10.));
    }

    #[test]
    fn inactive_premium_week_has_no_reset() {
        let body = PRO
            .replace("\"5.00\"", "\"0.00\"")
            .replace("\"2026-10-01T12:00:00.000Z\"", "null");
        let report = parse(&body).unwrap();
        assert_eq!(report.windows[0].kind, Kind::Weekly);
        assert_eq!(report.windows[0].used, 0.);
        assert!(report.windows[0].resets_at.is_none());
    }

    #[test]
    fn malformed_amounts_and_plans_fail() {
        assert!(parse(&PRO.replace("\"31.42\"", "\"-1\"")).is_err());
        assert!(parse(&PRO.replace("\"31.42\"", "31.42")).is_err());
        assert!(parse(&PRO.replace("\"pro\"", "\"gold\"")).is_err());
        assert!(parse(&PRO.replace("\"212.00\"", "null")).is_err());
    }
}
