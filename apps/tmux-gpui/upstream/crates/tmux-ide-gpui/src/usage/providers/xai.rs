//! xAI developer-platform billing, read from the Management API with a
//! Management API key and team ID from the config or `XAI_MANAGEMENT_API_KEY`
//! and `XAI_TEAM_ID`: the posted prepaid balance, and the last 30 days of
//! daily USD spend as best-effort enrichment. Inference keys are refused by
//! this API. This is the platform's prepaid billing, separate from the Grok
//! consumer subscription; there is no local sign-in to find.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json},
        values::{invalid, usd},
    },
};
use chrono::{DateTime, Days, NaiveDate, Utc};
use serde::Deserialize;

const ROOT: &str = "https://management-api.x.ai/v1/billing/teams";

pub(crate) struct Xai;

static META: Meta = Meta::new("xai", "xAI")
    .dashboard("https://console.x.ai")
    .status_page("https://status.x.ai")
    .settings(&[
        Setting::new(
            "api_key",
            &["XAI_MANAGEMENT_API_KEY"],
            "A Management API key from https://console.x.ai under Settings > Management \
             Keys, with billing read access. Inference API keys are not accepted.",
        ),
        Setting::new(
            "team_id",
            &["XAI_TEAM_ID"],
            "The xAI team ID to bill against, shown in the xAI Console URL and team \
             settings. The Management key must belong to this team.",
        ),
    ]);

impl Service for Xai {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        let Some(team) = probe
            .text_setting("team_id")
            .filter(|team| !team.is_empty() && !team.contains('/') && team != "." && team != "..")
        else {
            return Some(Err(Error::UsageNotSignedIn));
        };
        let root = format!(
            "{ROOT}/{}",
            url::form_urlencoded::byte_serialize(team.as_bytes()).collect::<String>()
        );
        let balance = match probe.body(Request::get(format!("{root}/prepaid/balance")).bearer(&key))
        {
            Ok(body) => body,
            Err(error) => return Some(Err(error)),
        };
        let now = Utc::now();
        let usage = match probe.body(
            Request::post(format!("{root}/usage"))
                .bearer(&key)
                .json(query(now)),
        ) {
            Ok(body) => Some(body),
            Err(Error::UsageRejected) => return Some(Err(Error::UsageRejected)),
            // History only enriches the balance.
            Err(_) => None,
        };
        Some(parse(&balance, usage.as_deref(), now.date_naive()))
    }
}

/// A daily USD-summed analytics query for the last 30 UTC days.
fn query(now: DateTime<Utc>) -> String {
    let start = now
        .date_naive()
        .checked_sub_days(Days::new(29))
        .unwrap_or(now.date_naive());
    let format = "%Y-%m-%d %H:%M:%S";
    serde_json::json!({
        "analyticsRequest": {
            "timeRange": {
                "startTime": format!("{} 00:00:00", start.format("%Y-%m-%d")),
                "endTime": now.format(format).to_string(),
                "timezone": "Etc/GMT",
            },
            "timeUnit": "TIME_UNIT_DAY",
            "values": [{"name": "usd", "aggregation": "AGGREGATION_SUM"}],
            "groupBy": [],
            "filters": [],
        }
    })
    .to_string()
}

pub(crate) fn parse(balance: &str, usage: Option<&str>, today: NaiveDate) -> Result<Report> {
    let ledger: Ledger = json(balance)?;
    // The ledger is inverted: a $10 top-up is "-1000" cents.
    let cents = ledger
        .total
        .and_then(|total| total.val)
        .and_then(|val| val.trim().parse::<f64>().ok())
        .filter(|cents| cents.is_finite())
        .ok_or_else(invalid)?;
    // Adding zero turns an empty ledger's -0 into 0.
    let balance = Balance::new(
        "Prepaid balance",
        -cents / 100. + 0.,
        Unit::Currency("USD".into()),
    );
    let spend = usage.and_then(|body| spend(body, today)).map(|spend| {
        let label = if spend.partial {
            "Last 30 days (partial)"
        } else {
            "Last 30 days"
        };
        Section::Facts {
            title: "Spend".into(),
            facts: vec![
                ("Today".into(), usd(spend.today)),
                (label.into(), usd(spend.total)),
            ],
        }
    });
    Ok(Report::new(
        Provider(&Xai),
        Account {
            email: None,
            plan: Some("Management API".into()),
        },
        Vec::new(),
    )
    .with_balances([balance])
    .with_sections(spend))
}

struct Spend {
    today: f64,
    total: f64,
    partial: bool,
}

/// None when the history is malformed, so it is left out rather than shown
/// as zero spend.
fn spend(body: &str, today: NaiveDate) -> Option<Spend> {
    let usage: Usage = json(body).ok()?;
    let mut spend = Spend {
        today: 0.,
        total: 0.,
        partial: usage.limit_reached.unwrap_or(false),
    };
    for series in usage.time_series? {
        for point in series.data_points? {
            let day = DateTime::parse_from_rfc3339(point.timestamp?.trim())
                .ok()?
                .with_timezone(&Utc)
                .date_naive();
            let value = *point.values?.first()?;
            if !value.is_finite() || value < 0. {
                return None;
            }
            spend.total += value;
            if day == today {
                spend.today += value;
            }
        }
    }
    Some(spend)
}

#[derive(Deserialize)]
struct Ledger {
    total: Option<Total>,
}

#[derive(Deserialize)]
struct Total {
    val: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    time_series: Option<Vec<Series>>,
    limit_reached: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Series {
    data_points: Option<Vec<Point>>,
}

#[derive(Deserialize)]
struct Point {
    timestamp: Option<String>,
    values: Option<Vec<f64>>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const USAGE: &str = r#"{
      "timeSeries": [
        {"dataPoints": [
          {"timestamp":"2027-01-13T00:00:00Z","values":[0.75973725]},
          {"timestamp":"2027-01-14T00:00:00Z","values":[0.5]},
          {"timestamp":"2027-01-15T00:00:00Z","values":[0]}
        ]},
        {"dataPoints": [
          {"timestamp":"2027-01-13T00:00:00Z","values":[0.5]},
          {"timestamp":"2027-01-14T00:00:00Z","values":[0]},
          {"timestamp":"2027-01-15T00:00:00Z","values":[0.25]}
        ]}
      ],
      "limitReached": false
    }"#;

    fn today() -> NaiveDate {
        NaiveDate::from_ymd_opt(2027, 1, 15).unwrap()
    }

    #[test]
    fn inverts_the_ledger_balance() {
        for (body, expected) in [
            (r#"{"total":{"val":"-1000"}}"#, 10.),
            (r#"{"total":{"val":"2500"}}"#, -25.),
            (r#"{"total":{"val":"-333"}}"#, 3.33),
            (r#"{"total":{"val":"0"}}"#, 0.),
        ] {
            let report = parse(body, None, today()).unwrap();
            assert!((report.balances[0].amount - expected).abs() < 1e-9);
            assert!(report.windows.is_empty());
            assert!(report.sections.is_empty());
        }
    }

    #[test]
    fn rejects_an_unparseable_balance() {
        assert!(parse(r#"{"total":{"val":"n/a"}}"#, None, today()).is_err());
        assert!(parse("{}", None, today()).is_err());
    }

    #[test]
    fn sums_daily_spend() {
        let report = parse(r#"{"total":{"val":"-1000"}}"#, Some(USAGE), today()).unwrap();
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0], ("Today".into(), "$0.25".into()));
        assert_eq!(facts[1], ("Last 30 days".into(), "$2.01".into()));
    }

    #[test]
    fn drops_malformed_history() {
        let body = r#"{"timeSeries":[{"dataPoints":[{"timestamp":"2027-01-15T00:00:00Z"}]}]}"#;
        let report = parse(r#"{"total":{"val":"0"}}"#, Some(body), today()).unwrap();
        assert!(report.sections.is_empty());
    }

    #[test]
    fn queries_thirty_utc_days() {
        let now = DateTime::parse_from_rfc3339("2027-01-15T12:34:56Z")
            .unwrap()
            .with_timezone(&Utc);
        let query: serde_json::Value = serde_json::from_str(&query(now)).unwrap();
        let range = &query["analyticsRequest"]["timeRange"];
        assert_eq!(range["startTime"], "2026-12-17 00:00:00");
        assert_eq!(range["endTime"], "2027-01-15 12:34:56");
    }
}
