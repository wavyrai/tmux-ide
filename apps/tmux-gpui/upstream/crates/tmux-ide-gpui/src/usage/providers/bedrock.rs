//! AWS Bedrock month-to-date spend from Cost Explorer, read by running the
//! AWS CLI on the probed host (`aws ce get-cost-and-usage`), so any sign-in
//! the CLI supports works: a named profile with SSO, assume-role, or
//! `credential_process`, or the `AWS_ACCESS_KEY_ID` family in its
//! environment. The CLI prints cost data only, never credentials.
//!
//! Each Cost Explorer request is billed by AWS ($0.01 at the time of
//! writing), so the provider only runs once `profile` or `budget` is set in
//! the config; `AWS_PROFILE` alone does not turn it on.
//!
//! Not ported from CodexBar: signing Cost Explorer requests itself (AWS
//! SigV4) from pasted access keys, the CloudWatch Claude token and request
//! totals, and the daily cost history.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::Probe,
        service::{Meta, Service, Setting, json, number},
    },
};
use chrono::{Datelike, NaiveDate};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const TIMEOUT: Duration = Duration::from_secs(30);
/// Cost Explorer is a global service served from this region.
const REGION: &str = "us-east-1";

pub(crate) struct Bedrock;

static META: Meta = Meta::new("bedrock", "AWS Bedrock")
    .dashboard("https://console.aws.amazon.com/bedrock")
    .status_page("https://health.aws.amazon.com/health/status")
    .settings(&[
        Setting::new(
            "profile",
            &[],
            "The AWS CLI profile to read Cost Explorer with, from ~/.aws/config on the \
             selected host (run `aws sso login --profile <name>` first for SSO). Use \
             \"default\" for the default credentials. The identity needs \
             ce:GetCostAndUsage. AWS bills every Cost Explorer request, so this provider \
             runs only once profile or budget is set here.",
        ),
        Setting::new(
            "budget",
            &["CODEXBAR_BEDROCK_BUDGET"],
            "Optional monthly Bedrock budget in US dollars, e.g. 250, shown as a monthly \
             limit. It does not cap AWS charges.",
        ),
        Setting::new(
            "aws_cli",
            &["AWS_CLI_PATH"],
            "Optional path to the AWS CLI v2 on the selected host when `aws` is not on \
             its PATH, e.g. /opt/homebrew/bin/aws.",
        ),
    ]);

impl Service for Bedrock {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let profile = probe
            .text_setting("profile")
            .filter(|name| !name.is_empty());
        let budget = probe
            .text_setting("budget")
            .and_then(|budget| budget.trim_start_matches('$').parse::<f64>().ok())
            .filter(|budget| budget.is_finite() && *budget > 0.);
        if profile.is_none() && budget.is_none() {
            return None;
        }
        Some(fetch(probe, profile.as_deref(), budget))
    }
}

fn fetch(probe: &mut Probe, profile: Option<&str>, budget: Option<f64>) -> Result<Report> {
    let today = chrono::Utc::now().date_naive();
    let start = today.with_day(1).unwrap_or(today);
    let end = today.succ_opt().unwrap_or(today);
    let period = format!("Start={},End={}", day(start), day(end));
    let program = probe
        .text_setting("aws_cli")
        .filter(|path| !path.is_empty())
        .unwrap_or_else(|| "aws".to_owned());
    let mut args = vec![
        "ce",
        "get-cost-and-usage",
        "--time-period",
        period.as_str(),
        "--granularity",
        "MONTHLY",
        "--metrics",
        "UnblendedCost",
        "--group-by",
        "Type=DIMENSION,Key=SERVICE",
        "--region",
        REGION,
        "--output",
        "json",
    ];
    if let Some(profile) = profile.filter(|profile| *profile != "default") {
        args.extend(["--profile", profile]);
    }
    let output = probe.command(&program, &args, TIMEOUT)?;
    if !output.success {
        return Err(Error::UsageCommand("aws ce get-cost-and-usage"));
    }
    parse(&output.stdout, budget, today)
}

fn day(date: NaiveDate) -> String {
    format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day())
}

/// Sums the month's Bedrock services, which Cost Explorer names per model
/// family, such as "Claude Sonnet (Bedrock Edition)".
pub(crate) fn parse(body: &str, budget: Option<f64>, today: NaiveDate) -> Result<Report> {
    let costs: Costs = json(body)?;
    let mut services: Vec<(String, f64)> = Vec::new();
    for group in costs
        .results_by_time
        .iter()
        .flat_map(|result| &result.groups)
    {
        let Some(name) = group.keys.first() else {
            continue;
        };
        if !name.to_ascii_lowercase().contains("bedrock") {
            continue;
        }
        let Some(amount) = group
            .metrics
            .unblended_cost
            .as_ref()
            .and_then(|cost| cost.amount)
            .filter(|amount| amount.is_finite())
        else {
            continue;
        };
        match services.iter_mut().find(|(service, _)| service == name) {
            Some((_, total)) => *total += amount,
            None => services.push((name.clone(), amount)),
        }
    }
    let spend: f64 = services.iter().map(|(_, amount)| amount).sum();
    let resets_at = next_month(today);
    let windows = budget
        .map(|budget| Window::new(Kind::Monthly, spend / budget * 100., resets_at, Some(MONTH)))
        .into_iter()
        .collect();
    let mut balance = Balance::new("Month to date", spend, Unit::Currency("USD".into()));
    if let Some(budget) = budget {
        balance = balance.out_of(budget);
    }
    services.sort_by(|a, b| b.1.total_cmp(&a.1));
    let breakdown = (!services.is_empty()).then(|| Section::Facts {
        title: "Spend by service".into(),
        facts: services
            .into_iter()
            .map(|(service, amount)| (service, format!("${amount:.2}")))
            .collect(),
    });
    Ok(Report::new(Provider(&Bedrock), Account::default(), windows)
        .with_balances([balance])
        .with_sections(breakdown))
}

/// Cost Explorer months are UTC calendar months.
fn next_month(today: NaiveDate) -> Option<SystemTime> {
    let (year, month) = match today.month() {
        12 => (today.year() + 1, 1),
        month => (today.year(), month + 1),
    };
    let start = NaiveDate::from_ymd_opt(year, month, 1)?
        .and_hms_opt(0, 0, 0)?
        .and_utc()
        .timestamp();
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(u64::try_from(start).ok()?))
}

#[derive(Deserialize)]
struct Costs {
    #[serde(rename = "ResultsByTime", default)]
    results_by_time: Vec<Period>,
}

#[derive(Deserialize)]
struct Period {
    #[serde(rename = "Groups", default)]
    groups: Vec<Group>,
}

#[derive(Deserialize)]
struct Group {
    #[serde(rename = "Keys", default)]
    keys: Vec<String>,
    #[serde(rename = "Metrics")]
    metrics: Metrics,
}

#[derive(Deserialize)]
struct Metrics {
    #[serde(rename = "UnblendedCost")]
    unblended_cost: Option<Amount>,
}

#[derive(Deserialize)]
struct Amount {
    #[serde(rename = "Amount", default, deserialize_with = "number")]
    amount: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const BODY: &str = r#"{
        "GroupDefinitions": [{"Type": "DIMENSION", "Key": "SERVICE"}],
        "ResultsByTime": [
            {
                "TimePeriod": {"Start": "2026-04-01", "End": "2026-04-06"},
                "Total": {},
                "Groups": [
                    {
                        "Keys": ["Claude Opus (Bedrock Edition)"],
                        "Metrics": {"UnblendedCost": {"Amount": "30.00", "Unit": "USD"}}
                    },
                    {
                        "Keys": ["Claude Sonnet (Bedrock Edition)"],
                        "Metrics": {"UnblendedCost": {"Amount": "12.50", "Unit": "USD"}}
                    },
                    {
                        "Keys": ["Amazon EC2"],
                        "Metrics": {"UnblendedCost": {"Amount": "5.00", "Unit": "USD"}}
                    }
                ],
                "Estimated": true
            }
        ],
        "DimensionValueAttributes": []
    }"#;

    fn april() -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 4, 5).unwrap()
    }

    #[test]
    fn sums_bedrock_services_against_budget() {
        let report = parse(BODY, Some(100.), april()).unwrap();
        assert_eq!(report.balances[0].amount, 42.5);
        assert_eq!(report.balances[0].total, Some(100.));
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Monthly);
        assert_eq!(report.windows[0].percent(), 43);
        let may = NaiveDate::from_ymd_opt(2026, 5, 1)
            .unwrap()
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_utc()
            .timestamp();
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(may as u64))
        );
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(
            facts[0],
            ("Claude Opus (Bedrock Edition)".into(), "$30.00".into())
        );
        assert_eq!(facts.len(), 2);
    }

    #[test]
    fn spend_without_budget_has_no_window() {
        let report = parse(BODY, None, april()).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].total, None);
    }

    #[test]
    fn december_resets_in_january() {
        let december = NaiveDate::from_ymd_opt(2026, 12, 31).unwrap();
        assert!(next_month(december).is_some());
        assert_eq!(day(december), "2026-12-31");
    }
}
