//! Grok (SuperGrok) credit usage from the Grok CLI's billing proxy, signed in
//! with the Grok CLI's own login in `$GROK_HOME/auth.json` (written by
//! `grok login`), else a pasted bearer in the `token` setting or
//! `GROK_OAUTH_TOKEN`. The billed plan comes from the proxy's settings.
//!
//! Not ported from CodexBar: the `grok agent stdio` JSON-RPC billing call
//! (unavailable in current CLIs anyway), the grok.com gRPC-web billing and
//! reset-coupon endpoints with browser cookies (gRPC-web, and grok.com now
//! wants a browser-held key pair), and the local session token history.
//! auth.json keys its entries by OIDC scope; the probe reads fixed JSON
//! paths, so only the Grok CLI's published client id and the legacy
//! sign-in scope are recognized.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, Section, WEEK, Window},
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const CREDITS: &str = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const SETTINGS_URL: &str = "https://cli-chat-proxy.grok.com/v1/settings";
/// auth.json entries in CodexBar's order of preference.
const SCOPES: &[&str] = &[
    "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828",
    "https://accounts.x.ai/sign-in",
];

pub(crate) struct Grok;

static META: Meta = Meta::new("grok", "Grok")
    .dashboard("https://grok.com/?_s=usage")
    .status_page("https://status.x.ai")
    .settings(&[Setting::new(
        "token",
        &["GROK_OAUTH_TOKEN"],
        "A SuperGrok bearer token, only needed when the Grok CLI is not signed in on the \
         selected host (run `grok login` there instead when you can). It is the \"key\" of \
         the https://auth.x.ai entry in ~/.grok/auth.json. xai- API keys do not work.",
    )]);

impl Service for Grok {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let path = HostPath::env_or("GROK_HOME", ".grok", "auth.json");
        let mut expired = false;
        if let Some(auth) = probe.file(&path) {
            for &scope in SCOPES {
                let Some(token) = probe.field(&auth, &[scope, "key"]) else {
                    continue;
                };
                let expires = probe
                    .text(&auth, &[scope, "expires_at"])
                    .and_then(|at| Timestamp::Text(at).time());
                if expires.is_some_and(|at| at <= SystemTime::now()) {
                    expired = true;
                    continue;
                }
                let account = Account {
                    email: probe.text(&auth, &[scope, "email"]),
                    plan: probe
                        .text(&auth, &[scope, "auth_mode"])
                        .and_then(|mode| login_plan(&mode)),
                };
                return Some(fetch(probe, &token, account));
            }
        }
        match probe
            .setting("token")
            .or_else(|| probe.env("GROK_OAUTH_TOKEN"))
        {
            Some(token) => Some(fetch(probe, &token, Account::default())),
            // `grok login` expires after about a week; say so rather than hide Grok.
            None => expired.then_some(Err(Error::UsageRejected)),
        }
    }
}

fn fetch(probe: &mut Probe, token: &Secret, account: Account) -> Result<Report> {
    let get = |url: &str| {
        Request::get(url)
            .bearer(token)
            .header("x-xai-token-auth", "xai-grok-cli")
            .header("Accept", "application/json")
            .header("User-Agent", "herdr-gpui")
    };
    let body = probe.body(get(CREDITS))?;
    // The billed tier is decoration: usage still shows when this fails.
    let tier = probe
        .http(get(SETTINGS_URL).timeout(Duration::from_secs(5)))
        .and_then(|response| response.json::<CliSettings>())
        .ok()
        .and_then(|settings| settings.subscription_tier_display);
    parse(&body, tier.as_deref(), account, SystemTime::now())
}

/// `oidc` is a SuperGrok sign-in; other modes are shown as named.
fn login_plan(mode: &str) -> Option<String> {
    match mode.trim().to_ascii_lowercase().as_str() {
        "" => None,
        "oidc" => Some("SuperGrok".into()),
        _ => Some(mode.trim().to_owned()),
    }
}

fn plan_name(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    let compact: String = trimmed
        .chars()
        .filter(char::is_ascii_alphabetic)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    match compact.as_str() {
        "" => None,
        "supergrokheavy" | "heavy" => Some("SuperGrok Heavy".into()),
        "supergrok" => Some("SuperGrok".into()),
        _ => Some(trimmed.to_owned()),
    }
}

pub(crate) fn parse(
    body: &str,
    tier: Option<&str>,
    mut account: Account,
    now: SystemTime,
) -> Result<Report> {
    let credits: Credits = json(body)?;
    let config = credits.config.ok_or_else(invalid)?;
    if let Some(plan) = tier
        .or(config.subscription_tier.as_deref())
        .or(credits.subscription_tier.as_deref())
        .and_then(plan_name)
    {
        account.plan = Some(plan);
    }
    let time = |text: &Option<String>| text.clone().and_then(|text| Timestamp::Text(text).time());
    let period_end = config
        .current_period
        .as_ref()
        .and_then(|period| time(&period.end));
    // The start must belong to the same period as the end.
    let (start, end) = match period_end {
        Some(end) => (
            config
                .current_period
                .as_ref()
                .and_then(|period| time(&period.start)),
            Some(end),
        ),
        None => (
            time(&config.billing_period_start),
            time(&config.billing_period_end),
        ),
    };
    let length = start.zip(end).and_then(|(start, end)| {
        let length = end.duration_since(start).ok()?;
        (start <= now && length >= Duration::from_secs(60)).then_some(length)
    });
    let percent = config
        .credit_usage_percent
        .filter(|percent| percent.is_finite())
        .or_else(|| {
            let cap = config.on_demand_cap.as_ref()?.val.filter(|cap| *cap > 0.)?;
            let used = config.on_demand_used.as_ref()?.val?;
            Some(used / cap * 100.)
        });
    let windows = match (percent, end) {
        (Some(percent), _) => vec![Window::new(kind(length), percent, end, length)],
        // A period without a percentage is unknown usage, not zero.
        (None, Some(_)) => Vec::new(),
        (None, None) => return Err(invalid()),
    };
    let unknown = windows.is_empty().then(|| Section::Facts {
        title: "Credits".into(),
        facts: vec![("Usage".into(), "Unavailable".into())],
    });
    Ok(Report::new(Provider(&Grok), account, windows).with_sections(unknown))
}

/// Grok bills weekly or monthly; the measured period decides which.
fn kind(length: Option<Duration>) -> Kind {
    const SLACK: Duration = Duration::from_secs(2 * 3600);
    match length {
        Some(length) if length.abs_diff(WEEK) <= SLACK => Kind::Weekly,
        Some(length)
            if (Duration::from_secs(28 * 86_400)..=Duration::from_secs(31 * 86_400) + SLACK)
                .contains(&length)
                || length.abs_diff(MONTH) <= SLACK =>
        {
            Kind::Monthly
        }
        _ => Kind::Named("Credits".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credits {
    config: Option<Config>,
    subscription_tier: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    credit_usage_percent: Option<f64>,
    current_period: Option<Period>,
    billing_period_start: Option<String>,
    billing_period_end: Option<String>,
    on_demand_cap: Option<Cents>,
    on_demand_used: Option<Cents>,
    subscription_tier: Option<String>,
}

#[derive(Deserialize)]
struct Period {
    start: Option<String>,
    end: Option<String>,
}

#[derive(Deserialize)]
struct Cents {
    val: Option<f64>,
}

#[derive(Deserialize)]
struct CliSettings {
    subscription_tier_display: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn at(text: &str) -> SystemTime {
        Timestamp::Text(text.into()).time().unwrap()
    }

    #[test]
    fn parses_weekly_credits() {
        let body = r#"{
          "config": {
            "creditUsagePercent": 12.5,
            "currentPeriod": {
              "type": "USAGE_PERIOD_TYPE_WEEKLY",
              "start": "2026-08-06T00:00:00Z",
              "end": "2026-08-13T00:00:00Z"
            },
            "billingPeriodEnd": "2026-08-13T00:00:00Z",
            "onDemandCap": { "val": 1000 },
            "onDemandUsed": { "val": 250 }
          }
        }"#;
        let account = Account {
            email: Some("user@example.com".into()),
            plan: login_plan("oidc"),
        };
        let report = parse(
            body,
            Some("SuperGrok Heavy"),
            account,
            at("2026-08-12T00:00:00Z"),
        )
        .unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Weekly);
        assert_eq!(report.windows[0].used, 12.5);
        assert_eq!(report.windows[0].length, Some(WEEK));
        assert_eq!(
            report.windows[0].resets_at,
            Some(at("2026-08-13T00:00:00Z"))
        );
        assert_eq!(report.account.plan.as_deref(), Some("SuperGrok Heavy"));
        assert_eq!(report.account.email.as_deref(), Some("user@example.com"));
    }

    #[test]
    fn falls_back_to_on_demand_ratio_and_billing_period() {
        let body = r#"{"config":{
            "billingPeriodStart":"2026-07-13T00:00:00Z",
            "billingPeriodEnd":"2026-08-13T00:00:00Z",
            "onDemandCap":{"val":1000},"onDemandUsed":{"val":250}}}"#;
        let report = parse(body, None, Account::default(), at("2026-08-12T00:00:00Z")).unwrap();
        assert_eq!(report.windows[0].percent(), 25);
        assert_eq!(report.windows[0].kind, Kind::Monthly);
    }

    #[test]
    fn period_without_percent_is_unknown() {
        let body = r#"{"config":{"currentPeriod":{"start":"2026-08-06T00:00:00Z",
            "end":"2026-08-13T00:00:00Z"}}}"#;
        let report = parse(body, None, Account::default(), at("2026-08-12T00:00:00Z")).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.sections.len(), 1);
    }

    #[test]
    fn future_start_leaves_length_unknown() {
        let body = r#"{"config":{"creditUsagePercent":90,
            "currentPeriod":{"start":"2026-08-14T00:00:00Z","end":"2026-08-21T00:00:00Z"}}}"#;
        let report = parse(body, None, Account::default(), at("2026-08-12T00:00:00Z")).unwrap();
        assert_eq!(report.windows[0].length, None);
        assert_eq!(report.windows[0].kind, Kind::Named("Credits".into()));
    }

    #[test]
    fn empty_answer_fails() {
        assert!(parse("{}", None, Account::default(), SystemTime::now()).is_err());
        assert!(
            parse(
                r#"{"config":{}}"#,
                None,
                Account::default(),
                SystemTime::now()
            )
            .is_err()
        );
    }

    #[test]
    fn names_plans() {
        assert_eq!(
            plan_name("super_grok_heavy").as_deref(),
            Some("SuperGrok Heavy")
        );
        assert_eq!(plan_name("SuperGrok").as_deref(), Some("SuperGrok"));
        assert_eq!(login_plan("session").as_deref(), Some("session"));
    }
}
