//! Doubao (Volcengine Ark) Coding Plan and Agent Plan windows, read from
//! the official `arkcli usage plan --format json` on the probed host after
//! `arkcli auth login`. Its output holds usage only, no credentials.
//!
//! Not ported: CodexBar's Volcengine AK/SK source, which signs requests
//! with Volcengine's HMAC scheme (request signing is not supported), and its
//! Ark API-key probe, which reads `x-ratelimit-*` response headers that the
//! probe does not return. Neither declares a setting here for that reason.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, SESSION, WEEK, Window},
        probe::Probe,
        service::{Meta, Service, Timestamp, json},
    },
};
use serde::Deserialize;
use serde_json::error::Category;
use std::time::Duration;

pub(crate) struct Doubao;

static META: Meta = Meta::new("doubao", "Doubao")
    .dashboard("https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&advancedActiveKey=subscribe");

impl Service for Doubao {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let output = match probe.command(
            "arkcli",
            &["usage", "plan", "--format", "json"],
            Duration::from_secs(15),
        ) {
            Ok(output) => output,
            // Not installed on this host.
            Err(Error::UsageProcess { .. }) => return None,
            Err(error) => return Some(Err(error)),
        };
        // A missing or signed-out arkcli exits with an error and prints no JSON.
        if !output.success && !output.stdout.trim_start().starts_with('{') {
            return None;
        }
        match parse(&output.stdout) {
            Err(Error::UsageNotSignedIn) => None,
            result => Some(result),
        }
    }
}

/// Each subscribed product's periods become windows; the personal Coding
/// Plan's are the standard ones, the others are named after their plan.
pub(crate) fn parse(stdout: &str) -> Result<Report> {
    let answer: Answer = json(stdout)?;
    let method = answer
        .viewer
        .and_then(|viewer| viewer.auth_method)
        .map(|method| method.trim().to_owned())
        .filter(|method| !method.is_empty());
    if method
        .as_deref()
        .is_some_and(|method| method.eq_ignore_ascii_case("none"))
    {
        return Err(Error::UsageNotSignedIn);
    }
    let mut windows = Vec::new();
    for item in answer.items {
        let plan = match item.product.to_ascii_lowercase().as_str() {
            "coding-plan" => None,
            "agent-plan" => Some("Agent"),
            "coding-plan-team" => Some("Team"),
            "agent-plan-team" => Some("Agent team"),
            _ => continue,
        };
        if item.subscribed == Some(false) {
            continue;
        }
        // A product that failed to load reports no periods; it must not
        // hide the others, but with nothing else it is an error below.
        for period in item.periods.unwrap_or_default() {
            let Some((kind, title, length)) = period_kind(&period.label) else {
                continue;
            };
            let kind = match plan {
                None => kind,
                Some(plan) => Kind::Named(format!("{plan} {title}")),
            };
            windows.push(Window::new(
                kind,
                period.percent,
                period.reset_at.as_ref().and_then(Timestamp::time),
                Some(length),
            ));
        }
    }
    if windows.is_empty() {
        return Err(Error::UsageJson(Category::Data));
    }
    let account = Account {
        email: None,
        plan: method,
    };
    Ok(Report::new(Provider(&Doubao), account, windows))
}

fn period_kind(label: &str) -> Option<(Kind, &'static str, Duration)> {
    Some(match label.trim().to_ascii_lowercase().as_str() {
        "session" | "5-hour" | "five_hour" | "5h" => (Kind::Session, "5-hour", SESSION),
        "weekly" | "week" => (Kind::Weekly, "weekly", WEEK),
        "monthly" | "month" => (Kind::Monthly, "monthly", MONTH),
        _ => return None,
    })
}

#[derive(Deserialize)]
struct Answer {
    viewer: Option<Viewer>,
    #[serde(default)]
    items: Vec<Item>,
}

#[derive(Deserialize)]
struct Viewer {
    auth_method: Option<String>,
}

#[derive(Deserialize)]
struct Item {
    product: String,
    subscribed: Option<bool>,
    periods: Option<Vec<Period>>,
}

#[derive(Deserialize)]
struct Period {
    label: String,
    percent: f64,
    reset_at: Option<Timestamp>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const OUTPUT: &str = r#"{
      "viewer": {"auth_method": "sso", "profile": "agent-plan_cn-beijing_personal"},
      "items": [
        {
          "product": "agent-plan",
          "subscribed": true,
          "periods": [
            {"label": "5h", "total": 2000, "percent": 0},
            {"label": "weekly", "used": 2009.33, "total": 7000, "percent": 28.7,
             "reset_at": "2026-07-20T00:00:00+08:00"},
            {"label": "monthly", "used": 2009.33, "total": 20000, "percent": 10.05,
             "reset_at": "2026-08-14T23:59:59+08:00"}
          ]
        },
        {
          "product": "coding-plan",
          "subscribed": true,
          "periods": [
            {"label": "session", "percent": 7.48, "reset_at": "2026-07-16T19:12:07+08:00"},
            {"label": "weekly", "percent": 2.71, "reset_at": "2026-07-20T00:00:00+08:00"},
            {"label": "monthly", "percent": 1.36, "reset_at": "2026-08-15T23:59:59+08:00"}
          ],
          "updated_at": 1784191193000
        },
        {"product": "coding-plan-team", "subscribed": false}
      ]
    }"#;

    #[test]
    fn coding_plan_is_standard_and_agent_plan_is_named() {
        let report = parse(OUTPUT).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("sso"));
        let find = |kind: Kind| {
            report
                .windows
                .iter()
                .find(|window| window.kind == kind)
                .unwrap()
                .clone()
        };
        let session = find(Kind::Session);
        assert!((session.used - 7.48).abs() < 1e-4);
        assert_eq!(session.length, Some(SESSION));
        assert!(session.resets_at.is_some());
        assert!((find(Kind::Weekly).used - 2.71).abs() < 1e-4);
        assert!((find(Kind::Monthly).used - 1.36).abs() < 1e-4);
        let agent = find(Kind::Named("Agent weekly".into()));
        assert!((agent.used - 28.7).abs() < 1e-4);
        assert_eq!(agent.length, Some(WEEK));
        assert_eq!(find(Kind::Named("Agent 5-hour".into())).used, 0.);
        assert_eq!(report.windows.len(), 6);
    }

    #[test]
    fn signed_out_and_empty_output() {
        assert!(matches!(
            parse(r#"{"viewer": {"auth_method": "none"}, "items": []}"#),
            Err(Error::UsageNotSignedIn)
        ));
        assert!(matches!(
            parse(r#"{"items": [{"product": "coding-plan", "error": "boom"}]}"#),
            Err(Error::UsageJson(_))
        ));
    }
}
