//! Devin daily and weekly quotas, read with a pasted app.devin.ai session
//! token (`token`, or `DEVIN_BEARER_TOKEN`) and the organization it belongs
//! to (`organization`, or `DEVIN_ORGANIZATION`/`DEVIN_ORG`).
//!
//! Not ported: CodexBar's automatic mode reads the `auth1_session` token and
//! organization metadata from Chromium's localStorage, which the probe cannot
//! read, so both must be copied from the browser. A token pasted with its
//! `Bearer ` prefix (as `DEVIN_AUTHORIZATION` holds it) is not accepted,
//! since the probe cannot strip a prefix from a secret.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, Section, Unit, Window, title_case},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::invalid,
    },
};
use serde::Deserialize;

const BASE: &str = "https://app.devin.ai/api";
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub(crate) struct Devin;

static META: Meta = Meta::new("devin", "Devin")
    .dashboard("https://app.devin.ai/settings/usage")
    .settings(&[
        Setting::new(
            "token",
            &["DEVIN_BEARER_TOKEN"],
            "Sign in to https://app.devin.ai, open your organization's Usage & Limits \
             page, then in Developer Tools > Network select the successful \
             billing/quota/usage request and copy its Authorization request header \
             without the leading \"Bearer \". The value is a browser session token and \
             expires with that session.",
        ),
        Setting::new(
            "organization",
            &["DEVIN_ORGANIZATION", "DEVIN_ORG"],
            "The x-cog-org-id request header of the same request (an org-… or org_… \
             id). An organization slug or its app.devin.ai URL also works.",
        ),
    ]);

impl Service for Devin {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let token = probe.setting("token")?;
        let Some(organization) = probe
            .text_setting("organization")
            .and_then(|raw| Organization::parse(&raw))
        else {
            return Some(Err(Error::UsageNotSignedIn));
        };
        Some(read(probe, &token, &organization))
    }
}

/// Where the quota lives: tried in CodexBar's order until one answers.
fn read(probe: &mut Probe, token: &Secret, organization: &Organization) -> Result<Report> {
    let mut last = Error::UsageStatus(404);
    for path in organization.paths() {
        let mut request = Request::get(format!("{BASE}/{path}/billing/quota/usage"))
            .bearer(token)
            .header("Accept", "application/json")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("User-Agent", AGENT);
        if let Some(id) = &organization.id {
            request = request.header("x-cog-org-id", id.as_str());
        }
        match probe.body(request) {
            Ok(body) => return parse(&body, organization.display()),
            Err(error @ Error::UsageRejected) => return Err(error),
            Err(error) => last = error,
        }
    }
    Err(last)
}

/// `org/acme`, or an internal `org-…`/`org_…` id sent as `organizations/…`.
#[derive(Debug, PartialEq, Eq)]
struct Organization {
    path: String,
    id: Option<String>,
}

impl Organization {
    fn parse(raw: &str) -> Option<Self> {
        let mut value = raw.trim();
        for prefix in ["https://", "http://"] {
            if let Some(rest) = value.strip_prefix(prefix) {
                let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
                if host == "devin.ai" || host.ends_with(".devin.ai") {
                    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
                    if let [kind @ ("org" | "organizations"), name, ..] = parts.as_slice() {
                        return Self::parse(&format!("{kind}/{name}"));
                    }
                }
                value = rest;
            }
        }
        let value = value.trim_matches('/');
        if value.is_empty()
            || !value
                .bytes()
                .all(|b| b.is_ascii_graphic() && b != b'?' && b != b'#')
        {
            return None;
        }
        let id = value
            .strip_prefix("organizations/")
            .or(Some(value))
            .filter(|id| id.starts_with("org-") || id.starts_with("org_"))
            .map(str::to_owned);
        let path = if value.starts_with("org/") || value.starts_with("organizations/") {
            value.to_owned()
        } else if let Some(id) = &id {
            format!("organizations/{id}")
        } else {
            format!("org/{value}")
        };
        Some(Self { path, id })
    }

    fn paths(&self) -> Vec<String> {
        let mut paths = Vec::new();
        if let Some(id) = &self.id {
            paths.push(id.clone());
        }
        paths.push(self.path.clone());
        if let Some(slug) = self.path.strip_prefix("org/") {
            paths.push(slug.to_owned());
        }
        if let Some(id) = &self.id {
            paths.push(format!("organizations/{id}"));
        }
        let mut seen = Vec::new();
        paths.retain(|path| {
            let fresh = !seen.contains(path);
            seen.push(path.clone());
            fresh
        });
        paths
    }

    fn display(&self) -> &str {
        self.path
            .strip_prefix("org/")
            .or_else(|| self.path.strip_prefix("organizations/"))
            .unwrap_or(&self.path)
    }
}

pub(crate) fn parse(body: &str, organization: &str) -> Result<Report> {
    let usage: Usage = json(body)?;
    let daily = (!usage.hide_daily_quota.unwrap_or(false))
        .then(|| window(Kind::Daily, usage.daily_percentage, &usage.daily_reset_at))
        .flatten();
    let weekly = window(
        Kind::Weekly,
        usage.weekly_percentage,
        &usage.weekly_reset_at,
    );
    if daily.is_none() && weekly.is_none() {
        return Err(invalid());
    }
    let plan = [
        usage.plan_name,
        usage.plan,
        usage.tier,
        usage.subscription_tier,
    ]
    .into_iter()
    .flatten()
    .map(|plan| {
        plan.split(['_', '-'])
            .filter(|word| !word.is_empty())
            .map(title_case)
            .collect::<Vec<_>>()
            .join(" ")
    })
    .find(|plan| !plan.is_empty());
    let overage = usage
        .overage_balance
        .or(usage.overage_balance_cents.map(|cents| cents / 100.))
        .filter(|amount| amount.is_finite() && *amount >= 0.);
    Ok(Report::new(
        Provider(&Devin),
        Account { email: None, plan },
        daily.into_iter().chain(weekly).collect(),
    )
    .with_balances(
        overage.map(|amount| {
            Balance::new("Extra usage balance", amount, Unit::Currency("USD".into()))
        }),
    )
    .with_sections([Section::Facts {
        title: "Organization".into(),
        facts: vec![("Name".into(), organization.to_owned())],
    }]))
}

/// Devin sends a fraction for small values and a percent otherwise.
fn window(kind: Kind, percent: Option<f64>, reset: &Option<Timestamp>) -> Option<Window> {
    let percent = percent.filter(|value| value.is_finite())?;
    let used = if percent < 1. {
        percent * 100.
    } else {
        percent
    };
    let length = kind.length();
    Some(Window::new(
        kind,
        used,
        reset.as_ref().and_then(Timestamp::time),
        length,
    ))
}

#[derive(Deserialize)]
struct Usage {
    hide_daily_quota: Option<bool>,
    #[serde(default, deserialize_with = "number")]
    daily_percentage: Option<f64>,
    daily_reset_at: Option<Timestamp>,
    #[serde(default, deserialize_with = "number")]
    weekly_percentage: Option<f64>,
    weekly_reset_at: Option<Timestamp>,
    #[serde(default, deserialize_with = "number")]
    overage_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    overage_balance_cents: Option<f64>,
    plan_name: Option<String>,
    plan: Option<String>,
    tier: Option<String>,
    subscription_tier: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    #[test]
    fn daily_and_weekly_quota() {
        let body = r#"{
            "is_quota_plan": true,
            "has_quota_allocation": true,
            "daily_percentage": 0.12,
            "weekly_percentage": 42,
            "daily_reset_at": "2026-06-11T00:00:00-08:00",
            "weekly_reset_at": "2026-06-14T00:00:00-08:00",
            "hide_daily_quota": false,
            "overage_balance_cents": 1250,
            "plan_name": "team_pro"
        }"#;
        let report = parse(body, "example-org").unwrap();
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Daily);
        assert_eq!(report.windows[0].percent(), 12);
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_164_800))
        );
        assert_eq!(report.windows[1].kind, Kind::Weekly);
        assert_eq!(report.windows[1].percent(), 42);
        assert_eq!(
            report.windows[1].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_781_424_000))
        );
        assert_eq!(report.account.plan.as_deref(), Some("Team Pro"));
        assert_eq!(report.balances[0].amount, 12.5);
    }

    #[test]
    fn hidden_daily_quota_is_left_out() {
        let body = r#"{"hide_daily_quota": true, "daily_percentage": 0, "weekly_percentage": 90,
            "weekly_reset_at": 1781424000}"#;
        let report = parse(body, "acme").unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Weekly);
        assert!(parse(r#"{"detail": "nope"}"#, "acme").is_err());
    }

    #[test]
    fn organization_forms() {
        let internal = Organization::parse("org_abc123").unwrap();
        assert_eq!(internal.id.as_deref(), Some("org_abc123"));
        assert_eq!(internal.paths(), ["org_abc123", "organizations/org_abc123"]);
        let slug = Organization::parse("https://app.devin.ai/org/acme/settings").unwrap();
        assert_eq!(slug.id, None);
        assert_eq!(slug.paths(), ["org/acme", "acme"]);
        assert_eq!(slug.display(), "acme");
        assert_eq!(Organization::parse("  "), None);
    }
}
