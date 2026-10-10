//! Qwen Cloud individual Token Plan usage (five-hour, weekly, and monthly
//! windows) from the home.qwencloud.com console, signed in with a console
//! session cookie: the `cookie` setting or `QWEN_CLOUD_COOKIE`, or, when Qwen
//! Cloud is listed in `[usage] show_providers`, the qwencloud / alibabacloud
//! cookies from Chrome or Safari. As in CodexBar, the `sfm_bailian` gateway's
//! `usage` answer gives the windows, `subscription` the tier, and
//! `quota-config` that tier's credit limits; an older subscription-summary
//! answer is read like Alibaba Token Plan's.
//!
//! The gateway requires the console's `sec_token`, read from the `sec_token`
//! setting or `/tool/user/info.json`; CodexBar also scrapes it from the
//! dashboard HTML, which the probe cannot do. Not ported: the
//! `QWEN_CLOUD_HOST` / `QWEN_CLOUD_QUOTA_URL` test overrides, the `cna`
//! anonymous id and CSRF headers derived from individual cookies (the probe
//! keeps the cookie header opaque), and Firefox cookies. Qwen Cloud has no
//! API-key usage endpoint.

use super::alibabatokenplan::{personal, report_with, team};
use super::oneconsole::{
    check, cornerstone, encode, expand, form_body, gateway_request, sec_token,
};
use crate::{
    Error, Result,
    usage::{
        model::{Provider, Report},
        probe::{Probe, Secret},
        service::{Meta, Service, Setting},
        values,
    },
};
use serde_json::Value;

const HOME: &str = "https://home.qwencloud.com";
const DATA: &str = "https://cs-data.qwencloud.com";
const DASHBOARD: &str = "https://home.qwencloud.com/billing/subscription/token-plan-individual";
const DOMAINS: &[&str] = &["qwencloud.com", "alibabacloud.com", "aliyun.com"];
const PRODUCT_CODE: &str = "sfm_tokenplansolo_public_intl";
const USAGE_API: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage";
const SUBSCRIPTION_API: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription";
const QUOTA_CONFIG_API: &str = "zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config";

pub(crate) struct Qwencloud;

static META: Meta = Meta::new("qwencloud", "Qwen Cloud")
    .dashboard(DASHBOARD)
    .status_page("https://status.alibabacloud.com")
    .settings(&[
        Setting::new(
            "cookie",
            &["QWEN_CLOUD_COOKIE"],
            "Your Qwen Cloud console session. Sign in at \
             https://home.qwencloud.com/billing/subscription/token-plan-individual, open \
             Developer Tools > Application > Cookies > https://home.qwencloud.com, and copy \
             the login ticket (login_qwencloud_ticket or login_aliyunid_ticket) together with \
             login_aliyunid_csrf and cna. Paste them as \"name=value; name2=value2\", or copy \
             the whole Cookie header of the data/api.json request from the Network tab.",
        ),
        Setting::new(
            "sec_token",
            &[],
            "Optional. The console's sec_token, when it cannot be read from \
             /tool/user/info.json: in Developer Tools > Network, the sec_token form field of \
             the data/api.json request on the Token Plan page.",
        ),
    ]);

impl Service for Qwencloud {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let cookie = probe.cookies(DOMAINS, &[])?;
        Some(fetch(probe, &cookie))
    }
}

fn fetch(probe: &mut Probe, cookie: &Secret) -> Result<Report> {
    let token = sec_token(probe, cookie, HOME).ok_or(Error::UsageRejected)?;
    let mut call = |api: &str, data: Value| -> Result<String> {
        let url = format!(
            "{DATA}/data/api.json?action=IntlBroadScopeAspnGateway&product=sfm_bailian&api={}&_v=undefined",
            encode(api)
        );
        let mut data = data;
        if let Some(object) = data.as_object_mut() {
            object.insert(
                "cornerstoneParam".into(),
                cornerstone(DASHBOARD, "QWENCLOUD", false),
            );
        }
        let params = serde_json::json!({ "Api": api, "V": "1.0", "Data": data }).to_string();
        let body = form_body(
            &[
                ("product", "sfm_bailian"),
                ("action", "IntlBroadScopeAspnGateway"),
                ("region", "ap-southeast-1"),
                ("language", "en-US"),
                ("params", &params),
            ],
            Some(&token),
        );
        let request = gateway_request(
            url,
            cookie,
            HOME,
            DASHBOARD,
            "application/json, text/plain, */*",
            body,
        );
        probe.body(request)
    };
    let usage = call(USAGE_API, serde_json::json!({}))?;
    let subscription = call(
        SUBSCRIPTION_API,
        serde_json::json!({ "commodityCode": PRODUCT_CODE }),
    )
    .ok();
    let config = call(QUOTA_CONFIG_API, serde_json::json!({})).ok();
    parse(&usage, subscription.as_deref(), config.as_deref())
}

/// The usage answer, with the optional subscription and quota-config answers
/// naming the tier and its limits.
pub(crate) fn parse(
    usage: &str,
    subscription: Option<&str>,
    config: Option<&str>,
) -> Result<Report> {
    let value =
        expand(serde_json::from_str(usage).map_err(|error| Error::UsageJson(error.classify()))?);
    let optional = |body: Option<&str>| {
        body.and_then(|body| serde_json::from_str::<Value>(body).ok())
            .map(expand)
    };
    let subscription = optional(subscription);
    let config = optional(config);
    if let Some(found) = personal(
        &value,
        subscription.as_ref(),
        config.as_ref(),
        "Token Plan",
        false,
    ) {
        return Ok(found.report(Provider(&Qwencloud)));
    }
    check(&value)?;
    team(&value)
        .map(|summary| report_with(Provider(&Qwencloud), summary))
        .ok_or_else(values::invalid)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;
    use crate::usage::model::{Kind, Section};
    use std::time::{Duration, SystemTime};

    fn at(seconds: u64) -> SystemTime {
        SystemTime::UNIX_EPOCH + Duration::from_secs(seconds)
    }

    #[test]
    fn parses_nested_personal_usage() {
        let inner = r#"{"code":0,"data":{"per5HourPercentage":0.03,"per5HourResetTime":1700003600000,
            "per1WeekPercentage":0.01,"per1WeekResetTime":1700086400000},"success":true}"#;
        let usage = serde_json::json!({"data": {"DataV2": {"data": inner}}, "httpStatusCode": 200})
            .to_string();
        let report = parse(
            &usage,
            Some(r#"{"data":{"specCode":"standard","status":"VALID"}}"#),
            Some(
                r#"{"data":{"lite":{"five_hour":1000,"weekly":10000},
                    "standard":{"five_hour":5000,"weekly":50000},
                    "pro":{"five_hour":10000,"weekly":100000}}}"#,
            ),
        )
        .unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Standard"));
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Session);
        assert!((report.windows[0].used - 3.).abs() < 1e-4);
        assert_eq!(report.windows[0].resets_at, Some(at(1_700_003_600)));
        assert_eq!(report.windows[1].kind, Kind::Weekly);
        assert_eq!(report.windows[1].resets_at, Some(at(1_700_086_400)));
        let Section::Facts { facts, .. } = &report.sections[0] else {
            panic!("expected credit facts");
        };
        assert_eq!(facts[1], ("Weekly".into(), "500 / 50,000 credits".into()));
    }

    #[test]
    fn monthly_only_usage_without_metadata() {
        let report = parse(
            r#"{"data":{"per1MonthPercentage":0.4,"per1MonthResetTime":1702000000000}}"#,
            None,
            None,
        )
        .unwrap();
        assert_eq!(report.account.plan.as_deref(), Some("Token Plan"));
        assert_eq!(report.windows[0].kind, Kind::Monthly);
        assert!((report.windows[0].used - 40.).abs() < 1e-4);
        assert!(report.sections.is_empty());
    }

    #[test]
    fn falls_back_to_subscription_summary() {
        let report = parse(
            r#"{"Success":true,"Data":{"TotalCount":1,"TotalValue":1000,"TotalSurplusValue":600}}"#,
            None,
            None,
        )
        .unwrap();
        assert_eq!(report.windows[0].used, 40.);
    }

    #[test]
    fn login_errors_are_rejected() {
        assert!(matches!(
            parse(
                r#"{"code":"PostonlyOrTokenError","message":"token error"}"#,
                None,
                None
            ),
            Err(Error::UsageRejected)
        ));
    }
}
