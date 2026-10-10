//! Droid (Factory) usage. The sign-in is, in CodexBar's order, a Factory API
//! key (`api_key`, or `FACTORY_API_KEY` here or on the probed host), else an
//! app.factory.ai web session (`cookie`, or the browser's cookies for a
//! provider listed in the config). Accounts on token-rate-limit billing show
//! their 5-hour, weekly, and monthly windows; older accounts their Standard
//! and Premium token allowances for the billing period.
//!
//! Not ported: `~/.factory/.env` (the probe reads a file only whole or as
//! JSON, not a dotenv line); WorkOS refresh tokens from Safari's localStorage
//! SQLite and Chromium's LevelDB, and minting access tokens from them or from
//! workos.com cookies, since the probe reads neither browser storage nor
//! writes the session store that keeps rotated refresh tokens.

use crate::{
    Error, Result,
    usage::{
        model::{
            Account, Balance, Kind, Provider, Report, SESSION, Section, Unit, WEEK, Window,
            title_case,
        },
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const API: &str = "https://api.factory.ai";
const APP: &str = "https://app.factory.ai";
const COOKIE_DOMAINS: [&str; 3] = ["factory.ai", "app.factory.ai", "auth.factory.ai"];
const COOKIE_NAMES: [&str; 8] = [
    "wos-session",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
    "__Secure-authjs.session-token",
    "__Host-authjs.csrf-token",
    "authjs.session-token",
    "session",
    "access-token",
];
/// Allowances above this are Factory's "unlimited".
const UNLIMITED: f64 = 1e12;

pub(crate) struct Factory;

enum Auth {
    Key(Secret),
    Cookie(Secret),
}

static META: Meta = Meta::new("factory", "Droid")
    .dashboard("https://app.factory.ai/settings/billing")
    .status_page("https://status.factory.ai")
    .settings(&[
        Setting::new(
            "api_key",
            &["FACTORY_API_KEY"],
            "A Factory API key (fk-…) from https://app.factory.ai/settings/api-keys.",
        ),
        Setting::new(
            "cookie",
            &[],
            "Used when no API key is set. Sign in to https://app.factory.ai, open \
             Developer Tools > Application > Cookies > https://app.factory.ai, and copy \
             the session cookies (wos-session, access-token, and any *.session-token) \
             as \"name=value; name2=value2\".",
        ),
    ]);

impl Service for Factory {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let auth = match probe
            .setting("api_key")
            .or_else(|| probe.env("FACTORY_API_KEY"))
        {
            Some(key) => Auth::Key(key),
            None => Auth::Cookie(probe.cookies(&COOKIE_DOMAINS, &COOKIE_NAMES)?),
        };
        Some(read(probe, &auth))
    }
}

fn request(url: String, auth: &Auth) -> Request {
    let request = Request::get(url)
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Origin", APP)
        .header("Referer", "https://app.factory.ai/")
        .header("x-factory-client", "web-app");
    match auth {
        Auth::Key(key) => request.bearer(key),
        Auth::Cookie(cookie) => request.cookie(cookie),
    }
}

fn read(probe: &mut Probe, auth: &Auth) -> Result<Report> {
    // The API host answers keys; the app host is the fallback. A rejection
    // is kept over later host noise such as a 404.
    let mut failure: Option<Error> = None;
    let mut found = None;
    for base in [API, APP] {
        match probe.body(request(format!("{base}/api/app/auth/me"), auth)) {
            Ok(body) => {
                found = Some((base, body));
                break;
            }
            Err(error) => {
                if !matches!(failure, Some(Error::UsageRejected)) {
                    failure = Some(error);
                }
            }
        }
    }
    let Some((base, me)) = found else {
        return Err(failure.unwrap_or(Error::UsageRejected));
    };
    let me = parse_me(&me)?;
    let now = SystemTime::now();

    let limits = probe
        .body(request(format!("{API}/api/billing/limits"), auth))
        .ok();
    if let Some(report) = limits.and_then(|body| parse_limits(&me, &body, now).ok().flatten()) {
        return Ok(report);
    }

    let mut url = format!("{base}/api/organization/subscription/usage?useCache=true");
    if let Some(user) = me.user_id() {
        url.push_str("&userId=");
        url.extend(url::form_urlencoded::byte_serialize(user.as_bytes()));
    }
    let body = probe.body(request(url, auth))?;
    parse_usage(&me, &body)
}

fn parse_me(body: &str) -> Result<Me> {
    json(body)
}

/// Token-rate-limit billing, or None when the account is not on it.
fn parse_limits(me: &Me, body: &str, now: SystemTime) -> Result<Option<Report>> {
    let billing: Billing = json(body)?;
    let Some(limits) = billing
        .limits
        .filter(|_| billing.uses_token_rate_limits_billing == Some(true))
    else {
        return Ok(None);
    };
    let windows = [
        (Kind::Session, &limits.standard.five_hour),
        (Kind::Weekly, &limits.standard.weekly),
        (Kind::Monthly, &limits.standard.monthly),
    ]
    .into_iter()
    .map(|(kind, window)| window.window(kind, now))
    .collect();
    let core = limits
        .core
        .as_ref()
        .filter(|core| core.has_usage())
        .map(|core| {
            [
                ("Core 5-hour", &core.five_hour, Some(SESSION)),
                ("Core weekly", &core.weekly, Some(WEEK)),
                ("Core monthly", &core.monthly, Kind::Monthly.length()),
            ]
            .into_iter()
            .map(|(name, window, length)| {
                Section::Limit(Window {
                    length,
                    ..window.window(Kind::Named(name.into()), now)
                })
            })
            .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let cents = billing.extra_usage_balance_cents.unwrap_or(0.);
    let balance = (cents > 0. || billing.extra_usage_allowed == Some(true)).then(|| {
        Balance::new(
            "Extra usage balance",
            cents / 100.,
            Unit::Currency("USD".into()),
        )
    });
    let plan = me.plan(billing.overage_preference.as_deref());
    Ok(Some(
        Report::new(Provider(&Factory), me.account(plan), windows)
            .with_balances(balance)
            .with_sections(core.into_iter().chain(me.organization())),
    ))
}

/// Standard and Premium token allowances over the billing period.
fn parse_usage(me: &Me, body: &str) -> Result<Report> {
    let usage: UsageAnswer = json(body)?;
    let usage = usage.usage.ok_or_else(invalid)?;
    let start = usage.start_date.as_ref().and_then(Timestamp::time);
    let end = usage.end_date.as_ref().and_then(Timestamp::time);
    let length = start
        .zip(end)
        .and_then(|(start, end)| end.duration_since(start).ok())
        .filter(|length| !length.is_zero());
    let windows: Vec<Window> = [("Standard", usage.standard), ("Premium", usage.premium)]
        .into_iter()
        .filter_map(|(name, tokens)| {
            let tokens = tokens?;
            Some(Window::new(
                Kind::Named(name.into()),
                tokens.used_percent(),
                end,
                length,
            ))
        })
        .collect();
    if windows.is_empty() {
        return Err(invalid());
    }
    let plan = me.plan(None);
    Ok(Report::new(Provider(&Factory), me.account(plan), windows).with_sections(me.organization()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Me {
    organization: Option<Organization>,
    user_profile: Option<UserProfile>,
}

impl Me {
    fn user_id(&self) -> Option<&str> {
        self.user_profile
            .as_ref()?
            .id
            .as_deref()
            .map(str::trim)
            .filter(|id| !id.is_empty())
    }

    /// `Factory Team - Pro - Fallback: credits`, as CodexBar shows it.
    fn plan(&self, overage: Option<&str>) -> Option<String> {
        let subscription = self.organization.as_ref()?.subscription.as_ref();
        let mut parts = Vec::new();
        if let Some(tier) = subscription
            .and_then(|subscription| subscription.factory_tier.as_deref())
            .filter(|tier| !tier.trim().is_empty())
        {
            parts.push(format!("Factory {}", title_case(tier)));
        }
        if let Some(plan) = subscription
            .and_then(|subscription| subscription.orb_subscription.as_ref())
            .and_then(|orb| orb.plan.as_ref())
            .and_then(|plan| plan.name.as_deref())
            .map(str::trim)
            .filter(|plan| !plan.is_empty() && !plan.to_lowercase().contains("factory"))
        {
            parts.push(plan.to_owned());
        }
        if let Some(overage) = overage.map(str::trim).filter(|overage| !overage.is_empty()) {
            parts.push(format!("Fallback: {overage}"));
        }
        (!parts.is_empty()).then(|| parts.join(" - "))
    }

    fn account(&self, plan: Option<String>) -> Account {
        Account {
            email: self
                .user_profile
                .as_ref()
                .and_then(|profile| profile.email.clone())
                .filter(|email| !email.trim().is_empty()),
            plan,
        }
    }

    fn organization(&self) -> Option<Section> {
        let name = self
            .organization
            .as_ref()?
            .name
            .clone()
            .filter(|name| !name.trim().is_empty())?;
        Some(Section::Facts {
            title: "Organization".into(),
            facts: vec![("Name".into(), name)],
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Organization {
    name: Option<String>,
    subscription: Option<Subscription>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Subscription {
    factory_tier: Option<String>,
    orb_subscription: Option<OrbSubscription>,
}

#[derive(Deserialize)]
struct OrbSubscription {
    plan: Option<Plan>,
}

#[derive(Deserialize)]
struct Plan {
    name: Option<String>,
}

#[derive(Deserialize)]
struct UserProfile {
    id: Option<String>,
    email: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Billing {
    uses_token_rate_limits_billing: Option<bool>,
    limits: Option<Limits>,
    #[serde(default, deserialize_with = "number")]
    extra_usage_balance_cents: Option<f64>,
    overage_preference: Option<String>,
    extra_usage_allowed: Option<bool>,
}

#[derive(Deserialize)]
struct Limits {
    standard: Pool,
    core: Option<Pool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Pool {
    five_hour: BillingWindow,
    weekly: BillingWindow,
    monthly: BillingWindow,
}

impl Pool {
    fn has_usage(&self) -> bool {
        [&self.five_hour, &self.weekly, &self.monthly]
            .iter()
            .any(|window| {
                window.used_percent > 0.
                    || window.window_end.is_some()
                    || window.seconds_remaining.is_some()
            })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BillingWindow {
    used_percent: f64,
    window_end: Option<Timestamp>,
    #[serde(default, deserialize_with = "number")]
    seconds_remaining: Option<f64>,
}

impl BillingWindow {
    fn window(&self, kind: Kind, now: SystemTime) -> Window {
        let end = self.window_end.as_ref().and_then(Timestamp::time);
        let reset = match self
            .seconds_remaining
            .filter(|seconds| *seconds > 0. && seconds.is_finite())
        {
            Some(seconds) => now.checked_add(Duration::from_secs_f64(seconds)),
            None => end.filter(|end| *end > now),
        };
        // An expired short window can keep its old share; the web app shows
        // it as reset, and so does this.
        let used = if reset.is_none() && end.is_some() && self.seconds_remaining.is_none() {
            0.
        } else {
            self.used_percent
        };
        let length = kind.length();
        Window::new(kind, used, reset, length)
    }
}

#[derive(Deserialize)]
struct UsageAnswer {
    usage: Option<UsageData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageData {
    start_date: Option<Timestamp>,
    end_date: Option<Timestamp>,
    standard: Option<Tokens>,
    premium: Option<Tokens>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    #[serde(default, deserialize_with = "number")]
    user_tokens: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    total_allowance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    used_ratio: Option<f64>,
}

impl Tokens {
    /// The service's ratio when it is usable, else tokens over allowance.
    fn used_percent(&self) -> f64 {
        let used = self.user_tokens.unwrap_or(0.);
        let allowance = self.total_allowance.unwrap_or(0.);
        let reliable = allowance > 0. && allowance <= UNLIMITED;
        if let Some(ratio) = self
            .used_ratio
            .filter(|ratio| ratio.is_finite())
            .filter(|ratio| !(*ratio == 0. && used > 0. && reliable))
        {
            if (-0.001..=1.001).contains(&ratio) {
                return ratio * 100.;
            }
            if !reliable && (-0.1..=100.1).contains(&ratio) {
                return ratio;
            }
        }
        if allowance > UNLIMITED {
            // Unlimited: a hundred million tokens reads as full.
            return used / 1e8 * 100.;
        }
        if allowance > 0. {
            used / allowance * 100.
        } else {
            0.
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const ME: &str = r#"{
      "organization": {
        "id": "org_1",
        "name": "Acme",
        "subscription": {
          "factoryTier": "team",
          "orbSubscription": {"plan": {"name": "Team", "id": "plan_1"}, "status": "active"}
        }
      },
      "userProfile": {"id": "user-1", "email": "dev@acme.test"}
    }"#;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn token_rate_limits() {
        let me = parse_me(ME).unwrap();
        let body = r#"{
          "usesTokenRateLimitsBilling": true,
          "limits": {
            "standard": {
              "fiveHour": {"usedPercent": 12, "secondsRemaining": 3600},
              "weekly": {"usedPercent": 34, "secondsRemaining": 86400},
              "monthly": {"usedPercent": 56, "secondsRemaining": 604800}
            }
          },
          "extraUsageBalanceCents": 250,
          "overagePreference": "credits",
          "extraUsageAllowed": true,
          "tokenRateLimitsRolloutEligible": true
        }"#;
        let now = at(1_800_000_000);
        let report = parse_limits(&me, body, now).unwrap().unwrap();
        let used: Vec<_> = report
            .windows
            .iter()
            .map(|w| (w.kind.clone(), w.percent()))
            .collect();
        assert_eq!(
            used,
            [(Kind::Session, 12), (Kind::Weekly, 34), (Kind::Monthly, 56)]
        );
        assert_eq!(report.windows[0].resets_at, Some(at(1_800_003_600)));
        assert_eq!(report.windows[0].length, Some(SESSION));
        assert_eq!(report.balances[0].amount, 2.5);
        assert_eq!(report.account.email.as_deref(), Some("dev@acme.test"));
        assert_eq!(
            report.account.plan.as_deref(),
            Some("Factory Team - Team - Fallback: credits")
        );
    }

    #[test]
    fn expired_window_reads_as_reset() {
        let me = parse_me(ME).unwrap();
        let body = r#"{"usesTokenRateLimitsBilling": true, "limits": {"standard": {
          "fiveHour": {"usedPercent": 80, "windowEnd": 1700000000},
          "weekly": {"usedPercent": 10},
          "monthly": {"usedPercent": 5}}}}"#;
        let report = parse_limits(&me, body, at(1_800_000_000)).unwrap().unwrap();
        assert_eq!(report.windows[0].percent(), 0);
        assert!(
            parse_limits(&me, r#"{"usesTokenRateLimitsBilling": false}"#, at(0))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn legacy_standard_and_premium() {
        let me = parse_me(ME).unwrap();
        assert_eq!(me.user_id(), Some("user-1"));
        let body = r#"{
          "usage": {
            "startDate": 1700000000000,
            "endDate": 1700003600000,
            "standard": {"userTokens": 100, "orgTotalTokensUsed": 250, "totalAllowance": 1000, "usedRatio": 0.10},
            "premium": {"userTokens": 10, "orgTotalTokensUsed": 20, "totalAllowance": 100, "usedRatio": 0.25}
          },
          "userId": "user-1"
        }"#;
        let report = parse_usage(&me, body).unwrap();
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Named("Premium".into()));
        assert_eq!(report.windows[0].percent(), 25);
        assert_eq!(report.windows[1].kind, Kind::Named("Standard".into()));
        assert_eq!(report.windows[1].percent(), 10);
        assert_eq!(report.windows[1].resets_at, Some(at(1_700_003_600)));
        assert_eq!(report.windows[1].length, Some(Duration::from_secs(3600)));
        assert_eq!(report.account.plan.as_deref(), Some("Factory Team - Team"));
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Organization".into(),
                facts: vec![("Name".into(), "Acme".into())],
            }]
        );
    }

    #[test]
    fn allowance_without_ratio() {
        let tokens = Tokens {
            user_tokens: Some(100.),
            total_allowance: Some(1000.),
            used_ratio: None,
        };
        assert_eq!(tokens.used_percent(), 10.);
    }
}
