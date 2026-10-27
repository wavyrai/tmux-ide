//! Command Code rolling limits and monthly USD credits, read with the
//! commandcode.ai web session: the `cookie` setting, else (when listed) the
//! better-auth session cookie from Chrome or Safari.
//!
//! Not ported: CodexBar remembers the last confirmed plan in memory to size
//! the monthly grant when the subscription lookup fails; here a failed
//! lookup only leaves the monthly row unsized when the credits response
//! omits the grant. CodexBar also accepts a bare session token; here the
//! cookie is pasted as `name=value`.

use crate::{
    Result,
    usage::{
        model::{
            Account, Balance, Kind, MONTH, Provider, Report, SESSION, Unit, WEEK, Window,
            title_case,
        },
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::{invalid, number},
    },
};
use serde_json::Value;
use std::time::{Duration, SystemTime};

const API: &str = "https://api.commandcode.ai";
const ORIGIN: &str = "https://commandcode.ai";
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
/// better-auth names its session cookie by deployment; CodexBar tries these in order.
const SESSION_COOKIES: &[&str] = &[
    "__Secure-commandcode_prod_.session_token",
    "commandcode_prod_.session_token",
    "__Host-commandcode_prod_.session_token",
    "__Host-better-auth.session_token",
    "__Secure-better-auth.session_token",
    "better-auth.session_token",
];
/// Monthly USD allowance of each plan, from https://commandcode.ai/pricing,
/// used when the credits response omits the grant.
const PLANS: &[(&str, &str, f64)] = &[
    ("individual-go", "Go", 10.),
    ("individual-goat", "GOAT", 70.),
    ("individual-pro", "Pro", 30.),
    ("individual-pro-v1", "Pro", 80.),
    ("individual-max", "Max", 150.),
    ("individual-ultra", "Ultra", 300.),
];

pub(crate) struct Commandcode;

static META: Meta = Meta::new("commandcode", "Command Code")
    .dashboard("https://commandcode.ai/studio")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Sign in to https://commandcode.ai, open Developer Tools > Application > Cookies \
         for https://commandcode.ai, and copy the session cookie: \
         __Secure-better-auth.session_token (or __Secure-commandcode_prod_.session_token, \
         whichever is present). Paste it as \"name=value\".",
    )]);

impl Service for Commandcode {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = SESSION_COOKIES
            .iter()
            .find_map(|name| probe.cookies(&["commandcode.ai"], &[*name]))?;
        Some(read(probe, &cookie))
    }
}

fn read(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let get = |path: &str| {
        Request::get(format!("{API}{path}"))
            .cookie(cookie)
            .header("Accept", "application/json, text/plain, */*")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("User-Agent", AGENT)
            .header("Origin", ORIGIN)
            .header("Referer", format!("{ORIGIN}/"))
    };
    let credits = probe.body(get("/internal/billing/credits"))?;
    // The subscription only names the plan and its period; credits stand without it.
    let subscription = probe
        .body(get("/internal/billing/subscriptions").timeout(Duration::from_secs(5)))
        .ok();
    parse(&credits, subscription.as_deref())
}

pub(crate) fn parse(credits: &str, subscription: Option<&str>) -> Result<Report> {
    let root: Value = json(credits)?;
    let credits = root.get("credits").ok_or_else(invalid)?;
    let remaining = credits
        .get("monthlyCredits")
        .and_then(number)
        .ok_or_else(invalid)?;
    let purchased = credits
        .get("purchasedCredits")
        .and_then(number)
        .unwrap_or(0.);
    let granted = credits
        .get("monthlyCreditsGranted")
        .and_then(number)
        .filter(|total| *total > 0.);
    let limits = root
        .get("windowLimits")
        .or_else(|| credits.get("windowLimits"));
    let mut windows: Vec<Window> = [
        (Kind::Session, "fiveHour", SESSION),
        (Kind::Weekly, "weekly", WEEK),
    ]
    .into_iter()
    .filter_map(|(kind, key, length)| {
        let limit = limits?.get(key)?;
        let cap = limit.get("cap").and_then(number).filter(|cap| *cap > 0.)?;
        let used = limit.get("used").and_then(number).unwrap_or(0.);
        Some(Window::new(
            kind,
            used / cap * 100.,
            time(limit.get("resetAt")),
            Some(length),
        ))
    })
    .collect();

    // `None`: the lookup failed; `Some(None)`: it answered with no subscription.
    let subscription: Option<Option<Subscription>> = subscription.and_then(parse_subscription);
    let known = subscription.as_ref().and_then(Option::as_ref);
    let plan = known.and_then(|known| {
        PLANS
            .iter()
            .find(|(id, _, _)| known.plan.eq_ignore_ascii_case(id))
    });
    let total = granted.or(plan.map(|(_, _, total)| *total));
    let period_end = known.and_then(|known| known.period_end);
    let monthly = match total {
        Some(total) => Some((total - remaining).clamp(0., total) / total * 100.),
        // An unknown grant is shown as untouched only when the lookup
        // answered and something is left to spend.
        None if subscription.is_some() && (remaining > 0. || purchased > 0.) => Some(0.),
        None => None,
    };
    if let Some(used) = monthly {
        windows.push(Window::new(Kind::Monthly, used, period_end, Some(MONTH)));
    }
    let usd = || Unit::Currency("USD".into());
    let left = Balance::new("Monthly credits left", remaining.max(0.), usd());
    let mut balances = vec![match total {
        Some(total) => left.out_of(total),
        None => left,
    }];
    if purchased > 0. {
        balances.push(Balance::new("Purchased credits", purchased, usd()));
    }
    let plan_name = match (plan, known) {
        (Some((_, name, _)), _) => Some((*name).to_owned()),
        (None, Some(known)) => Some(title_case(
            known
                .plan
                .trim_start_matches("individual-")
                .replace('-', " ")
                .as_str(),
        )),
        (None, None) => None,
    };
    let account = Account {
        email: None,
        plan: plan_name,
    };
    Ok(Report::new(Provider(&Commandcode), account, windows).with_balances(balances))
}

struct Subscription {
    plan: String,
    period_end: Option<SystemTime>,
}

/// `None` when the lookup failed or is unreadable, `Some(None)` for the
/// free tier, which only an explicit successful `data: null` means.
fn parse_subscription(body: &str) -> Option<Option<Subscription>> {
    let root: Value = json(body).ok()?;
    if root.get("success").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let data = root.get("data")?;
    if data.is_null() {
        return Some(None);
    }
    let data = data.as_object()?;
    let plan = data
        .get("planId")?
        .as_str()
        .map(str::trim)
        .filter(|plan| !plan.is_empty())?;
    Some(Some(Subscription {
        plan: plan.to_owned(),
        period_end: time(data.get("currentPeriodEnd")),
    }))
}

fn time(value: Option<&Value>) -> Option<SystemTime> {
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

    const CREDITS: &str = r#"{
      "credits": {"monthlyCredits": 8.5, "purchasedCredits": 2, "premiumMonthlyCredits": 0,
                  "opensourceMonthlyCredits": 0},
      "windowLimits": {
        "fiveHour": {"cap": 3, "used": 0.75, "resetAt": 1780000000000},
        "weekly": {"cap": 15, "used": 1.5, "resetAt": 1780100000000}
      }
    }"#;

    const SUBSCRIPTION: &str = r#"{"success":true,"data":{"id":"sub_1","status":"active",
      "currentPeriodStart":"2026-05-06T07:28:50.000Z","currentPeriodEnd":"2026-06-06T07:28:50.000Z",
      "planId":"individual-go"}}"#;

    #[test]
    fn rolling_windows_and_plan_sized_month() {
        let report = parse(CREDITS, Some(SUBSCRIPTION)).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Go"));
        let kinds: Vec<_> = report.windows.iter().map(|window| &window.kind).collect();
        assert_eq!(kinds, [&Kind::Session, &Kind::Weekly, &Kind::Monthly]);
        assert!((report.windows[0].used - 25.).abs() < 1e-4);
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_780_000_000))
        );
        assert!((report.windows[1].used - 10.).abs() < 1e-4);
        // $1.50 of the Go plan's $10 spent.
        assert!((report.windows[2].used - 15.).abs() < 1e-4);
        assert!(report.windows[2].resets_at.is_some());
        let usd = Unit::Currency("USD".into());
        assert_eq!(
            report.balances,
            vec![
                Balance::new("Monthly credits left", 8.5, usd.clone()).out_of(10.),
                Balance::new("Purchased credits", 2., usd),
            ]
        );
    }

    #[test]
    fn reported_grant_wins_over_the_plan() {
        let credits = r#"{"credits": {"monthlyCredits": "20", "monthlyCreditsGranted": 80,
            "windowLimits": {"fiveHour": {"cap": 4, "used": 1}}}}"#;
        let report = parse(credits, None).unwrap();
        assert_eq!(report.windows[0].kind, Kind::Session);
        assert!((report.windows[0].used - 25.).abs() < 1e-4);
        assert!((report.windows[1].used - 75.).abs() < 1e-4);
        assert_eq!(report.account.plan, None);
    }

    #[test]
    fn free_tier_and_failed_lookup_differ() {
        let credits = r#"{"credits": {"monthlyCredits": 1}}"#;
        let free = parse(credits, Some(r#"{"success": true, "data": null}"#)).unwrap();
        assert_eq!(free.windows.len(), 1);
        assert_eq!(free.windows[0].used, 0.);
        let failed = parse(credits, Some(r#"{"success": false}"#)).unwrap();
        assert!(failed.windows.is_empty());
        assert!(matches!(
            parse(r#"{"credits": {}}"#, None),
            Err(Error::UsageJson(_))
        ));
    }
}
