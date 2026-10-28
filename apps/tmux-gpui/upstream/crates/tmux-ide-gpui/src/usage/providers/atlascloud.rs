//! Atlas Cloud account balance, read from the public billing API with an
//! API key from the config or `ATLASCLOUD_API_KEY`, as CodexBar does.
//!
//! The balance has no quota, reset, or billing period, so none is invented.
//! Coding Plan quotas are a separate meter that CodexBar does not read
//! either, and there is no local credential or browser session to detect.

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

const URL: &str = "https://api.atlascloud.ai/public/v1/balance";

pub(crate) struct Atlascloud;

static META: Meta = Meta::new("atlascloud", "Atlas Cloud")
    .dashboard("https://www.atlascloud.ai/console")
    .settings(&[Setting::new(
        "api_key",
        &["ATLASCLOUD_API_KEY"],
        "A standard Atlas Cloud API key from https://www.atlascloud.ai/console. It needs \
         account balance read permission: use the account owner's key, or an Account Admin \
         or Finance key for a team. A public key ID (ak_…) cannot authenticate.",
    )]);

impl Service for Atlascloud {
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

/// Only an account-wide USD balance is accepted: a key-scoped or other
/// currency amount would be shown as something it is not.
pub(crate) fn parse(body: &str) -> Result<Report> {
    let balance: BalanceBody = json(body)?;
    let available = balance.available.ok_or_else(invalid)?;
    if balance.object.as_deref() != Some("balance")
        || balance.scope.as_deref() != Some("account")
        || available.currency.as_deref() != Some("usd")
    {
        return Err(invalid());
    }
    let amount = available
        .value
        .as_deref()
        .and_then(decimal)
        .ok_or_else(invalid)?;
    Ok(
        Report::new(Provider(&Atlascloud), Account::default(), Vec::new()).with_balances([
            Balance::new("Available balance", amount, Unit::Currency("USD".into())),
        ]),
    )
}

#[derive(Deserialize)]
struct BalanceBody {
    object: Option<String>,
    scope: Option<String>,
    available: Option<Available>,
}

#[derive(Deserialize)]
struct Available {
    value: Option<String>,
    currency: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    fn fixture(value: &str) -> String {
        format!(
            r#"{{"object":"balance","scope":"account","available":{{"value":"{value}","currency":"usd"}}}}"#
        )
    }

    #[test]
    fn reads_the_account_balance() {
        let report = parse(&fixture("95.50")).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account, Account::default());
        assert_eq!(report.balances.len(), 1);
        assert_eq!(report.balances[0].amount, 95.5);
        assert_eq!(report.balances[0].unit, Unit::Currency("USD".into()));
        assert_eq!(report.balances[0].total, None);
        assert_eq!(report.balances[0].text(), "$95.50");
    }

    #[test]
    fn keeps_zero_and_negative_balances() {
        assert_eq!(parse(&fixture("0")).unwrap().balances[0].amount, 0.);
        assert_eq!(parse(&fixture("-3.25")).unwrap().balances[0].amount, -3.25);
    }

    #[test]
    fn rejects_other_scopes_currencies_and_malformed_amounts() {
        for body in [
            fixture("95.50").replace("usd", "eur"),
            fixture("95.50").replace("account", "key"),
            fixture("95.50").replace("balance\"", "credit\""),
            fixture("1e3"),
            fixture("12."),
            fixture(""),
            fixture("NaN"),
            r#"{"object":"balance","scope":"account"}"#.into(),
            r#"{"object":"balance","scope":"account","available":{"value":12,"currency":"usd"}}"#
                .into(),
            "private-response".into(),
        ] {
            assert!(
                matches!(parse(&body), Err(Error::UsageJson(_))),
                "accepted {body}"
            );
        }
    }
}
