//! Venice balances. The sign-in is, in CodexBar's order, an API key
//! (`api_key`, or `VENICE_API_KEY`/`VENICE_KEY` here or on the probed host)
//! read against the billing balance endpoint, else a signed-in venice.ai web
//! session (`cookie`, or Chrome/Safari when listed) whose session token
//! carries the subscription-credit claims.
//!
//! Not ported: CodexBar reassembles a session cookie Chrome split into
//! numbered chunks (`__venice-auth.session-token.0`, `.1`, …); automatic
//! import here only takes the unsplit cookie, and a chunked one must be
//! pasted as a whole `cookie` header.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json, number},
    },
};
use serde::Deserialize;
use serde_json::error::Category;
use std::time::{Duration, SystemTime};

const BALANCE_URL: &str = "https://api.venice.ai/api/v1/billing/balance";
const SESSION_URL: &str = "https://outerface.venice.ai/api/user/session";
const SESSION_COOKIE: &str = "__venice-auth.session-token";
/// A token that expired within this long ago still counts, for clock skew.
const EXPIRY_SKEW: Duration = Duration::from_secs(60);

pub(crate) struct Venice;

static META: Meta = Meta::new("venice", "Venice")
    .dashboard("https://venice.ai/settings/api")
    .settings(&[
        Setting::new(
            "api_key",
            &["VENICE_API_KEY", "VENICE_KEY"],
            "A Venice API key from https://venice.ai/settings/api. It reads the USD and \
             DIEM API balance.",
        ),
        Setting::new(
            "cookie",
            &[],
            "Used when no API key is set, for subscription credits. Sign in to \
             https://venice.ai, open Developer Tools > Application > Cookies for \
             https://venice.ai, and copy the __venice-auth.session-token cookie (or every \
             __venice-auth.session-token.N chunk when it is split). Paste them as \
             \"name=value; name2=value2\".",
        ),
    ]);

impl Service for Venice {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("VENICE_API_KEY"))
            .or_else(|| probe.env("VENICE_KEY"));
        if let Some(key) = key {
            let request = Request::get(BALANCE_URL)
                .bearer(&key)
                .header("Accept", "application/json");
            return Some(probe.body(request).and_then(|body| parse_balance(&body)));
        }
        let cookie = probe.cookies(&["venice.ai"], &[SESSION_COOKIE])?;
        let request = Request::get(SESSION_URL)
            .cookie(&cookie)
            .header("Accept", "application/json");
        Some(
            probe
                .body(request)
                .and_then(|body| parse_session(&body, SystemTime::now())),
        )
    }
}

/// The API key's balance: USD, DIEM, or both, and whether it can be spent.
pub(crate) fn parse_balance(body: &str) -> Result<Report> {
    let answer: BalanceAnswer = json(body)?;
    let can_consume = answer.can_consume.ok_or(Error::UsageJson(Category::Data))?;
    let balances = answer.balances.ok_or(Error::UsageJson(Category::Data))?;
    let currency = answer
        .consumption_currency
        .map(|currency| currency.trim().to_uppercase())
        .filter(|currency| !currency.is_empty());
    let allocation = answer.diem_epoch_allocation.filter(|total| *total > 0.);
    let usd = balances
        .usd
        .map(|usd| Balance::new("USD", usd, Unit::Currency("USD".into())));
    let diem = balances.diem.map(|diem| {
        let balance = Balance::new("DIEM", diem, Unit::Count("DIEM".into()));
        match allocation {
            Some(total) => balance.out_of(total),
            None => balance,
        }
    });
    // The currency API calls spend comes first, so the status bar shows it.
    let ordered = if currency.as_deref() == Some("USD") {
        [usd, diem]
    } else {
        [diem, usd]
    };
    // DIEM spent from its epoch allocation is a real quota; its reset is not
    // reported, so the window carries no length or reset time.
    let windows = match (can_consume, currency.as_deref(), balances.diem, allocation) {
        (true, Some(currency), Some(diem), Some(total)) if currency != "USD" => vec![Window::new(
            Kind::Named("DIEM allocation".into()),
            (total - diem) / total * 100.,
            None,
            None,
        )],
        _ => Vec::new(),
    };
    let status = (!can_consume).then(|| Section::Facts {
        title: "Status".into(),
        facts: vec![(
            "API calls".into(),
            "Balance unavailable for API calls".into(),
        )],
    });
    Ok(Report::new(Provider(&Venice), Account::default(), windows)
        .with_balances(ordered.into_iter().flatten())
        .with_sections(status))
}

/// The web session answer: a JWT whose claims carry the subscription credits.
/// Only the claims are read; the token itself is neither kept nor verified.
pub(crate) fn parse_session(body: &str, now: SystemTime) -> Result<Report> {
    let session: Session = json(body)?;
    let token = session
        .token
        .filter(|token| !token.trim().is_empty())
        .ok_or(Error::UsageRejected)?;
    let payload = token
        .split('.')
        .nth(1)
        .and_then(base64url)
        .ok_or(Error::UsageJson(Category::Syntax))?;
    let claims: Claims =
        serde_json::from_slice(&payload).map_err(|error| Error::UsageJson(error.classify()))?;
    let expires = claims
        .exp
        .filter(|exp| (1e9..=4e9).contains(exp))
        .and_then(|exp| SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs_f64(exp)))
        .ok_or(Error::UsageRejected)?;
    if expires + EXPIRY_SKEW < now {
        return Err(Error::UsageRejected);
    }
    let user_type = claims
        .user_type
        .map(|kind| kind.trim().to_owned())
        .filter(|kind| !kind.is_empty());
    if user_type.as_deref().is_some_and(|kind| {
        [
            "anonymous",
            "anon",
            "guest",
            "unauthenticated",
            "logged_out",
        ]
        .contains(&kind.to_lowercase().as_str())
    }) {
        return Err(Error::UsageRejected);
    }
    let usage = claims
        .bundled_credits_usage
        .ok_or(Error::UsageJson(Category::Data))?;
    let used = usage
        .used_this_cycle
        .filter(|used| *used >= 0.)
        .ok_or(Error::UsageJson(Category::Data))?;
    let refill = usage
        .monthly_refill_credits
        .filter(|refill| *refill > 0.)
        .ok_or(Error::UsageJson(Category::Data))?;
    let credits = || Unit::Count("credits".into());
    let available = usage
        .available_credits
        .or(claims.bundled_credits)
        .filter(|credits| *credits >= 0.)
        .map(|amount| Balance::new("Subscription credits", amount, credits()));
    let total = claims
        .venice_credits
        .filter(|credits| *credits >= 0.)
        .map(|amount| Balance::new("Total credits", amount, credits()));
    // Monthly refill is not a spending cap: banked credits can outlast it,
    // so spend is shown against it without a quota window.
    let spent = Balance::new("Used this cycle", used, credits()).out_of(refill);
    let mut facts = Vec::new();
    if let Some(cap) = usage.tier_cap.filter(|cap| *cap >= 0.) {
        facts.push((
            "Bank cap".to_owned(),
            format!("{} credits", group(cap.round() as i64)),
        ));
    }
    if let Some(refill_at) = usage
        .next_refill_at
        .map(|millis| millis / 1000.)
        .filter(|seconds| (1e9..=4e9).contains(seconds))
        .and_then(|seconds| chrono::DateTime::from_timestamp(seconds as i64, 0))
    {
        facts.push((
            "Next refill".into(),
            refill_at.format("%b %-d, %Y").to_string(),
        ));
    }
    let section = (!facts.is_empty()).then(|| Section::Facts {
        title: "Credits".into(),
        facts,
    });
    let account = Account {
        email: None,
        plan: user_type,
    };
    Ok(Report::new(Provider(&Venice), account, Vec::new())
        .with_balances(available.into_iter().chain(total).chain([spent]))
        .with_sections(section))
}

/// Base64url without padding, as JWT segments are encoded.
fn base64url(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for byte in input.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'-' | b'+' => 62,
            b'_' | b'/' => 63,
            b'=' => break,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    Some(out)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceAnswer {
    can_consume: Option<bool>,
    consumption_currency: Option<String>,
    balances: Option<Balances>,
    #[serde(default, deserialize_with = "number")]
    diem_epoch_allocation: Option<f64>,
}

#[derive(Deserialize)]
struct Balances {
    #[serde(default, deserialize_with = "number")]
    diem: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    usd: Option<f64>,
}

#[derive(Deserialize)]
struct Session {
    token: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Claims {
    #[serde(default, deserialize_with = "number")]
    exp: Option<f64>,
    user_type: Option<String>,
    bundled_credits_usage: Option<CreditsUsage>,
    #[serde(default, deserialize_with = "number")]
    bundled_credits: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    venice_credits: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreditsUsage {
    #[serde(default, deserialize_with = "number")]
    used_this_cycle: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    monthly_refill_credits: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    available_credits: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    tier_cap: Option<f64>,
    /// Milliseconds since the epoch.
    #[serde(default, deserialize_with = "number")]
    next_refill_at: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn encode(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let n = chunk
                .iter()
                .enumerate()
                .fold(0u32, |n, (i, b)| n | (u32::from(*b) << (16 - 8 * i)));
            for i in 0..=chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            }
        }
        out
    }

    fn session(claims: &str) -> String {
        format!(
            r#"{{"token": "{}.{}.signature"}}"#,
            encode(br#"{"alg":"HS256"}"#),
            encode(claims.as_bytes())
        )
    }

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn diem_allocation_is_a_window() {
        let report = parse_balance(
            r#"{"canConsume": true, "consumptionCurrency": "DIEM",
                "balances": {"diem": "90.50", "usd": null}, "diemEpochAllocation": "100.0"}"#,
        )
        .unwrap();
        assert_eq!(report.windows.len(), 1);
        assert!((report.windows[0].used - 9.5).abs() < 1e-4);
        assert_eq!(
            report.balances,
            vec![Balance::new("DIEM", 90.5, Unit::Count("DIEM".into())).out_of(100.)]
        );
    }

    #[test]
    fn usd_consumption_puts_dollars_first() {
        let report = parse_balance(
            r#"{"canConsume": true, "consumptionCurrency": "USD",
                "balances": {"diem": 50.0, "usd": 12.34}, "diemEpochAllocation": 100.0}"#,
        )
        .unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "USD");
        assert!((report.balances[0].amount - 12.34).abs() < 1e-9);
        assert_eq!(report.balances[1].label, "DIEM");
    }

    #[test]
    fn unspendable_balance_is_flagged() {
        let report = parse_balance(
            r#"{"canConsume": false, "consumptionCurrency": "USD",
                "balances": {"diem": null, "usd": 100.0}, "diemEpochAllocation": null}"#,
        )
        .unwrap();
        assert_eq!(report.sections.len(), 1);
        assert!(matches!(
            parse_balance(r#"{"balances": {}}"#),
            Err(Error::UsageJson(_))
        ));
    }

    #[test]
    fn session_claims_become_credit_balances() {
        let body = session(
            r#"{"exp": 1790000000, "userType": "pro", "veniceCredits": 1500,
                "bundledCreditsUsage": {"usedThisCycle": 250, "monthlyRefillCredits": 1000,
                "availableCredits": 750.5, "tierCap": 3000, "nextRefillAt": 1790500000000}}"#,
        );
        let report = parse_session(&body, at(1_789_000_000)).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("pro"));
        let credits = Unit::Count("credits".into());
        assert_eq!(
            report.balances,
            vec![
                Balance::new("Subscription credits", 750.5, credits.clone()),
                Balance::new("Total credits", 1500., credits.clone()),
                Balance::new("Used this cycle", 250., credits).out_of(1000.),
            ]
        );
        let Some(Section::Facts { facts, .. }) = report.sections.first() else {
            panic!("expected credit facts");
        };
        assert_eq!(
            facts[0],
            ("Bank cap".to_owned(), "3,000 credits".to_owned())
        );
        assert_eq!(facts[1].0, "Next refill");
    }

    #[test]
    fn expired_or_anonymous_sessions_are_rejected() {
        let expired = session(
            r#"{"exp": 1700000000, "bundledCreditsUsage":
                {"usedThisCycle": 1, "monthlyRefillCredits": 10}}"#,
        );
        assert!(matches!(
            parse_session(&expired, at(1_789_000_000)),
            Err(Error::UsageRejected)
        ));
        let anonymous = session(r#"{"exp": 1790000000, "userType": "guest"}"#);
        assert!(matches!(
            parse_session(&anonymous, at(1_789_000_000)),
            Err(Error::UsageRejected)
        ));
    }
}
