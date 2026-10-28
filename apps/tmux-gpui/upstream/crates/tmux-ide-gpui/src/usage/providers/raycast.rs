//! Raycast AI credits, read from the website's unofficial
//! `frontend_api/current_user/ai_credits` route with a www.raycast.com
//! session: the `cookie` setting, or Chrome and Safari when Raycast is listed
//! in `show_providers`. The desktop app's OAuth bearer is not used, as in
//! CodexBar: website cookies are rejected by the desktop API and the bearer
//! lives in the Raycast app's private storage. Top-up packages and the
//! per-model breakdown are not fetched, as CodexBar does not either.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::{invalid, trimmed},
    },
};
use serde::Deserialize;

const URL: &str = "https://www.raycast.com/frontend_api/current_user/ai_credits";
/// The route serves the website, so it is asked as a browser would.
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub(crate) struct Raycast;

static META: Meta = Meta::new("raycast", "Raycast")
    .dashboard("https://www.raycast.com/settings")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Sign in at https://www.raycast.com/settings, open Developer Tools > Application > \
         Cookies > https://www.raycast.com, and copy __raycast_session (and csrf_token when \
         present) as one \"__raycast_session=value; csrf_token=value\" header.",
    )]);

impl Service for Raycast {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(&["www.raycast.com", "raycast.com"], &["__raycast_session"])?;
        let request = Request::get(URL)
            .cookie(&cookie)
            .header("Accept", "application/json")
            .header("Origin", "https://www.raycast.com")
            .header("Referer", "https://www.raycast.com/settings")
            .header("User-Agent", AGENT);
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let credits: Credits = json(body)?;
    let (remaining, total) = (
        credits.remaining_balance_credits,
        credits.total_balance_credits,
    );
    if remaining.is_none() && total.is_none() {
        return Err(invalid());
    }
    if [remaining, total]
        .into_iter()
        .flatten()
        .any(|amount| !amount.is_finite() || amount < 0.)
    {
        return Err(invalid());
    }
    let renewal = match credits.next_credits_at {
        Some(at) => Some(at.time().ok_or_else(invalid)?),
        None => None,
    };
    let plan = credits
        .funding_subscription
        .and_then(|funding| funding.tier)
        .map(|tier| tier.trim().to_owned())
        .filter(|tier| !tier.is_empty())
        .map(|tier| match tier.as_str() {
            "pro" => "Pro".to_owned(),
            "pro_plus" => "Pro+".to_owned(),
            "max" => "Max".to_owned(),
            _ => tier,
        });
    let account = Account { email: None, plan };
    let credits_unit = || Unit::Count("credits".into());
    // Rolled-over credits can leave more than the grant; the reported total
    // stays the denominator, so that reads as nothing used.
    let report = match (remaining, total) {
        (Some(remaining), Some(total)) if total > 0. => {
            let used = (total - remaining).max(0.) / total * 100.;
            Report::new(
                Provider(&Raycast),
                account,
                vec![Window::new(Kind::Monthly, used, renewal, Some(MONTH))],
            )
            .with_balances([Balance::new("Credits left", remaining, credits_unit()).out_of(total)])
        }
        _ => {
            let mut facts = Vec::new();
            if let Some(remaining) = remaining {
                facts.push(("Left".into(), trimmed(remaining)));
            }
            if let Some(total) = total {
                facts.push(("Total".into(), trimmed(total)));
            }
            if let Some(renewal) = renewal {
                let at = chrono::DateTime::<chrono::Utc>::from(renewal);
                facts.push(("Renews".into(), at.format("%b %-d").to_string()));
            }
            Report::new(Provider(&Raycast), account, Vec::new())
                .with_balances(
                    remaining
                        .map(|remaining| Balance::new("Credits left", remaining, credits_unit())),
                )
                .with_sections([Section::Facts {
                    title: "Credits".into(),
                    facts,
                }])
        }
    };
    Ok(report)
}

#[derive(Deserialize)]
struct Credits {
    #[serde(default, deserialize_with = "number")]
    remaining_balance_credits: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    total_balance_credits: Option<f64>,
    next_credits_at: Option<Timestamp>,
    funding_subscription: Option<Funding>,
}

#[derive(Deserialize)]
struct Funding {
    tier: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn credits_become_a_monthly_window() {
        let body = r#"{
          "remaining_balance_credits": "125",
          "total_balance_credits": "500",
          "next_credits_at": "2026-10-18T00:00:00.000Z",
          "funding_subscription": {"tier": "pro", "status": "active"}
        }"#;
        let report = parse(body).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        assert_eq!(report.windows.len(), 1);
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 75.).abs() < 0.01);
        assert!(window.resets_at.is_some());
        assert_eq!(window.length, Some(MONTH));
        assert_eq!(report.balances[0].amount, 125.);
        assert_eq!(report.balances[0].total, Some(500.));
    }

    #[test]
    fn rollover_above_the_grant_uses_nothing() {
        let body = r#"{"remaining_balance_credits": 750, "total_balance_credits": 500,
            "funding_subscription": {"tier": "pro_plus"}}"#;
        let report = parse(body).unwrap();
        assert_eq!(report.windows[0].used, 0.);
        assert_eq!(report.account.plan.as_deref(), Some("Pro+"));
    }

    #[test]
    fn zero_total_keeps_rows_instead_of_a_meter() {
        let body = r#"{"remaining_balance_credits": "12.5", "total_balance_credits": 0}"#;
        let report = parse(body).unwrap();
        assert!(report.windows.is_empty());
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0], ("Left".into(), "12.5".into()));
        assert_eq!(facts[1], ("Total".into(), "0".into()));
    }

    #[test]
    fn missing_or_negative_amounts_fail() {
        assert!(parse(r#"{"funding_subscription": {"tier": "pro"}}"#).is_err());
        assert!(parse(r#"{"remaining_balance_credits": -1, "total_balance_credits": 5}"#).is_err());
    }
}
