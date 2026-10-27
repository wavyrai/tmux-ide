//! Charm Hyper usage: the Hypercredit balance from `hyper.charm.land`, read
//! with a hyper.charm.land browser session (the `cookie` setting, or Chrome
//! and Safari when Charm Hyper is listed in `show_providers`) and falling
//! back to an API key from the config or `HYPER_API_KEY`, as CodexBar's Auto
//! mode does. The service reports only a balance: no plan, limit, or reset.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Provider, Report, Unit},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::Duration;

const URL: &str = "https://hyper.charm.land/v1/credits";
const DOMAIN: &str = "hyper.charm.land";

pub(crate) struct Hyper;

static META: Meta = Meta::new("hyper", "Charm Hyper")
    .dashboard("https://hyper.charm.land")
    .settings(&[
        Setting::new(
            "api_key",
            &["HYPER_API_KEY"],
            "A Charm Hyper API key from https://hyper.charm.land. Used when no browser \
             session is available or the session has expired.",
        ),
        Setting::new(
            "cookie",
            &[],
            "Sign in at https://hyper.charm.land, open Developer Tools > Application > \
             Cookies > https://hyper.charm.land, and copy every cookie there as one \
             \"name=value; name2=value2\" header.",
        ),
    ]);

impl Service for Hyper {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("HYPER_API_KEY"));
        let cookie = probe.cookies(&[DOMAIN], &[]);
        if key.is_none() && cookie.is_none() {
            return None;
        }
        if let Some(cookie) = cookie {
            let request = Request::get(URL)
                .cookie(&cookie)
                .header("Accept", "application/json")
                .timeout(Duration::from_secs(5));
            let answer = probe
                .body(request)
                .and_then(|body| parse(&body, Source::Session));
            // An expired session or one that cannot connect falls back to the
            // key; a malformed answer does not, as in CodexBar.
            match answer {
                Ok(report) => return Some(Ok(report)),
                Err(error) if key.is_none() => return Some(Err(error)),
                Err(Error::UsageRejected | Error::UsageStatus(300..=399))
                | Err(Error::UsageConnect | Error::UsageNetwork(_)) => {}
                Err(error) => return Some(Err(error)),
            }
        }
        key.map(|key| with_key(probe, &key))
    }
}

fn with_key(probe: &mut Probe, key: &Secret) -> Result<Report> {
    let request = Request::get(URL)
        .bearer(key)
        .header("Accept", "application/json");
    probe
        .body(request)
        .and_then(|body| parse(&body, Source::Key))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Source {
    Session,
    Key,
}

pub(crate) fn parse(body: &str, source: Source) -> Result<Report> {
    // A signed-out session lands on the HTML sign-in page with HTTP 200.
    if source == Source::Session && body.trim_start().starts_with('<') {
        return Err(Error::UsageRejected);
    }
    let credits: Credits = json(body)?;
    let balance = credits
        .balance
        .filter(|balance| balance.is_finite() && *balance >= 0.)
        .ok_or_else(invalid)?;
    let account = Account {
        email: None,
        plan: Some(
            match source {
                Source::Session => "Browser session",
                Source::Key => "API key",
            }
            .into(),
        ),
    };
    Ok(
        Report::new(Provider(&Hyper), account, Vec::new()).with_balances([Balance::new(
            "Hypercredits",
            balance,
            Unit::Count("HC".into()),
        )]),
    )
}

#[derive(Deserialize)]
struct Credits {
    balance: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn balance_is_hypercredits() {
        let report = parse(r#"{"balance":42.5}"#, Source::Key).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances.len(), 1);
        assert_eq!(report.balances[0].amount, 42.5);
        assert_eq!(report.balances[0].unit, Unit::Count("HC".into()));
        assert_eq!(report.balances[0].amount_text(), "42.50 HC");
        assert_eq!(report.account.plan.as_deref(), Some("API key"));
    }

    #[test]
    fn negative_or_missing_balance_fails() {
        assert!(parse(r#"{"balance":-1}"#, Source::Key).is_err());
        assert!(parse(r#"{"credits":5}"#, Source::Key).is_err());
    }

    #[test]
    fn sign_in_page_rejects_the_session() {
        assert!(matches!(
            parse("<!doctype html><title>Sign in</title>", Source::Session),
            Err(Error::UsageRejected)
        ));
    }
}
