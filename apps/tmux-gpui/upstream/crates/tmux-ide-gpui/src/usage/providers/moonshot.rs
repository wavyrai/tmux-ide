//! Moonshot / Kimi Open Platform balance, read with an API key from the
//! config or `MOONSHOT_API_KEY` / `MOONSHOT_KEY`, as CodexBar does. The
//! platform has no quota windows, only a prepaid balance, so the report is
//! the available balance with its voucher and cash parts.
//!
//! The key is bound to a region: International (`api.moonshot.ai`, USD) by
//! default, or China mainland (`api.moonshot.cn`, CNY) with `region =
//! "china"`. Kimi Code subscriptions are a separate provider (`kimi`).

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Provider, Report, Section, Unit},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json},
        values,
    },
};
use serde::Deserialize;

const INTERNATIONAL: &str = "https://api.moonshot.ai";
const CHINA: &str = "https://api.moonshot.cn";

pub(crate) struct Moonshot;

static META: Meta = Meta::new("moonshot", "Moonshot / Kimi Open Platform")
    .icon("icons/providers/kimi.svg")
    .dashboard("https://platform.moonshot.ai/console/account")
    .settings(&[
        Setting::new(
            "api_key",
            &["MOONSHOT_API_KEY", "MOONSHOT_KEY"],
            "A Moonshot / Kimi Open Platform API key, from \
             https://platform.moonshot.ai/console/api-keys (International) or \
             https://platform.moonshot.cn/console/api-keys (China mainland). Use a key \
             issued for the region set below.",
        ),
        Setting::new(
            "region",
            &["MOONSHOT_REGION"],
            "Which platform issued the key: \"international\" (the default, \
             api.moonshot.ai, balances in USD) or \"china\" (api.moonshot.cn, balances \
             in CNY).",
        ),
    ]);

impl Service for Moonshot {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        let region = Region::from(probe.text_setting("region").as_deref());
        let request = Request::get(format!("{}/v1/users/me/balance", region.origin()))
            .bearer(&key)
            .header("Accept", "application/json");
        Some(probe.body(request).and_then(|body| parse(&body, region)))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Region {
    International,
    China,
}

impl From<Option<&str>> for Region {
    fn from(value: Option<&str>) -> Self {
        match value
            .map(|value| value.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("china" | "cn" | "china mainland") => Self::China,
            _ => Self::International,
        }
    }
}

impl Region {
    fn origin(self) -> &'static str {
        match self {
            Self::International => INTERNATIONAL,
            Self::China => CHINA,
        }
    }

    fn currency(self) -> &'static str {
        match self {
            Self::International => "USD",
            Self::China => "CNY",
        }
    }
}

pub(crate) fn parse(body: &str, region: Region) -> Result<Report> {
    let response: BalanceResponse = json(body)?;
    // The platform reports failures in a 200 body; only a clean answer is usage.
    if response.code != 0 || !response.status {
        return Err(values::invalid());
    }
    let data = response.data;
    let unit = || Unit::Currency(region.currency().into());
    let text = |amount: f64| Balance::new("", amount, unit()).amount_text();
    let mut facts = vec![
        ("Voucher".to_owned(), text(data.voucher_balance)),
        ("Cash".to_owned(), text(data.cash_balance)),
    ];
    if data.cash_balance < 0. {
        facts.push(("In deficit".to_owned(), text(data.cash_balance.abs())));
    }
    Ok(
        Report::new(Provider(&Moonshot), Account::default(), Vec::new())
            .with_balances([Balance::new("Available", data.available_balance, unit())])
            .with_sections([Section::Facts {
                title: "Balance".into(),
                facts,
            }]),
    )
}

#[derive(Deserialize)]
struct BalanceResponse {
    code: i64,
    status: bool,
    data: BalanceData,
}

#[derive(Deserialize)]
struct BalanceData {
    available_balance: f64,
    voucher_balance: f64,
    cash_balance: f64,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    /// The documented `GET /v1/users/me/balance` answer.
    const FIXTURE: &str = r#"{"code":0,"data":{"available_balance":49.58894,
        "voucher_balance":46.58893,"cash_balance":3.00001},"scode":"0x0","status":true}"#;

    #[test]
    fn reads_the_available_balance_in_the_region_currency() {
        let report = parse(FIXTURE, Region::International).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances.len(), 1);
        assert_eq!(report.balances[0].label, "Available");
        assert!((report.balances[0].amount - 49.58894).abs() < 1e-9);
        assert_eq!(report.balances[0].unit, Unit::Currency("USD".into()));
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Balance".into(),
                facts: vec![
                    ("Voucher".into(), "$46.59".into()),
                    ("Cash".into(), "$3.00".into()),
                ],
            }]
        );

        let china = parse(FIXTURE, Region::China).unwrap();
        assert_eq!(china.balances[0].unit, Unit::Currency("CNY".into()));
    }

    #[test]
    fn shows_a_cash_deficit() {
        let body = r#"{"code":0,"scode":"0x0","status":true,"data":{"available_balance":0,
            "voucher_balance":0,"cash_balance":-1.5}}"#;
        let report = parse(body, Region::International).unwrap();
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("facts expected");
        };
        assert_eq!(facts[2], ("In deficit".into(), "$1.50".into()));
    }

    #[test]
    fn rejects_an_api_error_body() {
        let body = r#"{"code":5,"scode":"0x5","status":false,"data":{"available_balance":0,
            "voucher_balance":0,"cash_balance":0}}"#;
        assert!(matches!(
            parse(body, Region::International),
            Err(Error::UsageJson(_))
        ));
    }

    #[test]
    fn region_defaults_to_international() {
        assert_eq!(Region::from(None), Region::International);
        assert_eq!(Region::from(Some(" China ")), Region::China);
        assert_eq!(Region::from(Some("international")), Region::International);
    }
}
