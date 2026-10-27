//! Alibaba Cloud Model Studio / Bailian Coding Plan request quotas (five-hour,
//! weekly, and billing-month windows). Sign-in sources, in CodexBar's order:
//! a console session cookie (the `cookie` setting or
//! `ALIBABA_CODING_PLAN_COOKIE`, or, when the provider is listed in
//! `[usage] show_providers`, the aliyun / alibabacloud cookies from Chrome or
//! Safari) through the OneConsole gateway, then a Coding Plan API key from
//! the config or `ALIBABA_CODING_PLAN_API_KEY`, `ALIBABA_QWEN_API_KEY`, or
//! `DASHSCOPE_API_KEY`. Without an explicit `region`, a failure on the
//! International console is retried once on the China mainland one.
//!
//! The gateway needs the console's `sec_token`, read from the `sec_token`
//! setting or `/tool/user/info.json`; CodexBar also scrapes it from the
//! dashboard HTML, which the probe cannot do. Not ported: the
//! `ALIBABA_CODING_PLAN_HOST` / `_QUOTA_URL` overrides, the `cna` anonymous
//! id and CSRF headers derived from individual cookies (the probe keeps the
//! cookie header opaque), and Firefox cookies. Some mainland accounts answer
//! the API key with a console-login demand; that shows as a rejected sign-in.

use super::oneconsole::{
    CHROME_AGENT, DOMAINS, check, cornerstone, date, expand, find_object, find_value, first,
    form_body, gateway_request, sec_token, string,
};
use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, Provider, Report, Section, Window, group},
        probe::{Probe, Request, Secret},
        service::{Meta, Service, Setting},
        values::{invalid, number},
    },
};
use serde_json::{Map, Value};
use std::time::{Duration, SystemTime};

const QUOTA_API: &str = "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2";
const INFO_KEYS: &[&str] = &["codingPlanInstanceInfos", "coding_plan_instance_infos"];
const QUOTA_KEYS: &[&str] = &[
    "per5HourUsedQuota",
    "per5HourTotalQuota",
    "perWeekUsedQuota",
    "perWeekTotalQuota",
    "perBillMonthUsedQuota",
    "perBillMonthTotalQuota",
];

pub(crate) struct Alibaba;

static META: Meta = Meta::new("alibaba", "Alibaba")
    .dashboard("https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan")
    .status_page("https://status.aliyun.com")
    .settings(&[
        Setting::new(
            "cookie",
            &["ALIBABA_CODING_PLAN_COOKIE"],
            "Your Model Studio console session. Sign in to the Coding Plan page at \
             https://modelstudio.console.alibabacloud.com (or https://bailian.console.aliyun.com \
             in China), open Developer Tools > Application > Cookies for that site, and copy \
             at least login_aliyunid_ticket, login_aliyunid_pk, login_aliyunid_csrf and cna. \
             Paste them as \"name=value; name2=value2\", or copy the whole Cookie header of the \
             data/api.json request from the Network tab.",
        ),
        Setting::new(
            "api_key",
            &[
                "ALIBABA_CODING_PLAN_API_KEY",
                "ALIBABA_QWEN_API_KEY",
                "DASHSCOPE_API_KEY",
            ],
            "A Coding Plan API key (sk-sp-...) from the Coding Plan page of the Model Studio \
             console. Used when no console cookie works; some mainland accounts only answer \
             the cookie.",
        ),
        Setting::new(
            "region",
            &[],
            "Optional. \"intl\" (modelstudio.console.alibabacloud.com) or \"cn\" \
             (bailian.console.aliyun.com). Unset tries International, then China mainland.",
        ),
        Setting::new(
            "sec_token",
            &[],
            "Optional. The console's sec_token, when it cannot be read from \
             /tool/user/info.json: in Developer Tools > Network, the sec_token form field of \
             the data/api.json request on the Coding Plan page.",
        ),
    ]);

impl Service for Alibaba {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let chosen = probe
            .text_setting("region")
            .and_then(|raw| Region::parse(&raw));
        let regions: &[Region] = match chosen {
            Some(Region::Cn) => &[Region::Cn],
            Some(Region::Intl) => &[Region::Intl],
            None => &[Region::Intl, Region::Cn],
        };
        let cookie = probe.cookies(DOMAINS, &[]);
        let key = probe.setting("api_key");
        if cookie.is_none() && key.is_none() {
            return None;
        }
        let now = SystemTime::now();
        let mut outcome = Err(Error::UsageNotSignedIn);
        if let Some(cookie) = &cookie {
            outcome = across(regions, |region| fetch_web(probe, cookie, region, now));
        }
        if outcome.is_err()
            && let Some(key) = &key
        {
            outcome = across(regions, |region| fetch_api(probe, key, region, now));
        }
        Some(outcome)
    }
}

/// Tries each region in turn while the failure looks like the wrong one.
fn across(regions: &[Region], mut attempt: impl FnMut(Region) -> Result<Report>) -> Result<Report> {
    let mut outcome = Err(Error::UsageNotSignedIn);
    for region in regions {
        outcome = attempt(*region);
        match &outcome {
            Err(Error::UsageRejected | Error::UsageStatus(403 | 404) | Error::UsageJson(_)) => {}
            _ => break,
        }
    }
    outcome
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Region {
    Intl,
    Cn,
}

impl Region {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "intl" => Some(Self::Intl),
            "cn" => Some(Self::Cn),
            _ => None,
        }
    }

    fn gateway(self) -> &'static str {
        match self {
            Self::Intl => "https://modelstudio.console.alibabacloud.com",
            Self::Cn => "https://bailian.console.aliyun.com",
        }
    }

    fn rpc(self) -> &'static str {
        match self {
            Self::Intl => "https://bailian-singapore-cs.alibabacloud.com",
            Self::Cn => "https://bailian-cs.console.aliyun.com",
        }
    }

    fn dashboard(self) -> &'static str {
        match self {
            Self::Intl => {
                "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan"
            }
            Self::Cn => "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan",
        }
    }

    fn referer(self) -> &'static str {
        match self {
            Self::Intl => {
                "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan"
            }
            Self::Cn => "https://bailian.console.aliyun.com/cn-beijing/?tab=model",
        }
    }

    fn region_id(self) -> &'static str {
        match self {
            Self::Intl => "ap-southeast-1",
            Self::Cn => "cn-beijing",
        }
    }

    fn commodity(self) -> &'static str {
        match self {
            Self::Intl => "sfm_codingplan_public_intl",
            Self::Cn => "sfm_codingplan_public_cn",
        }
    }

    fn action(self) -> &'static str {
        match self {
            Self::Intl => "IntlBroadScopeAspnGateway",
            Self::Cn => "BroadScopeAspnGateway",
        }
    }

    fn console_site(self) -> &'static str {
        match self {
            Self::Intl => "MODELSTUDIO_ALIBABACLOUD",
            Self::Cn => "BAILIAN_ALIYUN",
        }
    }
}

fn fetch_web(
    probe: &mut Probe,
    cookie: &Secret,
    region: Region,
    now: SystemTime,
) -> Result<Report> {
    let token = sec_token(probe, cookie, region.gateway()).ok_or(Error::UsageRejected)?;
    let url = format!(
        "{}/data/api.json?action={}&product=sfm_bailian&api={QUOTA_API}&_v=undefined",
        region.rpc(),
        region.action()
    );
    let params = serde_json::json!({
        "Api": QUOTA_API,
        "V": "1.0",
        "Data": {
            "queryCodingPlanInstanceInfoRequest": {
                "commodityCode": region.commodity(),
                "onlyLatestOne": true,
            },
            "cornerstoneParam": cornerstone(region.dashboard(), region.console_site(), false),
        },
    })
    .to_string();
    let body = form_body(
        &[("params", &params), ("region", region.region_id())],
        Some(&token),
    );
    let request = gateway_request(url, cookie, region.gateway(), region.referer(), "*/*", body);
    let body = probe.body(request)?;
    parse(&body, now)
}

fn fetch_api(probe: &mut Probe, key: &Secret, region: Region, now: SystemTime) -> Result<Report> {
    let url = format!(
        "{}/data/api.json?action={QUOTA_API}&product=broadscope-bailian\
         &api=queryCodingPlanInstanceInfoV2&currentRegionId={}",
        region.gateway(),
        region.region_id()
    );
    let body = serde_json::json!({
        "queryCodingPlanInstanceInfoRequest": { "commodityCode": region.commodity() },
    })
    .to_string();
    let request = Request::post(url)
        .bearer(key)
        .secret_header("x-api-key", "", key)
        .secret_header("X-DashScope-API-Key", "", key)
        .header("Accept", "application/json")
        .header("User-Agent", CHROME_AGENT)
        .header("Origin", region.gateway())
        .header("Referer", region.dashboard())
        .json(body);
    let body = probe.body(request)?;
    parse(&body, now)
}

/// The Coding Plan instance answer: the active instance's quota windows, or,
/// for an active plan that reports no counters, just the plan.
pub(crate) fn parse(body: &str, now: SystemTime) -> Result<Report> {
    let value =
        expand(serde_json::from_str(body).map_err(|error| Error::UsageJson(error.classify()))?);
    check(&value)?;
    let infos: Vec<&Map<String, Value>> = find_value(&value, INFO_KEYS, true, Value::as_array)
        .map(|infos| infos.iter().filter_map(Value::as_object).collect())
        .unwrap_or_default();
    let mut best: Option<(&Map<String, Value>, i32)> = None;
    for &info in &infos {
        let score = active_score(info, now);
        if best.is_none_or(|(_, top)| score > top) {
            best = Some((info, score));
        }
    }
    let instance = match best {
        Some((info, score)) if score > 0 => Some(info),
        _ => infos.first().copied(),
    };
    let instance_active = instance.is_some_and(|info| active_score(info, now) > 0);
    let quota = if infos.len() > 1 && instance_active {
        instance.and_then(quota_of)
    } else {
        instance
            .and_then(quota_of)
            .or_else(|| quota_of_value(&value))
    };
    let plan = instance
        .and_then(plan_of)
        .or_else(|| infos.iter().find_map(|info| plan_of(info)))
        .or_else(|| {
            find_value(
                &value,
                &["planName", "plan_name", "packageName", "package_name"],
                true,
                string,
            )
        });
    let slots = [
        (
            Kind::Session,
            &["per5HourUsedQuota", "perFiveHourUsedQuota"][..],
            &["per5HourTotalQuota", "perFiveHourTotalQuota"][..],
            &[
                "per5HourQuotaNextRefreshTime",
                "perFiveHourQuotaNextRefreshTime",
            ][..],
        ),
        (
            Kind::Weekly,
            &["perWeekUsedQuota"][..],
            &["perWeekTotalQuota"][..],
            &["perWeekQuotaNextRefreshTime"][..],
        ),
        (
            Kind::Monthly,
            &["perBillMonthUsedQuota", "perMonthUsedQuota"][..],
            &["perBillMonthTotalQuota", "perMonthTotalQuota"][..],
            &[
                "perBillMonthQuotaNextRefreshTime",
                "perMonthQuotaNextRefreshTime",
            ][..],
        ),
    ];
    let mut windows = Vec::new();
    let mut facts = Vec::new();
    for (kind, used_keys, total_keys, reset_keys) in slots {
        let Some(quota) = quota else {
            break;
        };
        let Some(total) = first(quota, total_keys, number).filter(|total| *total > 0.) else {
            continue;
        };
        let used = first(quota, used_keys, number)
            .unwrap_or(0.)
            .clamp(0., total);
        let mut reset = first(quota, reset_keys, date);
        if kind == Kind::Session {
            reset = reset.map(|at| fresh_session_reset(at, now));
        }
        facts.push((
            kind.title().to_owned(),
            format!("{} / {}", group(used as i64), group(total as i64)),
        ));
        let length = kind.length();
        windows.push(Window::new(kind, used / total * 100., reset, length));
    }
    if windows.is_empty() {
        let active = instance.map_or_else(
            || {
                value
                    .as_object()
                    .is_some_and(|root| active_score(root, now) > 0)
            },
            |info| active_score(info, now) > 0,
        );
        return match plan.filter(|_| active) {
            Some(plan) => Ok(Report::new(
                Provider(&Alibaba),
                Account {
                    email: None,
                    plan: Some(plan),
                },
                Vec::new(),
            )
            .with_sections([Section::Facts {
                title: "Coding Plan".into(),
                facts: vec![("Status".into(), "Active, quota not reported".into())],
            }])),
            None => Err(invalid()),
        };
    }
    Ok(
        Report::new(Provider(&Alibaba), Account { email: None, plan }, windows).with_sections([
            Section::Facts {
                title: "Requests used".into(),
                facts,
            },
        ]),
    )
}

fn quota_of(info: &Map<String, Value>) -> Option<&Map<String, Value>> {
    let wrapped = info
        .get("codingPlanQuotaInfo")
        .or_else(|| info.get("coding_plan_quota_info"));
    wrapped
        .and_then(Value::as_object)
        .or_else(|| {
            QUOTA_KEYS
                .iter()
                .any(|key| info.contains_key(*key))
                .then_some(info)
        })
        .or_else(|| {
            info.values().find_map(|nested| match nested {
                Value::Object(_) => quota_of_value(nested),
                _ => None,
            })
        })
}

fn quota_of_value(value: &Value) -> Option<&Map<String, Value>> {
    find_value(
        value,
        &["codingPlanQuotaInfo", "coding_plan_quota_info"],
        false,
        Value::as_object,
    )
    .or_else(|| find_object(value, QUOTA_KEYS))
}

fn plan_of(info: &Map<String, Value>) -> Option<String> {
    [
        ["planName", "plan_name"],
        ["instanceName", "instance_name"],
        ["packageName", "package_name"],
    ]
    .iter()
    .find_map(|keys| first(info, keys, string))
}

fn active_score(info: &Map<String, Value>, now: SystemTime) -> i32 {
    if let Some(status) = first(info, &["status", "instanceStatus"], string) {
        let status = status.to_ascii_uppercase();
        if ["VALID", "ACTIVE"].contains(&status.as_str()) {
            return 3;
        }
        if [
            "EXPIRED",
            "INVALID",
            "INACTIVE",
            "DISABLED",
            "TERMINATED",
            "STOPPED",
        ]
        .contains(&status.as_str())
        {
            return -1;
        }
    }
    let active = first(info, &["isActive", "active"], |value| match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => number.as_f64().map(|n| n != 0.),
        Value::String(text) => match text.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" | "active" | "valid" => Some(true),
            "false" | "0" | "no" | "inactive" | "invalid" | "expired" => Some(false),
            _ => None,
        },
        _ => None,
    });
    if let Some(active) = active {
        return if active { 3 } else { -1 };
    }
    let expires = first(
        info,
        &["endTime", "periodEndTime", "expireTime", "expirationTime"],
        date,
    );
    i32::from(expires.is_some_and(|at| at > now))
}

/// The five-hour reset can arrive already past; it then means the window
/// that started there.
fn fresh_session_reset(at: SystemTime, now: SystemTime) -> SystemTime {
    let session = Kind::Session
        .length()
        .unwrap_or(Duration::from_secs(5 * 3600));
    let soon = now + Duration::from_secs(60);
    if at >= soon {
        return at;
    }
    let shifted = at + session;
    if shifted >= soon {
        shifted
    } else {
        now + session
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn parses_quota_payload() {
        let report = parse(
            r#"{
              "data": {
                "codingPlanInstanceInfos": [ { "planName": "Alibaba Coding Plan Pro" } ],
                "codingPlanQuotaInfo": {
                  "per5HourUsedQuota": 52,
                  "per5HourTotalQuota": 1000,
                  "per5HourQuotaNextRefreshTime": 1700000300000,
                  "perWeekUsedQuota": 800,
                  "perWeekTotalQuota": 5000,
                  "perWeekQuotaNextRefreshTime": 1700100000000,
                  "perBillMonthUsedQuota": 1200,
                  "perBillMonthTotalQuota": 20000,
                  "perBillMonthQuotaNextRefreshTime": 1701000000000
                }
              },
              "status_code": 0
            }"#,
            at(1_700_000_000),
        )
        .unwrap();
        assert_eq!(
            report.account.plan.as_deref(),
            Some("Alibaba Coding Plan Pro")
        );
        assert_eq!(report.windows.len(), 3);
        assert_eq!(report.windows[0].kind, Kind::Session);
        assert!((report.windows[0].used - 5.2).abs() < 1e-4);
        assert_eq!(report.windows[0].resets_at, Some(at(1_700_000_300)));
        assert_eq!(report.windows[1].used, 16.);
        assert_eq!(report.windows[2].used, 6.);
        assert_eq!(report.windows[2].resets_at, Some(at(1_701_000_000)));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected request facts");
        };
        assert_eq!(facts[0], ("Session".into(), "52 / 1,000".into()));
    }

    #[test]
    fn stale_session_reset_moves_forward() {
        let now = at(1_700_000_000);
        assert_eq!(
            fresh_session_reset(at(1_699_999_900), now),
            at(1_700_017_900)
        );
        assert_eq!(
            fresh_session_reset(at(1_600_000_000), now),
            at(1_700_018_000)
        );
    }

    #[test]
    fn active_plan_without_counters_keeps_the_plan() {
        let report = parse(
            r#"{"data":{"codingPlanInstanceInfos":[
                {"planName":"Old","status":"EXPIRED"},
                {"planName":"Lite","status":"VALID"}]}}"#,
            at(1_700_000_000),
        )
        .unwrap();
        assert!(report.windows.is_empty());
        assert_eq!(report.account.plan.as_deref(), Some("Lite"));
        assert!(parse(r#"{"data":{}}"#, at(1_700_000_000)).is_err());
    }

    #[test]
    fn console_login_is_rejected() {
        assert!(matches!(
            parse(
                r#"{"code":"ConsoleNeedLogin","message":"Please log in"}"#,
                at(0)
            ),
            Err(Error::UsageRejected)
        ));
    }
}
