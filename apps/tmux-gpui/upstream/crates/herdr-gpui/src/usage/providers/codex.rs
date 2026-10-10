//! Codex plan usage, read with the Codex CLI's own ChatGPT sign-in in
//! `$CODEX_HOME/auth.json`. An API-key-only install has no plan usage.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, Provider, Report, SESSION, Section, WEEK, Window, title_case},
        probe::{HostPath, Probe, Request},
        service::{Meta, Service, Timestamp, json},
    },
};
use serde::Deserialize;
use std::time::Duration;

pub(crate) const URL: &str = "https://chatgpt.com/backend-api/wham/usage";
pub(crate) const AGENT: &str = "codex-cli";

pub(crate) struct Codex;

static META: Meta = Meta::new("codex", "Codex")
    .icon("icons/agent-codex.svg")
    .dashboard("https://chatgpt.com/codex/settings/usage")
    .status_page("https://status.openai.com");

impl Service for Codex {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let auth = probe.file(&HostPath::env_or("CODEX_HOME", ".codex", "auth.json"))?;
        let token = probe.field(&auth, &["tokens", "access_token"])?;
        let mut request = Request::get(URL)
            .bearer(&token)
            .header("User-Agent", AGENT)
            .header("OpenAI-Beta", "codex-1")
            .header("originator", "Codex Desktop");
        if let Some(account) = probe.field(&auth, &["tokens", "account_id"]) {
            request = request.secret_header("ChatGPT-Account-Id", "", &account);
        }
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let usage: Usage = json(body)?;
    let windows = usage.rate_limit.map(Limits::windows).unwrap_or_default();
    let review = usage
        .code_review_rate_limit
        .map(Limits::windows)
        .unwrap_or_default()
        .into_iter()
        .next()
        .map(|window| {
            Section::Limit(Window {
                kind: Kind::Named("Code review".into()),
                ..window
            })
        });
    let resets = usage
        .rate_limit_reset_credits
        .map(|credits| Section::Facts {
            title: "Limit reset credits".into(),
            facts: vec![("Available".into(), credits.available_count.to_string())],
        });
    let credits = usage.credits.map(|credits| Section::Facts {
        title: "Credits".into(),
        facts: vec![(
            "Balance".into(),
            if credits.unlimited.unwrap_or(false) {
                "Unlimited".into()
            } else {
                credits.balance.unwrap_or_else(|| "0".into())
            },
        )],
    });
    let account = Account {
        email: usage.email.filter(|email| !email.trim().is_empty()),
        plan: usage
            .plan_type
            .map(|plan| title_case(&plan))
            .filter(|plan| !plan.is_empty()),
    };
    Ok(Report::new(Provider(&Codex), account, windows)
        .with_sections(review.into_iter().chain(resets).chain(credits)))
}

#[derive(Deserialize)]
struct Usage {
    email: Option<String>,
    plan_type: Option<String>,
    rate_limit: Option<Limits>,
    code_review_rate_limit: Option<Limits>,
    rate_limit_reset_credits: Option<ResetCredits>,
    credits: Option<Credits>,
}

#[derive(Deserialize)]
struct Limits {
    primary_window: Option<LimitWindow>,
    secondary_window: Option<LimitWindow>,
}

impl Limits {
    /// A window is known by its length; which slot it arrives in only decides
    /// when the length is missing or unfamiliar.
    fn windows(self) -> Vec<Window> {
        [
            (Kind::Session, self.primary_window),
            (Kind::Weekly, self.secondary_window),
        ]
        .into_iter()
        .filter_map(|(slot, window)| {
            let window = window?;
            let length = window.limit_window_seconds.map(Duration::from_secs);
            let kind = match length {
                Some(length) if length.abs_diff(SESSION) <= Duration::from_secs(60) => {
                    Kind::Session
                }
                Some(length) if length.abs_diff(WEEK) <= Duration::from_secs(60) => Kind::Weekly,
                _ => slot,
            };
            Some(Window::new(
                kind,
                window.used_percent,
                window.reset_at.as_ref().and_then(Timestamp::time),
                length,
            ))
        })
        .collect()
    }
}

#[derive(Deserialize)]
struct LimitWindow {
    used_percent: f64,
    limit_window_seconds: Option<u64>,
    reset_at: Option<Timestamp>,
}

#[derive(Deserialize)]
struct ResetCredits {
    available_count: u32,
}

#[derive(Deserialize)]
struct Credits {
    unlimited: Option<bool>,
    balance: Option<String>,
}
