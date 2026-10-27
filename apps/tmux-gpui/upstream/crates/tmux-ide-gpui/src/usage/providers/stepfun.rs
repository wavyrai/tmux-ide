//! StepFun Step Plan usage from the platform dashboard API, signed in with an
//! Oasis-Token: the `token` setting (or `STEPFUN_TOKEN`) with its `webid`,
//! else the `cookie` setting, else the platform.stepfun.com cookies from
//! Chrome or Safari when the provider is listed.
//!
//! Not ported from CodexBar: the username and password login
//! (`STEPFUN_USERNAME`/`STEPFUN_PASSWORD`), which needs the `INGRESSCOOKIE`
//! from a response's `Set-Cookie` header that the probe does not return, and
//! deriving the Oasis-Webid from the token's JWT claims, which would mean
//! decoding the secret here. The web id is therefore its own setting.

use crate::{
    Error, Result,
    usage::{
        model::{Account, Kind, MONTH, Provider, Report, Window},
        probe::{Part, Probe, Request},
        service::{Meta, Service, Setting, Timestamp, json, number},
        values::invalid,
    },
};
use serde::Deserialize;

const BASE: &str = "https://platform.stepfun.com/api/step.openapi.devcenter.Dashboard";
const APP_ID: &str = "10300";
const BROWSER: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 \
                       (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
/// The credit plan family; only a tie-breaker, as CodexBar treats it.
const CREDIT_FAMILY: f64 = 2.;

pub(crate) struct Stepfun;

static META: Meta = Meta::new("stepfun", "StepFun")
    .dashboard("https://platform.stepfun.com/plan-usage")
    .settings(&[
        Setting::new(
            "token",
            &["STEPFUN_TOKEN"],
            "Your StepFun Oasis-Token. Sign in at https://platform.stepfun.com, open \
             Developer Tools > Application > Cookies for platform.stepfun.com, and copy the \
             value of the Oasis-Token cookie. Set webid too.",
        ),
        Setting::new(
            "webid",
            &[],
            "The value of the Oasis-Webid cookie next to Oasis-Token on \
             platform.stepfun.com. StepFun rejects a token sent with another device's web id.",
        ),
        Setting::new(
            "cookie",
            &[],
            "Instead of token and webid: sign in at https://platform.stepfun.com, open \
             Developer Tools > Application > Cookies for platform.stepfun.com, and copy the \
             Oasis-Token and Oasis-Webid cookies as \"Oasis-Token=…; Oasis-Webid=…\".",
        ),
    ]);

impl Service for Stepfun {
    fn meta(&self) -> &'static Meta {
        &META
    }

    fn fetch(&self, probe: &mut Probe) -> Option<Result<Report>> {
        let webid = probe
            .text_setting("webid")
            .filter(|webid| !webid.is_empty());
        let mut cookie = Vec::new();
        if let Some(token) = probe.setting("token") {
            cookie.push(Part::Text("Oasis-Token=".into()));
            cookie.push(Part::Secret(token));
            if let Some(webid) = &webid {
                cookie.push(Part::Text(format!("; Oasis-Webid={webid}")));
            }
        } else {
            let header = probe.cookies(
                &["platform.stepfun.com", "stepfun.com"],
                &["Oasis-Token", "Oasis-Webid"],
            )?;
            cookie.push(Part::Secret(header));
        }
        Some(fetch(probe, &cookie, webid.as_deref()))
    }
}

fn fetch(probe: &mut Probe, cookie: &[Part], webid: Option<&str>) -> Result<Report> {
    let body = probe.body(request("QueryStepPlanRateLimit", cookie, webid))?;
    // The plan name is decoration: usage still shows when this fails.
    let plan = probe
        .body(request("GetStepPlanStatus", cookie, webid))
        .ok()
        .and_then(|body| parse_plan(&body));
    parse(&body, plan)
}

fn request(method: &str, cookie: &[Part], webid: Option<&str>) -> Request {
    let mut request = Request::post(format!("{BASE}/{method}"))
        .json("{}")
        .header("oasis-appid", APP_ID)
        .header("oasis-platform", "web")
        .header("User-Agent", BROWSER);
    if let Some(webid) = webid {
        request = request.header("oasis-webid", webid);
    }
    request.headers.push(("Cookie".into(), cookie.to_vec()));
    request
}

pub(crate) fn parse(body: &str, plan: Option<String>) -> Result<Report> {
    let limits: RateLimit = json(body)?;
    // StepFun answers an expired or foreign token with 200 and a failed status.
    if limits.status != Some(1) {
        return Err(Error::UsageRejected);
    }
    let account = Account { email: None, plan };
    if limits.is_credit_plan() {
        let windows = limits
            .plan_credit_rate_limit
            .as_ref()
            .and_then(|credit| {
                let left = credit.left_rate()?;
                let resets_at = credit
                    .subscription_credit_reset_time
                    .as_ref()
                    .and_then(Timestamp::time);
                Some(Window::new(
                    Kind::Named("Credit".into()),
                    (1. - left) * 100.,
                    resets_at,
                    resets_at.map(|_| MONTH),
                ))
            })
            .into_iter()
            .collect();
        return Ok(Report::new(Provider(&Stepfun), account, windows));
    }
    let windows = [
        (
            Kind::Session,
            limits.five_hour_usage_left_rate,
            &limits.five_hour_usage_reset_time,
        ),
        (
            Kind::Weekly,
            limits.weekly_usage_left_rate,
            &limits.weekly_usage_reset_time,
        ),
    ]
    .into_iter()
    .map(|(kind, left, reset)| -> Result<Window> {
        let left = left.ok_or_else(invalid)?;
        let reset = reset.as_ref().ok_or_else(invalid)?;
        let length = kind.length();
        Ok(Window::new(kind, (1. - left) * 100., reset.time(), length))
    })
    .collect::<Result<Vec<_>>>()?;
    Ok(Report::new(Provider(&Stepfun), account, windows))
}

fn parse_plan(body: &str) -> Option<String> {
    let status: PlanStatus = json(body).ok()?;
    let name = status.subscription?.name?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_owned())
}

#[derive(Deserialize)]
struct RateLimit {
    status: Option<i64>,
    #[serde(default, deserialize_with = "number")]
    five_hour_usage_left_rate: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    weekly_usage_left_rate: Option<f64>,
    five_hour_usage_reset_time: Option<Timestamp>,
    weekly_usage_reset_time: Option<Timestamp>,
    #[serde(default, deserialize_with = "number")]
    plan_family: Option<f64>,
    plan_credit_rate_limit: Option<CreditLimit>,
}

impl RateLimit {
    /// A live rolling window means the Coding Plan; no window but a credit
    /// pool means the Token Plan; `plan_family` only breaks a tie.
    fn is_credit_plan(&self) -> bool {
        let live = [
            &self.five_hour_usage_reset_time,
            &self.weekly_usage_reset_time,
        ]
        .into_iter()
        .any(|reset| reset.as_ref().and_then(Timestamp::time).is_some());
        if live {
            return false;
        }
        let pool = self.plan_credit_rate_limit.as_ref().is_some_and(|credit| {
            credit.subscription_credit_left_rate.is_some()
                || credit.topup_credit_left_rate.is_some()
                || !credit.credit_buckets.is_empty()
        });
        pool || self.plan_family == Some(CREDIT_FAMILY)
    }
}

#[derive(Deserialize)]
struct CreditLimit {
    #[serde(default, deserialize_with = "number")]
    subscription_credit_left_rate: Option<f64>,
    subscription_credit_reset_time: Option<Timestamp>,
    #[serde(default, deserialize_with = "number")]
    topup_credit_left_rate: Option<f64>,
    #[serde(default)]
    credit_buckets: Vec<Bucket>,
}

impl CreditLimit {
    /// The share of credit left, weighted by bucket sizes when every bucket
    /// has them: the subscription and top-up rates are separate fractions
    /// that cannot be added.
    fn left_rate(&self) -> Option<f64> {
        let balances: Vec<(f64, f64)> = self
            .credit_buckets
            .iter()
            .filter_map(|bucket| {
                let total = bucket.credit_total?;
                let residual = bucket.credit_residual?;
                let valid = total.is_finite()
                    && residual.is_finite()
                    && total > 0.
                    && (0. ..=total).contains(&residual);
                valid.then_some((total, residual))
            })
            .collect();
        if !balances.is_empty() && balances.len() == self.credit_buckets.len() {
            let total: f64 = balances.iter().map(|(total, _)| total).sum();
            let residual: f64 = balances.iter().map(|(_, residual)| residual).sum();
            return Some(residual / total);
        }
        self.subscription_credit_left_rate
            .or(self.topup_credit_left_rate)
    }
}

#[derive(Deserialize)]
struct Bucket {
    #[serde(default, deserialize_with = "number")]
    credit_total: Option<f64>,
    #[serde(default, deserialize_with = "number")]
    credit_residual: Option<f64>,
}

#[derive(Deserialize)]
struct PlanStatus {
    subscription: Option<Subscription>,
}

#[derive(Deserialize)]
struct Subscription {
    name: Option<String>,
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    #[test]
    fn parses_rate_windows() {
        let body = r#"{
            "status": 1,
            "desc": "",
            "five_hour_usage_left_rate": 0.8,
            "five_hour_usage_reset_time": "1777528800",
            "weekly_usage_left_rate": 0.6,
            "weekly_usage_reset_time": 1777899600
        }"#;
        let report = parse(body, Some("Plus".into())).unwrap();
        assert_eq!(report.windows.len(), 2);
        assert_eq!(report.windows[0].kind, Kind::Session);
        assert_eq!(report.windows[0].percent(), 20);
        assert!(report.windows[0].resets_at.is_some());
        assert_eq!(report.windows[1].kind, Kind::Weekly);
        assert_eq!(report.windows[1].percent(), 40);
        assert_eq!(report.account.plan.as_deref(), Some("Plus"));
    }

    #[test]
    fn parses_credit_plan_from_buckets() {
        let body = r#"{
            "status": 1,
            "five_hour_usage_left_rate": 0,
            "five_hour_usage_reset_time": "0",
            "weekly_usage_left_rate": 0,
            "weekly_usage_reset_time": "0",
            "plan_family": 2,
            "plan_credit_rate_limit": {
                "subscription_credit_left_rate": 0.9641,
                "subscription_credit_reset_time": "1780000000",
                "topup_credit_left_rate": 1,
                "credit_buckets": [
                    {"credit_total": "300", "credit_residual": "150", "expire_at": "0"},
                    {"credit_total": 100, "credit_residual": 50}
                ]
            }
        }"#;
        let report = parse(body, None).unwrap();
        assert_eq!(report.windows.len(), 1);
        assert_eq!(report.windows[0].kind, Kind::Named("Credit".into()));
        assert_eq!(report.windows[0].percent(), 50);
        assert_eq!(report.windows[0].length, Some(MONTH));
    }

    #[test]
    fn failed_status_is_rejected() {
        let body = r#"{"status": 0, "message": "Unauthorized"}"#;
        assert!(matches!(parse(body, None), Err(Error::UsageRejected)));
    }

    #[test]
    fn missing_window_fields_fail() {
        assert!(matches!(
            parse(r#"{"status": 1}"#, None),
            Err(Error::UsageJson(_))
        ));
    }

    #[test]
    fn reads_plan_name() {
        let body = r#"{"status":1,"subscription":{"name":" Mini ","plan_type":2,"status":1}}"#;
        assert_eq!(parse_plan(body).as_deref(), Some("Mini"));
    }
}
