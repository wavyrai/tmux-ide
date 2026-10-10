//! Vercel AI Gateway credits, read from the gateway's credits API with an AI
//! Gateway API key from the config or `AI_GATEWAY_API_KEY`, as CodexBar does.
//!
//! The endpoint reports the key's team-wide balance and lifetime spend with
//! no spending limit or reset, so no percentage or period is invented. Like
//! CodexBar, this does not read Vercel CLI credentials, switch teams, or use
//! the metered Custom Reporting API.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Provider, Report, Unit},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json},
        values::{decimal, invalid},
    },
};
use serde::Deserialize;

const URL: &str = "https://ai-gateway.vercel.sh/v1/credits";

pub(crate) struct Vercel;

static META: Meta = Meta::new("vercel", "Vercel AI Gateway")
    .dashboard("https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai-gateway")
    .settings(&[Setting::new(
        "api_key",
        &["AI_GATEWAY_API_KEY"],
        "An AI Gateway API key from the Vercel dashboard: AI Gateway > API Keys. The \
         balance is the key's team, so use a key of the team to show.",
    )]);

impl Service for Vercel {
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
    let credits: Credits = json(body)?;
    let balance = credits
        .balance
        .as_deref()
        .and_then(decimal)
        .ok_or_else(invalid)?;
    let spent = credits
        .total_used
        .as_deref()
        .and_then(decimal)
        .filter(|spent| *spent >= 0.)
        .ok_or_else(invalid)?;
    let usd = || Unit::Currency("USD".into());
    Ok(
        Report::new(Provider(&Vercel), Account::default(), Vec::new()).with_balances([
            Balance::new("Available balance", balance, usd()),
            Balance::new("Lifetime spend", spent, usd()),
        ]),
    )
}

#[derive(Deserialize)]
struct Credits {
    balance: Option<String>,
    total_used: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    #[test]
    fn reads_balance_and_lifetime_spend() {
        let report = parse(r#"{"balance":"95.50","total_used":"4.50"}"#).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account, Account::default());
        let texts: Vec<_> = report
            .balances
            .iter()
            .map(|balance| (balance.label.as_str(), balance.text()))
            .collect();
        assert_eq!(
            texts,
            [
                ("Available balance", "$95.50".to_owned()),
                ("Lifetime spend", "$4.50".to_owned()),
            ]
        );
        assert!(
            report
                .balances
                .iter()
                .all(|balance| balance.total.is_none())
        );
    }

    #[test]
    fn keeps_zero_and_negative_balances() {
        let report = parse(r#"{"balance":"-1.25","total_used":"0"}"#).unwrap();
        assert_eq!(report.balances[0].amount, -1.25);
        assert_eq!(report.balances[1].amount, 0.);
    }

    #[test]
    fn rejects_missing_negative_or_malformed_amounts() {
        for body in [
            r#"{"balance":"1.00","total_used":"-1.00"}"#,
            r#"{"balance":"1.00"}"#,
            r#"{"total_used":"1.00"}"#,
            r#"{"balance":1,"total_used":"1.00"}"#,
            r#"{"balance":"1e2","total_used":"1.00"}"#,
            r#"{"balance":".5","total_used":"1.00"}"#,
            "private-response",
        ] {
            assert!(
                matches!(parse(body), Err(Error::UsageJson(_))),
                "accepted {body}"
            );
        }
    }
}
