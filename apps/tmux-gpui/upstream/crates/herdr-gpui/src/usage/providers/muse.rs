//! Muse Code subscription usage, read with the Muse CLI's own device-code
//! login (`muse login`): `providers.meta.access_token` in
//! `$MUSE_AUTH_PATH` (default `~/.config/muse/auth.json`), else the login
//! keychain item `ai.meta.dev.credentials` / `meta` on a Mac, else the
//! `token` setting. The `dca:` token is posted to `muse-code/key`, whose
//! answer carries the plan, the 5-hour and weekly windows, and a freshly
//! minted inference key that is ignored and never stored.
//!
//! Not ported: CodexBar's keychain access-list preflight, which avoids a
//! prompt for a CLI-owned item (here the bounded `security` read times out
//! instead); its `dca:` prefix check, which would need the token revealed;
//! and the local session-log token history, which scans large directories.
//! On a remote host the minted inference key comes back with the response
//! body, as it does to CodexBar, and is dropped by the parser.

use crate::{
    Result,
    usage::{
        model::{Account, Kind, Provider, Report, SESSION, Section, WEEK, Window},
        probe::{HostPath, Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::Duration;

const URL: &str = "https://api.meta.ai/muse-code/key";
const KEYCHAIN: &str = "ai.meta.dev.credentials";
/// Later reset times than the year 4000 are dropped, as CodexBar does.
const LATEST: f64 = 64_092_211_200.;

pub(crate) struct Muse;

static META: Meta = Meta::new("muse", "Muse Code")
    .dashboard("https://dev.meta.ai")
    .settings(&[Setting::new(
        "token",
        &[],
        "A Muse CLI device-code access token (it starts with dca:), used when this host \
         has no `muse login`. It is providers.meta.access_token in \
         ~/.config/muse/auth.json on a machine where you ran `muse login`. Dashboard \
         LLM_ keys and LLM| inference keys are not accepted.",
    )]);

impl Service for Muse {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let file = probe.file(&HostPath::env_or(
            "MUSE_AUTH_PATH",
            ".config/muse/auth.json",
            "",
        ));
        let inline = file
            .as_ref()
            .and_then(|file| probe.field(file, &["providers", "meta", "access_token"]));
        let keychain = || {
            probe
                .is_macos()
                .then(|| probe.keychain(KEYCHAIN, Some("meta")))
                .flatten()
                .and_then(|payload| probe.field(&payload, &["access_token"]))
        };
        let token = inline
            .or_else(keychain)
            .or_else(|| probe.setting("token"))?;
        let request = Request::post(URL)
            .bearer(&token)
            .header("x-api-version", "1.0.0")
            .header("User-Agent", "CodexBar")
            .json("{}");
        Some(probe.body(request).and_then(|body| parse(&body)))
    }
}

pub(crate) fn parse(body: &str) -> Result<Report> {
    let key: Key = json(body)?;
    let plan = key
        .subs_tier_name
        .map(|plan| plan.trim().to_owned())
        .filter(|plan| !plan.is_empty());
    let email = key
        .user_email
        .map(|email| email.trim().to_owned())
        .filter(|email| !email.is_empty());
    let account = Account {
        email,
        plan: plan.or_else(|| Some("Muse login".into())),
    };
    let status = if key.require_payment == Some(true) {
        Some("Payment method required; finish billing at https://dev.meta.ai")
    } else if key.is_subs_active != Some(true) {
        Some("No active subscription on this login")
    } else if key.subs_usage.is_none() {
        Some("Quota not included in this login response")
    } else {
        None
    };
    if let Some(status) = status {
        return Ok(
            Report::new(Provider(&Muse), account, Vec::new()).with_sections([Section::Facts {
                title: "Subscription".into(),
                facts: vec![("Status".into(), status.into())],
            }]),
        );
    }
    let mut windows = Vec::new();
    if let Some(usage) = key.subs_usage {
        let minutes = usage.window.window_duration_mins.round();
        if !(1. ..1e9).contains(&minutes) {
            return Err(invalid());
        }
        let length = Duration::from_secs(minutes as u64 * 60);
        let kind = if length == SESSION {
            Kind::Session
        } else {
            Kind::Named(format!("{} hours", minutes / 60.))
        };
        windows.push(Window::new(
            kind,
            usage.window.used_percent,
            reset(usage.window.resets_at),
            Some(length),
        ));
        windows.push(Window::new(
            Kind::Weekly,
            usage.weekly.used_percent,
            reset(usage.weekly.resets_at),
            Some(WEEK),
        ));
    }
    Ok(Report::new(Provider(&Muse), account, windows))
}

fn reset(seconds: Option<f64>) -> Option<std::time::SystemTime> {
    seconds
        .filter(|seconds| *seconds > 0. && *seconds <= LATEST)
        .and_then(|seconds| Timestamp::Number(seconds).time())
}

#[derive(Deserialize)]
struct Key {
    require_payment: Option<bool>,
    is_subs_active: Option<bool>,
    user_email: Option<String>,
    subs_tier_name: Option<String>,
    subs_usage: Option<SubsUsage>,
}

#[derive(Deserialize)]
struct SubsUsage {
    window: Limit,
    weekly: Limit,
}

#[derive(Deserialize)]
struct Limit {
    used_percent: f64,
    #[serde(default = "no_duration")]
    window_duration_mins: f64,
    resets_at: Option<f64>,
}

/// The weekly window has no duration; a missing one on the rolling window is
/// refused by the parser.
fn no_duration() -> f64 {
    0.
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    const ACCOUNT: &str = r#"{
      "api_key":"LLM|fixture-inference-key", "payment_method":"Visa-0000",
      "require_payment":false, "is_subs_active":true, "user_email":"ada@example.com",
      "subs_tier_name":"Muse Code Power Usage",
      "subs_usage":{
        "window":{"used_percent":96,"window_duration_mins":300,"resets_at":1788599502},
        "weekly":{"used_percent":40,"resets_at":1788739200}
      }
    }"#;

    #[test]
    fn reads_both_windows_and_identity() {
        let report = parse(ACCOUNT).unwrap();
        assert_eq!(report.account.email.as_deref(), Some("ada@example.com"));
        assert_eq!(
            report.account.plan.as_deref(),
            Some("Muse Code Power Usage")
        );
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Session);
        assert_eq!(report.windows[0].used, 96.);
        assert_eq!(
            report.windows[0].resets_at,
            Some(SystemTime::UNIX_EPOCH + Duration::from_secs(1_788_599_502))
        );
        assert_eq!(report.windows[1].kind, Kind::Weekly);
        assert_eq!(report.windows[1].used, 40.);
        assert!(report.sections.is_empty());
    }

    #[test]
    fn active_login_without_quota_keeps_identity() {
        for body in [
            r#"{"is_subs_active":true,"user_email":"ada@example.com","subs_tier_name":"Muse Code Power Usage"}"#,
            r#"{"is_subs_active":true,"subs_tier_name":"Muse Code Power Usage","subs_usage":null}"#,
        ] {
            let report = parse(body).unwrap();
            assert!(report.windows.is_empty());
            assert_eq!(
                report.account.plan.as_deref(),
                Some("Muse Code Power Usage")
            );
            assert_eq!(report.sections.len(), 1);
        }
    }

    #[test]
    fn inactive_or_unpaid_invents_no_quota() {
        for body in [
            r#"{"require_payment":true,"is_subs_active":false}"#,
            r#"{"is_subs_active":false,"subs_usage":null}"#,
        ] {
            assert!(parse(body).unwrap().windows.is_empty());
        }
    }

    #[test]
    fn refuses_malformed_quota() {
        assert!(parse(r#"{"is_subs_active":true,"subs_usage":"window"}"#).is_err());
        let zero = ACCOUNT.replace("\"window_duration_mins\":300", "\"window_duration_mins\":0");
        assert!(parse(&zero).is_err());
    }

    #[test]
    fn drops_out_of_range_resets() {
        let body = ACCOUNT.replace("1788599502", "1e30");
        let report = parse(&body).unwrap();
        assert_eq!(report.windows[0].resets_at, None);
        assert_eq!(report.windows[0].used, 96.);
    }
}
