//! Codebuff credits and weekly rate limit. The sign-in is, in CodexBar's
//! order, an API key (`api_key`, or `CODEBUFF_API_KEY` here), else the
//! session the `codebuff` CLI (formerly `manicode`) keeps in
//! `~/.config/manicode/credentials.json` on the probed host, else
//! `CODEBUFF_API_KEY` there. As in CodexBar, an API key reads the credit
//! balance only; the CLI session also reads the plan and the weekly limit.
//! Everything CodexBar reads is ported.

use crate::{
    Result,
    usage::{
        model::{
            Account, Balance, Kind, Provider, Report, Section, Unit, WEEK, Window, title_case,
        },
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values,
    },
};
use serde_json::Value;

const BASE_URL: &str = "https://www.codebuff.com";

pub(crate) struct Codebuff;

static META: Meta = Meta::new("codebuff", "Codebuff")
    .dashboard("https://www.codebuff.com/usage")
    .settings(&[
        Setting::new(
            "api_key",
            &["CODEBUFF_API_KEY"],
            "A Codebuff API key from https://www.codebuff.com. It reads the credit balance \
             only; without it, the session from `codebuff login` is used, which also reads \
             the plan and weekly limit.",
        ),
        Setting::new(
            "base_url",
            &["CODEBUFF_API_URL"],
            "An https URL that replaces https://www.codebuff.com, e.g. for a staging server. \
             Other schemes are ignored so the token never travels unencrypted.",
        ),
    ]);

impl Service for Codebuff {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        // A token is never sent to a plain http override.
        let base = probe
            .text_setting("base_url")
            .filter(|url| url.starts_with("https://"))
            .map(|url| url.trim_end_matches('/').to_owned())
            .unwrap_or_else(|| BASE_URL.to_owned());
        if let Some(key) = probe.setting("api_key") {
            return Some(read(probe, &base, &key, None));
        }
        let credentials = HostPath::home(".config/manicode/credentials.json");
        if let Some(file) = probe.file(&credentials) {
            let token = probe
                .field(&file, &["default", "authToken"])
                .or_else(|| probe.field(&file, &["authToken"]));
            if let Some(token) = token {
                let email = probe.text(&file, &["default", "email"]);
                return Some(read(probe, &base, &token, Some(email)));
            }
        }
        let key = probe.env("CODEBUFF_API_KEY")?;
        Some(read(probe, &base, &key, None))
    }
}

/// `session` is the CLI sign-in's email when the token is a CLI session,
/// which alone may read the subscription.
fn read(
    probe: &mut Probe,
    base: &str,
    token: &Secret,
    session: Option<Option<String>>,
) -> Result<Report> {
    let usage = Request::post(format!("{base}/api/v1/usage"))
        .bearer(token)
        .header("Accept", "application/json")
        .json(r#"{"fingerprintId":"codexbar-usage"}"#);
    let usage = probe.body(usage)?;
    let Some(email) = session else {
        return parse(&usage, None, None);
    };
    let subscription = Request::get(format!("{base}/api/user/subscription"))
        .bearer(token)
        .header("Accept", "application/json");
    // The subscription only adds the plan and weekly limit; the credits
    // stand without it.
    let subscription = probe.body(subscription).ok();
    parse(&usage, subscription.as_deref(), email)
}

pub(crate) fn parse(
    usage: &str,
    subscription: Option<&str>,
    email: Option<String>,
) -> Result<Report> {
    let usage: Value = json(usage)?;
    if !usage.is_object() {
        return Err(values::invalid());
    }
    let used = amount(&usage, &["usage", "used"]);
    let quota = amount(&usage, &["quota", "limit"]);
    let remaining = amount(&usage, &["remainingBalance", "remaining"]);
    let resets_at = time(usage.get("next_quota_reset"));
    let total = quota
        .map(|quota| quota.max(0.))
        .or_else(|| Some((used? + remaining?).max(0.)));
    let spent = used
        .map(|used| used.max(0.))
        .or_else(|| Some((total? - remaining?).max(0.)))
        .unwrap_or(0.);
    let mut windows = Vec::new();
    match total {
        Some(total) if total > 0. => windows.push(Window::new(
            Kind::Named("Credits".into()),
            spent / total * 100.,
            resets_at,
            None,
        )),
        // No usable quota: shown as spent rather than as a healthy bar.
        _ if used.is_some() || remaining.is_some() => windows.push(Window::new(
            Kind::Named("Credits".into()),
            100.,
            resets_at,
            None,
        )),
        _ => {}
    }
    let balances =
        remaining.map(|left| Balance::new("Remaining", left, Unit::Count("credits".into())));
    let auto_top_up = ["autoTopupEnabled", "auto_topup_enabled"]
        .iter()
        .find_map(|key| usage.get(*key).and_then(Value::as_bool));

    let subscription: Option<Value> = subscription.and_then(|body| json(body).ok());
    let root = subscription.as_ref();
    let plan = root.and_then(|root| {
        let details = root.get("subscription");
        [
            details.and_then(|details| details.get("displayName")),
            root.get("displayName"),
            details.and_then(|details| details.get("tier")),
            root.get("tier"),
            details.and_then(|details| details.get("scheduledTier")),
        ]
        .into_iter()
        .flatten()
        .find_map(text)
    });
    let email = root
        .and_then(|root| {
            root.get("email")
                .or_else(|| root.get("user").and_then(|user| user.get("email")))
                .and_then(text)
        })
        .or(email.filter(|email| !email.trim().is_empty()));
    if let Some(limits) = root.and_then(|root| root.get("rateLimit")) {
        let limit = amount(limits, &["weeklyLimit", "limit"]).filter(|limit| *limit > 0.);
        if let Some(limit) = limit {
            let used = amount(limits, &["weeklyUsed", "used"])
                .unwrap_or(0.)
                .max(0.);
            windows.push(Window::new(
                Kind::Weekly,
                used / limit * 100.,
                time(limits.get("weeklyResetsAt")),
                Some(WEEK),
            ));
        }
    }
    let mut facts = Vec::new();
    if let Some(status) = root
        .and_then(|root| root.get("subscription"))
        .and_then(|details| details.get("status"))
        .and_then(text)
    {
        facts.push(("Subscription".to_owned(), title_case(&status)));
    }
    if let Some(enabled) = auto_top_up {
        facts.push((
            "Auto top-up".to_owned(),
            if enabled { "On" } else { "Off" }.to_owned(),
        ));
    }
    let section = (!facts.is_empty()).then(|| Section::Facts {
        title: "Account".into(),
        facts,
    });
    let account = Account {
        email,
        plan: plan.map(|plan| title_case(&plan)),
    };
    Ok(Report::new(Provider(&Codebuff), account, windows)
        .with_balances(balances)
        .with_sections(section))
}

/// The first of `keys` holding a finite number, sent as a number or a string.
fn amount(value: &Value, keys: &[&str]) -> Option<f64> {
    keys.iter().find_map(|key| values::number(value.get(*key)?))
}

fn text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(text) => text.trim().to_owned(),
        Value::Number(number) => number.to_string(),
        _ => return None,
    };
    (!text.is_empty()).then_some(text)
}

fn time(value: Option<&Value>) -> Option<std::time::SystemTime> {
    match value? {
        Value::Number(number) => Timestamp::Number(number.as_f64()?).time(),
        Value::String(text) => Timestamp::Text(text.clone()).time(),
        _ => None,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    #[test]
    fn api_key_reads_credits_only() {
        let report = parse(
            r#"{"usage":25,"quota":100,"remainingBalance":75}"#,
            None,
            None,
        )
        .unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Named("Credits".into()));
        assert!((report.windows[0].used - 25.).abs() < 1e-4);
        assert_eq!(
            report.balances,
            vec![Balance::new(
                "Remaining",
                75.,
                Unit::Count("credits".into())
            )]
        );
        assert_eq!(report.account, Account::default());
    }

    #[test]
    fn session_reads_plan_and_weekly_limit() {
        let usage = r#"{"used":"400","remaining":"600","next_quota_reset":"2026-10-01T00:00:00Z",
            "autoTopupEnabled":true}"#;
        let subscription = r#"{
            "subscription": {"displayName": "pro", "status": "active",
                             "billingPeriodEnd": "2026-10-01T00:00:00Z"},
            "rateLimit": {"weeklyUsed": 30, "weeklyLimit": 120, "weeklyResetsAt": 1790000000000},
            "email": "dev@example.com"
        }"#;
        let report = parse(usage, Some(subscription), Some("cli@example.com".into())).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        assert_eq!(report.account.email.as_deref(), Some("dev@example.com"));
        let credits = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Named("Credits".into()))
            .unwrap();
        assert!((credits.used - 40.).abs() < 1e-4);
        assert!(credits.resets_at.is_some());
        let weekly = report
            .windows
            .iter()
            .find(|window| window.kind == Kind::Weekly)
            .unwrap();
        assert!((weekly.used - 25.).abs() < 1e-4);
        assert_eq!(weekly.length, Some(WEEK));
        assert!(weekly.resets_at.is_some());
        let Some(Section::Facts { facts, .. }) = report.sections.first() else {
            panic!("expected account facts");
        };
        assert_eq!(facts[0], ("Subscription".to_owned(), "Active".to_owned()));
        assert_eq!(facts[1], ("Auto top-up".to_owned(), "On".to_owned()));
    }

    #[test]
    fn missing_quota_is_shown_as_spent() {
        let report = parse(r#"{"remainingBalance": 0}"#, Some("not json"), None).unwrap();
        assert!((report.windows[0].used - 100.).abs() < 1e-4);
        assert!(matches!(parse("[]", None, None), Err(Error::UsageJson(_))));
    }
}
