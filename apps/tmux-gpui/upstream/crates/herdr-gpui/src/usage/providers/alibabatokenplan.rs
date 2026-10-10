//! Alibaba Cloud Model Studio / Bailian Token Plan usage, Team (credit pool)
//! or Personal/Solo (five-hour, weekly, and monthly windows) as `region`
//! selects. Sign-in sources, in CodexBar's order: the signed-in Bailian CLI
//! (`bl usage token-plan`, or `bl console call` for Personal plans), whose
//! JSON output holds usage only; then a console session cookie (the `cookie`
//! setting or `ALIBABA_TOKEN_PLAN_COOKIE`, or, when the provider is listed in
//! `[usage] show_providers`, the aliyun / alibabacloud cookies from Chrome or
//! Safari) for the OneConsole gateway.
//!
//! The gateway's `sec_token` comes from the `sec_token` setting or the
//! console's `/tool/user/info.json`; CodexBar also scrapes it from the
//! dashboard HTML, which the probe cannot do. Not ported: the
//! `ALIBABA_TOKEN_PLAN_HOST` / `_QUOTA_URL` test overrides, the `cna`
//! anonymous id and CSRF headers derived from individual cookies (the probe
//! keeps the cookie header opaque), and Firefox cookies.

use super::oneconsole::{
    DOMAINS, check, cornerstone, date, encode, expand, find_object, find_value, first, form_body,
    gateway_request, sec_token, string,
};
use crate::{
    Error, Result,
    usage::{
        model::{
            Account, Balance, Kind, MONTH, Provider, Report, SESSION, Section, Unit, WEEK, Window,
            group, title_case,
        },
        probe::{Probe, Secret},
        service::{Meta, Service, Setting},
        values::{self, number},
    },
};
use serde_json::{Map, Value};
use std::time::{Duration, SystemTime};

const PERSONAL_PRODUCT: &str = "sfm_bailian";
const USAGE_API: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const SUBSCRIPTION_API: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
const QUOTA_CONFIG_API: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";
/// The Personal gateway sometimes answers "Success" without the windows; an
/// immediate retry usually has them.
const USAGE_ATTEMPTS: usize = 3;
const CLI_TIMEOUT: Duration = Duration::from_secs(15);

pub(crate) struct Alibabatokenplan;

static META: Meta = Meta::new("alibabatokenplan", "Alibaba Token Plan")
    .icon("icons/providers/alibaba.svg")
    .dashboard("https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan")
    .status_page("https://status.aliyun.com")
    .settings(&[
        Setting::new(
            "region",
            &[],
            "Which Token Plan to read: \"intl\" (International Team, the default), \"cn\" \
             (China mainland Team), \"intl-personal\" or \"cn-personal\" (Personal/Solo).",
        ),
        Setting::new(
            "cookie",
            &["ALIBABA_TOKEN_PLAN_COOKIE"],
            "Only needed without a signed-in Bailian CLI (bl). Sign in to the Token Plan page \
             (https://modelstudio.console.alibabacloud.com, or https://bailian.console.aliyun.com \
             in China), open Developer Tools > Application > Cookies for that site, and copy \
             at least login_aliyunid_ticket, login_aliyunid_pk, login_aliyunid_csrf and cna. \
             Paste them as \"name=value; name2=value2\", or copy the whole Cookie header of the \
             data/api.json request from the Network tab.",
        ),
        Setting::new(
            "sec_token",
            &[],
            "Optional. The console's sec_token, when it cannot be read from \
             /tool/user/info.json: in Developer Tools > Network, the sec_token form field of \
             any data/api.json request on the Token Plan page.",
        ),
    ]);

impl Service for Alibabatokenplan {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let region = probe
            .text_setting("region")
            .and_then(|raw| Region::parse(&raw))
            .unwrap_or(Region::Intl);
        let mut cli_answered = false;
        if let Ok(output) = probe.command("bl", &region.cli_args(), CLI_TIMEOUT)
            && output.success
        {
            if let Some(report) = parse_cli(&output.stdout) {
                return Some(Ok(report));
            }
            cli_answered = true;
        }
        let Some(cookie) = probe.cookies(DOMAINS, &[]) else {
            return cli_answered.then_some(Err(values::invalid()));
        };
        let token = sec_token(probe, &cookie, region.gateway());
        Some(if region.personal() {
            fetch_personal(probe, &cookie, token.as_ref(), region)
        } else {
            fetch_team(probe, &cookie, token.as_ref(), region)
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Region {
    Intl,
    Cn,
    IntlPersonal,
    CnPersonal,
}

impl Region {
    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "intl" | "" => Some(Self::Intl),
            "cn" => Some(Self::Cn),
            "intl-personal" => Some(Self::IntlPersonal),
            "cn-personal" => Some(Self::CnPersonal),
            _ => None,
        }
    }

    fn personal(self) -> bool {
        matches!(self, Self::IntlPersonal | Self::CnPersonal)
    }

    fn china(self) -> bool {
        matches!(self, Self::Cn | Self::CnPersonal)
    }

    fn gateway(self) -> &'static str {
        if self.china() {
            "https://bailian.console.aliyun.com"
        } else {
            "https://modelstudio.console.alibabacloud.com"
        }
    }

    fn quota_base(self) -> &'static str {
        match self {
            Self::Intl | Self::Cn => self.gateway(),
            Self::IntlPersonal => "https://bailian-singapore-cs.alibabacloud.com",
            Self::CnPersonal => "https://bailian-cs.console.aliyun.com",
        }
    }

    fn dashboard(self) -> &'static str {
        match self {
            Self::Intl => {
                "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan"
            }
            Self::Cn => {
                "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan"
            }
            Self::IntlPersonal => {
                "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=plan#/efm/subscription/token-plan/personal"
            }
            Self::CnPersonal => {
                "https://bailian.console.aliyun.com/cn-beijing?tab=plan#/efm/subscription/token-plan/personal"
            }
        }
    }

    fn region_id(self) -> &'static str {
        if self.china() {
            "cn-beijing"
        } else {
            "ap-southeast-1"
        }
    }

    fn product_code(self) -> &'static str {
        match self {
            Self::Intl => "sfm_tokenplanteams_dp_intl",
            Self::Cn => "sfm_tokenplanteams_dp_cn",
            Self::IntlPersonal => "sfm_tokenplansolo_public_intl",
            Self::CnPersonal => "sfm_tokenplansolo_public_cn",
        }
    }

    fn action(self) -> &'static str {
        if self.china() {
            "BroadScopeAspnGateway"
        } else {
            "IntlBroadScopeAspnGateway"
        }
    }

    /// Alibaba's live console contract, historical spelling included.
    fn console_site(self) -> &'static str {
        if self.china() {
            "BAILIAN_ALIYUN"
        } else {
            "MODELSTUDIO_ALBABACLOUD"
        }
    }

    fn cli_args(self) -> Vec<&'static str> {
        let mut args = if self.personal() {
            vec!["console", "call", "--api", USAGE_API, "--data", "{}"]
        } else {
            vec!["usage", "token-plan"]
        };
        args.extend([
            "--console-region",
            self.region_id(),
            "--console-site",
            if self.china() {
                "domestic"
            } else {
                "international"
            },
            "--output",
            "json",
        ]);
        args
    }
}

fn fetch_team(
    probe: &mut Probe,
    cookie: &Secret,
    token: Option<&Secret>,
    region: Region,
) -> Result<Report> {
    let url = format!(
        "{}/data/api.json?action=GetSubscriptionSummary&product=BssOpenAPI-V3&_tag=",
        region.quota_base()
    );
    let params = serde_json::json!({ "ProductCode": region.product_code() }).to_string();
    let body = form_body(
        &[
            ("product", "BssOpenAPI-V3"),
            ("action", "GetSubscriptionSummary"),
            ("params", &params),
            ("region", region.region_id()),
        ],
        token,
    );
    let request = gateway_request(
        url,
        cookie,
        region.gateway(),
        region.dashboard(),
        "*/*",
        body,
    );
    let body = probe.body(request)?;
    parse_team(&body)
}

fn fetch_personal(
    probe: &mut Probe,
    cookie: &Secret,
    token: Option<&Secret>,
    region: Region,
) -> Result<Report> {
    let mut call = |api: &str, data: Value| -> Result<Value> {
        let url = format!(
            "{}/data/api.json?action={}&product={PERSONAL_PRODUCT}&api={}&_v=undefined",
            region.quota_base(),
            region.action(),
            encode(api)
        );
        let mut data = data;
        if let Some(object) = data.as_object_mut() {
            object.insert(
                "cornerstoneParam".into(),
                cornerstone(region.dashboard(), region.console_site(), true),
            );
        }
        let params = serde_json::json!({ "Api": api, "V": "1.0", "Data": data }).to_string();
        let body = form_body(
            &[
                ("product", PERSONAL_PRODUCT),
                ("action", region.action()),
                ("region", region.region_id()),
                ("language", "en-US"),
                ("params", &params),
            ],
            token,
        );
        let request = gateway_request(
            url,
            cookie,
            region.gateway(),
            region.dashboard(),
            "application/json, text/plain, */*",
            body,
        );
        let body = probe.body(request)?;
        let value = expand(
            serde_json::from_str(&body).map_err(|error| Error::UsageJson(error.classify()))?,
        );
        check(&value)?;
        Ok(value)
    };
    let subscription = call(
        SUBSCRIPTION_API,
        serde_json::json!({ "commodityCode": region.product_code() }),
    )
    .ok();
    let config = call(QUOTA_CONFIG_API, serde_json::json!({})).ok();
    for _ in 0..USAGE_ATTEMPTS {
        let usage = call(USAGE_API, serde_json::json!({}))?;
        if let Some(found) = personal(
            &usage,
            subscription.as_ref(),
            config.as_ref(),
            "Personal",
            false,
        ) {
            return Ok(found.report(Provider(&Alibabatokenplan)));
        }
    }
    Err(values::invalid())
}

/// The Bailian CLI's JSON, which carries only the Personal-style ratios.
pub(crate) fn parse_cli(stdout: &str) -> Option<Report> {
    let value: Value = serde_json::from_str(stdout.trim()).ok()?;
    value.as_object()?;
    personal(&expand(value), None, None, "Token Plan", true)
        .map(|personal| personal.report(Provider(&Alibabatokenplan)))
}

const USED_KEYS: &[&str] = &[
    "usedQuota",
    "used_quota",
    "usedCredits",
    "usedCredit",
    "consumedCredits",
    "usage",
    "used",
    "usedAmount",
    "consumeAmount",
    "usedValue",
    "UsedValue",
    "consumedValue",
    "ConsumedValue",
];
const TOTAL_KEYS: &[&str] = &[
    "totalQuota",
    "total_quota",
    "totalCredits",
    "totalCredit",
    "quota",
    "creditLimit",
    "creditsTotal",
    "monthlyTotalQuota",
    "amount",
    "totalValue",
    "TotalValue",
    "cycleTotalValue",
    "CycleTotalValue",
];
const REMAINING_KEYS: &[&str] = &[
    "remainingQuota",
    "remainQuota",
    "remainingCredits",
    "remainingCredit",
    "availableCredits",
    "balance",
    "remaining",
    "availableAmount",
    "remainAmount",
    "totalSurplusValue",
    "TotalSurplusValue",
    "surplusValue",
    "SurplusValue",
    "cycleSurplusValue",
    "CycleSurplusValue",
];
const COUNT_KEYS: &[&str] = &[
    "totalCount",
    "TotalCount",
    "subscriptionTotalNumber",
    "SubscriptionTotalNumber",
];
const RESET_KEYS: &[&str] = &[
    "nextRefreshTime",
    "resetTime",
    "periodEndTime",
    "billingCycleEnd",
    "billCycleEndTime",
    "expireTime",
    "expirationTime",
    "endTime",
    "validEndTime",
    "instanceEndTime",
    "EndTime",
    "cycleEndTime",
    "CycleEndTime",
    "nearestExpireDate",
    "NearestExpireDate",
];
const PLAN_KEYS: &[&str] = &[
    "planName",
    "plan_name",
    "packageName",
    "package_name",
    "commodityName",
    "commodity_name",
    "specType",
    "SpecType",
    "instanceName",
    "instance_name",
    "displayName",
    "display_name",
    "ProductName",
    "productName",
    "name",
    "title",
    "planType",
    "plan_type",
];

/// A Team subscription summary: the credit pool used, left, and when the
/// nearest plan expires.
pub(crate) fn parse_team(body: &str) -> Result<Report> {
    let value =
        expand(serde_json::from_str(body).map_err(|error| Error::UsageJson(error.classify()))?);
    check(&value)?;
    team(&value)
        .map(|report| report_with(Provider(&Alibabatokenplan), report))
        .ok_or_else(values::invalid)
}

/// What a subscription summary says, before it is tied to a provider.
pub(super) struct Team {
    plan: Option<String>,
    used: Option<f64>,
    total: Option<f64>,
    remaining: Option<f64>,
    resets_at: Option<SystemTime>,
}

pub(super) fn team(value: &Value) -> Option<Team> {
    let quota_keys: Vec<&str> = [USED_KEYS, TOTAL_KEYS, REMAINING_KEYS].concat();
    let summary_keys: Vec<&str> = [USED_KEYS, TOTAL_KEYS, REMAINING_KEYS, COUNT_KEYS].concat();
    let has_any = |object: &Map<String, Value>, keys: &[&str]| {
        keys.iter().any(|key| object.contains_key(*key))
    };
    let data = find_value(
        value,
        &["Data", "data", "successResponse", "success_response"],
        true,
        Value::as_object,
    )
    .filter(|data| has_any(data, &summary_keys));
    let summary: Map<String, Value> = match data {
        Some(data) if has_any(data, &quota_keys) => data.clone(),
        // Some consoles nest the quota numbers in an `EquityList` entry while
        // the outer frame only counts subscriptions.
        Some(data) => {
            let wrapped = Value::Object(data.clone());
            find_object(&wrapped, &quota_keys)
                .cloned()
                .unwrap_or_else(|| data.clone())
        }
        None => find_object(value, &summary_keys)?.clone(),
    };
    let nested = Value::Object(summary.clone());
    let total = first(&summary, TOTAL_KEYS, number);
    let remaining = first(&summary, REMAINING_KEYS, number);
    let used = first(&summary, USED_KEYS, number).or_else(|| {
        total
            .zip(remaining)
            .map(|(total, remaining)| (total - remaining).max(0.))
    });
    let count = first(&summary, COUNT_KEYS, number);
    let resets_at = find_value(&nested, RESET_KEYS, true, date)
        .or_else(|| find_value(value, RESET_KEYS, true, date));
    let plan = find_value(&nested, PLAN_KEYS, true, string).or_else(|| {
        (count.is_some_and(|count| count > 0.) || total.is_some()).then(|| "TOKEN PLAN".to_owned())
    });
    if plan.is_none() && total.is_none() && used.is_none() && remaining.is_none() && count.is_none()
    {
        return None;
    }
    Some(Team {
        plan,
        used,
        total,
        remaining,
        resets_at,
    })
}

pub(super) fn report_with(provider: Provider, team: Team) -> Report {
    let percent = team.total.filter(|total| *total > 0.).and_then(|total| {
        let used = team
            .used
            .or_else(|| team.remaining.map(|left| total - left))?;
        Some(used.clamp(0., total) / total * 100.)
    });
    let windows = percent
        .map(|used| Window::new(Kind::Monthly, used, team.resets_at, Some(MONTH)))
        .into_iter()
        .collect();
    let credits = || Unit::Count("credits".into());
    let balance = match (
        team.total.filter(|total| *total > 0.),
        team.remaining,
        team.used,
    ) {
        (Some(total), Some(left), _) => {
            Some(Balance::new("Credits left", left.max(0.), credits()).out_of(total))
        }
        (Some(total), None, Some(used)) => {
            Some(Balance::new("Credits left", (total - used).max(0.), credits()).out_of(total))
        }
        (None, Some(left), _) => Some(Balance::new("Credits left", left.max(0.), credits())),
        _ => None,
    };
    let account = Account {
        email: None,
        plan: team.plan.filter(|plan| !plan.trim().is_empty()),
    };
    let mut report = Report::new(provider, account, windows).with_balances(balance);
    if percent.is_none() && report.balances.is_empty() {
        report = report.with_sections([Section::Facts {
            title: "Subscription".into(),
            facts: vec![("Active token plans".into(), "None".into())],
        }]);
    }
    report
}

/// Personal/Solo windows, with the plan tier and its credit limits when the
/// subscription and quota-config answers are at hand.
pub(super) struct Personal {
    windows: Vec<Window>,
    plan: Option<String>,
    totals: [Option<f64>; 3],
}

impl Personal {
    pub(super) fn report(self, provider: Provider) -> Report {
        let facts: Vec<(String, String)> = self
            .windows
            .iter()
            .zip(self.totals)
            .filter_map(|(window, total)| {
                let total = total.filter(|total| *total > 0.)?;
                let used = total * f64::from(window.used) / 100.;
                Some((
                    window.kind.title().to_owned(),
                    format!(
                        "{} / {} credits",
                        group(used.round() as i64),
                        group(total.round() as i64)
                    ),
                ))
            })
            .collect();
        let report = Report::new(
            provider,
            Account {
                email: None,
                plan: self.plan,
            },
            self.windows,
        );
        if facts.is_empty() {
            report
        } else {
            report.with_sections([Section::Facts {
                title: "Credits used".into(),
                facts,
            }])
        }
    }
}

/// `strict` is the CLI's contract: ratios must be JSON numbers within 0..=1,
/// resets millisecond numbers, and a reset only counts with its ratio.
pub(super) fn personal(
    usage: &Value,
    subscription: Option<&Value>,
    config: Option<&Value>,
    default_plan: &str,
    strict: bool,
) -> Option<Personal> {
    let usage = find_object(
        usage,
        &[
            "per5HourPercentage",
            "per1WeekPercentage",
            "per1MonthPercentage",
        ],
    )?;
    let ratio = |key: &str| {
        let value = usage.get(key)?;
        let ratio = if strict {
            value.as_f64().filter(|ratio| (0. ..=1.).contains(ratio))?
        } else {
            number(value)?
        };
        ratio.is_finite().then(|| ratio.clamp(0., 1.) * 100.)
    };
    let reset = |key: &str| {
        let value = usage.get(key)?;
        if strict {
            let millis = value
                .as_f64()
                .filter(|millis| millis.is_finite() && *millis > 0.)?;
            SystemTime::UNIX_EPOCH.checked_add(Duration::try_from_secs_f64(millis / 1000.).ok()?)
        } else {
            date(value)
        }
    };
    let slots = [
        (
            Kind::Session,
            "per5HourPercentage",
            "per5HourResetTime",
            SESSION,
        ),
        (
            Kind::Weekly,
            "per1WeekPercentage",
            "per1WeekResetTime",
            WEEK,
        ),
        (
            Kind::Monthly,
            "per1MonthPercentage",
            "per1MonthResetTime",
            MONTH,
        ),
    ];
    let code = subscription.and_then(plan_code);
    let limits = code
        .as_deref()
        .zip(config)
        .and_then(|(code, config)| quota_totals(config, code));
    let mut windows = Vec::new();
    let mut totals = [None; 3];
    for (kind, percent_key, reset_key, length) in slots {
        let Some(percent) = ratio(percent_key) else {
            continue;
        };
        let index = windows.len();
        let slot = match kind {
            Kind::Session => 0,
            Kind::Weekly => 1,
            _ => 2,
        };
        totals[index] = limits.and_then(|limits| limits[slot]);
        windows.push(Window::new(kind, percent, reset(reset_key), Some(length)));
    }
    if windows.is_empty() {
        return None;
    }
    let plan = code.map_or_else(
        || default_plan.to_owned(),
        |code| {
            if matches!(code.as_str(), "lite" | "standard" | "pro" | "max") {
                title_case(&code)
            } else {
                code
            }
        },
    );
    Some(Personal {
        windows,
        plan: Some(plan),
        totals,
    })
}

fn plan_code(subscription: &Value) -> Option<String> {
    const KEYS: &[&str] = &["specCode", "spec_code", "planName", "plan_name"];
    let plan = find_object(subscription, KEYS)?;
    KEYS.iter()
        .find_map(|key| string(plan.get(*key)?))
        .map(|code| code.to_lowercase())
}

fn quota_totals(config: &Value, code: &str) -> Option<[Option<f64>; 3]> {
    let quota = find_value(config, &[code], true, Value::as_object)?;
    let get = |keys: &[&str]| keys.iter().find_map(|key| number(quota.get(*key)?));
    let totals = [
        get(&["five_hour", "fiveHour"]),
        get(&["weekly"]),
        get(&["monthly"]),
    ];
    totals.iter().any(Option::is_some).then_some(totals)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests;
