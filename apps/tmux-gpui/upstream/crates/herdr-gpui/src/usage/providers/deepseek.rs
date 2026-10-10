//! DeepSeek credit balance. The sign-in is, in CodexBar's order, an API key
//! (`api_key`, or `DEEPSEEK_API_KEY`/`DEEPSEEK_KEY` here or on the probed
//! host) read against the public balance endpoint, else a DeepSeek Platform
//! session token (`platform_token`) read against the dashboard's user summary.
//!
//! Not ported: CodexBar imports the Platform `userToken` from Chrome's
//! localStorage, which the probe cannot read, so the token must be pasted;
//! and the Platform's per-key daily cost and token history, private
//! dashboard endpoints whose calendar bucketing adds little to a balance.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json, number},
    },
};
use serde::Deserialize;
use serde_json::error::Category;

const BALANCE_URL: &str = "https://api.deepseek.com/user/balance";
const SUMMARY_URL: &str = "https://platform.deepseek.com/api/v0/users/get_user_summary";

pub(crate) struct Deepseek;

static META: Meta = Meta::new("deepseek", "DeepSeek")
    .dashboard("https://platform.deepseek.com/usage")
    .status_page("https://status.deepseek.com")
    .settings(&[
        Setting::new(
            "api_key",
            &["DEEPSEEK_API_KEY", "DEEPSEEK_KEY"],
            "A DeepSeek API key from https://platform.deepseek.com/api_keys. It reads \
             the remaining credit balance.",
        ),
        Setting::new(
            "platform_token",
            &["DEEPSEEK_PLATFORM_TOKEN", "DEEPSEEK_USER_TOKEN"],
            "Used when no API key is set. Sign in to https://platform.deepseek.com, open \
             Developer Tools > Application > Local Storage > https://platform.deepseek.com, \
             and copy the value of the userToken entry (either the whole JSON value or \
             just its \"value\" field).",
        ),
    ]);

impl Service for Deepseek {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let api_key = probe
            .setting("api_key")
            .or_else(|| probe.env("DEEPSEEK_API_KEY"))
            .or_else(|| probe.env("DEEPSEEK_KEY"));
        if let Some(key) = api_key {
            let request = Request::get(BALANCE_URL)
                .bearer(&key)
                .header("Accept", "application/json");
            return Some(probe.body(request).and_then(|body| parse_balance(&body)));
        }
        let stored = probe.setting("platform_token")?;
        // localStorage keeps the token as `{"value":"…"}`; a bare token is used as is.
        let token = probe.field(&stored, &["value"]).unwrap_or(stored);
        let request = Request::get(SUMMARY_URL)
            .bearer(&token)
            .header("Accept", "application/json")
            .header("x-client-platform", "web");
        Some(probe.body(request).and_then(|body| parse_summary(&body)))
    }
}

/// The public API's answer: one entry per currency the account holds.
pub(crate) fn parse_balance(body: &str) -> Result<Report> {
    let answer: BalanceAnswer = json(body)?;
    let wallets: Vec<Wallet> = answer
        .balance_infos
        .into_iter()
        .map(|info| {
            Ok(Wallet {
                currency: info.currency,
                total: info.total_balance.ok_or(Error::UsageJson(Category::Data))?,
                granted: info
                    .granted_balance
                    .ok_or(Error::UsageJson(Category::Data))?,
                paid: info
                    .topped_up_balance
                    .ok_or(Error::UsageJson(Category::Data))?,
            })
        })
        .collect::<Result<_>>()?;
    Ok(report(choose(wallets), answer.is_available))
}

/// The Platform dashboard's answer: paid (`normal`) and granted (`bonus`)
/// wallets, summed per currency.
pub(crate) fn parse_summary(body: &str) -> Result<Report> {
    let answer: SummaryAnswer = json(body)?;
    check_code(answer.code)?;
    let data = answer.data.ok_or(Error::UsageJson(Category::Data))?;
    check_code(data.biz_code)?;
    let summary = data.biz_data.ok_or(Error::UsageJson(Category::Data))?;
    let mut wallets: Vec<Wallet> = Vec::new();
    let entries = summary
        .normal_wallets
        .into_iter()
        .map(|wallet| (wallet, false))
        .chain(
            summary
                .bonus_wallets
                .into_iter()
                .map(|wallet| (wallet, true)),
        );
    for (wallet, granted) in entries {
        let amount = wallet.balance.ok_or(Error::UsageJson(Category::Data))?;
        let index = match wallets
            .iter()
            .position(|known| known.currency == wallet.currency)
        {
            Some(index) => index,
            None => {
                wallets.push(Wallet {
                    currency: wallet.currency,
                    total: 0.,
                    granted: 0.,
                    paid: 0.,
                });
                wallets.len() - 1
            }
        };
        if let Some(entry) = wallets.get_mut(index) {
            entry.total += amount;
            if granted {
                entry.granted += amount;
            } else {
                entry.paid += amount;
            }
        }
    }
    wallets.sort_by(|a, b| a.currency.cmp(&b.currency));
    let wallet = choose(wallets);
    let available = wallet.as_ref().is_some_and(|wallet| wallet.total > 0.);
    Ok(report(wallet, available))
}

/// DeepSeek reports an expired Platform session as code 40002 or 40003.
fn check_code(code: Option<i64>) -> Result<()> {
    match code {
        None | Some(0) => Ok(()),
        Some(40002 | 40003) => Err(Error::UsageRejected),
        Some(_) => Err(Error::UsageJson(Category::Data)),
    }
}

/// USD when it is funded, else any funded currency, else USD, else the first:
/// an empty USD row must not hide a positive CNY balance.
fn choose(wallets: Vec<Wallet>) -> Option<Wallet> {
    let pick = wallets
        .iter()
        .position(|wallet| wallet.currency == "USD" && wallet.total > 0.)
        .or_else(|| wallets.iter().position(|wallet| wallet.total > 0.))
        .or_else(|| wallets.iter().position(|wallet| wallet.currency == "USD"))
        .unwrap_or(0);
    wallets.into_iter().nth(pick)
}

fn report(wallet: Option<Wallet>, available: bool) -> Report {
    let wallet = wallet.unwrap_or(Wallet {
        currency: "USD".into(),
        total: 0.,
        granted: 0.,
        paid: 0.,
    });
    let unit = Unit::Currency(wallet.currency.trim().to_uppercase());
    let mut facts = vec![
        (
            "Paid".to_owned(),
            Balance::new("Paid", wallet.paid, unit.clone()).amount_text(),
        ),
        (
            "Granted".to_owned(),
            Balance::new("Granted", wallet.granted, unit.clone()).amount_text(),
        ),
    ];
    if wallet.total <= 0. {
        facts.push((
            "Status".into(),
            "Add credits at platform.deepseek.com".into(),
        ));
    } else if !available {
        facts.push(("Status".into(), "Balance unavailable for API calls".into()));
    }
    Report::new(Provider(&Deepseek), Account::default(), Vec::new())
        .with_balances([Balance::new("Balance", wallet.total, unit)])
        .with_sections([Section::Facts {
            title: "Credits".into(),
            facts,
        }])
}

struct Wallet {
    currency: String,
    total: f64,
    granted: f64,
    paid: f64,
}

#[derive(Deserialize)]
struct BalanceAnswer {
    #[serde(default)]
    is_available: bool,
    #[serde(default)]
    balance_infos: Vec<BalanceInfo>,
}

#[derive(Deserialize)]
struct BalanceInfo {
    currency: String,
    #[serde(default, deserialize_with = "number")]
    total_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    granted_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    topped_up_balance: Option<f64>,
}

#[derive(Deserialize)]
struct SummaryAnswer {
    code: Option<i64>,
    data: Option<SummaryData>,
}

#[derive(Deserialize)]
struct SummaryData {
    biz_code: Option<i64>,
    biz_data: Option<Summary>,
}

#[derive(Deserialize)]
struct Summary {
    #[serde(default)]
    normal_wallets: Vec<PlatformWallet>,
    #[serde(default)]
    bonus_wallets: Vec<PlatformWallet>,
}

#[derive(Deserialize)]
struct PlatformWallet {
    #[serde(default, deserialize_with = "number")]
    balance: Option<f64>,
    currency: String,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn api_balance_prefers_funded_usd() {
        let body = r#"{
          "is_available": true,
          "balance_infos": [
            {"currency": "CNY", "total_balance": "0.00", "granted_balance": "0.00", "topped_up_balance": "0.00"},
            {"currency": "USD", "total_balance": "50.00", "granted_balance": "10.00", "topped_up_balance": "40.00"}
          ]
        }"#;
        let report = parse_balance(body).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(
            report.balances,
            vec![Balance::new("Balance", 50., Unit::Currency("USD".into()))]
        );
        let Some(Section::Facts { facts, .. }) = report.sections.first() else {
            panic!("expected credit facts");
        };
        assert_eq!(facts[0], ("Paid".to_owned(), "$40.00".to_owned()));
        assert_eq!(facts[1], ("Granted".to_owned(), "$10.00".to_owned()));
        assert_eq!(facts.len(), 2);
    }

    #[test]
    fn api_balance_shows_a_funded_cny_over_an_empty_usd() {
        let body = r#"{
          "is_available": false,
          "balance_infos": [
            {"currency": "USD", "total_balance": "0", "granted_balance": "0", "topped_up_balance": "0"},
            {"currency": "CNY", "total_balance": "12.5", "granted_balance": "0", "topped_up_balance": "12.5"}
          ]
        }"#;
        let report = parse_balance(body).unwrap();
        assert_eq!(report.balances[0].amount, 12.5);
        assert_eq!(report.balances[0].unit, Unit::Currency("CNY".into()));
        let Some(Section::Facts { facts, .. }) = report.sections.first() else {
            panic!("expected credit facts");
        };
        assert_eq!(facts[2].1, "Balance unavailable for API calls");
    }

    #[test]
    fn api_balance_rejects_non_numeric_amounts() {
        let body = r#"{"is_available": true, "balance_infos": [
            {"currency": "USD", "total_balance": "n/a", "granted_balance": "0", "topped_up_balance": "0"}
        ]}"#;
        assert!(matches!(parse_balance(body), Err(Error::UsageJson(_))));
    }

    #[test]
    fn platform_summary_sums_paid_and_granted_wallets() {
        let body = r#"{
          "code": 0,
          "data": {
            "biz_code": 0,
            "biz_data": {
              "normal_wallets": [{"balance": "7.97", "currency": "USD"}],
              "bonus_wallets": [{"balance": 0.50, "currency": "USD"}]
            }
          }
        }"#;
        let report = parse_summary(body).unwrap();
        assert!((report.balances[0].amount - 8.47).abs() < 1e-9);
        let Some(Section::Facts { facts, .. }) = report.sections.first() else {
            panic!("expected credit facts");
        };
        assert_eq!(facts[0].1, "$7.97");
        assert_eq!(facts[1].1, "$0.50");
    }

    #[test]
    fn platform_summary_maps_expired_sessions() {
        assert!(matches!(
            parse_summary(r#"{"code": 40003}"#),
            Err(Error::UsageRejected)
        ));
        assert!(matches!(
            parse_summary(r#"{"code": 0, "data": {"biz_code": 40002}}"#),
            Err(Error::UsageRejected)
        ));
    }
}
