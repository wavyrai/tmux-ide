//! Cursor plan usage from the cursor.com dashboard API, signed in with a
//! cursor.com session cookie: the `cookie` setting, or, when Cursor is listed
//! in `[usage] show_providers`, the session cookie imported from Chrome or
//! Safari under whichever of CodexBar's names the browser has (the current
//! WorkOS token, or a legacy next-auth, WorkOS AuthKit, or Auth.js session). `/api/usage-summary` gives the billing cycle's included, Auto, and
//! API percentages and on-demand spend; `/api/auth/me` the account; the
//! legacy `/api/usage` request quota; and `get-sand-usage-status` the Grok Bot
//! allowance, the last three best-effort as in CodexBar.
//!
//! Not ported: CodexBar's preferred source, Cursor.app's own access token, is
//! read from the app's SQLite state database (`state.vscdb`), which the probe
//! cannot read; Firefox cookies; the verified Enterprise/Team member budget
//! (`/api/dashboard/teams` plus paged `get-team-spend`), whose headline falls
//! back to the usage summary as CodexBar does when that lookup fails; and the
//! usage-events cost history; and sending every cursor.com cookie when none
//! has a known session name.

use crate::{
    Result,
    usage::{
        model::{Account, Balance, Kind, MONTH, Provider, Report, Section, Unit, Window},
        probe::{Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json, number},
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const BASE: &str = "https://cursor.com";
const DOMAINS: &[&str] = &["cursor.com", "cursor.sh"];
/// The session cookie names CodexBar accepts, in its order; the first one a
/// browser holds is imported.
const SESSION_COOKIES: &[&str] = &[
    "WorkosCursorSessionToken",
    "__Secure-next-auth.session-token",
    "next-auth.session-token",
    "wos-session",
    "__Secure-wos-session",
    "authjs.session-token",
    "__Secure-authjs.session-token",
];

pub(crate) struct Cursor;

static META: Meta = Meta::new("cursor", "Cursor")
    .dashboard("https://cursor.com/dashboard?tab=usage")
    .status_page("https://status.cursor.com")
    .settings(&[Setting::new(
        "cookie",
        &[],
        "Your cursor.com session. Sign in at https://cursor.com/dashboard, open Developer \
         Tools > Application > Cookies > https://cursor.com, and copy the \
         WorkosCursorSessionToken cookie (or __Secure-next-auth.session-token on older \
         accounts). Paste it as \"WorkosCursorSessionToken=value\". Not needed when Cursor \
         is listed in show_providers and you are signed in with Chrome or Safari.",
    )]);

impl Service for Cursor {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies_any(DOMAINS, SESSION_COOKIES)?;
        let get = |path: &str| {
            Request::get(format!("{BASE}{path}"))
                .cookie(&cookie)
                .header("Accept", "application/json")
        };
        let summary = match probe.body(get("/api/usage-summary")) {
            Ok(summary) => summary,
            Err(error) => return Some(Err(error)),
        };
        let me = probe
            .body(get("/api/auth/me"))
            .ok()
            .and_then(|body| json::<User>(&body).ok());
        let requests = me
            .as_ref()
            .and_then(|me| me.sub.as_deref())
            .filter(|sub| !sub.is_empty())
            .and_then(|sub| {
                let user: String = url::form_urlencoded::byte_serialize(sub.as_bytes()).collect();
                probe.body(get(&format!("/api/usage?user={user}"))).ok()
            });
        let sand = probe
            .body(
                Request::post(format!("{BASE}/api/dashboard/get-sand-usage-status"))
                    .cookie(&cookie)
                    .header("Accept", "application/json")
                    .header("Origin", BASE)
                    .timeout(Duration::from_secs(5))
                    .json("{}"),
            )
            .ok();
        Some(parse(
            &summary,
            me,
            requests.as_deref(),
            sand.as_deref(),
            SystemTime::now(),
        ))
    }
}

pub(crate) fn parse(
    summary: &str,
    me: Option<User>,
    requests: Option<&str>,
    sand: Option<&str>,
    now: SystemTime,
) -> Result<Report> {
    let summary: Summary = json(summary)?;
    let start = summary
        .billing_cycle_start
        .as_ref()
        .and_then(Timestamp::time);
    let end = summary.billing_cycle_end.as_ref().and_then(Timestamp::time);
    let cycle = start
        .zip(end)
        .and_then(|(start, end)| end.duration_since(start).ok())
        .filter(|length| !length.is_zero())
        .or(Some(MONTH));
    let individual = summary.individual_usage.unwrap_or_default();
    let plan = individual.plan.unwrap_or_default();
    let quota = requests
        .and_then(|body| json::<RequestUsage>(body).ok())
        .and_then(|usage| usage.gpt4)
        .and_then(|gpt4| {
            let limit = gpt4.max_request_usage.filter(|limit| *limit > 0)?;
            Some((gpt4.num_requests_total.or(gpt4.num_requests)?, limit))
        });
    let percent = |value: Option<f64>| value.filter(|value| value.is_finite());
    let auto = percent(plan.auto_percent_used);
    let api = percent(plan.api_percent_used);
    let ratio = |used: Option<f64>, limit: Option<f64>| {
        let limit = limit.filter(|limit| *limit > 0.)?;
        Some(used.unwrap_or(0.) / limit * 100.)
    };
    let overall = individual.overall.unwrap_or_default();
    let team = summary.team_usage.unwrap_or_default();
    let pooled = team.pooled.unwrap_or_default();
    let headline = match quota {
        Some((used, limit)) => used as f64 / limit as f64 * 100.,
        None => percent(plan.total_percent_used)
            .or_else(|| auto.zip(api).map(|(auto, api)| (auto + api) / 2.))
            .or(api)
            .or(auto)
            .or_else(|| ratio(plan.used, plan.limit))
            .or_else(|| ratio(overall.used, overall.limit))
            .or_else(|| ratio(pooled.used, pooled.limit))
            .unwrap_or(0.),
    };
    let mut windows = vec![Window::new(Kind::Monthly, headline, end, cycle)];
    if quota.is_none() {
        windows.extend(
            [("Auto + Composer", auto), ("API", api)]
                .into_iter()
                .filter_map(|(name, used)| {
                    Some(Window::new(Kind::Named(name.into()), used?, end, cycle))
                }),
        );
    }

    let mut sections = Vec::new();
    if let Some((used, limit)) = quota {
        sections.push(Section::Facts {
            title: "Usage".into(),
            facts: vec![("Request quota".into(), format!("{used} / {limit}"))],
        });
    } else if let Some(grok) = sand
        .and_then(|body| json::<Sand>(body).ok())
        .and_then(|sand| sand.window(now))
    {
        sections.push(Section::Limit(grok));
    }
    let cents = |value: Option<f64>| value.map(|cents| cents / 100.);
    let included = [
        (plan.used, plan.limit),
        (overall.used, overall.limit),
        (pooled.used, pooled.limit),
    ]
    .into_iter()
    .find(|(used, limit)| used.is_some_and(|v| v > 0.) || limit.is_some_and(|v| v > 0.));
    if let Some((used, limit)) = included {
        sections.push(Section::Facts {
            title: "Included usage".into(),
            facts: vec![(
                "This cycle".into(),
                format!(
                    "${:.2} of ${:.2}",
                    cents(used).unwrap_or(0.),
                    cents(limit).unwrap_or(0.)
                ),
            )],
        });
    }

    let on_demand = individual.on_demand.unwrap_or_default();
    let team_on_demand = team.on_demand.unwrap_or_default();
    let personal_used = cents(on_demand.used).unwrap_or(0.);
    // A personal cap wins; a team with no member cap shares one budget.
    let (used, limit, label) = match (cents(on_demand.limit), cents(team_on_demand.limit)) {
        (Some(limit), _) if limit > 0. => (personal_used, Some(limit), "On-demand"),
        (_, Some(limit)) if limit > 0. => (
            cents(team_on_demand.used).unwrap_or(0.),
            Some(limit),
            "Team on-demand",
        ),
        _ => (personal_used, None, "On-demand"),
    };
    let usd = || Unit::Currency("USD".into());
    let balance = match limit {
        Some(limit) => {
            Some(Balance::new(format!("{label} left"), (limit - used).max(0.), usd()).out_of(limit))
        }
        None if used > 0. => Some(Balance::new(format!("{label} spend"), used, usd())),
        None => None,
    };
    if limit.is_some() && (used > 0. || label == "Team on-demand") {
        let mut facts = vec![("Spent this cycle".into(), format!("${used:.2}"))];
        if label == "Team on-demand" && personal_used > 0. {
            facts.push(("Your share".into(), format!("${personal_used:.2}")));
        }
        sections.push(Section::Facts {
            title: label.into(),
            facts,
        });
    }

    let account = Account {
        email: me
            .and_then(|me| me.email)
            .filter(|email| !email.trim().is_empty()),
        plan: summary
            .membership_type
            .as_deref()
            .filter(|kind| !kind.trim().is_empty())
            .map(membership),
    };
    Ok(Report::new(Provider(&Cursor), account, windows)
        .with_balances(balance)
        .with_sections(sections))
}

fn membership(kind: &str) -> String {
    let name = match kind.to_ascii_lowercase().as_str() {
        "enterprise" => "Enterprise",
        "express" => "Start",
        "free" => "Free",
        "free_trial" => "Pro Trial",
        "hobby" => "Hobby",
        "pro" | "pro_student" => "Pro",
        "pro_plus" => "Pro+",
        "team" => "Team",
        "ultra" => "Ultra",
        _ => kind,
    };
    format!("Cursor {name}")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    billing_cycle_start: Option<Timestamp>,
    billing_cycle_end: Option<Timestamp>,
    membership_type: Option<String>,
    individual_usage: Option<Individual>,
    team_usage: Option<Team>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Individual {
    plan: Option<Plan>,
    on_demand: Option<Spend>,
    overall: Option<Spend>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Team {
    on_demand: Option<Spend>,
    pooled: Option<Spend>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plan {
    #[serde(default, deserialize_with = "number")]
    used: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    limit: Option<f64>,
    auto_percent_used: Option<f64>,
    api_percent_used: Option<f64>,
    total_percent_used: Option<f64>,
}

/// Cents, as every Cursor spend field is.
#[derive(Default, Deserialize)]
struct Spend {
    #[serde(default, deserialize_with = "number")]
    used: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    limit: Option<f64>,
}

#[derive(Deserialize)]
pub(crate) struct User {
    email: Option<String>,
    sub: Option<String>,
}

#[derive(Deserialize)]
struct RequestUsage {
    #[serde(rename = "gpt-4")]
    gpt4: Option<ModelUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsage {
    num_requests: Option<u64>,
    num_requests_total: Option<u64>,
    max_request_usage: Option<u64>,
}

/// Grok Bot ("Sand") weekly included or trial usage.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sand {
    current_period_start: Option<Timestamp>,
    next_reset_timestamp_utc: Option<Timestamp>,
    usage_percent: Option<f64>,
    has_non_zero_included_limit: Option<bool>,
    included_limit_zero: Option<bool>,
    sand_trial_expires_at: Option<Timestamp>,
}

impl Sand {
    /// Only a paid allowance or an unexpired trial; a trial's expiry does not
    /// replenish it, so a trial has no reset.
    fn window(self, now: SystemTime) -> Option<Window> {
        let paid = self
            .included_limit_zero
            .map(|zero| !zero)
            .or(self.has_non_zero_included_limit);
        let trial = paid != Some(true)
            && self
                .sand_trial_expires_at
                .as_ref()
                .and_then(Timestamp::time)
                .is_some_and(|expires| expires > now);
        if paid != Some(true) && !trial {
            return None;
        }
        let used = self.usage_percent.filter(|used| used.is_finite())?;
        let resets_at = if trial {
            None
        } else {
            self.next_reset_timestamp_utc
                .as_ref()
                .and_then(Timestamp::time)
        };
        let length = self
            .current_period_start
            .as_ref()
            .and_then(Timestamp::time)
            .zip(resets_at)
            .and_then(|(start, end)| end.duration_since(start).ok())
            .filter(|length| !length.is_zero());
        Some(Window::new(
            Kind::Named("Grok Bot".into()),
            used,
            resets_at,
            length,
        ))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const SUMMARY: &str = r#"{
        "billingCycleStart": "2025-01-01T00:00:00.000Z",
        "billingCycleEnd": "2025-02-01T00:00:00.000Z",
        "membershipType": "pro",
        "individualUsage": {
            "plan": {
                "enabled": true, "used": 1500, "limit": 5000, "remaining": 3500,
                "autoPercentUsed": 20.0, "apiPercentUsed": 40.0, "totalPercentUsed": 30.0
            },
            "onDemand": { "enabled": true, "used": 500, "limit": 10000, "remaining": 9500 }
        },
        "teamUsage": {
            "onDemand": { "enabled": true, "used": 2000, "limit": 50000, "remaining": 48000 }
        }
    }"#;

    fn user() -> User {
        json(r#"{"email":"dev@example.com","email_verified":true,"name":"Dev","sub":"user_01"}"#)
            .unwrap()
    }

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn parses_usage_summary() {
        let report = parse(SUMMARY, Some(user()), None, None, at(1_736_000_000)).unwrap();
        assert_eq!(report.account.email.as_deref(), Some("dev@example.com"));
        assert_eq!(report.account.plan.as_deref(), Some("Cursor Pro"));
        let monthly = &report.windows[0];
        assert_eq!(monthly.kind, Kind::Monthly);
        assert_eq!(monthly.used, 30.);
        assert_eq!(monthly.resets_at, Some(at(1_738_368_000)));
        assert_eq!(monthly.length, Some(Duration::from_secs(31 * 86_400)));
        assert_eq!(report.windows[1].kind, Kind::Named("API".into()));
        assert_eq!(report.windows[1].used, 40.);
        assert_eq!(
            report.windows[2].kind,
            Kind::Named("Auto + Composer".into())
        );
        assert_eq!(report.windows[2].used, 20.);
        let balance = &report.balances[0];
        assert_eq!(balance.label, "On-demand left");
        assert_eq!(balance.amount, 95.);
        assert_eq!(balance.total, Some(100.));
        assert!(report.sections.contains(&Section::Facts {
            title: "Included usage".into(),
            facts: vec![("This cycle".into(), "$15.00 of $50.00".into())],
        }));
    }

    #[test]
    fn legacy_request_plan_uses_request_quota() {
        let report = parse(
            SUMMARY,
            None,
            Some(r#"{"gpt-4":{"numRequests":120,"numRequestsTotal":125,"maxRequestUsage":500},"startOfMonth":"2025-01-01T00:00:00.000Z"}"#),
            None,
            at(1_736_000_000),
        )
        .unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].used, 25.);
        assert!(report.sections.contains(&Section::Facts {
            title: "Usage".into(),
            facts: vec![("Request quota".into(), "125 / 500".into())],
        }));
    }

    #[test]
    fn team_budget_and_grok_bot() {
        let summary = r#"{
            "billingCycleEnd": "2025-02-01T00:00:00.000Z",
            "membershipType": "team",
            "individualUsage": { "onDemand": { "used": 300 } },
            "teamUsage": {
                "onDemand": { "used": 2000, "limit": 50000 },
                "pooled": { "used": 25000, "limit": 100000 }
            }
        }"#;
        let sand = r#"{
            "currentPeriodStart": "2025-01-10T00:00:00Z",
            "nextResetTimestampUtc": "2025-01-17T00:00:00Z",
            "usagePercent": 42.5,
            "hasAvailableUsage": true,
            "includedLimitZero": false
        }"#;
        let report = parse(summary, None, None, Some(sand), at(1_736_500_000)).unwrap();
        assert_eq!(report.windows[0].used, 25.);
        assert_eq!(report.windows[0].length, Some(MONTH));
        assert_eq!(report.balances[0].label, "Team on-demand left");
        assert_eq!(report.balances[0].amount, 480.);
        let Some(Section::Limit(grok)) = report.sections.first() else {
            panic!("expected Grok Bot limit");
        };
        assert_eq!(grok.kind, Kind::Named("Grok Bot".into()));
        assert_eq!(grok.used, 42.5);
        assert_eq!(grok.length, Some(Duration::from_secs(7 * 86_400)));
        assert!(report.sections.contains(&Section::Facts {
            title: "Team on-demand".into(),
            facts: vec![
                ("Spent this cycle".into(), "$20.00".into()),
                ("Your share".into(), "$3.00".into()),
            ],
        }));
    }

    #[test]
    fn expired_grok_trial_is_hidden() {
        let sand = r#"{"usagePercent": 10, "includedLimitZero": true,
                       "sandTrialExpiresAt": "2025-01-01T00:00:00Z"}"#;
        let report = parse(SUMMARY, None, None, Some(sand), at(1_736_000_000)).unwrap();
        assert!(
            !report
                .sections
                .iter()
                .any(|s| matches!(s, Section::Limit(_)))
        );
    }
}
