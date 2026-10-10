//! Zed plan and edit-prediction usage. Two sign-ins are read, in CodexBar's
//! order:
//!
//! - The editor's own GitHub sign-in on a Mac, sent to
//!   `cloud.zed.dev/client/users/me` as `Authorization: <user id> <token>`.
//!   The server comes from `server_url` / `credentials_url` in
//!   `~/.config/zed/settings.json`, as Zed itself reads them.
//! - A zed.dev browser session (the `cookie` setting, or Chrome/Safari when
//!   Zed is listed in `show_providers`), sent to
//!   `cloud.zed.dev/frontend/billing/usage`, which adds token spend and its
//!   spending limit.
//!
//! The editor token is a keychain *internet* password whose server is the
//! credentials URL and whose account is the Zed user id, as Zed stores it;
//! the generic-password layout CodexBar falls back to is tried next. The
//! item belongs to Zed, so reading it makes macOS ask; it is only read when
//! Zed is listed in `show_providers` and the user pressed Allow in its panel.
//!
//! Not ported: the Linux editor sign-in lives in the Secret Service, which
//! the probe cannot read.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, title_case},
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{invalid, usd},
    },
};
use serde::Deserialize;
use serde_json::Value;
use std::time::{Duration, SystemTime};

const SERVER: &str = "https://zed.dev";
const CLOUD: &str = "https://cloud.zed.dev";
const BILLING: &str = "https://cloud.zed.dev/frontend/billing/usage";

pub(crate) struct Zed;

static META: Meta = Meta::new("zed", "Zed")
    .dashboard("https://zed.dev/account")
    .status_page("https://status.zed.dev")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "The zed.dev browser session, for token spend. Sign in at https://zed.dev in your \
         browser (signing in inside the editor is not enough), open Developer Tools → \
         Application → Cookies → https://zed.dev, copy the zed.session cookie, and paste it \
         as \"zed.session=value\".",
    )]);

impl Service for Zed {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        if let Some(report) = editor(probe) {
            return Some(report);
        }
        let cookie = probe.cookies(&["zed.dev"], &["zed.session"])?;
        let request = Request::get(BILLING)
            .cookie(&cookie)
            .header("Accept", "application/json");
        Some(probe.body(request).and_then(|body| parse_billing(&body)))
    }
}

/// The editor sign-in, when the host is a Mac that holds one.
fn editor(probe: &mut Probe) -> Option<Result<Report>> {
    if !probe.is_macos() {
        return None;
    }
    let settings = HostPath::home(".config/zed/settings.json");
    let server = probe
        .file_text(&settings, &["server_url"])
        .filter(|server| !server.is_empty())
        .unwrap_or_else(|| SERVER.to_owned());
    let service = probe
        .file_text(&settings, &["credentials_url"])
        .filter(|credentials| !credentials.is_empty())
        .unwrap_or_else(|| server.clone());
    let api = cloud_url(&server, &service)?;
    let (user, token) = [Class::Internet, Class::Generic]
        .into_iter()
        .find_map(|class| credentials(probe, class, &service))?;
    let request = Request::get(api)
        .secret_header("Authorization", &format!("{user} "), &token)
        .header("Accept", "application/json");
    Some(probe.body(request).and_then(|body| parse_editor(&body)))
}

/// The keychain item classes Zed's sign-in may be kept under, in the
/// order CodexBar looks.
#[derive(Clone, Copy)]
enum Class {
    Internet,
    Generic,
}

impl Class {
    fn find(self) -> &'static str {
        match self {
            Self::Internet => "find-internet-password",
            Self::Generic => "find-generic-password",
        }
    }
}

/// The user id and token of the sign-in kept under `service`. The attribute
/// listing is brought back without `-w`, so it carries no password.
fn credentials(probe: &mut Probe, class: Class, service: &str) -> Option<(String, Secret)> {
    let listing = probe
        .command(
            "/usr/bin/security",
            &[class.find(), "-s", service],
            Duration::from_secs(10),
        )
        .ok()
        .filter(|output| output.success)?;
    let user = account(&listing.stdout)?;
    let token = match class {
        Class::Internet => probe.foreign_keychain_internet(service, Some(user.as_str())),
        Class::Generic => probe.foreign_keychain(service, Some(user.as_str())),
    }?;
    Some((user, token))
}

/// Zed's own servers answer at cloud.zed.dev; a custom server must be HTTPS
/// and keep its credentials under its own URL, so a settings change cannot
/// send a token to another host.
fn cloud_url(server: &str, service: &str) -> Option<String> {
    let base = match server {
        "https://zed.dev" | "https://staging.zed.dev" => CLOUD.to_owned(),
        custom if custom.starts_with("https://") && service == custom => {
            custom.trim_end_matches('/').to_owned()
        }
        _ => return None,
    };
    Some(format!("{base}/client/users/me"))
}

/// The account attribute of a `security find-*-password` listing,
/// which holds the Zed user id. The listing carries no password.
fn account(listing: &str) -> Option<String> {
    listing.lines().find_map(|line| {
        let value = line.trim().strip_prefix("\"acct\"<blob>=\"")?;
        let value = value.strip_suffix('"')?;
        (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
            .then(|| value.to_owned())
    })
}

/// `zed_pro_trial` as `Zed Pro Trial`.
fn plan_name(plan: &str) -> Option<String> {
    let name = plan
        .split('_')
        .filter(|word| !word.is_empty())
        .map(|word| title_case(&word.to_lowercase()))
        .collect::<Vec<_>>()
        .join(" ");
    (!name.is_empty()).then_some(name)
}

/// `null` means unlimited only in the billing answer.
enum Predictions {
    Unlimited,
    Limited(u64),
}

fn predictions_limit(limit: &Value, null_is_unlimited: bool) -> Result<Predictions> {
    match limit {
        Value::String(text) if text == "unlimited" => Ok(Predictions::Unlimited),
        Value::Null if null_is_unlimited => Ok(Predictions::Unlimited),
        Value::Number(number) => number
            .as_u64()
            .map(Predictions::Limited)
            .ok_or_else(invalid),
        Value::Object(object) => object
            .get("limited")
            .and_then(Value::as_u64)
            .map(Predictions::Limited)
            .ok_or_else(invalid),
        _ => Err(invalid()),
    }
}

/// Edit predictions renew with the billing period; the window carries the
/// period's end and length when the service reports them.
fn predictions(
    usage: &EditPredictions,
    null_is_unlimited: bool,
    period: Option<(SystemTime, Duration)>,
) -> Result<(Option<Window>, (String, String))> {
    Ok(match predictions_limit(&usage.limit, null_is_unlimited)? {
        Predictions::Unlimited => (
            None,
            (
                "Edit predictions".into(),
                format!("{} used · Unlimited", usage.used),
            ),
        ),
        Predictions::Limited(limit) => (
            (limit > 0).then(|| {
                Window::new(
                    Kind::Monthly,
                    usage.used as f64 / limit as f64 * 100.,
                    period.map(|(end, _)| end),
                    period.map(|(_, length)| length),
                )
            }),
            (
                "Edit predictions".into(),
                format!("{} of {limit}", usage.used.min(limit)),
            ),
        ),
    })
}

pub(crate) fn parse_editor(body: &str) -> Result<Report> {
    let me: Me = json(body)?;
    let period = me.plan.subscription_period.as_ref().and_then(|period| {
        let start = period.started_at.time()?;
        let end = period.ended_at.time()?;
        Some((end, end.duration_since(start).ok()?))
    });
    let (window, prediction) = predictions(&me.plan.usage.edit_predictions, false, period)?;
    let mut facts = vec![prediction];
    if me.plan.has_overdue_invoices {
        facts.push(("Billing".into(), "Overdue invoices".into()));
    }
    let account = Account {
        email: Some(me.user.github_login.trim().to_owned()).filter(|login| !login.is_empty()),
        plan: plan_name(&me.plan.plan_v3),
    };
    Ok(
        Report::new(Provider(&Zed), account, window.into_iter().collect()).with_sections([
            Section::Facts {
                title: "Plan".into(),
                facts,
            },
        ]),
    )
}

pub(crate) fn parse_billing(body: &str) -> Result<Report> {
    let billing: Billing = json(body)?;
    let (window, prediction) = predictions(&billing.current_usage.edit_predictions, true, None)?;
    let spend = &billing.current_usage.token_spend;
    let spent = spend.spend_in_cents / 100.;
    let cap = spend.limit_in_cents.map(|cents| cents / 100.);
    let balance = Balance::new("Token spend", spent, Unit::Currency("USD".into()));
    let mut facts = vec![
        prediction,
        ("Spent".into(), usd(spent)),
        (
            "Spend limit".into(),
            cap.map_or_else(|| "Not reported".into(), usd),
        ),
    ];
    if let Some(cap) = cap {
        facts.push(("Remaining budget".into(), usd(cap - spent)));
    }
    Ok(Report::new(
        Provider(&Zed),
        Account {
            email: None,
            plan: plan_name(&billing.plan),
        },
        window.into_iter().collect(),
    )
    .with_balances([match cap {
        Some(cap) => balance.out_of(cap),
        None => balance,
    }])
    .with_sections([Section::Facts {
        title: "Current billing period".into(),
        facts,
    }]))
}

#[derive(Deserialize)]
struct Me {
    user: User,
    plan: Plan,
}

#[derive(Deserialize)]
struct User {
    github_login: String,
}

#[derive(Deserialize)]
struct Plan {
    plan_v3: String,
    subscription_period: Option<Period>,
    usage: Usage,
    has_overdue_invoices: bool,
}

#[derive(Deserialize)]
struct Period {
    started_at: Timestamp,
    ended_at: Timestamp,
}

#[derive(Deserialize)]
struct Usage {
    edit_predictions: EditPredictions,
}

#[derive(Deserialize)]
struct EditPredictions {
    used: u64,
    #[serde(default)]
    limit: Value,
}

#[derive(Deserialize)]
struct Billing {
    plan: String,
    current_usage: BillingUsage,
}

#[derive(Deserialize)]
struct BillingUsage {
    token_spend: TokenSpend,
    edit_predictions: EditPredictions,
}

#[derive(Deserialize)]
struct TokenSpend {
    spend_in_cents: f64,
    limit_in_cents: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    /// CodexBar's editor fixture.
    fn editor_fixture(limit: &str) -> String {
        format!(
            r#"{{
              "user": {{"id": 4242, "github_login": "octocat", "name": "The Octocat"}},
              "feature_flags": [],
              "plan": {{
                "plan_v3": "zed_pro",
                "subscription_period": {{
                  "started_at": "2026-05-13T00:00:00.000Z",
                  "ended_at": "2026-06-13T00:00:00.000Z"
                }},
                "usage": {{"edit_predictions": {{"used": 30, "limit": {limit}}}}},
                "has_overdue_invoices": true
              }}
            }}"#
        )
    }

    /// CodexBar's browser billing fixture.
    const BILLING_BODY: &str = r#"{"plan":"zed_pro","current_usage":{
      "token_spend":{"spend_in_cents":250,"limit_in_cents":1000},
      "edit_predictions":{"used":12,"limit":100}}}"#;

    #[test]
    fn reads_the_editor_plan_and_billing_period() {
        let report = parse_editor(&editor_fixture("{\"limited\": 120}")).unwrap();
        assert_eq!(report.provider.id(), "zed");
        assert_eq!(report.account.email.as_deref(), Some("octocat"));
        assert_eq!(report.account.plan.as_deref(), Some("Zed Pro"));
        let window = &report.windows[0];
        assert_eq!(window.percent(), 25);
        assert_eq!(window.length, Some(Duration::from_secs(31 * 86_400)));
        assert!(window.resets_at.is_some());
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(
            facts[0],
            ("Edit predictions".to_owned(), "30 of 120".to_owned())
        );
        assert_eq!(
            facts[1],
            ("Billing".to_owned(), "Overdue invoices".to_owned())
        );
    }

    #[test]
    fn unlimited_predictions_have_no_window() {
        let report = parse_editor(&editor_fixture("\"unlimited\"")).unwrap();
        assert!(report.windows.is_empty());
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0].1, "30 used · Unlimited");
    }

    #[test]
    fn an_editor_null_limit_is_malformed() {
        assert!(parse_editor(&editor_fixture("null")).is_err());
    }

    #[test]
    fn reads_browser_billing() {
        let report = parse_billing(BILLING_BODY).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Zed Pro"));
        assert_eq!(report.windows[0].percent(), 12);
        let balance = &report.balances[0];
        assert_eq!(balance.text(), "$2.50 of $10.00");
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert!(facts.contains(&("Remaining budget".to_owned(), "$7.50".to_owned())));
    }

    #[test]
    fn finds_the_user_id_in_a_keychain_listing() {
        let listing = "keychain: \"/Users/me/Library/Keychains/login.keychain-db\"\n\
                       class: \"genp\"\nattributes:\n    \
                       0x00000007 <blob>=\"https://zed.dev\"\n    \
                       \"acct\"<blob>=\"4242\"\n    \"svce\"<blob>=\"https://zed.dev\"\n";
        assert_eq!(account(listing).as_deref(), Some("4242"));
        assert_eq!(account("\"acct\"<blob>=<NULL>"), None);
    }

    #[test]
    fn finds_the_user_id_in_an_internet_password_listing() {
        let listing = "keychain: \"/Users/me/Library/Keychains/login.keychain-db\"\n\
                       class: \"inet\"\nattributes:\n    \
                       \"acct\"<blob>=\"4242\"\n    \"atyp\"<blob>=\"dflt\"\n    \
                       \"ptcl\"<uint32>=\"htps\"\n    \"srvr\"<blob>=\"https://zed.dev\"\n";
        assert_eq!(account(listing).as_deref(), Some("4242"));
    }

    #[test]
    fn custom_servers_keep_their_credentials() {
        assert_eq!(
            cloud_url(SERVER, SERVER).as_deref(),
            Some("https://cloud.zed.dev/client/users/me")
        );
        assert_eq!(
            cloud_url("https://zed.example", "https://zed.example").as_deref(),
            Some("https://zed.example/client/users/me")
        );
        assert_eq!(cloud_url("https://zed.example", SERVER), None);
        assert_eq!(cloud_url("http://zed.example", "http://zed.example"), None);
    }
}
