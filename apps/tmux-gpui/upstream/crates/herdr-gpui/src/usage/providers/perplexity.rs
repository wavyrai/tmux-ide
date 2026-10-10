//! Perplexity credits, read from `GET /rest/billing/credits` with a
//! perplexity.ai web session: the `cookie` setting (or `PERPLEXITY_COOKIE`,
//! or Chrome/Safari when Perplexity is listed in `show_providers`), else a
//! bare `session_token` (`PERPLEXITY_SESSION_TOKEN`), tried under each of
//! the four session cookie names Perplexity has used, as CodexBar does.
//!
//! Usage is attributed recurring credits first, then purchased, then bonus,
//! as CodexBar does. Not ported: CodexBar reassembles a session cookie split
//! into numbered chunks into one value; here chunks are sent as they are,
//! which the site's own session library also accepts.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
    },
};
use serde::Deserialize;
use std::time::SystemTime;

const URL: &str = "https://www.perplexity.ai/rest/billing/credits?version=2.18&source=default";
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";
const SESSION_NAMES: &[&str] = &[
    "__Secure-authjs.session-token",
    "authjs.session-token",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
];
/// The session names and the first chunks of a session split across cookies.
const COOKIE_NAMES: &[&str] = &[
    "__Secure-authjs.session-token",
    "__Secure-authjs.session-token.0",
    "__Secure-authjs.session-token.1",
    "__Secure-authjs.session-token.2",
    "authjs.session-token",
    "__Secure-next-auth.session-token",
    "__Secure-next-auth.session-token.0",
    "__Secure-next-auth.session-token.1",
    "__Secure-next-auth.session-token.2",
    "next-auth.session-token",
];

pub(crate) struct Perplexity;

static META: Meta = Meta::new("perplexity", "Perplexity")
    .dashboard("https://www.perplexity.ai/account/usage")
    .status_page("https://status.perplexity.com")
    .settings(&[
        Setting::new(
            "cookie",
            &["PERPLEXITY_COOKIE"],
            "The perplexity.ai web session. Sign in at https://www.perplexity.ai, open \
             Developer Tools → Application → Cookies → https://www.perplexity.ai, copy the \
             session cookie (__Secure-next-auth.session-token, or __Secure-authjs.session-token \
             on newer sign-ins), and paste it as \"name=value\".",
        ),
        Setting::new(
            "session_token",
            &["PERPLEXITY_SESSION_TOKEN"],
            "Alternatively, only the value of that session cookie; each session cookie name \
             is tried in turn.",
        ),
    ]);

impl Service for Perplexity {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        if let Some(cookie) = probe.cookies(&["www.perplexity.ai", "perplexity.ai"], COOKIE_NAMES) {
            return Some(
                credits(probe, &cookie, "").and_then(|body| parse(&body, SystemTime::now())),
            );
        }
        let token = probe.setting("session_token")?;
        let mut outcome = Err(Error::UsageRejected);
        for name in SESSION_NAMES {
            outcome = credits(probe, &token, &format!("{name}="));
            if !matches!(outcome, Err(Error::UsageRejected)) {
                break;
            }
        }
        Some(outcome.and_then(|body| parse(&body, SystemTime::now())))
    }
}

/// The credits answer, with the session sent as `Cookie: <prefix><secret>`.
fn credits(probe: &mut Probe, session: &Secret, prefix: &str) -> Result<String> {
    let request = Request::get(URL)
        .secret_header("Cookie", prefix, session)
        .header("Accept", "application/json")
        .header("Origin", "https://www.perplexity.ai")
        .header("Referer", "https://www.perplexity.ai/account/usage")
        .header("User-Agent", AGENT);
    probe.body(request)
}

pub(crate) fn parse(body: &str, now: SystemTime) -> Result<Report> {
    let credits: Credits = json(body)?;
    let sum = |kind: &str| -> f64 {
        credits
            .credit_grants
            .iter()
            .filter(|grant| grant.kind == kind)
            .filter(|grant| kind != "promotional" || grant.live(now))
            .map(|grant| grant.amount_cents)
            .sum::<f64>()
            .max(0.)
    };
    let recurring = sum("recurring");
    let promo = sum("promotional");
    let purchased = sum("purchased").max(credits.current_period_purchased_cents);
    let mut remaining = credits.total_usage_cents;
    let recurring_used = remaining.min(recurring);
    remaining -= recurring_used;
    let purchased_used = remaining.min(purchased);
    remaining -= purchased_used;
    let promo_used = remaining.min(promo);
    let renewal = credits.renewal_date_ts.time();
    let window = if recurring > 0. {
        Some(Window::new(
            Kind::Monthly,
            recurring_used / recurring * 100.,
            renewal,
            Some(MONTH),
        ))
    } else if promo > 0. || purchased > 0. {
        None
    } else {
        Some(Window::new(Kind::Monthly, 100., renewal, Some(MONTH)))
    };
    let pool = |label: &str, used: f64, total: f64| {
        (total > 0.).then(|| {
            Balance::new(label, (total - used).max(0.), Unit::Count("credits".into())).out_of(total)
        })
    };
    let balances = [
        pool("Bonus credits", promo_used, promo),
        pool("Purchased credits", purchased_used, purchased),
    ];
    let whole = |value: f64| group(value.round() as i64);
    let mut facts = vec![(
        "Credits".to_owned(),
        format!("{} of {}", whole(recurring_used), whole(recurring)),
    )];
    let expiry = credits
        .credit_grants
        .iter()
        .filter(|grant| grant.kind == "promotional" && grant.live(now))
        .filter_map(|grant| grant.expires_at_ts.as_ref()?.time())
        .min();
    if let Some(expiry) = expiry {
        facts.push((
            "Bonus expires".to_owned(),
            chrono::DateTime::<chrono::Utc>::from(expiry)
                .format("%b %-d, %Y")
                .to_string(),
        ));
    }
    let plan = (recurring > 0.)
        .then_some(if recurring < 5000. { "Pro" } else { "Max" })
        .map(str::to_owned);
    Ok(Report::new(
        Provider(&Perplexity),
        Account { email: None, plan },
        window.into_iter().collect(),
    )
    .with_balances(balances.into_iter().flatten())
    .with_sections([Section::Facts {
        title: "Credits".into(),
        facts,
    }]))
}

#[derive(Deserialize)]
struct Credits {
    #[serde(alias = "renewalDateTs")]
    renewal_date_ts: Timestamp,
    #[serde(alias = "currentPeriodPurchasedCents")]
    current_period_purchased_cents: f64,
    #[serde(alias = "totalUsageCents")]
    total_usage_cents: f64,
    #[serde(alias = "creditGrants")]
    credit_grants: Vec<Grant>,
}

#[derive(Deserialize)]
struct Grant {
    #[serde(rename = "type")]
    kind: String,
    #[serde(alias = "amountCents")]
    amount_cents: f64,
    #[serde(alias = "expiresAtTs")]
    expires_at_ts: Option<Timestamp>,
}

impl Grant {
    /// A grant without an expiry never expires.
    fn live(&self, now: SystemTime) -> bool {
        self.expires_at_ts
            .as_ref()
            .and_then(Timestamp::time)
            .is_none_or(|at| at > now)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::Duration;

    const NOW: u64 = 1_780_000_000;
    const RENEWAL: u64 = 1_781_000_000;
    const FUTURE: u64 = 1_790_000_000;

    fn now() -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(NOW)
    }

    /// CodexBar's full-response fixture.
    fn full() -> String {
        format!(
            r#"{{
              "balance_cents": 7250,
              "renewal_date_ts": {RENEWAL},
              "current_period_purchased_cents": 0,
              "credit_grants": [
                {{"type": "recurring", "amount_cents": 10000, "expires_at_ts": {FUTURE}}},
                {{"type": "promotional", "amount_cents": 20000, "expires_at_ts": {FUTURE}}}
              ],
              "total_usage_cents": 2750
            }}"#
        )
    }

    #[test]
    fn reads_recurring_and_bonus_credits() {
        let report = parse(&full(), now()).unwrap();
        assert_eq!(report.provider.id(), "perplexity");
        assert_eq!(report.account.plan.as_deref(), Some("Max"));
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Monthly);
        assert!((window.used - 27.5).abs() < 1e-4);
        assert_eq!(
            window.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(RENEWAL))
        );
        assert_eq!(report.balances.len(), 1);
        assert_eq!(report.balances[0].label, "Bonus credits");
        assert_eq!(report.balances[0].amount, 20_000.);
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(
            facts[0],
            ("Credits".to_owned(), "2,750 of 10,000".to_owned())
        );
    }

    #[test]
    fn usage_spills_into_purchased_then_bonus() {
        let body = format!(
            r#"{{"balance_cents": 0, "renewal_date_ts": {RENEWAL},
              "current_period_purchased_cents": 3000,
              "credit_grants": [
                {{"type": "recurring", "amount_cents": 5000, "expires_at_ts": {FUTURE}}},
                {{"type": "promotional", "amount_cents": 4000, "expires_at_ts": {FUTURE}}}
              ],
              "total_usage_cents": 9000}}"#
        );
        let report = parse(&body, now()).unwrap();
        assert_eq!(report.windows[0].percent(), 100);
        let bonus = &report.balances[0];
        assert_eq!((bonus.amount, bonus.total), (3000., Some(4000.)));
        let purchased = &report.balances[1];
        assert_eq!((purchased.amount, purchased.total), (0., Some(3000.)));
    }

    #[test]
    fn expired_bonus_is_ignored() {
        let body = format!(
            r#"{{"balanceCents": 0, "renewalDateTs": {RENEWAL}, "currentPeriodPurchasedCents": 0,
              "creditGrants": [{{"type": "promotional", "amountCents": 500, "expiresAtTs": 1}}],
              "totalUsageCents": 0}}"#
        );
        let report = parse(&body, now()).unwrap();
        assert!(report.balances.is_empty());
        assert_eq!(report.account.plan, None);
        assert_eq!(report.windows[0].percent(), 100);
    }
}
