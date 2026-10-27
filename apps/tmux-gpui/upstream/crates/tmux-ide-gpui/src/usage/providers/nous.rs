//! Nous Portal credits, read from `/api/oauth/account` with the OAuth access
//! token Hermes Agent's login stores in `$HERMES_HOME/auth.json` (default
//! `~/.hermes`) or its cross-profile copy `shared/nous_auth.json`, or with
//! `NOUS_PORTAL_ACCESS_TOKEN`. Portal API keys only work for inference.
//!
//! The token is never refreshed: Nous refresh tokens are single-use and a
//! replay revokes Hermes's whole session, so an expired token is reported for
//! `hermes` to renew. The token goes only to an HTTPS `base_url` override, a
//! `portal_base_url` Hermes stored under `nousresearch.com`, or the default
//! portal. Not ported: CodexBar's early expiry check from a JWT `exp` claim,
//! which would need the token revealed; `expires_at` stored by Hermes is
//! still honored.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const PORTAL: &str = "https://portal.nousresearch.com";
const TRUSTED: &str = "nousresearch.com";
/// Tokens this close to expiry are treated as expired.
const SKEW: Duration = Duration::from_secs(60);
/// Hermes pools a handful of Nous credentials at most.
const POOL: usize = 8;

pub(crate) struct Nous;

static META: Meta = Meta::new("nous", "Nous Portal")
    .dashboard("https://portal.nousresearch.com/usage")
    .settings(&[
        Setting::new(
            "token",
            &["NOUS_PORTAL_ACCESS_TOKEN"],
            "A Nous Portal OAuth access token, used instead of Hermes Agent's login in \
             ~/.hermes/auth.json (sign in with `hermes auth add nous`). It lasts about an \
             hour; portal API keys are not accepted.",
        ),
        Setting::new(
            "base_url",
            &["NOUS_PORTAL_BASE_URL", "HERMES_PORTAL_BASE_URL"],
            "An HTTPS portal origin such as https://portal.nousresearch.com, for a preview \
             deployment. Plain HTTP is refused.",
        ),
    ]);

impl Service for Nous {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let (token, stored_portal) = match probe.setting("token") {
            Some(token) => (token, None),
            None => match hermes(probe)? {
                Ok(found) => found,
                Err(error) => return Some(Err(error)),
            },
        };
        let portal = probe
            .text_setting("base_url")
            .and_then(|url| origin(&url))
            .or_else(|| {
                stored_portal
                    .as_deref()
                    .and_then(origin)
                    .filter(|url| trusted(url))
            })
            .unwrap_or_else(|| PORTAL.to_owned());
        Some(
            probe
                .body(Request::get(format!("{portal}/api/oauth/account")).bearer(&token))
                .and_then(|body| parse(&body)),
        )
    }
}

/// Hermes's stored token and portal, from the first auth file with an
/// unexpired one. Some(Err) when a login exists but every token expired.
fn hermes(probe: &mut Probe) -> Option<Result<(Secret, Option<String>)>> {
    let now = SystemTime::now();
    let mut expired = false;
    for rest in ["auth.json", "shared/nous_auth.json"] {
        let Some(file) = probe.file(&HostPath::env_or("HERMES_HOME", ".hermes", rest)) else {
            continue;
        };
        let Some(state) = state(probe, &file) else {
            continue;
        };
        let expires = probe
            .text(&file, &state.key("expires_at"))
            .and_then(|at| Timestamp::Text(at).time());
        if expires.is_some_and(|at| at <= now + SKEW) {
            expired = true;
            continue;
        }
        let Some(token) = probe.field(&file, &state.key("access_token")) else {
            continue;
        };
        let portal = probe.text(&file, &state.key("portal_base_url"));
        return Some(Ok((token, portal)));
    }
    expired.then_some(Err(Error::UsageRejected))
}

/// Where in an auth file the Nous state sits: `providers.nous`, the best
/// `credential_pool.nous[i]`, or the root.
enum State {
    Provider,
    Pool(usize),
    Root,
}

impl State {
    fn key<'a>(&self, name: &'a str) -> Vec<&'a str> {
        const INDICES: [&str; POOL] = ["0", "1", "2", "3", "4", "5", "6", "7"];
        match self {
            Self::Provider => vec!["providers", "nous", name],
            Self::Pool(index) => vec!["credential_pool", "nous", INDICES[*index], name],
            Self::Root => vec![name],
        }
    }
}

fn state(probe: &mut Probe, file: &Secret) -> Option<State> {
    if probe
        .field(file, &State::Provider.key("access_token"))
        .is_some()
    {
        return Some(State::Provider);
    }
    // Hermes's own choice: the newest agent-key expiry, then the newest
    // access expiry, then the lowest priority.
    let mut best: Option<(usize, (f64, f64, i64))> = None;
    for index in 0..POOL {
        let state = State::Pool(index);
        if probe.field(file, &state.key("access_token")).is_none() {
            break;
        }
        let seconds = |text: Option<String>| {
            text.and_then(|at| Timestamp::Text(at).time())
                .and_then(|at| at.duration_since(SystemTime::UNIX_EPOCH).ok())
                .map_or(0., |at| at.as_secs_f64())
        };
        let rank = (
            seconds(probe.text(file, &state.key("agent_key_expires_at"))),
            seconds(probe.text(file, &state.key("expires_at"))),
            -probe
                .text(file, &state.key("priority"))
                .and_then(|priority| priority.parse::<i64>().ok())
                .unwrap_or(0),
        );
        if best.as_ref().is_none_or(|(_, top)| rank > *top) {
            best = Some((index, rank));
        }
    }
    if let Some((index, _)) = best {
        return Some(State::Pool(index));
    }
    probe
        .field(file, &State::Root.key("access_token"))
        .map(|_| State::Root)
}

/// An `https://host` origin without credentials, path, query, or fragment.
fn origin(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw.trim().trim_end_matches('/')).ok()?;
    let plain = url.scheme() == "https"
        && url.host_str().is_some_and(|host| !host.is_empty())
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none();
    plain.then(|| url.as_str().trim_end_matches('/').to_owned())
}

fn trusted(origin: &str) -> bool {
    url::Url::parse(origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| host == TRUSTED || host.ends_with(".nousresearch.com"))
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let account: AccountResponse = json(body)?;
    // The portal's own client treats any truthy `error` as a failure.
    if account.error.as_ref().is_some_and(truthy) {
        return Err(invalid());
    }
    let subscription = account.subscription.unwrap_or_default();
    let access = account.paid_service_access.unwrap_or_default();
    let monthly = subscription.monthly_credits;
    if monthly.is_some_and(|monthly| monthly < 0.) {
        return Err(invalid());
    }
    let remaining = subscription
        .credits_remaining
        .or(access.subscription_credits_remaining);
    let purchased = account
        .purchased_credits_remaining
        .or(access.purchased_credits_remaining);
    let rollover = subscription.rollover_credits;
    let total = access.total_usable_credits;
    if [monthly, remaining, rollover, purchased, total]
        .iter()
        .all(Option::is_none)
    {
        return Err(invalid());
    }
    let renews = subscription
        .current_period_end
        .as_ref()
        .and_then(Timestamp::time);
    let grant = monthly.filter(|monthly| *monthly > 0.);
    let windows = grant
        .zip(remaining)
        .map(|(grant, remaining)| {
            Window::new(
                Kind::Monthly,
                (grant - remaining.max(0.)).max(0.) / grant * 100.,
                renews,
                Some(MONTH),
            )
        })
        .into_iter()
        .collect();
    let usd = || Unit::Currency("USD".into());
    let mut balances = Vec::new();
    match (remaining, grant) {
        (Some(remaining), Some(grant)) => balances
            .push(Balance::new("Subscription credits", remaining.max(0.), usd()).out_of(grant)),
        (Some(remaining), None) => {
            balances.push(Balance::new(
                "Subscription credits",
                remaining.max(0.),
                usd(),
            ));
        }
        (None, Some(grant)) => balances.push(Balance::new("Monthly grant", grant, usd())),
        (None, None) => {}
    }
    balances.extend(purchased.map(|amount| Balance::new("Top-up credits", amount, usd())));
    balances.extend(total.map(|amount| Balance::new("Total usable", amount, usd())));
    let mut facts = Vec::new();
    if let Some(organization) = account
        .organisation
        .and_then(|organization| organization.name)
        .filter(|name| !name.trim().is_empty())
    {
        facts.push(("Organization".into(), organization.trim().to_owned()));
    }
    if let Some(rollover) = rollover.filter(|rollover| *rollover > 0.) {
        facts.push(("Rollover credits".into(), format!("${rollover:.2}")));
    }
    if let Some(renews) = renews {
        facts.push((
            "Renews".into(),
            chrono::DateTime::<chrono::Utc>::from(renews)
                .format("%b %-d")
                .to_string(),
        ));
    }
    let plan = subscription
        .plan
        .map(|plan| plan.trim().to_owned())
        .filter(|plan| !plan.is_empty())
        .or_else(|| {
            (access.has_active_subscription == Some(true)).then(|| "Subscription".to_owned())
        });
    let email = account
        .user
        .and_then(|user| user.email)
        .map(|email| email.trim().to_owned())
        .filter(|email| !email.is_empty());
    Ok(
        Report::new(Provider(&Nous), Account { email, plan }, windows)
            .with_balances(balances)
            .with_sections((!facts.is_empty()).then(|| Section::Facts {
                title: "Subscription".into(),
                facts,
            })),
    )
}

fn truthy(value: &serde_json::Value) -> bool {
    use serde_json::Value;
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

#[derive(Deserialize)]
struct AccountResponse {
    error: Option<serde_json::Value>,
    user: Option<User>,
    organisation: Option<Organisation>,
    subscription: Option<Subscription>,
    #[serde(default, deserialize_with = "number")]
    purchased_credits_remaining: Option<f64>,
    paid_service_access: Option<Access>,
}

#[derive(Deserialize)]
struct User {
    email: Option<String>,
}

#[derive(Deserialize)]
struct Organisation {
    name: Option<String>,
}

#[derive(Default, Deserialize)]
struct Subscription {
    plan: Option<String>,
    #[serde(default, deserialize_with = "number")]
    monthly_credits: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    credits_remaining: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    rollover_credits: Option<f64>,
    current_period_end: Option<Timestamp>,
}

#[derive(Default, Deserialize)]
struct Access {
    has_active_subscription: Option<bool>,
    #[serde(default, deserialize_with = "number")]
    subscription_credits_remaining: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    purchased_credits_remaining: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    total_usable_credits: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const ACCOUNT: &str = r#"{
      "user": {"email": "dev@example.com"},
      "organisation": {"name": "Example account"},
      "subscription": {
        "plan": "Ultra", "monthly_credits": 220, "credits_remaining": 55,
        "rollover_credits": 0, "current_period_end": "2026-10-12T04:29:00.000Z"
      },
      "purchased_credits_remaining": 19.25,
      "paid_service_access": {"has_active_subscription": true, "total_usable_credits": 74.25}
    }"#;

    #[test]
    fn keeps_subscription_and_purchased_credits_apart() {
        let report = parse(ACCOUNT).unwrap();
        assert_eq!(report.account.email.as_deref(), Some("dev@example.com"));
        assert_eq!(report.account.plan.as_deref(), Some("Ultra"));
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Monthly);
        assert_eq!(report.windows[0].used, 75.);
        assert!(report.windows[0].resets_at.is_some());
        let balances: Vec<_> = report
            .balances
            .iter()
            .map(|balance| (balance.label.as_str(), balance.amount, balance.total))
            .collect();
        assert_eq!(
            balances,
            [
                ("Subscription credits", 55., Some(220.)),
                ("Top-up credits", 19.25, None),
                ("Total usable", 74.25, None),
            ]
        );
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0], ("Organization".into(), "Example account".into()));
        assert_eq!(facts[1], ("Renews".into(), "Oct 12".into()));
    }

    #[test]
    fn reads_string_amounts_and_free_tier() {
        let body = r#"{"subscription": {"monthly_credits": "0"},
            "paid_service_access": {"purchased_credits_remaining": "3.5"}}"#;
        let report = parse(body).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances.len(), 1);
        assert_eq!(report.balances[0].amount, 3.5);
    }

    #[test]
    fn grant_without_remaining_has_no_meter() {
        let report = parse(r#"{"subscription":{"plan":"Ultra","monthly_credits":220}}"#).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.balances[0].label, "Monthly grant");
    }

    #[test]
    fn refuses_bodies_without_amounts() {
        assert!(parse(r#"{"user": {"email": "a@b.c"}}"#).is_err());
        assert!(parse(r#"{"error": "nope", "purchased_credits_remaining": 1}"#).is_err());
        assert!(parse(r#"{"subscription": {"monthly_credits": -1}}"#).is_err());
    }

    #[test]
    fn sends_the_token_to_trusted_https_origins_only() {
        assert_eq!(
            origin("https://preview.nousresearch.com/").as_deref(),
            Some("https://preview.nousresearch.com")
        );
        assert_eq!(origin("http://portal.nousresearch.com"), None);
        assert_eq!(origin("https://portal.nousresearch.com/api"), None);
        assert!(trusted("https://portal.nousresearch.com"));
        assert!(!trusted("https://nousresearch.com.evil.io"));
        assert!(!trusted("https://evilnousresearch.com"));
    }
}
