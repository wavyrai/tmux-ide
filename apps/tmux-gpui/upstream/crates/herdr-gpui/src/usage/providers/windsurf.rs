//! Windsurf plan quota. Two sources, in CodexBar's order:
//!
//! - A pasted website session bundle (the `session` setting): the four
//!   `devin_*` values windsurf.com keeps in localStorage, sent to
//!   `GetPlanStatus` for live daily and weekly quota.
//! - The plan the Windsurf editor caches in its `state.vscdb`
//!   (`windsurf.settings.cachedPlanInfo`), read on the host with the
//!   `sqlite3` CLI. It holds no credential, and it is only as fresh as the
//!   editor's last launch.
//!
//! Not ported: importing the session bundle from a browser's localStorage,
//! which the probe cannot read. `GetPlanStatus` is a ConnectRPC method;
//! CodexBar sends it protobuf, but a protobuf body needs the token's length
//! and the answer is binary, so it is asked with Connect's JSON encoding
//! instead, which Connect servers accept alongside protobuf. A cache stored
//! as a UTF-16 blob, which CodexBar also decodes, is not read.

use crate::{
    Error, Result,
    usage::{
        model::{Account, DAY, Kind, Provider, Report, Section, WEEK, Window},
        probe::{HostPath, Part, Probe, Request, Secret},
        service::{Meta, Service, Setting, Timestamp, json},
        values::invalid,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const PLAN_STATUS: &str =
    "https://windsurf.com/_backend/exa.seat_management_pb.SeatManagementService/GetPlanStatus";
const MAC_CACHE: &str = "Library/Application Support/Windsurf/User/globalStorage/state.vscdb";
const LINUX_CACHE: &str = ".config/Windsurf/User/globalStorage/state.vscdb";
const QUERY: &str =
    "SELECT value FROM ItemTable WHERE key = 'windsurf.settings.cachedPlanInfo' LIMIT 1;";
/// Runs `sqlite3` read-only on `$HOME/$1`, so the path needs no quoting here.
const SCRIPT: &str = "exec sqlite3 -readonly \"$HOME/$1\" \"$2\"";

pub(crate) struct Windsurf;

static META: Meta = Meta::new("windsurf", "Windsurf")
    .dashboard("https://windsurf.com/subscription/usage")
    .status_page("https://status.windsurf.com")
    .settings(&[Setting::new(
        "session",
        &[],
        "The windsurf.com session bundle, for live quota. Sign in at \
         https://windsurf.com/profile in Chrome, open Developer Tools → Application → \
         Local Storage → https://windsurf.com (or https://app.devin.ai), and copy the values \
         of devin_session_token, devin_auth1_token, devin_account_id, and \
         devin_primary_org_id into one JSON object: \
         {\"devin_session_token\": \"…\", \"devin_auth1_token\": \"…\", \
         \"devin_account_id\": \"…\", \"devin_primary_org_id\": \"…\"}. Without it, the \
         plan the Windsurf editor cached at its last launch is shown.",
    )]);

impl Service for Windsurf {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        if let Some(bundle) = probe.setting("session") {
            return Some(web(probe, &bundle));
        }
        let cache = if probe.is_macos() {
            MAC_CACHE
        } else {
            LINUX_CACHE
        };
        if !probe.exists(&HostPath::home(cache)) {
            return None;
        }
        let output = match probe.command(
            "sh",
            &["-c", SCRIPT, "sh", cache, QUERY],
            Duration::from_secs(10),
        ) {
            Ok(output) if output.success => output,
            Ok(_) => return Some(Err(Error::UsageCommand("read the Windsurf plan cache"))),
            Err(error) => return Some(Err(error)),
        };
        let cached = output.stdout.trim();
        // No cached plan means the editor was never signed in.
        (!cached.is_empty()).then(|| parse_cache(cached))
    }
}

fn web(probe: &mut Probe, bundle: &Secret) -> Result<Report> {
    let session = value(probe, bundle, "devin_session_token")?;
    let auth1 = value(probe, bundle, "devin_auth1_token")?;
    let account = value(probe, bundle, "devin_account_id")?;
    let org = value(probe, bundle, "devin_primary_org_id")?;
    let request = Request::post(PLAN_STATUS)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json")
        .header("Connect-Protocol-Version", "1")
        .header("Origin", "https://windsurf.com")
        .header("Referer", "https://windsurf.com/profile")
        .secret_header("x-auth-token", "", &session)
        .secret_header("x-devin-session-token", "", &session)
        .secret_header("x-devin-auth1-token", "", &auth1)
        .secret_header("x-devin-account-id", "", &account)
        .secret_header("x-devin-primary-org-id", "", &org)
        .body(vec![
            Part::Text("{\"authToken\":\"".into()),
            Part::Secret(session.clone()),
            Part::Text("\",\"includeTopUpStatus\":true}".into()),
        ]);
    parse_web(&probe.body(request)?)
}

/// One value of the pasted bundle; a bundle missing one is no sign-in.
fn value(probe: &mut Probe, bundle: &Secret, key: &str) -> Result<Secret> {
    probe.field(bundle, &[key]).ok_or(Error::UsageNotSignedIn)
}

/// A `GetPlanStatus` answer in Connect's JSON encoding.
pub(crate) fn parse_web(body: &str) -> Result<Report> {
    let status = json::<PlanStatusResponse>(body)?
        .plan_status
        .ok_or_else(invalid)?;
    let quota = |remaining: Option<f64>, resets: Option<&Timestamp>| {
        Some((remaining?, resets.and_then(Timestamp::time)))
    };
    Ok(report(
        status.plan_info.and_then(|info| info.plan_name),
        quota(
            status.daily_quota_remaining_percent,
            status.daily_quota_reset_at_unix.as_ref(),
        ),
        quota(
            status.weekly_quota_remaining_percent,
            status.weekly_quota_reset_at_unix.as_ref(),
        ),
        Vec::new(),
        status.plan_end.as_ref().and_then(Timestamp::time),
    ))
}

/// The editor's cached plan. Newer caches drop the quota percentages but
/// keep message and flow-action counters, which stand in for them.
pub(crate) fn parse_cache(body: &str) -> Result<Report> {
    let info: CachedPlanInfo = json(body)?;
    let quota = info.quota_usage.as_ref();
    let daily = quota.and_then(|quota| {
        Some((
            quota.daily_remaining_percent?,
            quota.daily_reset_at_unix.as_ref().and_then(Timestamp::time),
        ))
    });
    let weekly = quota.and_then(|quota| {
        Some((
            quota.weekly_remaining_percent?,
            quota
                .weekly_reset_at_unix
                .as_ref()
                .and_then(Timestamp::time),
        ))
    });
    let counters = info
        .usage
        .as_ref()
        .map(|usage| {
            [
                (
                    daily.is_none(),
                    "Messages",
                    usage.messages,
                    usage.used_messages,
                    usage.remaining_messages,
                ),
                (
                    weekly.is_none(),
                    "Flow actions",
                    usage.flow_actions,
                    usage.used_flow_actions,
                    usage.remaining_flow_actions,
                ),
            ]
            .into_iter()
            .filter(|(missing, ..)| *missing)
            .filter_map(|(_, name, total, used, remaining)| counter(name, total, used, remaining))
            .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(report(
        info.plan_name,
        daily,
        weekly,
        counters,
        info.end_timestamp.as_ref().and_then(Timestamp::time),
    ))
}

/// `used / total` of a counter, the used count inferred from the remainder
/// when the cache only has that.
fn counter(
    name: &str,
    total: Option<f64>,
    used: Option<f64>,
    remaining: Option<f64>,
) -> Option<Window> {
    let total = total.filter(|total| *total > 0.)?;
    let used = used.or_else(|| remaining.map(|remaining| (total - remaining).max(0.)))?;
    Some(Window::new(
        Kind::Named(name.to_owned()),
        used.clamp(0., total) / total * 100.,
        None,
        None,
    ))
}

type Quota = Option<(f64, Option<SystemTime>)>;

fn report(
    plan: Option<String>,
    daily: Quota,
    weekly: Quota,
    counters: Vec<Window>,
    plan_end: Option<SystemTime>,
) -> Report {
    let windows = [(Kind::Daily, DAY, daily), (Kind::Weekly, WEEK, weekly)]
        .into_iter()
        .filter_map(|(kind, length, quota)| {
            let (remaining, resets_at) = quota?;
            Some(Window::new(kind, 100. - remaining, resets_at, Some(length)))
        })
        .chain(counters)
        .collect();
    let plan = plan
        .map(|plan| plan.trim().to_owned())
        .filter(|plan| !plan.is_empty());
    let ends = plan_end.map(|end| Section::Facts {
        title: "Plan".into(),
        facts: vec![(
            "Renews".into(),
            chrono::DateTime::<chrono::Utc>::from(end)
                .format("%b %-d, %Y")
                .to_string(),
        )],
    });
    Report::new(Provider(&Windsurf), Account { email: None, plan }, windows).with_sections(ends)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanStatusResponse {
    plan_status: Option<PlanStatus>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanStatus {
    plan_info: Option<PlanInfo>,
    plan_end: Option<Timestamp>,
    daily_quota_remaining_percent: Option<f64>,
    weekly_quota_remaining_percent: Option<f64>,
    daily_quota_reset_at_unix: Option<Timestamp>,
    weekly_quota_reset_at_unix: Option<Timestamp>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanInfo {
    plan_name: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPlanInfo {
    plan_name: Option<String>,
    end_timestamp: Option<Timestamp>,
    usage: Option<CachedUsage>,
    quota_usage: Option<QuotaUsage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedUsage {
    messages: Option<f64>,
    used_messages: Option<f64>,
    remaining_messages: Option<f64>,
    flow_actions: Option<f64>,
    used_flow_actions: Option<f64>,
    remaining_flow_actions: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaUsage {
    daily_remaining_percent: Option<f64>,
    weekly_remaining_percent: Option<f64>,
    daily_reset_at_unix: Option<Timestamp>,
    weekly_reset_at_unix: Option<Timestamp>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> Option<SystemTime> {
        Some(SystemTime::UNIX_EPOCH + Duration::from_secs(seconds))
    }

    /// CodexBar's status probe fixture.
    const CACHE: &str = r#"{
      "planName": "Pro",
      "startTimestamp": 1771610750000,
      "endTimestamp": 1774029950000,
      "usage": {
        "messages": 50000, "usedMessages": 35650, "remainingMessages": 14350,
        "flowActions": 150000, "usedFlowActions": 0, "remainingFlowActions": 150000
      },
      "quotaUsage": {
        "dailyRemainingPercent": 9, "weeklyRemainingPercent": 54,
        "dailyResetAtUnix": 1774080000, "weeklyResetAtUnix": 1774166400
      }
    }"#;

    #[test]
    fn reads_cached_quota() {
        let report = parse_cache(CACHE).unwrap();
        assert_eq!(report.provider.id(), "windsurf");
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Daily);
        assert_eq!(report.windows[0].percent(), 91);
        assert_eq!(report.windows[0].resets_at, at(1_774_080_000));
        assert_eq!(report.windows[1].kind, Kind::Weekly);
        assert_eq!(report.windows[1].percent(), 46);
        assert_eq!(report.windows[1].resets_at, at(1_774_166_400));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected facts");
        };
        assert_eq!(facts[0], ("Renews".to_owned(), "Mar 20, 2026".to_owned()));
    }

    #[test]
    fn counters_stand_in_for_missing_quota() {
        let report = parse_cache(
            r#"{"planName":"Free","usage":{"messages":50000,"remainingMessages":14350,
                "flowActions":150000,"usedFlowActions":0}}"#,
        )
        .unwrap();
        assert_eq!(report.windows[0].kind, Kind::Named("Flow actions".into()));
        assert_eq!(report.windows[0].percent(), 0);
        assert_eq!(report.windows[1].kind, Kind::Named("Messages".into()));
        assert_eq!(report.windows[1].percent(), 71);
        assert!(report.sections.is_empty());
    }

    #[test]
    fn reads_the_connect_json_plan_status() {
        let report = parse_web(
            r#"{"planStatus":{"planInfo":{"planName":"Pro","teamsTier":1},
                "planEnd":"2026-10-01T00:00:00Z",
                "dailyQuotaRemainingPercent":75,"weeklyQuotaRemainingPercent":40,
                "dailyQuotaResetAtUnix":"1774080000","weeklyQuotaResetAtUnix":"1774166400"}}"#,
        )
        .unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        assert_eq!(report.windows[0].percent(), 25);
        assert_eq!(report.windows[0].resets_at, at(1_774_080_000));
        assert_eq!(report.windows[1].percent(), 60);
        assert_eq!(report.windows[1].resets_at, at(1_774_166_400));
    }

    #[test]
    fn an_empty_status_is_an_error() {
        assert!(matches!(parse_web("{}"), Err(Error::UsageJson(_))));
    }
}
