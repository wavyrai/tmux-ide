//! GitHub Copilot premium request and chat quotas from GitHub's
//! `copilot_internal/user` endpoint. The GitHub token is `token` (or
//! `COPILOT_API_TOKEN`), else the sign-in the Copilot editor plugins keep on
//! the probed host in `$XDG_CONFIG_HOME/github-copilot/apps.json` or the older
//! `hosts.json` (copilot.vim, copilot.lua, the Copilot language server).
//! `enterprise_host` points both at a GitHub Enterprise Cloud host.
//!
//! Not ported: CodexBar signs in with its own GitHub device flow, an
//! interactive login, so a token must come from config or an editor plugin;
//! and its optional budget bars, scraped from github.com's web billing page
//! with browser cookies and a page nonce.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, Section, Window, group, title_case},
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json, number},
    },
};
use serde::Deserialize;
use std::time::SystemTime;

/// The OAuth app copilot.vim and the Copilot language server sign in with.
const PLUGIN_APP: &str = "github.com:Iv1.b507a08c87ecfe98";

pub(crate) struct Copilot;

static META: Meta = Meta::new("copilot", "Copilot")
    .dashboard("https://github.com/settings/copilot")
    .status_page("https://www.githubstatus.com")
    .settings(&[
        Setting::new(
            "token",
            &["COPILOT_API_TOKEN"],
            "A GitHub token of the account with Copilot, e.g. a fine-grained personal \
             access token from https://github.com/settings/personal-access-tokens with no \
             extra permissions, or the output of `gh auth token`. Not needed when a \
             Copilot editor plugin is signed in on the host.",
        ),
        Setting::new(
            "enterprise_host",
            &[],
            "For GitHub Enterprise Cloud with data residency: the host, such as \
             octocorp.ghe.com. Usage is then read from api.<host>.",
        ),
    ]);

impl Service for Copilot {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let token = probe.setting("token").or_else(|| plugin_token(probe))?;
        let api = api_host(probe.text_setting("enterprise_host").as_deref());
        let request = Request::get(format!("https://{api}/copilot_internal/user"))
            .secret_header("Authorization", "token ", &token)
            .header("Accept", "application/json")
            .header("Editor-Version", "vscode/1.96.2")
            .header("Editor-Plugin-Version", "copilot-chat/0.26.7")
            .header("User-Agent", "GitHubCopilotChat/0.26.7")
            .header("X-Github-Api-Version", "2025-04-01");
        let body = match probe.body(request) {
            Ok(body) => body,
            Err(error) => return Some(Err(error)),
        };
        let login = login(probe, &api, &token);
        Some(parse(&body, login))
    }
}

fn plugin_token(probe: &mut Probe) -> Option<Secret> {
    let path = |file: &str| {
        HostPath::env_or(
            "XDG_CONFIG_HOME",
            ".config",
            format!("github-copilot/{file}"),
        )
    };
    let apps = probe.file(&path("apps.json"));
    if let Some(token) = apps.and_then(|apps| probe.field(&apps, &[PLUGIN_APP, "oauth_token"])) {
        return Some(token);
    }
    let hosts = probe.file(&path("hosts.json"))?;
    probe.field(&hosts, &["github.com", "oauth_token"])
}

/// `octocorp.ghe.com` is served by `api.octocorp.ghe.com`.
fn api_host(enterprise: Option<&str>) -> String {
    let host = enterprise
        .map(|raw| {
            let raw = raw.trim();
            let raw = raw
                .strip_prefix("https://")
                .or_else(|| raw.strip_prefix("http://"))
                .unwrap_or(raw);
            raw.split(['/', '?', '#'])
                .next()
                .unwrap_or_default()
                .trim_end_matches('.')
                .trim_end_matches(":443")
                .to_lowercase()
        })
        .filter(|host| {
            !host.is_empty()
                && host
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b':'))
        });
    match host.as_deref() {
        None | Some("github.com") | Some("api.github.com") => "api.github.com".into(),
        Some(host) if host.starts_with("api.") => host.into(),
        Some(host) => format!("api.{host}"),
    }
}

/// The GitHub login, shown as the account; not worth failing the report for.
fn login(probe: &mut Probe, api: &str, token: &Secret) -> Option<String> {
    let request = Request::get(format!("https://{api}/user"))
        .secret_header("Authorization", "token ", token)
        .header("Accept", "application/json");
    let user: User = probe.http(request).ok()?.json().ok()?;
    user.login.filter(|login| !login.trim().is_empty())
}

pub(crate) fn parse(body: &str, login: Option<String>) -> Result<Report> {
    let usage: Usage = json(body)?;
    let resets = usage
        .quota_reset_date
        .as_deref()
        .map(str::trim)
        .filter(|date| !date.is_empty())
        .and_then(reset_time);
    let snapshots = usage.quota_snapshots.unwrap_or_default();
    let monthly = usage.monthly_quotas.unwrap_or_default();
    let limited = usage.limited_user_quotas.unwrap_or_default();
    let premium = snapshots
        .premium_interactions
        .as_ref()
        .and_then(Snapshot::used)
        .or_else(|| fallback(monthly.completions, limited.completions));
    let chat = snapshots
        .chat
        .as_ref()
        .and_then(Snapshot::used)
        .or_else(|| fallback(monthly.chat, limited.chat));
    let windows: Vec<Window> = [("Premium", premium), ("Chat", chat)]
        .into_iter()
        .filter_map(|(name, used)| {
            Some(Window::new(
                Kind::Named(name.into()),
                used?,
                resets,
                Some(MONTH),
            ))
        })
        .collect();
    let credits = snapshots
        .premium_interactions
        .as_ref()
        .and_then(|snapshot| snapshot.credits_used)
        .or_else(|| {
            snapshots
                .chat
                .as_ref()
                .and_then(|snapshot| snapshot.credits_used)
        });
    let unlimited = [&snapshots.premium_interactions, &snapshots.chat]
        .into_iter()
        .flatten()
        .any(|snapshot| snapshot.unlimited == Some(true));
    let token_billing = usage.token_based_billing.unwrap_or(false);
    // Metered seats report 0 credits too; only show credits that mean something.
    let credits = credits.filter(|used| token_billing || unlimited || *used > 0.);
    let plan = usage
        .copilot_plan
        .map(|plan| title_case(&plan.replace('_', " ")))
        .filter(|plan| !plan.is_empty());
    let mut facts = Vec::new();
    if let Some(used) = credits {
        facts.push(("Credits used".into(), group(used.round() as i64)));
    }
    if unlimited && windows.is_empty() {
        facts.push(("Quota".into(), "Unlimited".into()));
    }
    Ok(
        Report::new(Provider(&Copilot), Account { email: login, plan }, windows).with_sections(
            (!facts.is_empty()).then(|| Section::Facts {
                title: "Credits".into(),
                facts,
            }),
        ),
    )
}

/// `2025-02-01` or a full timestamp, taken as UTC.
fn reset_time(text: &str) -> Option<SystemTime> {
    if let Some(at) = Timestamp::Text(text.to_owned()).time() {
        return Some(at);
    }
    let date = chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    let seconds = u64::try_from(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp()).ok()?;
    SystemTime::UNIX_EPOCH.checked_add(std::time::Duration::from_secs(seconds))
}

/// A share from the older `monthly_quotas`/`limited_user_quotas` counts.
fn fallback(total: Option<f64>, left: Option<f64>) -> Option<f64> {
    let total = total.filter(|total| *total > 0.)?;
    let left = left?.max(0.);
    Some(100. - (left / total * 100.).clamp(0., 100.))
}

#[derive(Deserialize)]
struct Usage {
    copilot_plan: Option<String>,
    token_based_billing: Option<bool>,
    quota_reset_date: Option<String>,
    quota_snapshots: Option<Snapshots>,
    monthly_quotas: Option<Counts>,
    limited_user_quotas: Option<Counts>,
}

#[derive(Default, Deserialize)]
struct Snapshots {
    premium_interactions: Option<Snapshot>,
    chat: Option<Snapshot>,
}

#[derive(Deserialize)]
struct Snapshot {
    #[serde(default, deserialize_with = "number")]
    entitlement: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    remaining: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    percent_remaining: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    credits_used: Option<f64>,
    unlimited: Option<bool>,
}

impl Snapshot {
    /// The used percent, or None for unlimited and zero-entitlement
    /// placeholders, which carry no quota.
    fn used(&self) -> Option<f64> {
        if self.unlimited == Some(true) {
            return None;
        }
        if self.entitlement == Some(0.) && self.remaining == Some(0.) {
            return None;
        }
        let left = self.percent_remaining.or_else(|| {
            let total = self.entitlement.filter(|total| *total > 0.)?;
            Some(self.remaining? / total * 100.)
        })?;
        Some((100. - left).max(0.))
    }
}

#[derive(Default, Deserialize)]
struct Counts {
    #[serde(default, deserialize_with = "number")]
    chat: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    completions: Option<f64>,
}

#[derive(Deserialize)]
struct User {
    login: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn premium_and_chat_quotas() {
        let body = r#"{
          "copilot_plan": "individual_pro",
          "assigned_date": "2025-01-01",
          "quota_reset_date": "2025-02-01",
          "quota_snapshots": {
            "premium_interactions": {"entitlement": 500, "remaining": 450,
              "percent_remaining": 90, "quota_id": "premium_interactions"},
            "chat": {"entitlement": 300, "remaining": 150, "percent_remaining": 50,
              "quota_id": "chat"}
          }
        }"#;
        let report = parse(body, Some("octocat".into())).unwrap();
        assert_eq!(report.account.email.as_deref(), Some("octocat"));
        assert_eq!(report.account.plan.as_deref(), Some("Individual pro"));
        assert_eq!(report.windows.len(), 2);
        let premium = report
            .windows
            .iter()
            .find(|w| w.kind == Kind::Named("Premium".into()))
            .unwrap();
        assert_eq!(premium.percent(), 10);
        assert_eq!(premium.length, Some(MONTH));
        assert_eq!(
            premium.resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_738_368_000))
        );
        let chat = report
            .windows
            .iter()
            .find(|w| w.kind == Kind::Named("Chat".into()))
            .unwrap();
        assert_eq!(chat.percent(), 50);
        assert!(report.sections.is_empty());
    }

    #[test]
    fn unlimited_and_placeholder_snapshots_are_not_windows() {
        let body = r#"{
          "copilot_plan": "business",
          "token_based_billing": true,
          "quota_snapshots": {
            "premium_interactions": {"entitlement": 0, "remaining": 0, "percent_remaining": 100,
              "credits_used": 31},
            "chat": {"unlimited": true}
          }
        }"#;
        let report = parse(body, None).unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(
            report.sections,
            vec![Section::Facts {
                title: "Credits".into(),
                facts: vec![
                    ("Credits used".into(), "31".into()),
                    ("Quota".into(), "Unlimited".into()),
                ],
            }]
        );
    }

    #[test]
    fn monthly_counts_fall_back() {
        let body = r#"{"copilot_plan": "free",
          "monthly_quotas": {"chat": 50, "completions": 2000},
          "limited_user_quotas": {"chat": 40, "completions": 500}}"#;
        let report = parse(body, None).unwrap();
        let chat = report
            .windows
            .iter()
            .find(|w| w.kind == Kind::Named("Chat".into()))
            .unwrap();
        assert_eq!(chat.percent(), 20);
        let premium = report
            .windows
            .iter()
            .find(|w| w.kind == Kind::Named("Premium".into()))
            .unwrap();
        assert_eq!(premium.percent(), 75);
    }

    #[test]
    fn enterprise_hosts() {
        assert_eq!(api_host(None), "api.github.com");
        assert_eq!(
            api_host(Some("https://octocorp.ghe.com/login")),
            "api.octocorp.ghe.com"
        );
        assert_eq!(
            api_host(Some("api.octocorp.ghe.com")),
            "api.octocorp.ghe.com"
        );
    }
}
