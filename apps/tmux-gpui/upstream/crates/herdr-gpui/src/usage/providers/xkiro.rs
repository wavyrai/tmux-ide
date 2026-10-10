//! xKiro daily free-token allowance, read from the unmetered usage API with
//! an API key from the config or `XKIRO_API_KEY`, as CodexBar does. CodexBar
//! imports no cookies and starts no login flow for xKiro, and neither does
//! this.
//!
//! The counters are account-wide and reset at 00:00 UTC. A missing counter
//! stays unknown and a null daily limit is shown as uncapped, so no
//! percentage is invented. The wallet balance, which CodexBar leaves out, is
//! shown as a balance when present; it never feeds the daily window.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, DAY, Kind, Provider, Report, Section, Unit, Window, group},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, json},
        values::{invalid, number},
    },
};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::time::{Duration, SystemTime};

const URL: &str = "https://api.xkiro.com/v1/usage";
/// JavaScript's safe-integer limit, which CodexBar requires of counters.
const MAX_COUNTER: u64 = (1 << 53) - 1;

pub(crate) struct Xkiro;

static META: Meta = Meta::new("xkiro", "xKiro")
    .dashboard("https://xkiro.com")
    .settings(&[Setting::new(
        "api_key",
        &["XKIRO_API_KEY"],
        "An xKiro API key from your account at https://xkiro.com. It is sent only to \
         api.xkiro.com; reading usage spends no tokens.",
    )]);

impl Service for Xkiro {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let key = probe.setting("api_key")?;
        Some(
            probe
                .body(Request::get(URL).bearer(&key))
                .and_then(|body| parse(&body, SystemTime::now())),
        )
    }
}

pub(crate) fn parse(body: &str, now: SystemTime) -> Result<Report> {
    let usage: Usage = json(body)?;
    let free = match (usage.object.as_deref(), usage.free_tokens) {
        (Some("usage"), Some(free)) => free,
        _ => return Err(invalid()),
    };
    let uncapped = matches!(free.limit_per_day, Some(None));
    let used = counter(free.used_today.flatten())?;
    let limit = counter(free.limit_per_day.flatten())?;
    let remaining = counter(free.remaining.flatten())?;
    if used.is_none() && limit.is_none() && remaining.is_none() && !uncapped {
        return Err(invalid());
    }

    let windows = match (used, limit) {
        (Some(used), Some(limit)) => {
            let percent = if limit == 0 {
                100.
            } else {
                used as f64 / limit as f64 * 100.
            };
            vec![Window::new(
                Kind::Daily,
                percent,
                next_utc_midnight(now),
                Some(DAY),
            )]
        }
        _ => Vec::new(),
    };

    let tokens = |value: u64| group(i64::try_from(value).unwrap_or(i64::MAX));
    let mut facts = Vec::new();
    if let Some(used) = used {
        facts.push(("Tokens used today".to_owned(), tokens(used)));
    }
    match limit {
        Some(limit) => facts.push(("Daily allowance".to_owned(), tokens(limit))),
        None if uncapped => {
            facts.push(("Daily allowance".to_owned(), "No cap reported".to_owned()))
        }
        None => {}
    }
    if let Some(remaining) = remaining {
        facts.push(("Tokens remaining".to_owned(), tokens(remaining)));
    }
    facts.push(("Daily reset".to_owned(), "00:00 UTC".to_owned()));

    let text = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    let plan = match &usage.plan {
        Some(Value::Null) => Some("Pay as you go".to_owned()),
        plan => text(plan.as_ref()),
    };
    let email = text(usage.user.as_ref().and_then(|user| user.get("email")));
    let wallet = usage
        .wallet
        .as_ref()
        .and_then(|wallet| wallet.get("balance_usd"))
        .and_then(number)
        .map(|balance| Balance::new("Wallet", balance, Unit::Currency("USD".into())));

    Ok(
        Report::new(Provider(&Xkiro), Account { email, plan }, windows)
            .with_balances(wallet)
            .with_sections([Section::Facts {
                title: "Free tokens".into(),
                facts,
            }]),
    )
}

/// A counter is a non-negative whole number or absent; anything else means
/// the response is not what the counters are documented as.
fn counter(value: Option<Value>) -> Result<Option<u64>> {
    match value {
        None => Ok(None),
        Some(value) => value
            .as_u64()
            .filter(|count| *count <= MAX_COUNTER)
            .map(Some)
            .ok_or_else(invalid),
    }
}

fn next_utc_midnight(now: SystemTime) -> Option<SystemTime> {
    let seconds = now.duration_since(SystemTime::UNIX_EPOCH).ok()?.as_secs();
    let next = (seconds / DAY.as_secs() + 1) * DAY.as_secs();
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(next))
}

/// Keeps a field sent as `null` apart from one left out: a null daily limit
/// means uncapped, while a missing one is unknown.
fn present<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Option<Value>>, D::Error> {
    let value = Value::deserialize(deserializer)?;
    Ok(Some((!value.is_null()).then_some(value)))
}

#[derive(Deserialize)]
struct Usage {
    object: Option<String>,
    /// Kept as a value so a null plan (pay as you go) differs from none.
    #[serde(default, deserialize_with = "plan")]
    plan: Option<Value>,
    user: Option<Value>,
    free_tokens: Option<FreeTokens>,
    wallet: Option<Value>,
}

fn plan<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> std::result::Result<Option<Value>, D::Error> {
    Value::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct FreeTokens {
    #[serde(default, deserialize_with = "present")]
    used_today: Option<Option<Value>>,
    #[serde(default, deserialize_with = "present")]
    limit_per_day: Option<Option<Value>>,
    #[serde(default, deserialize_with = "present")]
    remaining: Option<Option<Value>>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::Error;

    /// https://docs.xkiro.com/api/usage/: the PAYG example CodexBar tests
    /// with, with a synthetic identity.
    const FIXTURE: &str = r#"{"object":"usage","plan":null,"user":{"email":"dev@example.com"},"windows":[],
        "free_tokens":{"used_today":124035,"limit_per_day":5000000,"remaining":4875965},
        "wallet":{"balance_usd":"4.812300","held_usd":"0.150000"}}"#;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    fn facts(report: &Report) -> Vec<String> {
        match report.sections.as_slice() {
            [Section::Facts { facts, .. }] => {
                facts.iter().map(|(_, value)| value.clone()).collect()
            }
            sections => panic!("unexpected sections {sections:?}"),
        }
    }

    #[test]
    fn reads_the_daily_free_token_window() {
        let report = parse(FIXTURE, at(1_790_251_200)).unwrap();
        assert_eq!(report.windows.len(), 1);
        let window = &report.windows[0];
        assert_eq!(window.kind, Kind::Daily);
        assert!((window.used - 2.4807).abs() < 0.0001);
        assert_eq!(window.resets_at, Some(at(1_790_294_400)));
        assert_eq!(window.length, Some(DAY));
        assert_eq!(report.account.email.as_deref(), Some("dev@example.com"));
        assert_eq!(report.account.plan.as_deref(), Some("Pay as you go"));
        assert_eq!(
            facts(&report),
            ["124,035", "5,000,000", "4,875,965", "00:00 UTC"]
        );
        assert_eq!(report.balances.len(), 1);
        assert_eq!(report.balances[0].text(), "$4.81");
    }

    #[test]
    fn missing_counters_and_uncapped_accounts_invent_no_headroom() {
        for (fields, expected) in [
            (
                r#""used_today":0,"limit_per_day":null,"remaining":null"#,
                vec!["0", "No cap reported", "00:00 UTC"],
            ),
            (r#""remaining":12"#, vec!["12", "00:00 UTC"]),
            (r#""limit_per_day":500000"#, vec!["500,000", "00:00 UTC"]),
        ] {
            let body = format!(r#"{{"object":"usage","free_tokens":{{{fields}}}}}"#);
            let report = parse(&body, at(1_790_251_200)).unwrap();
            assert!(report.windows.is_empty(), "{fields}");
            assert_eq!(report.account, Account::default(), "{fields}");
            assert_eq!(facts(&report), expected, "{fields}");
        }
    }

    #[test]
    fn exhaustion_and_zero_allowance_are_full() {
        for limit in [0, 500_000] {
            let body = format!(
                r#"{{"object":"usage","plan":"pro","free_tokens":{{"used_today":{limit},"limit_per_day":{limit},"remaining":0}}}}"#
            );
            let report = parse(&body, at(1_790_251_200)).unwrap();
            assert_eq!(report.windows[0].used, 100.);
            assert_eq!(report.account.plan.as_deref(), Some("pro"));
            assert!(report.balances.is_empty());
        }
    }

    #[test]
    fn rejects_invalid_counters_and_shapes() {
        for value in [
            "-1",
            "0.5",
            "true",
            "\"private-response\"",
            "9007199254740992",
            "{}",
            "[]",
        ] {
            let body = format!(r#"{{"object":"usage","free_tokens":{{"used_today":{value}}}}}"#);
            assert!(
                matches!(parse(&body, at(0)), Err(Error::UsageJson(_))),
                "accepted {value}"
            );
        }
        for body in [
            "private-response",
            "null",
            "[]",
            "{}",
            r#"{"object":"usage","free_tokens":{}}"#,
            r#"{"object":"other","free_tokens":{"used_today":1}}"#,
        ] {
            assert!(
                matches!(parse(body, at(0)), Err(Error::UsageJson(_))),
                "accepted {body}"
            );
        }
    }
}
