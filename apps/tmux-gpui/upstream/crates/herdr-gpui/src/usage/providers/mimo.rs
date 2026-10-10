//! Xiaomi MiMo balance and token plan, read from the MiMo console API with a
//! platform.xiaomimimo.com browser session: the `cookie` setting, or
//! Chrome/Safari when MiMo is listed in `show_providers`. The balance is
//! required; the token plan's detail and monthly usage are shown when the
//! account has one.
//!
//! Not ported: CodexBar's opt-in local fallback, which reads token totals a
//! separate wrapper script writes to `~/.codexbar/mimo-local-usage.json`.
//! That file belongs to CodexBar's own tooling, not to MiMo.

use crate::{
    Error, Result,
    usage::{
        model::{
            Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window, group,
            title_case,
        },
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::{https_base, invalid},
    },
};
use serde::Deserialize;

const BASE: &str = "https://platform.xiaomimimo.com/api/v1";
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub(crate) struct Mimo;

static META: Meta = Meta::new("mimo", "Xiaomi MiMo")
    .dashboard("https://platform.xiaomimimo.com/#/console/balance")
    .settings(&[
        Setting::new(
            "cookie",
            &[],
            "The MiMo console session. Sign in at \
             https://platform.xiaomimimo.com/#/console/balance, open Developer Tools → \
             Application → Cookies → https://platform.xiaomimimo.com, copy the \
             api-platform_serviceToken and userId cookies (and api-platform_ph and \
             api-platform_slh when present), and paste them as \
             \"api-platform_serviceToken=value; userId=value\".",
        ),
        Setting::new(
            "base_url",
            &["MIMO_API_URL"],
            "Optional HTTPS API URL. Defaults to https://platform.xiaomimimo.com/api/v1.",
        ),
    ]);

impl Service for Mimo {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(
            &["platform.xiaomimimo.com", "xiaomimimo.com"],
            &[
                "api-platform_serviceToken",
                "userId",
                "api-platform_ph",
                "api-platform_slh",
            ],
        )?;
        Some(fetch(probe, &cookie))
    }
}

fn fetch(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    // An override must stay on HTTPS: the session is attached to it.
    let base = https_base(probe.text_setting("base_url"), BASE)?;
    let mut get = |path: &str| -> Result<String> {
        let request = Request::get(format!("{base}/{path}"))
            .cookie(cookie)
            .header("Accept", "application/json, text/plain, */*")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("x-timeZone", "UTC+00:00")
            .header("Origin", "https://platform.xiaomimimo.com")
            .header(
                "Referer",
                "https://platform.xiaomimimo.com/#/console/balance",
            )
            .header("User-Agent", AGENT);
        let response = probe.http(request)?;
        // An expired session is redirected to the login flow.
        if (300..400).contains(&response.status) {
            return Err(Error::UsageRejected);
        }
        response.ok()
    };
    let balance = get("balance")?;
    let detail = get("tokenPlan/detail").ok();
    let usage = get("tokenPlan/usage").ok();
    parse(&balance, detail.as_deref(), usage.as_deref())
}

/// The balance is required; the token plan's detail and usage are optional
/// and left out when they do not parse.
pub(crate) fn parse(balance: &str, detail: Option<&str>, usage: Option<&str>) -> Result<Report> {
    let balance = payload::<BalancePayload>(balance)?;
    let amount = balance.balance.ok_or_else(invalid)?;
    let currency = balance.currency.trim().to_uppercase();
    if currency.is_empty() {
        return Err(invalid());
    }
    let detail = detail.and_then(|body| payload::<PlanDetail>(body).ok());
    let item = usage
        .and_then(|body| payload::<PlanUsage>(body).ok())
        .and_then(|usage| usage.month_usage)
        .and_then(|month| month.items.into_iter().next())
        .filter(|item| item.limit > 0);
    let period_end = detail
        .as_ref()
        .and_then(|detail| detail.current_period_end.as_ref())
        .and_then(Timestamp::time);
    let window = item.as_ref().map(|item| {
        Window::new(
            Kind::Monthly,
            item.percent * 100.,
            period_end,
            period_end.map(|_| MONTH),
        )
    });
    let money =
        |amount: f64| Balance::new("", amount, Unit::Currency(currency.clone())).amount_text();
    let mut facts = Vec::new();
    if let (Some(paid), Some(granted)) = (balance.cash_balance, balance.gift_balance) {
        facts.push(("Paid".to_owned(), money(paid)));
        facts.push(("Granted".to_owned(), money(granted)));
    }
    if let Some(item) = &item {
        facts.push((
            "Token plan".to_owned(),
            format!("{} of {} credits", group(item.used), group(item.limit)),
        ));
    }
    if detail.as_ref().is_some_and(|detail| detail.expired) {
        facts.push(("Token plan".to_owned(), "Expired".to_owned()));
    }
    let plan = detail
        .and_then(|detail| detail.plan_code)
        .map(|code| title_case(&code))
        .filter(|code| !code.is_empty());
    Ok(Report::new(
        Provider(&Mimo),
        Account { email: None, plan },
        window.into_iter().collect(),
    )
    .with_balances([Balance::new("Balance", amount, Unit::Currency(currency))])
    .with_sections((!facts.is_empty()).then(|| Section::Facts {
        title: "Account".into(),
        facts,
    })))
}

/// MiMo wraps every answer in `{code, message, data}`; a nonzero code is a
/// failure even under HTTP 200.
fn payload<T: for<'de> Deserialize<'de>>(body: &str) -> Result<T> {
    let envelope: Envelope<T> = json(body)?;
    match envelope.code {
        0 => envelope.data.ok_or_else(invalid),
        401 | 403 => Err(Error::UsageRejected),
        _ => Err(invalid()),
    }
}

#[derive(Deserialize)]
struct Envelope<T> {
    code: i64,
    data: Option<T>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalancePayload {
    #[serde(default, deserialize_with = "number")]
    balance: Option<f64>,
    currency: String,
    #[serde(default, deserialize_with = "number")]
    cash_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    gift_balance: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanDetail {
    plan_code: Option<String>,
    current_period_end: Option<Timestamp>,
    #[serde(default)]
    expired: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanUsage {
    month_usage: Option<MonthUsage>,
}

#[derive(Deserialize)]
struct MonthUsage {
    items: Vec<UsageItem>,
}

#[derive(Deserialize)]
struct UsageItem {
    used: i64,
    limit: i64,
    percent: f64,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    /// CodexBar's combined-snapshot fixtures.
    const BALANCE: &str = r#"{"code":0,"message":"","data":{"balance":"25.51","currency":"USD","cashBalance":"20","giftBalance":"5.51"}}"#;
    const DETAIL: &str = r#"{"code":0,"message":"","data":{"planCode":"standard","currentPeriodEnd":"2026-05-04 23:59:59","expired":false}}"#;
    const USAGE: &str = r#"{"code":0,"message":"","data":{"monthUsage":{"percent":0.0505,
        "items":[{"name":"month_total_token","used":10100158,"limit":200000000,"percent":0.0505}]}}}"#;

    #[test]
    fn merges_balance_and_token_plan() {
        let report = parse(BALANCE, Some(DETAIL), Some(USAGE)).unwrap();
        assert_eq!(report.provider.id(), "mimo");
        assert_eq!(report.account.plan.as_deref(), Some("Standard"));
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 5.05).abs() < 1e-4);
        assert_eq!(
            window.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_777_939_199))
        );
        assert_eq!(window.length, Some(MONTH));
        assert_eq!(report.balances[0].text(), "$25.51");
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0], ("Paid".to_owned(), "$20.00".to_owned()));
        assert_eq!(facts[1], ("Granted".to_owned(), "$5.51".to_owned()));
        assert_eq!(
            facts[2],
            (
                "Token plan".to_owned(),
                "10,100,158 of 200,000,000 credits".to_owned()
            )
        );
    }

    #[test]
    fn balance_alone_has_no_window() {
        let report = parse(
            r#"{"code":0,"message":"","data":{"balance":"25.51","frozenBalance":null,"currency":"USD","overdraftLimit":null}}"#,
            None,
            Some(r#"{"code":500,"message":"no plan","data":null}"#),
        )
        .unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].amount, 25.51);
        assert!(report.sections.is_empty());
    }

    #[test]
    fn a_login_code_is_a_rejection() {
        assert!(matches!(
            parse(r#"{"code":401,"message":"login","data":null}"#, None, None),
            Err(Error::UsageRejected)
        ));
    }
}
