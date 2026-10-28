//! MiniMax Coding Plan and Token Plan quotas. The sign-in is, in CodexBar's
//! order, an API key (`api_key`, or `MINIMAX_CODING_API_KEY`/`MINIMAX_API_KEY`
//! here or on the probed host) read against the Token Plan endpoint and then
//! the legacy Coding Plan one, else a platform.minimax.io web session
//! (`cookie`, `MINIMAX_COOKIE`/`MINIMAX_COOKIE_HEADER`, or the browser's
//! cookies for a provider listed in the config) read against the web
//! remains endpoint. `region = "cn"` uses the China mainland hosts.
//!
//! Not ported: CodexBar also scrapes the Coding Plan HTML page when the
//! remains endpoint fails, reads access tokens from Chromium localStorage and
//! IndexedDB, and charts the web billing history; the probe cannot read
//! browser storage, and the page scrape and billing history add little to the
//! quota windows.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Balance, Kind, Provider, Report, SESSION, Section, Unit, WEEK, Window},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting, json, number},
        values,
    },
};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const TOKEN_PLAN_PATH: &str = "/v1/token_plan/remains";
const CODING_PLAN_PATH: &str = "/v1/api/openplatform/coding_plan/remains";
const COOKIE_DOMAINS: [&str; 6] = [
    "platform.minimax.io",
    "openplatform.minimax.io",
    "minimax.io",
    "platform.minimaxi.com",
    "openplatform.minimaxi.com",
    "minimaxi.com",
];
const AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                     (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

pub(crate) struct Minimax;

struct Hosts {
    api: &'static str,
    platform: &'static str,
    www: &'static str,
}

const GLOBAL: Hosts = Hosts {
    api: "https://api.minimax.io",
    platform: "https://platform.minimax.io",
    www: "https://www.minimax.io",
};
const CHINA: Hosts = Hosts {
    api: "https://api.minimaxi.com",
    platform: "https://platform.minimaxi.com",
    www: "https://www.minimaxi.com",
};

static META: Meta = Meta::new("minimax", "MiniMax")
    .dashboard("https://platform.minimax.io/user-center/payment/coding-plan?cycle_type=3")
    .settings(&[
        Setting::new(
            "api_key",
            &["MINIMAX_CODING_API_KEY", "MINIMAX_API_KEY"],
            "A MiniMax Coding Plan or Token Plan API key (sk-cp-…) from \
             https://platform.minimax.io/user-center/basic-information/interface-key.",
        ),
        Setting::new(
            "cookie",
            &["MINIMAX_COOKIE", "MINIMAX_COOKIE_HEADER"],
            "Used when no API key is set. Sign in to https://platform.minimax.io, open \
             Developer Tools > Application > Cookies > https://platform.minimax.io, and \
             copy every cookie (including HERTZ-SESSION) as \"name=value; name2=value2\".",
        ),
        Setting::new(
            "region",
            &[],
            "\"global\" for minimax.io (the default) or \"cn\" for the China mainland \
             platform at minimaxi.com.",
        ),
    ]);

impl Service for Minimax {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let hosts = match probe.text_setting("region").as_deref() {
            Some("cn") => &CHINA,
            _ => &GLOBAL,
        };
        let key = probe
            .setting("api_key")
            .or_else(|| probe.env("MINIMAX_CODING_API_KEY"))
            .or_else(|| probe.env("MINIMAX_API_KEY"));
        if let Some(key) = key {
            return Some(with_key(probe, &key, hosts));
        }
        let cookie = probe.cookies(&COOKIE_DOMAINS, &[])?;
        Some(with_cookie(probe, &cookie, hosts))
    }
}

/// The Token Plan endpoint first; the legacy Coding Plan one when it does not
/// know the key or the plan.
fn with_key(probe: &mut Probe, key: &Secret, hosts: &Hosts) -> Result<Report> {
    let mut first = None;
    for path in [TOKEN_PLAN_PATH, CODING_PLAN_PATH] {
        let request = Request::get(format!("{}{path}", hosts.api))
            .bearer(key)
            .header("Accept", "application/json");
        let result = probe
            .body(request)
            .and_then(|body| parse(&body, SystemTime::now()));
        match result {
            Ok(report) => return Ok(report),
            // A key the Token Plan rejects may still be a legacy Coding Plan key.
            Err(error) => match first.take() {
                None => first = Some(error),
                Some(Error::UsageRejected) => return Err(Error::UsageRejected),
                Some(_) => return Err(error),
            },
        }
    }
    Err(first.unwrap_or(Error::UsageStatus(404)))
}

fn with_cookie(probe: &mut Probe, cookie: &Secret, hosts: &Hosts) -> Result<Report> {
    let mut last = Error::UsageStatus(404);
    for base in [hosts.platform, hosts.www] {
        let request = Request::get(format!("{base}{CODING_PLAN_PATH}"))
            .cookie(cookie)
            .header("Accept", "application/json, text/plain, */*")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("User-Agent", AGENT)
            .header("X-Requested-With", "XMLHttpRequest")
            .header("Origin", base)
            .header(
                "Referer",
                format!("{}/user-center/payment/coding-plan", hosts.platform),
            );
        match probe
            .body(request)
            .and_then(|body| parse(&body, SystemTime::now()))
        {
            Ok(report) => return Ok(report),
            Err(error @ Error::UsageRejected) => return Err(error),
            Err(error) => last = error,
        }
    }
    Err(last)
}

pub(crate) fn parse(body: &str, now: SystemTime) -> Result<Report> {
    let root: Payload = json(body)?;
    let status = root
        .data
        .as_ref()
        .and_then(|data| data.base_resp.as_ref())
        .or(root.base_resp.as_ref())
        .and_then(|base| base.status_code);
    // 1004 is MiniMax's signed-out status.
    match status {
        None => {}
        Some(0.) => {}
        Some(1004.) => return Err(Error::UsageRejected),
        Some(_) => return Err(values::invalid()),
    }
    let data = root.data.unwrap_or(root.plan);
    if data.model_remains.is_empty() {
        return Err(values::invalid());
    }

    let mut windows = Vec::new();
    let mut others = Vec::new();
    for item in &data.model_remains {
        let Some(model) = item.model_name.as_deref() else {
            continue;
        };
        let service = service_name(model);
        let text = is_text(model);
        let interval = Lane {
            total: item.current_interval_total_count,
            remaining: item.current_interval_usage_count,
            remaining_percent: item.current_interval_remaining_percent,
            status: item.current_interval_status,
            start: item.start_time,
            end: item.end_time,
            remains: item.remains_time,
        };
        if let Some(window) = interval.window(&service, text, false, now) {
            (if text { &mut windows } else { &mut others }).push(window);
        }
        // Only text generation has a real weekly quota.
        if text {
            let weekly = Lane {
                total: item.current_weekly_total_count,
                remaining: item.current_weekly_usage_count,
                remaining_percent: item.current_weekly_remaining_percent,
                status: item.current_weekly_status,
                start: item.weekly_start_time,
                end: item.weekly_end_time,
                remains: item.weekly_remains_time,
            };
            if let Some(window) = weekly.window(&service, text, true, now) {
                windows.push(window);
            }
        }
    }
    if windows.is_empty() && !others.is_empty() {
        windows.push(others.remove(0));
    }

    let plan = [
        data.current_subscribe_title,
        data.plan_name,
        data.combo_title,
        data.current_plan_title,
        data.current_combo_card.and_then(|card| card.title),
    ]
    .into_iter()
    .flatten()
    .map(|plan| plan.trim().to_owned())
    .find(|plan| !plan.is_empty());
    let points = [
        data.points_balance,
        data.point_balance,
        data.credits_balance,
        data.credit_balance,
        data.balance,
    ]
    .into_iter()
    .flatten()
    .find(|value| value.is_finite());
    Ok(
        Report::new(Provider(&Minimax), Account { email: None, plan }, windows)
            .with_balances(
                points.map(|points| Balance::new("Points", points, Unit::Count("points".into()))),
            )
            .with_sections(others.into_iter().map(Section::Limit)),
    )
}

/// `general` and `MiniMax-M*` are text generation; the rest are named by
/// what they make.
fn service_name(model: &str) -> String {
    let lower = model.trim().to_lowercase();
    if is_text(model) {
        "Text".into()
    } else if lower == "video" {
        "Video".into()
    } else if lower.contains("speech") {
        "Speech".into()
    } else if lower.contains("hailuo") && lower.contains("fast") {
        "Image to video".into()
    } else if lower.contains("hailuo") {
        "Text to video".into()
    } else if lower.starts_with("image-") {
        "Image".into()
    } else if lower.contains("music") {
        "Music".into()
    } else {
        model.trim().to_owned()
    }
}

fn is_text(model: &str) -> bool {
    let lower = model.trim().to_lowercase();
    lower == "general" || lower.contains("minimax-m") || lower.starts_with("m2.")
}

/// One quota lane. `usage_count` fields hold what is left, not what is used.
struct Lane {
    total: Option<f64>,
    remaining: Option<f64>,
    remaining_percent: Option<f64>,
    status: Option<f64>,
    start: Option<f64>,
    end: Option<f64>,
    remains: Option<f64>,
}

impl Lane {
    fn window(&self, service: &str, text: bool, weekly: bool, now: SystemTime) -> Option<Window> {
        let full = self.remaining_percent.is_some_and(|left| left >= 100.);
        let empty = self.total.unwrap_or(0.) == 0. && self.remaining.unwrap_or(0.) == 0.;
        // Status 3 is a lane the plan does not include, or an unlimited weekly
        // text quota; neither is a limit to show.
        if self.status == Some(3.) && full && (empty || (text && weekly)) {
            return None;
        }
        let used = match (self.remaining_percent, self.total, self.remaining) {
            (Some(left), _, _) => 100. - left,
            (None, Some(total), Some(remaining)) if total > 0. => {
                (total - remaining).max(0.) / total * 100.
            }
            _ => return None,
        };
        let start = self.start.and_then(epoch);
        let end = self.end.and_then(epoch);
        let length = match (start, end) {
            (Some(start), Some(end)) => end
                .duration_since(start)
                .ok()
                .filter(|span| !span.is_zero()),
            _ => None,
        };
        let resets = end.filter(|end| *end > now).or_else(|| {
            let remains = self.remains.filter(|remains| *remains > 0.)?;
            let seconds = if remains > 1_000_000. {
                remains / 1000.
            } else {
                remains
            };
            now.checked_add(Duration::from_secs_f64(seconds))
        });
        let near = |length: Duration, target: Duration| {
            length.abs_diff(target) <= Duration::from_secs(3600)
        };
        let kind = match length {
            _ if text && weekly => Kind::Weekly,
            Some(length) if text && near(length, SESSION) => Kind::Session,
            Some(length) if near(length, Duration::from_secs(86_400)) => {
                Kind::Named(format!("{service} daily"))
            }
            Some(length) => Kind::Named(format!("{service} {}h", length.as_secs().div_ceil(3600))),
            None => Kind::Named(service.to_owned()),
        };
        let length = if weekly {
            length.or(Some(WEEK))
        } else {
            length
        };
        Some(Window::new(kind, used, resets, length))
    }
}

/// MiniMax sends seconds or milliseconds.
fn epoch(value: f64) -> Option<SystemTime> {
    let seconds = if value > 1e12 {
        value / 1000.
    } else if value > 1e9 {
        value
    } else {
        return None;
    };
    SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs_f64(seconds))
}

#[derive(Deserialize)]
struct Payload {
    base_resp: Option<BaseResp>,
    data: Option<Plan>,
    #[serde(flatten)]
    plan: Plan,
}

#[derive(Deserialize)]
struct BaseResp {
    #[serde(default, deserialize_with = "number")]
    status_code: Option<f64>,
}

#[derive(Deserialize)]
struct Plan {
    base_resp: Option<BaseResp>,
    current_subscribe_title: Option<String>,
    plan_name: Option<String>,
    combo_title: Option<String>,
    current_plan_title: Option<String>,
    current_combo_card: Option<ComboCard>,
    #[serde(default, deserialize_with = "number")]
    points_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    point_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    credits_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    credit_balance: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    balance: Option<f64>,
    #[serde(default)]
    model_remains: Vec<ModelRemains>,
}

#[derive(Deserialize)]
struct ComboCard {
    title: Option<String>,
}

#[derive(Deserialize)]
struct ModelRemains {
    model_name: Option<String>,
    #[serde(default, deserialize_with = "number")]
    current_interval_total_count: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    current_interval_usage_count: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    current_interval_remaining_percent: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    current_interval_status: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    start_time: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    end_time: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    remains_time: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    current_weekly_total_count: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    current_weekly_usage_count: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    current_weekly_remaining_percent: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    current_weekly_status: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    weekly_start_time: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    weekly_end_time: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    weekly_remains_time: Option<f64>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn coding_plan_counts_left_become_session_and_weekly() {
        let start = 1_700_000_000_000_u64;
        let end = start + 5 * 3600 * 1000;
        let week_start = start - 2 * 86_400 * 1000;
        let week_end = week_start + 7 * 86_400 * 1000;
        let body = format!(
            r#"{{"base_resp": {{"status_code": 0}}, "current_subscribe_title": "Max",
              "model_remains": [{{"model_name": "MiniMax-M1",
                "current_interval_total_count": 1000, "current_interval_usage_count": 250,
                "start_time": {start}, "end_time": {end},
                "current_weekly_total_count": 6000, "current_weekly_usage_count": 5376,
                "weekly_start_time": {week_start}, "weekly_end_time": {week_end}}}]}}"#
        );
        let report = parse(&body, at(1_700_000_000)).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Max"));
        assert_eq!(report.windows.len(), 2);
        let session = &report.windows[0];
        assert_eq!(session.kind, Kind::Session);
        assert_eq!(session.percent(), 75);
        assert_eq!(session.length, Some(SESSION));
        assert_eq!(session.resets_at, Some(at(1_700_000_000 + 5 * 3600)));
        let weekly = &report.windows[1];
        assert_eq!(weekly.kind, Kind::Weekly);
        assert_eq!(weekly.percent(), 10);
        assert_eq!(weekly.length, Some(WEEK));
    }

    #[test]
    fn token_plan_percentages_and_other_lanes() {
        let body = r#"{
          "base_resp": { "status_code": "0" },
          "model_remains": [
            {"model_name": "video", "current_interval_total_count": 100,
             "current_interval_usage_count": 70, "current_interval_remaining_percent": 30,
             "start_time": 1780243200000, "end_time": 1780329600000},
            {"model_name": "general", "current_interval_total_count": 0,
             "current_interval_usage_count": 0, "current_interval_remaining_percent": 96,
             "start_time": 1780279200000, "end_time": 1780297200000,
             "current_weekly_total_count": 0, "current_weekly_usage_count": 0,
             "current_weekly_remaining_percent": 99,
             "weekly_start_time": 1780243200000, "weekly_end_time": 1780848000000},
            {"model_name": "Hailuo-2.3", "current_interval_status": 3,
             "current_interval_total_count": 0, "current_interval_usage_count": 0,
             "current_interval_remaining_percent": 100}
          ],
          "points_balance": 14000
        }"#;
        let report = parse(body, at(1_780_282_340)).unwrap();
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Session);
        assert_eq!(report.windows[0].percent(), 4);
        assert_eq!(report.windows[1].kind, Kind::Weekly);
        assert_eq!(report.windows[1].percent(), 1);
        // The video lane is kept as a section; the unavailable Hailuo lane is not.
        assert_eq!(report.sections.len(), 1);
        let Section::Limit(video) = &report.sections[0] else {
            panic!("limit");
        };
        assert_eq!(video.kind, Kind::Named("Video daily".into()));
        assert_eq!(video.percent(), 70);
        assert_eq!(report.balances[0].amount, 14000.);
    }

    #[test]
    fn signed_out_status_is_rejected() {
        let body = r#"{"base_resp": {"status_code": 1004, "status_msg": "cookie is missing, log in again"}}"#;
        assert!(matches!(
            parse(body, at(0)).unwrap_err(),
            Error::UsageRejected
        ));
    }
}
