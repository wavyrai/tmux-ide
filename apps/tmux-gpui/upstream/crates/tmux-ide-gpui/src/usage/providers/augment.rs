//! Augment Code credits for the billing cycle. As CodexBar does, the Auggie
//! CLI's own report (`auggie account status`) is read first when Auggie is
//! signed in on the host (`~/.augment/session.json` or
//! `AUGMENT_SESSION_AUTH`), then the app.augmentcode.com web session: the
//! `cookie` setting, else (when the provider is listed) the augmentcode.com
//! cookies from Chrome or Safari, sent to `/api/credits` and
//! `/api/subscription`.
//!
//! Not ported: CodexBar's session keepalive, which pings
//! `/api/auth/session` and re-imports browser cookies before they expire,
//! and its cached copy of the last working cookies. Here an expired cookie
//! shows as rejected until the browser session is refreshed.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Unit, Window, group},
        probe::{HostPath, Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json, number},
    },
};
use chrono::{NaiveDate, TimeZone};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const BASE: &str = "https://app.augmentcode.com";

pub(crate) struct Augment;

static META: Meta = Meta::new("augment", "Augment")
    .dashboard("https://app.augmentcode.com/account/subscription")
    .status_page("https://status.augmentcode.com")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Your app.augmentcode.com browser session, used when the Auggie CLI is not signed \
         in. Sign in at https://app.augmentcode.com, open Developer Tools → Application → \
         Cookies → https://app.augmentcode.com, and copy the session cookies (such as \
         `_session`, `session`, `web_rpc_proxy_session`, or `auth0`), pasted as one \
         header: \"name=value; name2=value2\".",
    )]);

impl Service for Augment {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cli = if probe.exists(&HostPath::home(".augment/session.json"))
            || probe.env("AUGMENT_SESSION_AUTH").is_some()
        {
            Some(
                probe
                    .command("auggie", &["account", "status"], Duration::from_secs(15))
                    .and_then(|output| parse_cli(&output.stdout)),
            )
        } else {
            None
        };
        let cli = match cli {
            Some(Ok(report)) => return Some(Ok(report)),
            other => other,
        };

        let Some(cookie) = probe.cookies(&["app.augmentcode.com", "augmentcode.com"], &[]) else {
            return cli;
        };
        let get = |path: &str| {
            Request::get(format!("{BASE}{path}"))
                .cookie(&cookie)
                .header("Accept", "application/json")
        };
        let credits = match probe.body(get("/api/credits")) {
            Ok(body) => body,
            Err(error) => return Some(Err(error)),
        };
        // The subscription only adds the plan, email, and cycle end.
        let subscription = probe.body(get("/api/subscription")).ok();
        Some(parse_web(&credits, subscription.as_deref()))
    }
}

pub(crate) fn parse_web(credits: &str, subscription: Option<&str>) -> Result<Report> {
    let credits: Credits = json(credits)?;
    let subscription =
        subscription.and_then(|body| serde_json::from_str::<Subscription>(body).ok());
    let limit = credits
        .usage_units_available
        .filter(|available| *available > 0.)
        .or_else(|| {
            Some(credits.usage_units_remaining? + credits.usage_units_consumed_this_billing_cycle?)
        });
    let usage = Usage {
        remaining: credits.usage_units_remaining,
        used: credits.usage_units_consumed_this_billing_cycle,
        limit,
        cycle_end: subscription
            .as_ref()
            .and_then(|subscription| subscription.billing_period_end.as_ref())
            .and_then(Timestamp::time),
        plan: subscription
            .as_ref()
            .and_then(|subscription| subscription.plan_name.clone()),
    };
    let email = subscription.and_then(|subscription| subscription.email);
    Ok(usage.report(email))
}

/// `auggie account status`, in the current layout or the one before 2026:
///
/// ```text
/// 319,054 credits remaining                     Max Plan
/// 450,000 credits / month
/// 9 days remaining in this billing cycle (ends 6/9/2026)
/// ```
///
/// ```text
/// Max Plan 450,000 credits / month
/// 11,657 remaining · 953,170 / 964,827 credits used
/// ```
pub(crate) fn parse_cli(output: &str) -> Result<Report> {
    let (mut monthly, mut remaining, mut used, mut total) = (None, None, None, None);
    let (mut cycle_end, mut plan) = (None, None);
    for line in output.lines().map(str::trim) {
        if line.contains("Authentication failed") || line.contains("auggie login") {
            return Err(Error::UsageRejected);
        }
        if line.contains("credits / month") {
            monthly = number_before(line, "credits / month");
            total = total.or(monthly);
        } else if line.contains("Max Plan")
            && line.contains("credits")
            && !line.contains("remaining")
        {
            monthly = number_before(line, "credits");
        }
        if plan.is_none() {
            plan = plan_name(line);
        }
        if line.contains("credits remaining") && !line.contains("billing cycle") {
            remaining = number_before(line, "credits remaining");
        }
        if line.contains("remaining") && line.contains("credits used") {
            remaining = number_before(line, "remaining").or(remaining);
            if let Some(at) = line.find("credits used") {
                let head = line[..at].trim_end();
                let limit = trailing_number(head);
                let spent = head
                    .trim_end_matches(|c: char| c.is_ascii_digit() || c == ',' || c == '.')
                    .trim_end()
                    .strip_suffix('/')
                    .and_then(|head| trailing_number(head.trim_end()));
                if let (Some(spent), Some(limit)) = (spent, limit) {
                    used = Some(spent);
                    total = Some(limit);
                }
            }
        }
        if line.contains("billing cycle")
            && let Some(at) = line.find("ends ")
        {
            let date: String = line[at + "ends ".len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '/')
                .collect();
            cycle_end = NaiveDate::parse_from_str(&date, "%m/%d/%Y")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .and_then(|midnight| chrono::Local.from_local_datetime(&midnight).earliest())
                .map(SystemTime::from);
        }
    }
    let remaining = remaining.ok_or(Error::UsageCommand("auggie account status"))?;
    let limit = total
        .or(monthly)
        .ok_or(Error::UsageCommand("auggie account status"))?;
    let usage = Usage {
        remaining: Some(remaining),
        used: Some(used.unwrap_or((limit - remaining).max(0.))),
        limit: Some(limit),
        cycle_end,
        plan: plan.or_else(|| {
            monthly.map(|monthly| format!("{} credits/month", group(monthly.round() as i64)))
        }),
    };
    Ok(usage.report(None))
}

struct Usage {
    remaining: Option<f64>,
    used: Option<f64>,
    limit: Option<f64>,
    cycle_end: Option<SystemTime>,
    plan: Option<String>,
}

impl Usage {
    fn report(self, email: Option<String>) -> Report {
        let percent = match (self.used, self.remaining, self.limit) {
            (Some(used), _, Some(limit)) if limit > 0. => used / limit * 100.,
            (None, Some(remaining), Some(limit)) if limit > 0. => {
                (limit - remaining) / limit * 100.
            }
            _ => 0.,
        };
        let window = Window::new(Kind::Monthly, percent, self.cycle_end, Some(MONTH));
        let balance = self.limit.map(|limit| {
            let remaining = self
                .remaining
                .unwrap_or_else(|| (limit - self.used.unwrap_or(0.)).max(0.));
            Balance::new("Credits left", remaining, Unit::Count("credits".into())).out_of(limit)
        });
        Report::new(
            Provider(&Augment),
            Account {
                email: email.filter(|email| !email.trim().is_empty()),
                plan: self.plan.filter(|plan| !plan.trim().is_empty()),
            },
            vec![window],
        )
        .with_balances(balance)
    }
}

/// `Max Plan` from a line naming the plan.
fn plan_name(line: &str) -> Option<String> {
    let words: Vec<&str> = line.split_whitespace().collect();
    let at = words.iter().position(|word| *word == "Plan")?;
    let name = words.get(at.checked_sub(1)?)?;
    name.chars()
        .all(char::is_alphabetic)
        .then(|| format!("{name} Plan"))
}

/// The number, commas allowed, right before `marker`.
fn number_before(line: &str, marker: &str) -> Option<f64> {
    trailing_number(line[..line.find(marker)?].trim_end())
}

fn trailing_number(text: &str) -> Option<f64> {
    let start = text
        .rfind(|c: char| !(c.is_ascii_digit() || c == ',' || c == '.'))
        .map_or(0, |at| {
            at + text[at..].chars().next().map_or(1, char::len_utf8)
        });
    let digits = text[start..].replace(',', "");
    digits.trim_matches('.').parse().ok()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credits {
    #[serde(default, deserialize_with = "number")]
    usage_units_remaining: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    usage_units_consumed_this_billing_cycle: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    usage_units_available: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    plan_name: Option<String>,
    billing_period_end: Option<Timestamp>,
    email: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_current_cli_report() {
        let output = "╭ Account ───────────────────────────────────────────────╮\n\
                      │                                                        │\n\
                      │ 319,054 credits remaining                     Max Plan │\n\
                      │                                450,000 credits / month │\n\
                      │                                                        │\n\
                      ╰────────────────────────────────────────────────────────╯\n\
                      \n\
                       9 days remaining in this billing cycle (ends 6/9/2026)\n\
                       For more detail, visit https://app.augmentcode.com/account\n";
        let report = parse_cli(output).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Max Plan"));
        assert_eq!(
            report.balances,
            vec![
                Balance::new("Credits left", 319_054., Unit::Count("credits".into()))
                    .out_of(450_000.)
            ]
        );
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert_eq!(window.percent(), 29);
        let end = chrono::DateTime::<chrono::Local>::from(window.resets_at.unwrap()).date_naive();
        assert_eq!(end, NaiveDate::from_ymd_opt(2026, 6, 9).unwrap());
    }

    #[test]
    fn reads_the_legacy_cli_report() {
        let output = "Max Plan 450,000 credits / month\n\
                      11,657 remaining · 953,170 / 964,827 credits used\n\
                      2 days remaining in this billing cycle (ends 1/8/2026)\n";
        let report = parse_cli(output).unwrap();
        assert_eq!(
            report.balances,
            vec![
                Balance::new("Credits left", 11_657., Unit::Count("credits".into()))
                    .out_of(964_827.)
            ]
        );
        assert_eq!(report.windows[0].percent(), 99);
    }

    #[test]
    fn a_signed_out_cli_is_rejected() {
        assert!(matches!(
            parse_cli("Authentication failed. Run auggie login."),
            Err(Error::UsageRejected)
        ));
        assert!(matches!(parse_cli(""), Err(Error::UsageCommand(_))));
    }

    #[test]
    fn reads_the_web_credits_and_subscription() {
        let credits = r#"{"usageUnitsRemaining":15,"usageUnitsConsumedThisBillingCycle":10,
            "usageUnitsAvailable":100,"usageBalanceStatus":"ok"}"#;
        let subscription = r#"{"planName":"Developer","billingPeriodEnd":"2026-07-01T00:00:00Z",
            "email":"dev@example.com","organization":null}"#;
        let report = parse_web(credits, Some(subscription)).unwrap();
        assert_eq!(report.account.email.as_deref(), Some("dev@example.com"));
        assert_eq!(report.account.plan.as_deref(), Some("Developer"));
        assert_eq!(report.windows[0].percent(), 10);
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_782_864_000))
        );
        assert_eq!(
            report.balances,
            vec![Balance::new("Credits left", 15., Unit::Count("credits".into())).out_of(100.)]
        );
    }

    #[test]
    fn a_zero_allowance_falls_back_to_remaining_plus_used() {
        let credits = r#"{"usageUnitsRemaining":15,"usageUnitsConsumedThisBillingCycle":10,
            "usageUnitsAvailable":0}"#;
        let report = parse_web(credits, None).unwrap();
        assert_eq!(report.windows[0].percent(), 40);
        assert_eq!(report.balances[0].total, Some(25.));
    }
}
