//! z.ai / GLM Coding Plan quotas, read with an API key: `api_key` or
//! `Z_AI_API_KEY` (here or on the probed host), and for the BigModel China
//! region also `BIGMODEL_API_KEY`, `ZHIPU_API_KEY`, `ZHIPUAI_API_KEY`,
//! `GLM_API_KEY`, or the key file `~/.coding-relay/glm-api-key`,
//! `~/.config/bigmodel/api_key`, or `~/.config/zhipu/api_key` on the host.
//!
//! The quota limits become the 5-hour and weekly windows plus the MCP lane,
//! BigModel China adds the pay-as-you-go balance, and the last 30 days of
//! tokens per model are listed. Team usage sends the BigModel organization
//! and project headers, as CodexBar does.
//!
//! Not ported: CodexBar takes a key file's first line, but the probe hands
//! a file back whole, so the file must hold only the key; and the hourly
//! token chart, which the panel has no chart for.

use crate::{
    Error, Result,
    usage::{
        model::{
            Account, Balance, DAY, Kind, MONTH, Provider, Report, SESSION, Section, Unit, WEEK,
            Window, group,
        },
        probe::{HostPath, Probe, Request, Secret},
        service::{Meta, Service, Setting, json},
        values::invalid,
    },
};
use chrono::{Datelike, Duration as Span, Timelike, Utc, Weekday};
use serde::Deserialize;
use std::time::{Duration, SystemTime};

const GLOBAL: &str = "https://api.z.ai";
const CHINA: &str = "https://open.bigmodel.cn";
const QUOTA_PATH: &str = "/api/monitor/usage/quota/limit";
const MODEL_USAGE_PATH: &str = "/api/monitor/usage/model-usage";
const BALANCE_URL: &str = "https://www.bigmodel.cn/api/biz/account/query-customer-account-report";
const CHINA_KEYS: [&str; 4] = [
    "BIGMODEL_API_KEY",
    "ZHIPU_API_KEY",
    "ZHIPUAI_API_KEY",
    "GLM_API_KEY",
];
const CHINA_FILES: [&str; 3] = [
    ".coding-relay/glm-api-key",
    ".config/bigmodel/api_key",
    ".config/zhipu/api_key",
];

pub(crate) struct Zai;

static META: Meta = Meta::new("zai", "z.ai / GLM")
    .dashboard("https://z.ai/manage-apikey/coding-plan/personal/my-plan")
    .settings(&[
        Setting::new(
            "api_key",
            &["Z_AI_API_KEY"],
            "A z.ai API key from https://z.ai/manage-apikey/apikey-list, or for BigModel \
             China one from https://bigmodel.cn/usercenter/proj-mgmt/apikeys.",
        ),
        Setting::new(
            "region",
            &[],
            "\"global\" for api.z.ai (the default) or \"bigmodel-cn\" for \
             open.bigmodel.cn, the China mainland GLM Coding Plan.",
        ),
        Setting::new(
            "api_host",
            &["Z_AI_API_HOST"],
            "An HTTPS host that replaces the region's API host, e.g. a proxy.",
        ),
        Setting::new(
            "quota_url",
            &["Z_AI_QUOTA_URL"],
            "A full HTTPS URL that replaces the quota endpoint.",
        ),
        Setting::new(
            "balance_url",
            &["Z_AI_BALANCE_URL"],
            "A full HTTPS URL that replaces the BigModel China balance endpoint.",
        ),
        Setting::new(
            "usage_scope",
            &[],
            "\"personal\" (the default) or \"team\" for BigModel team usage, which also \
             needs organization and project.",
        ),
        Setting::new(
            "organization",
            &["Z_AI_BIGMODEL_ORGANIZATION"],
            "For team usage: open https://bigmodel.cn/coding-plan/team/usage-stats, pick \
             the team, and in Developer Tools > Network copy the Bigmodel-Organization \
             request header of the quota/limit request.",
        ),
        Setting::new(
            "project",
            &["Z_AI_BIGMODEL_PROJECT"],
            "For team usage: the Bigmodel-Project request header of the same request.",
        ),
    ]);

impl Service for Zai {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let china = probe.text_setting("region").as_deref() == Some("bigmodel-cn");
        let key = api_key(probe, china)?;
        Some(read(probe, &key, china))
    }
}

fn api_key(probe: &mut Probe, china: bool) -> Option<Secret> {
    if let Some(key) = probe
        .setting("api_key")
        .or_else(|| probe.env("Z_AI_API_KEY"))
    {
        return Some(key);
    }
    if !china {
        return None;
    }
    CHINA_KEYS
        .iter()
        .find_map(|name| probe.env(name))
        .or_else(|| {
            CHINA_FILES
                .iter()
                .find_map(|path| probe.file(&HostPath::home(*path)))
        })
}

fn read(probe: &mut Probe, key: &Secret, china: bool) -> Result<Report> {
    let base = match probe
        .text_setting("api_host")
        .filter(|host| !host.is_empty())
    {
        Some(host) => https(&host)?,
        None => (if china { CHINA } else { GLOBAL }).to_owned(),
    };
    let team = match probe.text_setting("usage_scope").as_deref() {
        Some("team") => Some((
            probe
                .text_setting("organization")
                .filter(|value| !value.is_empty())
                .ok_or(Error::UsageNotSignedIn)?,
            probe
                .text_setting("project")
                .filter(|value| !value.is_empty())
                .ok_or(Error::UsageNotSignedIn)?,
        )),
        _ => None,
    };
    let get = |url: String| {
        let request = Request::get(url)
            .bearer(key)
            .header("Accept", "application/json");
        match &team {
            Some((organization, project)) => request
                .header("Bigmodel-Organization", organization.as_str())
                .header("Bigmodel-Project", project.as_str()),
            None => request,
        }
    };

    let quota_url = match probe
        .text_setting("quota_url")
        .filter(|url| !url.is_empty())
    {
        Some(url) => https(&url)?,
        None => format!("{base}{QUOTA_PATH}"),
    };
    let quota_url = if team.is_some() {
        with_query(&quota_url, "type=2")
    } else {
        quota_url
    };
    let body = probe.body(get(quota_url))?;
    let now = SystemTime::now();
    let mut report = parse(&body, now)?;

    if china {
        let balance_url = match probe
            .text_setting("balance_url")
            .filter(|url| !url.is_empty())
        {
            Some(url) => https(&url)?,
            None => BALANCE_URL.to_owned(),
        };
        // The balance is optional; its failure must not hide the quota.
        let request = Request::get(balance_url)
            .bearer(key)
            .header("Accept", "application/json")
            .timeout(Duration::from_secs(5));
        if let Some(balance) = probe
            .body(request)
            .ok()
            .and_then(|body| parse_balance(&body))
        {
            report = report.with_balances([balance]);
        }
    }

    let (start, end) = token_range(chrono::Local::now());
    let mut url = format!(
        "{base}{MODEL_USAGE_PATH}?startTime={}&endTime={}",
        encode(&start),
        encode(&end),
    );
    if team.is_some() {
        url.push_str("&type=3");
    }
    if let Some(tokens) = probe
        .body(get(url))
        .ok()
        .and_then(|body| parse_tokens(&body))
    {
        report = report.with_sections([tokens]);
    }
    Ok(report)
}

/// Overrides must stay on HTTPS so the key never travels in the clear.
fn https(value: &str) -> Result<String> {
    let value = value.trim().trim_end_matches('/');
    if value.starts_with("https://") {
        Ok(value.to_owned())
    } else if value.contains("://") {
        Err(Error::UsageNotSignedIn)
    } else {
        Ok(format!("https://{value}"))
    }
}

/// Sets `type=…`, replacing any `type` the URL already has.
fn with_query(url: &str, pair: &str) -> String {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    let mut parts: Vec<&str> = query
        .split('&')
        .filter(|part| !part.is_empty() && part.split('=').next() != Some("type"))
        .collect();
    parts.push(pair);
    format!("{path}?{}", parts.join("&"))
}

fn encode(text: &str) -> String {
    url::form_urlencoded::byte_serialize(text.as_bytes()).collect()
}

/// Local midnight 30 days ago through the end of this hour, as the web
/// dashboard asks.
fn token_range(now: chrono::DateTime<chrono::Local>) -> (String, String) {
    let format = "%Y-%m-%d %H:%M:%S";
    let start = (now - Span::days(30))
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .map(|at| at.format(format).to_string())
        .unwrap_or_default();
    let end = now
        .with_minute(59)
        .and_then(|at| at.with_second(59))
        .unwrap_or(now)
        .format(format)
        .to_string();
    (start, end)
}

pub(crate) fn parse(body: &str, now: SystemTime) -> Result<Report> {
    let root: Root = json(body)?;
    if root.success != Some(true) || root.code != Some(200) {
        return Err(Error::UsageRejected);
    }
    let data = root.data.ok_or_else(invalid)?;
    let limits: Vec<Limit> = data
        .limits
        .ok_or_else(invalid)?
        .into_iter()
        .filter(|limit| {
            matches!(
                limit.kind.as_str(),
                "TOKENS_LIMIT" | "CREDIT_LIMIT" | "TIME_LIMIT"
            )
        })
        .collect();

    let mut plan_limits: Vec<&Limit> = limits
        .iter()
        .filter(|limit| limit.kind != "TIME_LIMIT")
        .collect();
    plan_limits.sort_by_key(|limit| limit.length().unwrap_or(Duration::MAX));
    let mcp = limits.iter().rfind(|limit| limit.kind == "TIME_LIMIT");

    let mut windows: Vec<Window> = Vec::new();
    let mut facts: Vec<(String, String)> = Vec::new();
    let credits = plan_limits.iter().any(|limit| limit.kind == "CREDIT_LIMIT");
    let chosen: Vec<&Limit> = match plan_limits.as_slice() {
        [] => Vec::new(),
        [only] => vec![*only],
        [first, .., last] => vec![*first, *last],
    };
    for limit in &chosen {
        windows.push(limit.window(now, None));
    }
    if let Some(last) = chosen.last() {
        let label = if credits {
            "Credit quota"
        } else {
            "Token quota"
        };
        facts.push((label.into(), last.detail()));
    }
    if let [first, _] = chosen.as_slice() {
        let label = if credits {
            "Session credit quota"
        } else {
            "Session token quota"
        };
        facts.push((label.into(), first.detail()));
    }
    if credits {
        facts.push(("Quota rate".into(), quota_rate(now)));
    }
    let mut sections = Vec::new();
    if let Some(mcp) = mcp {
        let window = mcp.window(now, Some("MCP"));
        if windows.is_empty() {
            windows.push(window);
        } else {
            sections.push(Section::Limit(window));
        }
        facts.push(("MCP quota".into(), mcp.detail()));
        facts.extend(
            mcp.usage_details
                .iter()
                .flatten()
                .take(20)
                .filter_map(|detail| Some((detail.model_code.clone()?, detail.usage?.to_string()))),
        );
    }
    if !facts.is_empty() {
        sections.insert(
            0,
            Section::Facts {
                title: "Quota details".into(),
                facts,
            },
        );
    }
    let plan = [
        data.plan_name,
        data.plan,
        data.plan_type,
        data.package_name,
        data.level,
    ]
    .into_iter()
    .flatten()
    .map(|plan| plan.trim().to_owned())
    .find(|plan| !plan.is_empty());
    Ok(Report::new(Provider(&Zai), Account { email: None, plan }, windows).with_sections(sections))
}

/// Credit plans cost double on weekdays 06:00–10:00 UTC; no endpoint says so.
fn quota_rate(now: SystemTime) -> String {
    let now = chrono::DateTime::<Utc>::from(now);
    let weekday = !matches!(now.weekday(), Weekday::Sat | Weekday::Sun);
    if weekday && (6..10).contains(&now.hour()) {
        "Peak".into()
    } else {
        "Off-peak".into()
    }
}

/// The BigModel China pay-as-you-go balance, in yuan.
pub(crate) fn parse_balance(body: &str) -> Option<Balance> {
    let report: BalanceReport = json(body).ok()?;
    if report.success != Some(true) {
        return None;
    }
    let data = report.data?;
    let amount = data
        .available_balance
        .or(data.balance)
        .filter(|value| value.is_finite())?;
    Some(Balance::new(
        "Account balance",
        amount,
        Unit::Currency("CNY".into()),
    ))
}

/// Tokens per model over the requested range, largest first.
pub(crate) fn parse_tokens(body: &str) -> Option<Section> {
    let usage: ModelUsage = json(body).ok()?;
    if usage.success != Some(true) || usage.code != Some(200) {
        return None;
    }
    let mut totals: Vec<(String, u64)> = usage
        .data?
        .model_data_list
        .unwrap_or_default()
        .into_iter()
        .map(|model| {
            let tokens = model
                .tokens_usage
                .unwrap_or_default()
                .into_iter()
                .flatten()
                .filter(|value| *value > 0.)
                .map(|value| value as u64)
                .fold(0_u64, u64::saturating_add);
            (model.model_name.unwrap_or_else(|| "Unknown".into()), tokens)
        })
        .filter(|(_, tokens)| *tokens > 0)
        .collect();
    if totals.is_empty() {
        return None;
    }
    totals.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Some(Section::Facts {
        title: "Tokens, last 30 days".into(),
        facts: totals
            .into_iter()
            .take(20)
            .map(|(name, tokens)| (name, compact(tokens)))
            .collect(),
    })
}

/// `1.25M`, `3B`; smaller counts stay exact.
fn compact(value: u64) -> String {
    let (divisor, suffix) = match value {
        1_000_000_000.. => (1e9, "B"),
        1_000_000.. => (1e6, "M"),
        _ => return group(i64::try_from(value).unwrap_or(i64::MAX)),
    };
    let scaled = value as f64 / divisor;
    let digits = if scaled >= 100. {
        0
    } else if scaled >= 10. {
        1
    } else {
        2
    };
    let text = format!("{scaled:.digits$}");
    let text = if text.contains('.') {
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    } else {
        text
    };
    format!("{text}{suffix}")
}

#[derive(Deserialize)]
struct Root {
    code: Option<i64>,
    success: Option<bool>,
    data: Option<Data>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Data {
    limits: Option<Vec<Limit>>,
    plan_name: Option<String>,
    plan: Option<String>,
    #[serde(rename = "plan_type")]
    plan_type: Option<String>,
    package_name: Option<String>,
    level: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Limit {
    #[serde(rename = "type")]
    kind: String,
    unit: i64,
    number: i64,
    percentage: f64,
    usage: Option<i64>,
    current_value: Option<i64>,
    remaining: Option<i64>,
    next_reset_time: Option<i64>,
    usage_details: Option<Vec<UsageDetail>>,
}

impl Limit {
    /// Units are 1 day, 3 hour, 5 minute, 6 week.
    fn length(&self) -> Option<Duration> {
        let unit = match self.unit {
            1 => DAY,
            3 => Duration::from_secs(3600),
            5 => Duration::from_secs(60),
            6 => WEEK,
            _ => return None,
        };
        u32::try_from(self.number)
            .ok()
            .filter(|number| *number > 0)
            .and_then(|number| unit.checked_mul(number))
    }

    /// Counts decide the share when the service sends them; the rounded
    /// `percentage` otherwise.
    fn used(&self) -> f64 {
        let Some(total) = self.usage.filter(|total| *total > 0) else {
            return self.percentage;
        };
        let used = match (self.remaining, self.current_value) {
            (Some(remaining), current) => {
                (total - remaining).max(current.unwrap_or(total - remaining))
            }
            (None, Some(current)) => current,
            (None, None) => return self.percentage,
        };
        used.clamp(0, total) as f64 / total as f64 * 100.
    }

    fn window(&self, now: SystemTime, name: Option<&str>) -> Window {
        // A single minute unit marks the monthly MCP allowance.
        let length = if self.kind == "TIME_LIMIT" && self.unit == 5 && self.number == 1 {
            Some(MONTH)
        } else {
            self.length()
        };
        let reset = self
            .next_reset_time
            .and_then(|millis| u64::try_from(millis).ok())
            .map(|millis| SystemTime::UNIX_EPOCH + Duration::from_millis(millis))
            // A five-hour reset further out than the window is a wrong clock.
            .filter(|at| {
                length != Some(SESSION)
                    || at.duration_since(now).unwrap_or_default()
                        <= SESSION + Duration::from_secs(60)
            });
        let kind = match (name, length) {
            (Some(name), _) => Kind::Named(name.into()),
            (None, Some(length)) if length == SESSION => Kind::Session,
            (None, Some(length)) if length == WEEK => Kind::Weekly,
            (None, Some(length)) if length == DAY => Kind::Daily,
            (None, Some(length)) => Kind::Named(format!("{}-hour", length.as_secs() / 3600)),
            (None, None) => Kind::Named("Quota".into()),
        };
        Window::new(kind, self.used(), reset, length)
    }

    fn detail(&self) -> String {
        let used = self.used();
        let mut text = if used.fract() == 0. {
            format!("{used:.0}% used")
        } else {
            format!("{used:.1}% used")
        };
        if let Some(total) = self.usage {
            text.push_str(&format!(" · {total} limit"));
        }
        if let Some(remaining) = self.remaining {
            text.push_str(&format!(" · {remaining} remaining"));
        }
        text
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageDetail {
    model_code: Option<String>,
    usage: Option<i64>,
}

#[derive(Deserialize)]
struct BalanceReport {
    success: Option<bool>,
    data: Option<BalanceData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BalanceData {
    #[serde(default, deserialize_with = "crate::usage::service::number")]
    available_balance: Option<f64>,
    #[serde(default, deserialize_with = "crate::usage::service::number")]
    balance: Option<f64>,
}

#[derive(Deserialize)]
struct ModelUsage {
    code: Option<i64>,
    success: Option<bool>,
    data: Option<ModelUsageData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelUsageData {
    model_data_list: Option<Vec<ModelData>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelData {
    model_name: Option<String>,
    tokens_usage: Option<Vec<Option<f64>>>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    const QUOTA: &str = r#"{"code":200,"msg":"success","success":true,"data":{"planName":"Pro","limits":[
      {"type":"TOKENS_LIMIT","unit":3,"number":5,"percentage":25,"nextResetTime":1785816000000},
      {"type":"TOKENS_LIMIT","unit":6,"number":1,"percentage":9,"nextResetTime":1786291200000},
      {"type":"TIME_LIMIT","unit":5,"number":1,"usage":1000,"currentValue":224,"remaining":776,
       "percentage":22,"usageDetails":[{"modelCode":"search-prime","usage":210},
       {"modelCode":"web-reader","usage":14}]}
    ]}}"#;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn coding_plan_limits_become_session_weekly_and_mcp() {
        let report = parse(QUOTA, at(1_785_812_400)).unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Pro"));
        assert_eq!(report.windows.len(), 2);
        let session = &report.windows[0];
        assert_eq!(session.kind, Kind::Session);
        assert_eq!(session.percent(), 25);
        assert_eq!(session.resets_at, Some(at(1_785_816_000)));
        assert_eq!(session.length, Some(SESSION));
        let weekly = &report.windows[1];
        assert_eq!(weekly.kind, Kind::Weekly);
        assert_eq!(weekly.percent(), 9);
        assert_eq!(weekly.length, Some(WEEK));
        let mcp = report
            .sections
            .iter()
            .find_map(|section| match section {
                Section::Limit(window) => Some(window),
                _ => None,
            })
            .unwrap();
        assert_eq!(mcp.kind, Kind::Named("MCP".into()));
        assert_eq!(mcp.length, Some(MONTH));
        // 224 of 1000 used, from the counts rather than the rounded percentage.
        assert!((mcp.used - 22.4).abs() < 0.01);
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("quota details first");
        };
        assert!(facts.contains(&("search-prime".into(), "210".into())));
        assert!(facts.contains(&("Token quota".into(), "9% used".into())));
    }

    #[test]
    fn implausible_five_hour_reset_is_dropped() {
        let body = r#"{"code":200,"success":true,"data":{"limits":[
          {"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":2000,"currentValue":100,"remaining":1900,
           "percentage":5,"nextResetTime":1786073946574}]}}"#;
        let report = parse(body, at(1_785_816_000)).unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Session);
        assert_eq!(report.windows[0].resets_at, None);
        assert_eq!(report.windows[0].percent(), 5);
    }

    #[test]
    fn failed_envelope_is_rejected() {
        let body = r#"{"code":1001,"msg":"token invalid","success":false}"#;
        assert!(matches!(
            parse(body, at(0)).unwrap_err(),
            Error::UsageRejected
        ));
    }

    #[test]
    fn china_balance_prefers_available() {
        let body = r#"{"code":200,"success":true,"data":{"balance":42.5,"availableBalance":40.0,
            "rechargeAmount":100.0,"giveAmount":20.0,"totalSpendAmount":77.5}}"#;
        let balance = parse_balance(body).unwrap();
        assert_eq!(balance.amount, 40.0);
        assert_eq!(balance.unit, Unit::Currency("CNY".into()));
        let body = r#"{"success":true,"data":{"balance":42.5,"availableBalance":null}}"#;
        assert_eq!(parse_balance(body).unwrap().amount, 42.5);
    }

    #[test]
    fn model_tokens_are_totalled() {
        let body = r#"{"code":200,"msg":"success","success":true,"data":{
          "x_time":["2026-08-02 08:00","2026-08-02 09:00"],
          "modelDataList":[{"modelName":"glm-4.6","tokensUsage":[100,null]},
          {"modelName":"glm-4.5","tokensUsage":[50,25]},
          {"modelName":"glm-big","tokensUsage":[1250000,0]}]}}"#;
        let Section::Facts { facts, .. } = parse_tokens(body).unwrap() else {
            panic!("facts");
        };
        assert_eq!(
            facts,
            vec![
                ("glm-big".into(), "1.25M".into()),
                ("glm-4.6".into(), "100".into()),
                ("glm-4.5".into(), "75".into()),
            ]
        );
    }

    #[test]
    fn team_scope_replaces_type() {
        assert_eq!(
            with_query("https://x/api?type=1&a=b", "type=2"),
            "https://x/api?a=b&type=2"
        );
        assert!(https("http://proxy").is_err());
        assert_eq!(https("proxy.example/").unwrap(), "https://proxy.example");
    }
}
